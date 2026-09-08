// 存储层：IndexedDB（idb-keyval 封装）。
// 关键设计：**元数据和书文件分开存**——书库页只加载元数据，
// 不把 70MB 的 Blob 读进内存，否则开个书库页就爆了。
import { del, get, keys, set } from 'idb-keyval'
import type { ReadingProgress } from './progress'

export interface BookMeta {
  id: string
  title: string
  author: string
  cover?: string
  fileName: string
  chapterCount: number
  addedAt: number
}

const KEY_META = 'meta:'
const KEY_FILE = 'file:'
const KEY_PROGRESS = 'progress:'

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

/** 删书必须连带删进度，否则会留下孤儿记录 */
export async function deleteBook(id: string): Promise<void> {
  await del(KEY_META + id)
  await del(KEY_FILE + id)
  await del(KEY_PROGRESS + id)
}
