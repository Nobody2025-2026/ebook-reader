// 存储层：IndexedDB（idb-keyval 封装）。
// 关键设计：**元数据和书文件分开存**——书库页只加载元数据，
// 不把 70MB 的 Blob 读进内存，否则开个书库页就爆了。
import { del, get, keys, set } from 'idb-keyval'
import { hasBookmarkAt, sortBookmarks, type Bookmark } from './bookmark'
import type { ReadingProgress } from './progress'

export interface BookMeta {
  id: string
  title: string
  author: string
  cover?: string
  /** 这份封面是用第几版提取算法得到的，算法改了就自动重取（见 cover.ts） */
  coverVersion?: number
  fileName: string
  chapterCount: number
  addedAt: number
}

const KEY_META = 'meta:'
const KEY_FILE = 'file:'
const KEY_PROGRESS = 'progress:'
const KEY_BOOKMARKS = 'bookmarks:'
const KEY_STATS = 'stats:'
const KEY_ANNOTATIONS = 'annotations:'

/**
 * 书文件以 ArrayBuffer 形式存，不存 Blob。
 * 原因：Blob 依赖结构化克隆对 Blob 的支持，实测在 jsdom + fake-indexeddb 下
 * 会被序列化成空对象，字节直接丢失（真实浏览器里应该没问题，但这是"刷新后还能
 * 打开书"的根基，不能只靠推测）。ArrayBuffer 到处都能存，也能在测试里验证内容。
 * 代价：读回时要在内存里拼一份——解析库本来也要把整本书读进内存，没有额外损失。
 */
export async function saveBook(meta: BookMeta, file: Blob): Promise<void> {
  await set(KEY_META + meta.id, meta)
  await set(KEY_FILE + meta.id, await file.arrayBuffer())
}

export async function getBookMeta(id: string): Promise<BookMeta | undefined> {
  return get<BookMeta>(KEY_META + id)
}

export async function getBookFile(id: string, fileName: string): Promise<File | undefined> {
  const buffer = await get<ArrayBuffer>(KEY_FILE + id)
  if (!buffer) return undefined
  return new File([buffer], fileName, { type: 'application/epub+zip' })
}

/** 书库页用：只读元数据，按加入时间倒序 */
export async function listBooks(): Promise<BookMeta[]> {
  const allKeys = await keys()
  const metaKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(KEY_META),
  )
  const metas = await Promise.all(metaKeys.map((k) => get<BookMeta>(k)))
  return metas
    .filter((m): m is BookMeta => Boolean(m))
    .sort((a, b) => b.addedAt - a.addedAt)
}

export async function listProgress(): Promise<Record<string, ReadingProgress>> {
  const allKeys = await keys()
  const progressKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(KEY_PROGRESS),
  )
  const result: Record<string, ReadingProgress> = {}
  await Promise.all(
    progressKeys.map(async (k) => {
      const p = await get<ReadingProgress>(k)
      if (p) result[k.slice(KEY_PROGRESS.length)] = p
    }),
  )
  return result
}

export async function saveProgress(id: string, progress: ReadingProgress): Promise<void> {
  await set(KEY_PROGRESS + id, progress)
}

export async function getProgress(id: string): Promise<ReadingProgress | undefined> {
  return get<ReadingProgress>(KEY_PROGRESS + id)
}

/** 从头读：清除一本书的阅读进度（不删书、不删文件） */
export async function clearProgress(id: string): Promise<void> {
  await del(KEY_PROGRESS + id)
}

/**
 * 书签按"一本书一个数组"存。
 * 书签数量有限（一本书几十个顶天），整存整取比逐条 key 简单，
 * 而且删书时只要删一个 key，不会留孤儿。
 */
export async function listBookmarks(bookId: string): Promise<Bookmark[]> {
  const list = await get<Bookmark[]>(KEY_BOOKMARKS + bookId)
  return sortBookmarks(list ?? [])
}

/** 加书签。同一位置已有则不重复写，返回 false 让 UI 提示"这个位置已经有了" */
export async function addBookmark(bookId: string, bm: Bookmark): Promise<boolean> {
  const list = (await get<Bookmark[]>(KEY_BOOKMARKS + bookId)) ?? []
  if (hasBookmarkAt(list, bm.chapterIndex, bm.blockIndex)) return false
  await set(KEY_BOOKMARKS + bookId, sortBookmarks([...list, bm]))
  return true
}

export async function removeBookmark(bookId: string, id: string): Promise<void> {
  const list = (await get<Bookmark[]>(KEY_BOOKMARKS + bookId)) ?? []
  await set(
    KEY_BOOKMARKS + bookId,
    list.filter((b) => b.id !== id),
  )
}

/**
 * 写入封面：给早期导入、cover 为空或封面版本过旧的书补/换封面。
 * 只改 cover 与 coverVersion，其余元数据原样保留（新增/删书都可能并发，
 * 做合并而非覆盖）。
 */
export async function updateBookCover(
  id: string,
  cover: string,
  version: number,
): Promise<void> {
  const meta = await get<BookMeta>(KEY_META + id)
  if (!meta) return
  await set(KEY_META + id, { ...meta, cover, coverVersion: version })
}

/** 删书必须连带删进度、书签、阅读统计和高亮笔记，否则会留下孤儿记录 */
export async function deleteBook(id: string): Promise<void> {
  await del(KEY_META + id)
  await del(KEY_FILE + id)
  await del(KEY_PROGRESS + id)
  await del(KEY_BOOKMARKS + id)
  await del(KEY_STATS + id)
  await del(KEY_ANNOTATIONS + id)
}

