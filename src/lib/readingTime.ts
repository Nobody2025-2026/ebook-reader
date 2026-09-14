// 「本章剩余时间」估算（P1-2）。
//
// 思路照 Kindle：用**已读时长 + 已读字数**倒推速度（字/分钟），
// 再拿"本章还剩多少字"除一下，就是剩余时间。
//
// 全是估算，所以刻意保守 —— 宁可先不给数字，也不要给一个离谱的数字：
// - 样本太小（读得不足 1 分钟、或不足 2000 字）就不估，免得刚打开就报"剩 0 分"；
// - 速度夹在 [200, 2000] 字/分钟：防止"刚打开就拖到 90%"这种操作倒推出荒谬速度；
// - 权重为 0（解压失败 / 脏 EPUB）一律不估，退回百分比显示。

import type { ContentRange } from './progress'

/** 低于这个时长 / 字数就不估算：样本太小，估出来只会误导 */
const MIN_SECONDS = 60
const MIN_READ_WORDS = 2000
/** 中文阅读的合理区间（字/分钟），超出即视为数据不可信 */
const MIN_SPEED = 200
const MAX_SPEED = 2000

export interface RemainInput {
  weights: number[]
  chapterIndex: number
  /** 本章读到第几成（0~1） */
  withinRatio: number
  contentRange: ContentRange
  /** 累计阅读秒数（只算前台时间，与 stats: 同口径） */
  readSeconds: number
  /** 全书百分比（0~100） */
  percent: number
}

/**
 * 本章还大约要读多少分钟。
 *
 * @returns `null` = 暂不估算（样本太小 / 权重缺失，UI 应退回显示百分比）；
 *          `0` = 本章已读完。
 */
export function estimateChapterRemainMinutes(input: RemainInput): number | null {
  const { weights, chapterIndex, withinRatio, contentRange, readSeconds, percent } = input
  if (!weights.length || readSeconds < MIN_SECONDS) return null

  const first = Math.max(contentRange.first, 0)
  const last = Math.min(contentRange.last, weights.length - 1)
  if (last < first) return null

  const contentTotal = weights.slice(first, last + 1).reduce((sum, w) => sum + w, 0)
  if (contentTotal <= 0) return null

  const chapterWords = weights[chapterIndex] ?? 0
  if (chapterWords <= 0) return null

  const ratio = Math.min(Math.max(withinRatio, 0), 1)
  const remainWords = chapterWords * (1 - ratio)
  // 读到章尾了：明确给 0，让 UI 能说"本章读完"而不是继续显示一个 1 分钟
  if (remainWords <= 0) return 0

  const readWords = contentTotal * (Math.min(Math.max(percent, 0), 100) / 100)
  if (readWords < MIN_READ_WORDS) return null

  const rawSpeed = readWords / (readSeconds / 60)
  const speed = Math.min(Math.max(rawSpeed, MIN_SPEED), MAX_SPEED)
  return Math.max(1, Math.round(remainWords / speed))
}

/** 剩余时间 → 顶栏上那句短文案（手机上位置有限，务必短） */
export function formatRemainText(minutes: number | null): string {
  if (minutes == null) return '剩余时间估算中'
  if (minutes <= 0) return '本章读完'
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m > 0 ? `剩 ${h} 时 ${m} 分` : `剩 ${h} 小时`
  }
  return `剩约 ${minutes} 分`
}
