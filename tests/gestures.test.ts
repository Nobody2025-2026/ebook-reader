import { describe, expect, it } from 'vitest'
import {
  detectSwipe,
  isTap,
  resolveTapZone,
  SWIPE_MAX_DURATION_MS,
  TAP_MAX_MOVE_PX,
  type TouchPoint,
} from '../src/lib/gestures'

const at = (x: number, y: number, t: number): TouchPoint => ({ x, y, t })

describe('点按分区', () => {
  it('左右边缘翻页，中间唤菜单', () => {
    expect(resolveTapZone(50, 1000)).toBe('prev')
    expect(resolveTapZone(500, 1000)).toBe('center')
    expect(resolveTapZone(950, 1000)).toBe('next')
  })

  it('边界值：正好压在分界线上算中间区（宁可弹菜单也别乱翻页）', () => {
    // 1000 * 0.22 = 220
    expect(resolveTapZone(219, 1000)).toBe('prev')
    expect(resolveTapZone(220, 1000)).toBe('center')
    expect(resolveTapZone(780, 1000)).toBe('center')
    expect(resolveTapZone(781, 1000)).toBe('next')
  })

  it('宽度异常（0 / 负数 / NaN）一律当中区', () => {
    expect(resolveTapZone(10, 0)).toBe('center')
    expect(resolveTapZone(10, -100)).toBe('center')
    expect(resolveTapZone(Number.NaN, 1000)).toBe('center')
    expect(resolveTapZone(10, Number.NaN)).toBe('center')
  })
})

describe('点按判定', () => {
  it('原地轻点算点按', () => {
    expect(isTap(at(100, 100, 0), at(101, 99, 120))).toBe(true)
  })

  it(`移动超过 ${TAP_MAX_MOVE_PX}px 就不算点按（那是滑动）`, () => {
    expect(isTap(at(100, 100, 0), at(100 + TAP_MAX_MOVE_PX + 1, 100, 120))).toBe(false)
    expect(isTap(at(100, 100, 0), at(100 + TAP_MAX_MOVE_PX, 100, 120))).toBe(true)
  })

  it('按太久不算点按——长按是选词加高亮，不能顺带翻页', () => {
    expect(isTap(at(100, 100, 0), at(100, 100, 800))).toBe(false)
  })

  it('时间戳倒挂（异常）不算点按', () => {
    expect(isTap(at(100, 100, 500), at(100, 100, 100))).toBe(false)
  })
})

describe('左右滑动判定', () => {
  it('从右往左划 = 下一屏，从左往右划 = 上一屏', () => {
    expect(detectSwipe(at(500, 300, 0), at(300, 300, 200))).toBe('next')
    expect(detectSwipe(at(300, 300, 0), at(500, 300, 200))).toBe('prev')
  })

  it('横向距离不够不算翻页', () => {
    expect(detectSwipe(at(500, 300, 0), at(470, 300, 200))).toBe('none')
  })

  it('纵向为主 → 判定为普通滚动，不抢', () => {
    // dy=-200 远大于 dx=-50 的 0.6 倍
    expect(detectSwipe(at(500, 300, 0), at(450, 100, 200))).toBe('none')
  })

  it('斜着划但以横向为主 → 仍然翻页', () => {
    // |dy|=40 <= |dx|*0.6 = 48
    expect(detectSwipe(at(500, 300, 0), at(420, 260, 200))).toBe('next')
  })

  it(`划太久（> ${SWIPE_MAX_DURATION_MS}ms）当成慢速拖拽，不翻页`, () => {
    expect(detectSwipe(at(500, 300, 0), at(200, 300, 900))).toBe('none')
  })

  it('纯纵向滑动（dx=0）永远不翻页', () => {
    expect(detectSwipe(at(500, 300, 0), at(500, 100, 150))).toBe('none')
  })
})