// ---- 高亮与笔记（P1）----
//
// 字符级锚点：章内某块级元素的 [startOffset, endOffset) 文本区间。
// 与进度锚点(chapterIndex+blockIndex)同源，只是多了一对字符偏移，足以精确还原高亮。

export interface Annotation {
  id: string
  bookId: string
  chapterIndex: number
  blockIndex: number
  startOffset: number
  endOffset: number
  /** 高亮的原文（仅用于展示/导出，重绘靠偏移而非文本匹配） */
  text: string
  /** 笔记正文（可选） */
  note?: string
  /** 高亮底色（CSS color），默认浅黄 */
  color?: string
  createdAt: number
  updatedAt?: number
}

/** 生成高亮 id（与书签 newBookmarkId 同款简单方案） */
export function newAnnotationId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function listAnnotations(bookId: string): Promise<Annotation[]> {
  const list = (await get<Annotation[]>(KEY_ANNOTATIONS + bookId)) ?? []
  return list.sort((a, b) => a.chapterIndex - b.chapterIndex || a.startOffset - b.startOffset)
}

/** 加高亮。同一区间已存在则不重复写，返回 false 让 UI 提示 */
export async function addAnnotation(bookId: string, ann: Annotation): Promise<boolean> {
  const list = (await get<Annotation[]>(KEY_ANNOTATIONS + bookId)) ?? []
  const dup = list.some(
    (a) =>
      a.chapterIndex === ann.chapterIndex &&
      a.blockIndex === ann.blockIndex &&
      a.startOffset === ann.startOffset &&
      a.endOffset === ann.endOffset,
  )
  if (dup) return false
  await set(KEY_ANNOTATIONS + bookId, [...list, ann])
  return true
}

export async function updateAnnotationNote(
  bookId: string,
  id: string,
  note: string,
): Promise<void> {
  const list = (await get<Annotation[]>(KEY_ANNOTATIONS + bookId)) ?? []
  await set(
    KEY_ANNOTATIONS + bookId,
    list.map((a) => (a.id === id ? { ...a, note, updatedAt: Date.now() } : a)),
  )
}

export async function removeAnnotation(bookId: string, id: string): Promise<void> {
  const list = (await get<Annotation[]>(KEY_ANNOTATIONS + bookId)) ?? []
  await set(
    KEY_ANNOTATIONS + bookId,
    list.filter((a) => a.id !== id),
  )
}

/**
 * 导出单书的高亮笔记为 Markdown（纯本地，不联网、不跨设备）。
 * 这是 PRD 砍掉的"云同步/跨设备"的本地替代：笔记留在你浏览器，
 * 想备份就导出一份 .md。返回 Markdown 文本，由调用方触发下载。
 */
export async function exportAnnotations(bookId: string, title: string): Promise<string> {
  const list = await listAnnotations(bookId)
  const lines: string[] = [`# ${title || '阅读笔记'} — 高亮与笔记`, '']
  if (list.length === 0) {
    lines.push('_还没有高亮或笔记。_')
    return lines.join('\n')
  }
  let lastChapter = -1
  for (const ann of list) {
    if (ann.chapterIndex !== lastChapter) {
      lines.push('', `## 第 ${ann.chapterIndex + 1} 章`, '')
      lastChapter = ann.chapterIndex
    }
    lines.push(`> ${ann.text}`, '')
    if (ann.note) lines.push(ann.note, '')
  }
  return lines.join('\n')
}

// ---- 阅读时长统计（P1）----

export interface ReadingStats {
  bookId: string
  /** 累计阅读秒数（仅前景阅读计时，切后台/息屏不计） */
  totalSeconds: number
  /** 打开书的次数（每次进入阅读页记一次） */
  sessions: number
  firstOpenedAt: number
  lastReadAt: number
  finishedAt?: number
}

export async function getStats(id: string): Promise<ReadingStats | undefined> {
  return get<ReadingStats>(KEY_STATS + id)
}

export async function listStats(): Promise<Record<string, ReadingStats>> {
  const allKeys = await keys()
  const statKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(KEY_STATS),
  )
  const result: Record<string, ReadingStats> = {}
  await Promise.all(
    statKeys.map(async (k) => {
      const s = await get<ReadingStats>(k)
      if (s) result[k.slice(KEY_STATS.length)] = s
    }),
  )
  return result
}

/** 进入阅读页时调用一次：记一次阅读会话（首次打开初始化记录） */
export async function touchOpen(id: string): Promise<void> {
  const now = Date.now()
  const existing = await get<ReadingStats>(KEY_STATS + id)
  if (existing) {
    await set(KEY_STATS + id, { ...existing, sessions: existing.sessions + 1, lastReadAt: now })
    return
  }
  await set(KEY_STATS + id, {
    bookId: id,
    totalSeconds: 0,
    sessions: 1,
    firstOpenedAt: now,
    lastReadAt: now,
  })
}

/** 累加阅读时长（秒）；仅在前景阅读时调用，切后台不计 */
export async function addReadingSeconds(id: string, secs: number): Promise<void> {
  if (secs <= 0) return
  const now = Date.now()
  const existing = await get<ReadingStats>(KEY_STATS + id)
  if (existing) {
    await set(KEY_STATS + id, {
      ...existing,
      totalSeconds: existing.totalSeconds + secs,
      lastReadAt: now,
    })
    return
  }
  await set(KEY_STATS + id, {
    bookId: id,
    totalSeconds: secs,
    sessions: 0,
    firstOpenedAt: now,
    lastReadAt: now,
  })
}
