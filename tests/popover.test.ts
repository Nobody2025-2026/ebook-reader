import { describe, expect, it } from 'vitest'
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  resolvePopoverPosition,
  type PopoverAnchorRect,
  type Size2D,
} from '../src/lib/popover'

/** 手机竖屏（iPhone 14 Pro 的逻辑像素），绝大多数高亮浮层都发生在这个尺寸下 */
const PHONE: Size2D = { width: 390, height: 844 }
/** 浮层实测大约这么高（摘录 + 四个色块 + 笔记框 + 两个按钮） */
const POP: Size2D = { width: 300, height: 200 }

const anchorAt = (top: number, bottom: number, left = 40): PopoverAnchorRect => ({ top, bottom, left })

describe('resolvePopoverPosition', () => {
  it('下方空间充足：挂在选区下方，不翻转', () => {
    const pos = resolvePopoverPosition(anchorAt(100, 140), POP, PHONE)
    expect(pos.top).toBe(140 + POPOVER_GAP)
    expect(pos.flipped).toBe(false)
  })

  it('下方放不下、上方放得下：翻到选区上方（这是手机划词靠底部的关键场景）', () => {
    // 选区下沿 780，视口 844 → 下方只剩 64，塞不下 200 高的浮层
    const pos = resolvePopoverPosition(anchorAt(740, 780), POP, PHONE)
    expect(pos.flipped).toBe(true)
    expect(pos.top).toBe(740 - POP.height - POPOVER_GAP)
    // 翻上去之后整个浮层必须落在视口内
    expect(pos.top).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(pos.top + POP.height + POPOVER_MARGIN).toBeLessThanOrEqual(PHONE.height)
  })

  it('上下都放不下：夹进视口，而不是把浮层顶到屏幕外', () => {
    // 视口只有 300 高，浮层 200 高，选区占了中间 → 两侧都塞不下
    const viewport: Size2D = { width: 390, height: 300 }
    const pos = resolvePopoverPosition(anchorAt(140, 160), POP, viewport)
    expect(pos.top).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(pos.top + POP.height + POPOVER_MARGIN).toBeLessThanOrEqual(viewport.height)
  })

  it('选区贴着屏幕最底部：浮层仍然完整可见（原 bug 的复现场景）', () => {
    const pos = resolvePopoverPosition(anchorAt(800, 828), POP, PHONE)
    expect(pos.top + POP.height + POPOVER_MARGIN).toBeLessThanOrEqual(PHONE.height)
    expect(pos.top).toBeGreaterThanOrEqual(POPOVER_MARGIN)
  })

  it('锚点跑到视口下方很远时，浮层仍被夹进视口（翻转也算救不回来的情况）', () => {
    // 真浏览器复核抓到的实例：锚点在视口下方 1584px。
    // 翻转判断只看"锚点另一侧装不装得下"，而那一侧同样在视口外 ——
    // 光靠翻转，浮层会跟着锚点一起消失在屏幕外。
    const pos = resolvePopoverPosition(anchorAt(1560, 1584), POP, PHONE)
    expect(pos.top).toBeGreaterThanOrEqual(POPOVER_MARGIN)
    expect(pos.top + POP.height + POPOVER_MARGIN).toBeLessThanOrEqual(PHONE.height)
  })

  it('锚点在视口上方（负坐标）时也夹回来', () => {
    const pos = resolvePopoverPosition(anchorAt(-100, -60), POP, PHONE)
    expect(pos.top).toBe(POPOVER_MARGIN)
  })

  it('横向：靠右越界时夹回来', () => {
    const pos = resolvePopoverPosition(anchorAt(100, 140, 370), POP, PHONE)
    expect(pos.left).toBe(PHONE.width - POP.width - POPOVER_MARGIN)
    expect(pos.left + POP.width + POPOVER_MARGIN).toBeLessThanOrEqual(PHONE.width)
  })

  it('横向：靠左越界时也夹回，不出现负坐标', () => {
    const pos = resolvePopoverPosition(anchorAt(100, 140, -20), POP, PHONE)
    expect(pos.left).toBe(POPOVER_MARGIN)
  })

  it('视口比浮层还窄：left 不会算成负数（原算法 Math.min(left, innerWidth-320) 的错误就在这里）', () => {
    const narrow: Size2D = { width: 250, height: 600 }
    const pos = resolvePopoverPosition(anchorAt(100, 140, 30), POP, narrow)
    expect(pos.left).toBe(POPOVER_MARGIN)
    expect(pos.left).toBeGreaterThanOrEqual(0)
  })

  it('preferBelow=false：优先挂上方，上方放不下才翻到下方', () => {
    const up = resolvePopoverPosition(anchorAt(400, 440), POP, PHONE, false)
    expect(up.flipped).toBe(false)
    expect(up.top).toBe(400 - POP.height - POPOVER_GAP)

    const down = resolvePopoverPosition(anchorAt(100, 140), POP, PHONE, false)
    expect(down.flipped).toBe(true)
    expect(down.top).toBe(140 + POPOVER_GAP)
  })

  it('返回的永远是有限数：NaN / 负尺寸输入不产生 NaN 坐标', () => {
    const bad = resolvePopoverPosition(
      { top: Number.NaN, bottom: Number.NaN, left: Number.NaN },
      { width: Number.NaN, height: Number.NaN },
      { width: Number.NaN, height: Number.NaN },
    )
    expect(Number.isFinite(bad.top)).toBe(true)
    expect(Number.isFinite(bad.left)).toBe(true)
    expect(bad.top).toBeGreaterThanOrEqual(0)
    expect(bad.left).toBeGreaterThanOrEqual(0)
  })

  it('恰好贴合边界：不越界也不无谓翻转', () => {
    // 视口 400，锚点下沿 192，浮层 200，margin 12 → 192+8+200+12 = 412 > 400 放不下
    const viewport: Size2D = { width: 390, height: 400 }
    const tight = resolvePopoverPosition(anchorAt(140, 180), POP, viewport)
    expect(tight.top + POP.height + POPOVER_MARGIN).toBeLessThanOrEqual(viewport.height)
    expect(tight.top).toBeGreaterThanOrEqual(POPOVER_MARGIN)
  })
})
