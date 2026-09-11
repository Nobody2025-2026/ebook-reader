import { describe, expect, it } from 'vitest'
import {
  detectFontAvailability,
  firstUsableFamily,
  isFontUsable,
  type FontProbe,
} from '../src/lib/fontAvailability'

const GENERICS = new Set(['monospace', 'serif', 'sans-serif'])

/**
 * 造一个「模拟浏览器」的探针：给出真实存在的字体名 + 各自的宽度，
 * 量宽度时按 CSS 的回退规则取**第一个真正存在的**字体名。
 * 这样就能在纯逻辑层复现"Safari 屏蔽了某个系统字体名"的场景。
 */
function makeProbe(exists: string[], widthOf: Record<string, number>): FontProbe {
  return {
    width(font: string) {
      const quoted = [...font.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      const bare = font
        .replace(/^[\d.]+px\s*/, '')
        .replace(/"[^"]+"/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const candidates = [...quoted, ...bare]
      const hit = candidates.find((c) => GENERICS.has(c) || exists.includes(c))
      return widthOf[hit ?? ''] ?? -1
    },
  }
}

describe('单个字体名是否真的生效', () => {
  const widths = { 'Kaiti SC': 120, monospace: 80, serif: 96 }

  it('字体存在且宽度与回退字体不同 → 可用', () => {
    const probe = makeProbe(['Kaiti SC'], widths)
    expect(isFontUsable('Kaiti SC', probe)).toBe(true)
  })

  it('字体不存在（被浏览器屏蔽）→ 两次回退宽度都完全一致 → 判定不可用', () => {
    const probe = makeProbe([], widths)
    expect(isFontUsable('Kaiti SC', probe)).toBe(false)
  })

  it('两个回退字体都要比：只在 monospace 下同宽、但 serif 下不同 → 仍判定可用', () => {
    // 候选字体宽度恰好等于 monospace，但和 serif 不同 → 第一个回退会误判，第二个救回来
    const probe = makeProbe(['Weird Font'], { 'Weird Font': 80, monospace: 80, serif: 96 })
    expect(isFontUsable('Weird Font', probe)).toBe(true)
  })
})

describe('候选表里挑第一个能用的', () => {
  it('按顺序返回第一个存在的字体名', () => {
    const probe = makeProbe(['STKaiti'], { STKaiti: 111, monospace: 80, serif: 96 })
    expect(firstUsableFamily(['Kaiti SC', 'STKaiti', 'KaiTi'], probe)).toBe('STKaiti')
  })

  it('全都不存在 → null', () => {
    const probe = makeProbe([], { monospace: 80, serif: 96 })
    expect(firstUsableFamily(['Kaiti SC', 'STKaiti'], probe)).toBeNull()
  })
})

describe('整组判定（设置面板据此标灰）', () => {
  const groups = {
    songti: ['Songti SC'],
    heiti: ['PingFang SC'],
    kaiti: ['Kaiti SC'],
  }

  it('存在与否逐组如实反映', () => {
    const probe = makeProbe(['Songti SC', 'PingFang SC'], {
      'Songti SC': 100,
      'PingFang SC': 90,
      monospace: 80,
      serif: 96,
    })
    expect(detectFontAvailability(groups, probe)).toEqual({
      songti: true,
      heiti: true,
      kaiti: false,
    })
  })

  it('探测不了（没有 canvas / SSR）时一律当可用，绝不把选择全禁用', () => {
    expect(detectFontAvailability(groups, null)).toEqual({
      songti: true,
      heiti: true,
      kaiti: true,
    })
  })
})
