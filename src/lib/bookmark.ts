// 书签模型：锚点直接复用阅读进度的「章节序号 + 章内块下标」（见 progress.ts）。
//
// 为什么不存像素/滚动条位置：真实样本《涛动周期论》单章最多 45 张图且全部懒加载，
// 滚动时图片陆续把内容往下顶，同一个 scrollTop 两次对应的内容可能完全不同。
// 存"第几个段落块"不受影响——只要那段还在 DOM 里，位置就是确定的。
// 所以书签和进度共用一套锚点，恢复逻辑也能直接复用。

export interface Bookmark {
  id: string
  chapterIndex: number
  blockIndex: number
  /** 该位置段落的开头文字，书签列表里靠它认位置 */
  excerpt: string
  /** 添加时的全书百分比（书签列表排序之外的展示信息） */
  percent: number
  createdAt: number
}

/** 摘录最大长度。中文 42 字足够认位置，再长列表里也显示不下 */
const EXCERPT_MAX = 42

/**
 * 从段落文本生成摘录：压平空白后截断。
 * 空段落（章节标题页、纯图片段）给兜底文案，避免书签列表出现无法辨认的空白项。
 */
export function makeExcerpt(text: string | null | undefined, maxLen = EXCERPT_MAX): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return '（此页无文字）'
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat
}

/** 同一块上是否已有书签——避免连点添加出一串重复项 */
export function hasBookmarkAt(
  list: Bookmark[],
  chapterIndex: number,
  blockIndex: number,
): boolean {
  return list.some((b) => b.chapterIndex === chapterIndex && b.blockIndex === blockIndex)
}

/** 按正文顺序排：先章后块，同位置按添加时间。列表从上往下读即全书顺序 */
export function sortBookmarks(list: Bookmark[]): Bookmark[] {
  return [...list].sort(
    (a, b) =>
      a.chapterIndex - b.chapterIndex ||
      a.blockIndex - b.blockIndex ||
      a.createdAt - b.createdAt,
  )
}

/**
 * 书签 id。不用 crypto.randomUUID：jsdom / 部分 WebView 里不一定有，
 * 而 id 只需要在同一本书内唯一，时间戳 + 随机串足够。
 */
export function newBookmarkId(): string {
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
