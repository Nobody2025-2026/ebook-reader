import { describe, expect, it } from 'vitest'
import {
  detectFontAvailability,
  firstUsableFamily,
  isFontUsable,
  isProbeReliable,
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

  it('候选表为空 = 不依赖具名字体 → 永远可用（「系统默认」就走这条）', () => {
    const probe = makeProbe([], { monospace: 80, serif: 96 })
    expect(detectFontAvailability({ system: [] }, probe)).toEqual({ system: true })
  })
})

describe('探针自检（防"所有字体全被标灰"）', () => {
  it('正常探针：不存在的字体判不可用 + 通用族之间有宽度差 → 可信', () => {
    const probe = makeProbe(['Songti SC'], { 'Songti SC': 100, monospace: 80, serif: 96 })
    expect(isProbeReliable(probe)).toBe(true)
  })

  it('canvas 度量被浏览器抹平（所有宽度相同）→ 探针不可信', () => {
    // 某些国产浏览器 / 隐私模式会归一化字体度量。此时所有候选都会"与回退同宽"，
    // 于是每个字体都被判成不可用——用户在安卓夸克上就看到"5 个全灰"。
    const flat: FontProbe = { width: () => 100 }
    expect(isProbeReliable(flat)).toBe(false)
  })

  it('探针把不存在的字体也量出差异（失真）→ 不可信', () => {
    // 每个 font 串都返回唯一宽度：连 "__no_such_font__" 都和回退不同 → 方向一不成立
    const noisy: FontProbe = { width: (font) => font.length }
    expect(isProbeReliable(noisy)).toBe(false)
  })

  it('探针不可信时全部当可用，而不是全部标灰', () => {
    const flat: FontProbe = { width: () => 100 }
    expect(detectFontAvailability({ songti: ['Songti SC'], kaiti: ['Kaiti SC'] }, flat)).toEqual({
      songti: true,
      kaiti: true,
    })
  })
})

describe('安卓场景回归（2026-09-12 实测反馈）', () => {
  // 安卓没有 Songti SC / Kaiti SC 这些桌面字体，但**有** Noto Sans CJK SC
  // （系统默认中文字体）。候选表里写了它，黑体就该判为可用——否则用户看到
  // 5 个字体全灰，以为功能坏了。
  const android = makeProbe(['Noto Sans CJK SC'], {
    'Noto Sans CJK SC': 92,
    monospace: 80,
    serif: 96,
  })

  it('黑体（命中 Noto Sans CJK SC）判可用', () => {
    expect(
      detectFontAvailability({ heiti: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'] }, android),
    ).toEqual({ heiti: true })
  })

  it('宋体/楷体（安卓确实没有）判不可用——这是如实反映，不是 bug', () => {
    expect(
      detectFontAvailability({ songti: ['Songti SC', 'SimSun'], kaiti: ['Kaiti SC'] }, android),
    ).toEqual({ songti: false, kaiti: false })
  })

  it('系统默认始终可用，用户永远有一个能选的中文字体', () => {
    expect(detectFontAvailability({ system: [] }, android)).toEqual({ system: true })
  })
})
