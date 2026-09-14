// 书库的排序与筛选（P1-6）：纯逻辑，不碰 DOM，方便单测。
//
// 背景：书库原先只按"导入时间倒序"一种排法，也没有筛选。书一多（>20 本）就是刚需，
// 主流阅读器都有（Apple Books 多种排序 + 列表/网格、微信读书按进度排、Koodo 书架 + 标签）。

/** 排序方式。`added` 是历史行为（导入时间倒序），保持为默认以免老用户觉得乱了。 */
export type SortKey = 'added' | 'recent' | 'title' | 'author'

export const SORT_KEYS: SortKey[] = ['added', 'recent', 'title', 'author']

export const SORT_LABELS: Record<SortKey, string> = {
  added: '导入时间',
  recent: '最近阅读',
  title: '书名',
  author: '作者',
}

/**
 * 只依赖这几个字段，好让本文件不反向依赖组件层（避免 lib → components 的循环引用）。
 * `LibraryBook` 结构上满足它。
 */
export interface SortableBook {
  title: string
  author: string
  addedAt: number
  stats?: { lastReadAt: number }
}

/** 按给定方式排序（返回新数组，不改原数组） */
export function sortBooks<T extends SortableBook>(list: T[], key: SortKey): T[] {
  const copy = [...list]
  switch (key) {
    case 'recent':
      // 「从未读过」的书没有 lastReadAt，用 0 沉到最底；同刻再按导入时间倒序，保证稳定
      return copy.sort(
        (a, b) => (b.stats?.lastReadAt ?? 0) - (a.stats?.lastReadAt ?? 0) || b.addedAt - a.addedAt,
      )
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
    case 'author':
      // 没填作者的一律当"佚名"处理，排在一起时才不会东一个西一个
      return copy.sort((a, b) =>
        (a.author || '佚名').localeCompare(b.author || '佚名', 'zh'),
      )
    case 'added':
    default:
      return copy.sort((a, b) => b.addedAt - a.addedAt)
  }
}

/**
 * 书名 / 作者关键词筛选。空白关键词返回原数组（不制造无谓的拷贝）。
 * 刻意不做模糊匹配与分词：书名就那么几个字，子串匹配已经够用，也可预期。
 */
export function filterBooks<T extends SortableBook>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (b) =>
      b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q),
  )
}
