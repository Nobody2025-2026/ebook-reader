// 进度模型：用"段落序号"做锚点，不用绝对像素。
//
// 为什么是段落不是像素？
// 真实样本《涛动周期论》单章最多 45 张图，全部加了 loading="lazy"。
// 用户滚动时图片会陆续加载，把后面的内容一寸寸往下顶。
// 同一个 scrollTop 刻度对应的内容可能前后两次完全不一样。
// 存"第几个段落"则不受图片撑开的影响——只要那段还在 DOM 里，
// 它的位置就是确定的，恢复时 scrollIntoView 即可。
//
// chapterIndex + blockIndex 共同锚定：
// - chapterIndex：当前正在看的章节（spine 里的序号）
// - blockIndex：该章节内"视口顶压着的那段"的块级元素下标
// 两者一起就足够精确，不需要像素。

export interface ReadingProgress {
  chapterIndex: number
  /** 当前章节内被视口顶部压着的那段块级元素的下标 */
  blockIndex: number
  /** 全书百分比（粗略显示用，0~100） */
  percent: number
  updatedAt: number
}

/**
 * 块级元素的"高度 + 顶边"快照。给一组块的视口坐标，告诉我视口顶压着哪一块。
 * 通常由调用方遍历所有 chapter 内的 p/h1~h6/li/blockquote 得到。
 */
export interface BlockRect {
  top: number
  bottom: number
  /** 这个块属于第几章（spine 序号） */
  chapterIndex: number
  /** 这个块在该章内的下标 */
  blockIndex: number
}

/** 视口顶边（一般是 0，但留给调用方传其他值） */
export function findAnchorBlock(
  blocks: BlockRect[],
  viewportTop: number,
): { chapterIndex: number; blockIndex: number } {
  if (blocks.length === 0) return { chapterIndex: 0, blockIndex: 0 }
  // 找出"最后一个 top ≤ viewportTop + 1" 的块
  // +1 是浮点容差，避免正好压在边界上时反复横跳
  let result = blocks[0]
  for (const block of blocks) {
    if (block.top <= viewportTop + 1) result = block
    else break
  }

  // 退化情形兜底：所有块 top 完全相同（jsdom 这类没有真实布局的环境，
  // getBoundingClientRect 一律返回 0）。此时"视口顶压在哪一段"本就无法判定，
  // 原逻辑会一路落到最后一章——但下一章往往只是被预加载机制提前塞进 DOM，
  // 读者其实还在第一章。退化时直接取文档最顶部的块（已加载的第一章第一段），
  // 与"刚打开、还没真正滚动"的语义一致。真实布局下各块 top 必有落差，不会触发。
  if (blocks.every((b) => b.top === blocks[0].top)) {
    return { chapterIndex: blocks[0].chapterIndex, blockIndex: blocks[0].blockIndex }
  }

  return { chapterIndex: result.chapterIndex, blockIndex: result.blockIndex }
}

/**
 * 章节内块级元素按"视口坐标 → 全局块下标"映射，存为纯函数便于单测。
 * chapterTops[i] = 第 i 章顶边相对滚动容器的像素值
 * blocksInChapter[i] = 第 i 章内的块级元素数量
 * scrollTop = 当前滚动位置
 *
 * 返回 (chapterIndex, blockIndex)
 */
export function locateFromTops(
  chapterTops: number[],
  blocksPerChapter: number[],
  scrollTop: number,
): { chapterIndex: number; blockIndex: number } {
  if (chapterTops.length === 0) return { chapterIndex: 0, blockIndex: 0 }

  // 先按章节顶边定位人在哪一章
  let chapterIndex = 0
  for (let i = 0; i < chapterTops.length; i++) {
    if (chapterTops[i] <= scrollTop + 1) chapterIndex = i
    else break
  }

  // 章内偏移，按"均匀"假设给个比例（粗略估计，真实块高不等）
  const top = chapterTops[chapterIndex]
  const nextTop = chapterTops[chapterIndex + 1] ?? Number.POSITIVE_INFINITY
  const chapterHeight = nextTop - top
  const offsetIntoChapter = Math.max(scrollTop - top, 0)
  const total = blocksPerChapter[chapterIndex] ?? 0
  if (total <= 0 || chapterHeight <= 0) {
    return { chapterIndex, blockIndex: 0 }
  }
  const ratio = Math.min(offsetIntoChapter / chapterHeight, 0.9999)
  return { chapterIndex, blockIndex: Math.floor(ratio * total) }
}

