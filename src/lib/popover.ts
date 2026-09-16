/**
 * 浮层定位：把一个 fixed 定位的浮层摆到锚点旁边，并保证它**整个落在视口内**。
 *
 * 为什么单独抽出来：原先组件里只有一句 `top: rect.bottom + 8`，
 * 既不看下方还剩多少空间、也不看上方，更不管左右越界。手机真机上直接表现为
 * "划词太靠屏幕底部 → 浮层下半截被浏览器工具栏吃掉，「加高亮 / 取消」按不到"
 * ——用户划完词却确认不了，等于这条功能白做。
 *
 * 规则（自上而下，命中即停）：
 *   1. 优先摆到首选的那一侧（触屏/桌面统一：锚点**下方**，不遮住刚选中的字）
 *   2. 该侧放不下 → 翻到另一侧
 *   3. 另一侧也放不下 → 夹进视口（配合 CSS max-height，内容仍能滚到）
 *   4. 横向永远夹进视口（窄屏下原来的算法会得到负数，浮层有一半跑到屏幕外）
 *
 * 纯函数、不碰 DOM，方便表驱动单测——这类"边界算错"的 bug 靠肉眼很难发现。
 */

/** 锚点矩形（视口 fixed 坐标系，即 getBoundingClientRect 的值） */
export interface PopoverAnchorRect {
  /** 锚点上沿 */
  top: number
  /** 锚点下沿 */
  bottom: number
  /** 锚点左沿 */
  left: number
}

export interface Size2D {
  width: number
  height: number
}

export interface PopoverPosition {
  top: number
  left: number
  /** 是否因空间不足翻了方向（测试与调试用） */
  flipped: boolean
}

/** 浮层与锚点之间的空隙 */
export const POPOVER_GAP = 8

/** 浮层与视口边缘之间至少留出的空隙 */
export const POPOVER_MARGIN = 12

export function resolvePopoverPosition(
  anchor: PopoverAnchorRect,
  pop: Size2D,
  viewport: Size2D,
  preferBelow = true,
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
): PopoverPosition {
  const vw = Number.isFinite(viewport.width) ? viewport.width : 0
  const vh = Number.isFinite(viewport.height) ? viewport.height : 0
  const popH = Number.isFinite(pop.height) && pop.height > 0 ? pop.height : 0
  const popW = Number.isFinite(pop.width) && pop.width > 0 ? pop.width : 0
  // 锚点坐标也要挡一道 NaN：Math.min/max 遇到 NaN 会把它传染给结果，
  // 最后浮层拿到 top: NaN 就彻底不显示了（比位置不准更糟）。
  const anchorTop = Number.isFinite(anchor.top) ? anchor.top : margin
  const anchorBottom = Number.isFinite(anchor.bottom) ? anchor.bottom : anchorTop
  const anchorLeft = Number.isFinite(anchor.left) ? anchor.left : margin

  const belowTop = anchorBottom + gap
  const aboveTop = anchorTop - popH - gap
  const fitsBelow = belowTop + popH + margin <= vh
  const fitsAbove = aboveTop >= margin

  let top: number
  let flipped = false
  const first = preferBelow ? belowTop : aboveTop
  const second = preferBelow ? aboveTop : belowTop
  const firstFits = preferBelow ? fitsBelow : fitsAbove
  const secondFits = preferBelow ? fitsAbove : fitsBelow

  if (firstFits) {
    top = first
  } else if (secondFits) {
    top = second
    flipped = true
  } else {
    // 上下都塞不下（极窄横屏、或选区本身很长）→ 夹进视口。
    // 这种情况下浮层必然比可视区还高，由 CSS 的 max-height + overflow 兜底，
    // 至少保证「加高亮 / 取消」能滚到。
    top = Math.max(margin, vh - popH - margin)
  }

  // 最后一道保险：无论算出来什么，浮层本身一律夹在视口内。
  //
  // 为什么翻转之后还要夹：翻转判断的是"锚点另一侧能不能装下浮层"，
  // 如果锚点**本身就在视口外**（窗口刚缩过、或锚点离视口很远），
  // 那"另一侧"同样在视口外，翻过去等于白翻、浮层直接消失在屏幕外。
  // 真浏览器复核就抓到过这一例：锚点在视口下方 1584px，浮层跟着跑到 1584。
  const clampedTop = Math.min(Math.max(margin, top), Math.max(margin, vh - popH - margin))

  // 横向：夹进视口。maxLeft 用 max(margin, …) 兜底，避免视口比浮层还窄时
  // 算出负数（那样浮层左边会跑到屏幕外，且不可滚回来）。
  const maxLeft = Math.max(margin, vw - popW - margin)
  const left = Math.min(Math.max(margin, anchorLeft), maxLeft)

  return { top: clampedTop, left, flipped }
}
