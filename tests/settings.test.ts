// 字体设置：内置字体栈解析、自定义字体前缀、loadSettings 归一化迁移。
import { describe, expect, it, vi } from 'vitest'
import { get } from 'idb-keyval'

// settings.ts 直接依赖 idb-keyval，这里整体 mock 掉，只验证归一化逻辑。
vi.mock('idb-keyval', () => ({
  get: vi.fn(),
  set: vi.fn(),
}))

import {
  CONTENT_MAX_PX,
  DEFAULT_SETTINGS,
  FONT_KEYS,
  FONT_PROBE_FAMILIES,
  FONT_STACKS,
  PAGE_MARGIN_MAX,
  customFontValue,
  fontStack,
  loadSettings,
} from '../src/lib/settings'

const mockedGet = get as ReturnType<typeof vi.fn>

describe('fontStack', () => {
  it('内置字体 key 解析成对应字体栈', () => {
    expect(fontStack('songti')).toContain('Songti SC')
    expect(fontStack('heiti')).toContain('Microsoft YaHei')
    expect(fontStack('fangsong')).toContain('FangSong')
  })

  it('字体栈里带各移动平台真实存在的中文字体名', () => {
    // 安卓默认中文字体：不写进来，探测会把"本可用"的黑体判成不可用
    expect(FONT_STACKS.heiti).toContain('Noto Sans CJK SC')
    expect(FONT_STACKS.songti).toContain('Noto Serif CJK SC')
    // 国产 ROM 的内置中文字体
    expect(FONT_STACKS.heiti).toContain('HarmonyOS Sans SC')
    expect(FONT_STACKS.heiti).toContain('MiSans')
  })

  it('system 走系统默认栈，且不写死任何平台专有字体名', () => {
    expect(fontStack('system')).toContain('system-ui')
    expect(fontStack('system')).toContain('sans-serif')
  })

  it('自定义字体 cf: 前缀直接用 family 名', () => {
    expect(fontStack('cf:MyFont-12ab')).toContain('"MyFont-12ab"')
  })

  it('未知 key 回落到系统默认（不是宋体——宋体在移动端并不存在）', () => {
    expect(fontStack('not-a-font')).toBe(FONT_STACKS.system)
  })
})

describe('customFontValue', () => {
  it('加上 cf: 前缀', () => {
    expect(customFontValue('Foo')).toBe('cf:Foo')
  })
})

describe('FONT_KEYS', () => {
  it('系统默认排第一，另有 5 种跨平台字体，且不含 Mac 独占的冬青/思源', () => {
    expect(FONT_KEYS).toEqual(['system', 'songti', 'heiti', 'kaiti', 'yuanti', 'fangsong'])
    expect(FONT_KEYS).not.toContain('hiragino')
    expect(FONT_KEYS).not.toContain('siyuanhei')
  })

  it('默认字体是系统默认——唯一在四个平台上都真实生效的选项', () => {
    expect(DEFAULT_SETTINGS.fontFamily).toBe('system')
  })

  it('system 的探测候选表为空（语义＝不依赖具名字体、永远可用）', () => {
    // 空数组别改成塞通用族：通用族一定命中，等于永远"可用"，探测就没意义了
    expect(FONT_PROBE_FAMILIES.system).toEqual([])
    for (const key of FONT_KEYS.filter((k) => k !== 'system')) {
      expect(FONT_PROBE_FAMILIES[key].length).toBeGreaterThan(0)
    }
  })

  it('每个探测候选都真的写在字体栈里，否则会探测出一个栈里根本没有的字体', () => {
    for (const key of FONT_KEYS) {
      for (const family of FONT_PROBE_FAMILIES[key]) {
        expect(FONT_STACKS[key]).toContain(family)
      }
    }
  })
})