/** 章节序号 + 章内比例 → 全书百分比。 */
export function computePercent(
  chapterIndex: number,
  totalChapters: number,
  withinRatio: number,
): number {
  if (totalChapters <= 0) return 0
  // 以"章"为粗粒度，章内再微调。这样即使未加载章节的块数未知，比例也是稳定的。
  const chapterRatio = chapterIndex / totalChapters
  const fine = Math.min(Math.max(withinRatio, 0), 1) / totalChapters
  return Math.min(Math.max((chapterRatio + fine) * 100, 0), 100)
}

/**
 * 内容范围：去掉封面/目录/版权/索引等边缘轻量章节后，真正的阅读正文区间。
 * 很多 EPUB（尤其是 z-library 转换版）把 nav.xhtml 放在 spine 末尾，
 * 直接按 spine 顺序算百分比会让"目录页"显示 99%+；恢复进度时如果落在
 * 这些边缘章节上，用户打开就看见一个目录且"无法往前翻"。
 *
 * 检测逻辑：从两端向中间扫，去掉权重明显低于平均值的章节。
 * ratio 默认 0.05：轻量章节 < 平均权重的 5% 即视为边缘物质。
 */
export interface ContentRange {
  first: number
  last: number
}

export function detectContentRange(
  weights: number[],
  edgeRatio = 0.05,
): ContentRange {
  if (weights.length === 0) return { first: 0, last: -1 }
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return { first: 0, last: weights.length - 1 }

  const avg = total / weights.length
  const threshold = edgeRatio * avg

  let first = 0
  while (first < weights.length && weights[first] < threshold) first++
  let last = weights.length - 1
  while (last >= 0 && weights[last] < threshold) last--

  // 极端情况：所有章节都低于阈值，说明内容本身就很零碎，不要全 trim
  if (first > last) return { first: 0, last: weights.length - 1 }
  return { first, last }
}

/**
 * 按字数加权的全书百分比。
 *
 * 为什么需要它：转换版 EPUB 常把全书塞进一个 spine 项
 * （《策略思维》spine 仅 4 项，第 2 项独占 25 万字），
 * 按"章号/总章数"平摊会让目录页直接显示 50%。
 * 按各章纯文字长度加权后，同一位置约为 0.5%，且章内能平滑爬升。
 *
 * weights[i] = 第 i 章的纯文字数（0 表示空章/未数到）。
 * 权重全 0（解压失败等极端情况）时退化为按章等权，保证总有合理输出。
 *
 * contentRange 可选：传入 detectContentRange 的结果后，百分比只在正文区间
 * 内计算。
 * - 落在区间**之前**（封面/目录/版权页）：算 0%。
 * - 落在区间**之后**（nav/索引/尾页）：算 100%。
 * - 落在区间内：按区间内累计字数 / 区间总字数。
 * 这样"滚到末尾的 nav 页"不会把进度顶到 100%——因为它本来就在正文区间外。
 */
export function computeWeightedPercent(
  chapterIndex: number,
  withinRatio: number,
  weights: number[],
  contentRange?: ContentRange,
): number {
  if (weights.length === 0) return 0
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return computePercent(chapterIndex, weights.length, withinRatio)

  const range =
    contentRange && contentRange.last >= contentRange.first
      ? contentRange
      : { first: 0, last: weights.length - 1 }

  if (chapterIndex < range.first) return 0
  if (chapterIndex > range.last) return 100

  const contentTotal = weights
    .slice(range.first, range.last + 1)
    .reduce((sum, w) => sum + w, 0)
  if (contentTotal <= 0) return computePercent(chapterIndex, weights.length, withinRatio)

  let before = 0
  for (let i = range.first; i < chapterIndex; i++) before += weights[i]
  const within = weights[chapterIndex] * Math.min(Math.max(withinRatio, 0), 1)
  return Math.min(Math.max(((before + within) / contentTotal) * 100, 0), 100)
}
