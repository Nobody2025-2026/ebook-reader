// 进度计算：故意写成纯函数，不碰 DOM，这样能直接单测。
// 阅读器里的实际测量（offsetTop / scrollTop）在组件里做完再喂进来。

export interface ReadingProgress {
  chapterIndex: number
  /** 当前章节内的滚动偏移，单位 px */
  offset: number
  percent: number
  updatedAt: number
}

/**
 * 根据每章顶边位置和当前滚动位置，判断"人在哪一章、章内滚到哪"。
 * tops 按加载顺序给出（相对滚动容器）。
 */
export function locateCurrent(
  tops: number[],
  scrollTop: number,
): { chapterIndex: number; offset: number } {
  if (tops.length === 0) return { chapterIndex: 0, offset: 0 }
  let index = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= scrollTop + 1) index = i
    else break
  }
  return { chapterIndex: index, offset: Math.max(scrollTop - tops[index], 0) }
}

/** 章节内比例 + 章节序号 → 全书百分比，越界一律夹紧到 0~100 */
export function computePercent(
  chapterIndex: number,
  offset: number,
  chapterHeight: number,
  totalChapters: number,
): number {
  if (totalChapters <= 0) return 0
  const ratio = chapterHeight > 0 ? Math.min(Math.max(offset / chapterHeight, 0), 1) : 0
  return Math.min(Math.max(((chapterIndex + ratio) / totalChapters) * 100, 0), 100)
}
