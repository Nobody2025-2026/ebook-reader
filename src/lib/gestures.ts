/**
 * 触摸手势判定：纯函数，不碰 DOM，方便单测。
 *
 * 为什么非要自己判：本项目是**连续滚动**（不是分页），
 * 所以"翻页"其实是"滚一屏"。触屏上至少要能：
 *   点左/右边缘 = 上一屏/下一屏（Apple Books / Kindle 的约定）
 *   左右滑动   = 上一屏/下一屏
 *   点中间     = 唤出/隐藏顶栏（沉浸式阅读）
 */

/** 左右边缘各占多宽算"翻页区"；剩下中间一块是"菜单区" */
export const TAP_EDGE_RATIO = 0.22

/** 手指移动超过这个距离就不算"点按"（当作滑动） */
export const TAP_MAX_MOVE_PX = 12

/** 按太久也不算点按——长按是选词加高亮，不能顺带翻页 */
export const TAP_MAX_DURATION_MS = 600

/** 滑动至少走这么远才算翻页 */
export const SWIPE_MIN_DISTANCE_PX = 45

/** 划太久就当成慢速拖拽，不算翻页 */
export const SWIPE_MAX_DURATION_MS = 700

/** 纵向位移超过横向的这个比例 → 判定为"在上下滚"，不翻页 */
export const SWIPE_MAX_CROSS_AXIS_RATIO = 0.6

export type TapZone = 'prev' | 'center' | 'next'

export interface TouchPoint {
  x: number
  y: number
  /** 时间戳（ms），用 Date.now() 即可 */
  t: number
}

/**
 * 点按落点在哪个区。
 * 宽度异常（0 / 负数 / NaN）时一律当中区，宁可只弹菜单也不要乱翻页。
 */
export function resolveTapZone(x: number, width: number): TapZone {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 'center'
  if (x < width * TAP_EDGE_RATIO) return 'prev'
  if (x > width * (1 - TAP_EDGE_RATIO)) return 'next'
  return 'center'
}

export function isTap(start: TouchPoint, end: TouchPoint): boolean {
  const dt = end.t - start.t
  if (dt < 0 || dt > TAP_MAX_DURATION_MS) return false
  const dx = end.x - start.x
  const dy = end.y - start.y
  return Math.hypot(dx, dy) <= TAP_MAX_MOVE_PX
}

/**
 * 左右滑动判定。返回的 'next' = 下一屏（手指从右往左划，dx<0）。
 * 纵向为主、距离太短、或耗时太长，都返回 'none' —— 让原生滚动/长按该干嘛干嘛。
 */
export function detectSwipe(start: TouchPoint, end: TouchPoint): 'prev' | 'next' | 'none' {
  const dt = end.t - start.t
  if (dt < 0 || dt > SWIPE_MAX_DURATION_MS) return 'none'

  const dx = end.x - start.x
  const dy = end.y - start.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)

  if (adx < SWIPE_MIN_DISTANCE_PX) return 'none'
  // 主要是纵向移动 → 这是普通的上下滚动，别抢
  if (ady > adx * SWIPE_MAX_CROSS_AXIS_RATIO) return 'none'

  return dx < 0 ? 'next' : 'prev'
}
