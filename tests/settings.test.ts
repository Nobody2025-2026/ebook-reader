// 字体设置：内置字体栈解析、自定义字体前缀、loadSettings 归一化迁移。
import { describe, expect, it, vi } from 'vitest'
import { get } from 'idb-keyval'

// settings.ts 直接依赖 idb-keyval，这里整体 mock 掉，只验证归一化逻辑。
vi.mock('idb-keyval', () => ({
  get: vi.fn(),
  set: vi.fn(),
}))

import {
  DEFAULT_SETTINGS,
  FONT_KEYS,
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

  it('自定义字体 cf: 前缀直接用 family 名', () => {
    expect(fontStack('cf:MyFont-12ab')).toBe('"MyFont-12ab", sans-serif')
  })

  it('未知 key 回落到宋体', () => {
    expect(fontStack('not-a-font')).toContain('Songti SC')
  })
})

describe('customFontValue', () => {
  it('加上 cf: 前缀', () => {
    expect(customFontValue('Foo')).toBe('cf:Foo')
  })
})

describe('FONT_KEYS', () => {
  it('是 5 种跨平台字体，且不含 Mac 独占的冬青/思源', () => {
    expect(FONT_KEYS).toEqual(['songti', 'heiti', 'kaiti', 'yuanti', 'fangsong'])
    expect(FONT_KEYS).not.toContain('hiragino')
    expect(FONT_KEYS).not.toContain('siyuanhei')
  })
})

describe('loadSettings 归一化', () => {
  it('自定义字体 cf: 原样保留', async () => {
    mockedGet.mockResolvedValue({ fontFamily: 'cf:MyFont-12ab', customFonts: [] })
    const s = await loadSettings()
    expect(s.fontFamily).toBe('cf:MyFont-12ab')
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