describe('loadSettings 归一化', () => {
  it('自定义字体 cf: 原样保留', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'cf:MyFont-12ab', customFonts: [] })
    const s = await loadSettings()
    expect(s.fontFamily).toBe('cf:MyFont-12ab')
  })

  it('system 原样保留（新增的 key，别被归一化吃掉）', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'system' })
    expect((await loadSettings()).fontFamily).toBe('system')
  })

  it('老用户已存的宋体原样保留——不擅自改用户的显式选择', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'songti' })
    expect((await loadSettings()).fontFamily).toBe('songti')
  })

  it('早期 Mac 独占字体 hiragino/siyuanhei 回落 heiti', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'hiragino' })
    expect((await loadSettings()).fontFamily).toBe('heiti')
    mockedGet.mockResolvedValue({ fontFamily: 'siyuanhei' })
    expect((await loadSettings()).fontFamily).toBe('heiti')
  })

  it('老版本 serif/sans 迁移到宋体/黑体', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'serif' })
    expect((await loadSettings()).fontFamily).toBe('songti')
    mockedGet.mockResolvedValue({ fontFamily: 'sans' })
    expect((await loadSettings()).fontFamily).toBe('heiti')
  })

  it('未知 key 回落默认，且缺省 customFonts 补空数组', async () => {
    mockedGet.mockResolvedValue({ fontFamily: '???' })
    const s = await loadSettings()
    expect(s.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily)
    expect(s.customFonts).toEqual([])
  })

  it('读到的 customFonts 透传', async () => {
    const custom = [{ id: 'x', family: 'CustomFont-xxxx', filename: 'a.ttf' }]
    mockedGet.mockResolvedValue({ fontFamily: 'cf:CustomFont-xxxx', customFonts: custom })
    const s = await loadSettings()
    expect(s.customFonts).toEqual(custom)
  })
})

// pageMargin 的语义从「正文最大宽度」（480–900）改成了「左右留白」（0–120）。
// 两个值域几乎不重叠，旧值必须回默认 —— 否则 680 会被当成 680px 留白，
// 正文被挤成一条线。这也是「手机上皮边距滑块无效」那个 Bug 的收尾。
describe('loadSettings 页边距迁移', () => {
  it('旧语义的值（480–900，正文宽度）一律回落默认留白', async () => {
    for (const old of [480, 680, 900]) {
      mockedGet.mockResolvedValue({ pageMargin: old })
      expect((await loadSettings()).pageMargin).toBe(DEFAULT_SETTINGS.pageMargin)
    }
  })

  it('新语义范围内的值原样保留', async () => {
    for (const v of [0, 20, 72, PAGE_MARGIN_MAX]) {
      mockedGet.mockResolvedValue({ pageMargin: v })
      expect((await loadSettings()).pageMargin).toBe(v)
    }
  })

  it('越界/非法值收敛到合法区间', async () => {
    mockedGet.mockResolvedValue({ pageMargin: -30 })
    expect((await loadSettings()).pageMargin).toBe(0)
    mockedGet.mockResolvedValue({ pageMargin: Number.NaN })
    expect((await loadSettings()).pageMargin).toBe(DEFAULT_SETTINGS.pageMargin)
    mockedGet.mockResolvedValue({ pageMargin: '80' as unknown as number })
    expect((await loadSettings()).pageMargin).toBe(DEFAULT_SETTINGS.pageMargin)
  })

  it('旧值域与新区间没有交集（迁移判据不会误伤新值）', () => {
    // 旧值最小 480，新值最大 120：中间留了充足的隔离带
    expect(PAGE_MARGIN_MAX).toBeLessThan(480)
  })

  it('默认留白在常见屏宽下都留得下正文', () => {
    // 手机上：390 − reader-scroll 左右内边距(14×2，见 ≤720px 媒体查询) − 2×留白
    const phoneText = 390 - 14 * 2 - DEFAULT_SETTINGS.pageMargin * 2
    expect(phoneText).toBeGreaterThan(280)
    // 宽屏上：栏宽上限 − 2×留白
    const desktopText = CONTENT_MAX_PX - DEFAULT_SETTINGS.pageMargin * 2
    expect(desktopText).toBeGreaterThan(600)
  })
})
