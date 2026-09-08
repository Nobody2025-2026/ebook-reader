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
 * 按字数加权的全书百分比。
 *
 * 为什么需要它：转换版 EPUB 常把全书塞进一个 spine 项
 * （《策略思维》spine 仅 4 项，第 2 项独占 25 万字），
 * 按"章号/总章数"平摊会让目录页直接显示 50%。
 * 按各章纯文字长度加权后，同一位置约为 0.5%，且章内能平滑爬升。
 *
 * weights[i] = 第 i 章的纯文字数（0 表示空章/未数到）。
 * 权重全 0（解压失败等极端情况）时退化为按章等权，保证总有合理输出。
 */
export function computeWeightedPercent(
  chapterIndex: number,
  withinRatio: number,
  weights: number[],
): number {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (weights.length === 0) return 0
  if (total <= 0) return computePercent(chapterIndex, weights.length, withinRatio)

  const idx = Math.min(Math.max(chapterIndex, 0), weights.length - 1)
  let before = 0
  for (let i = 0; i < idx; i++) before += weights[i]
  const within = weights[idx] * Math.min(Math.max(withinRatio, 0), 1)
  return Math.min(Math.max(((before + within) / total) * 100, 0), 100)
}
