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
  MARGIN_CAP_VW,
  PAGE_MARGIN_MAX,
  PAGE_MARGIN_STEP,
  THEME_CHOICES,
  THEME_LABELS,
  contentWidthFactor,
  customFontValue,
  effectivePageMargin,
  fontStack,
  loadSettings,
  pageMarginCapPx,
  resolveTheme,
  systemPrefersDark,
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

// 栏宽系数：把 max-width 从"写死 760px"变成"随留白放宽"，留白 0 = 正文铺满。
// 起因：默认留白下 1512 视口实测正文盒恒为 760px，两侧各空 206px，
// 把留白拖到 0 那 206px 一分不少 —— 用户报"页边距设 0 两边还空那么多"。
describe('contentWidthFactor（栏宽系数）', () => {
  it('留白 0 → 0（取消栏宽上限，正文铺满）', () => {
    expect(contentWidthFactor(0)).toBe(0)
  })

  it('默认留白 → 1（标准栏宽 760px，观感与旧版一致）', () => {
    expect(contentWidthFactor(DEFAULT_SETTINGS.pageMargin)).toBe(1)
  })

  it('0 与默认值之间线性插值', () => {
    const mid = DEFAULT_SETTINGS.pageMargin / 2
    expect(contentWidthFactor(mid)).toBeCloseTo(0.5, 6)
    expect(contentWidthFactor(mid / 2)).toBeCloseTo(0.25, 6)
  })

  it('大于默认留白一律 1（这一段是纯加留白，不再动栏宽）', () => {
    for (const v of [DEFAULT_SETTINGS.pageMargin + 1, 60, PAGE_MARGIN_MAX]) {
      expect(contentWidthFactor(v)).toBe(1)
    }
  })

  it('非法值走 normalizePageMargin：负数→0，NaN/非数字→默认', () => {
    expect(contentWidthFactor(-30)).toBe(0)
    expect(contentWidthFactor(Number.NaN)).toBe(1)
    expect(contentWidthFactor('80' as unknown as number)).toBe(1)
  })

  it('单调不增：留白越大，系数只会更小或不变（不会出现「越拖越宽」）', () => {
    let prev = contentWidthFactor(0)
    expect(prev).toBe(0)
    for (let m = 2; m <= PAGE_MARGIN_MAX; m += 2) {
      const t = contentWidthFactor(m)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    expect(prev).toBe(1)
  })
})

// 留白的「屏宽封顶」：留白是绝对 px（0–120），在 320px 屏上占 37.5%、1440px 上只占
// 8.3% —— 同一个值语义失衡。真机实测 320px 屏留白 120 → 正文只剩 52px（一行 2 字）。
// 封顶比例 12% 的妙处：1440px 下 12vw = 172px > 上限 120，桌面行为一点不变。
describe('pageMarginCapPx（留白按屏宽封顶）', () => {
  it('宽屏不封顶：12% 已超过 PAGE_MARGIN_MAX，回落到上限', () => {
    // 1440 × 12% = 172.8 > 120
    expect(pageMarginCapPx(1440)).toBe(PAGE_MARGIN_MAX)
    expect(pageMarginCapPx(2560)).toBe(PAGE_MARGIN_MAX)
    expect(pageMarginCapPx(1024)).toBe(PAGE_MARGIN_MAX) // 122.88 → 120
  })

  it('窄屏按 12% 收，且对齐到滑块步长（不会算出网格外的 max）', () => {
    // 390 × 12% = 46.8 → 向下取到 4 的倍数 = 44
    const cap390 = pageMarginCapPx(390)
    expect(cap390).toBe(44)
    expect(cap390 % PAGE_MARGIN_STEP).toBe(0)
    // 320 × 12% = 38.4 → 36
    expect(pageMarginCapPx(320)).toBe(36)
    expect(pageMarginCapPx(320) % PAGE_MARGIN_STEP).toBe(0)
  })

  it('封顶后再窄也留得下正文：每档每侧留白 ≤ 屏宽 12%', () => {
    for (const w of [280, 320, 360, 390, 430, 768, 844]) {
      const cap = pageMarginCapPx(w)
      expect(cap).toBeLessThanOrEqual((w * MARGIN_CAP_VW) / 100)
      // 正文盒 = 屏宽 − reader-scroll 内边距(14×2) − 两侧留白 ≥ 180px（一行 10 汉字）
      expect(w - 28 - cap * 2).toBeGreaterThanOrEqual(180)
    }
  })

  it('视口宽非法时不限制（宁可少限制，也别算出 0 变成死滑块）', () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pageMarginCapPx(bad)).toBe(PAGE_MARGIN_MAX)
    }
  })
})

describe('effectivePageMargin（实际生效留白）', () => {
  it('设置值低于封顶 → 原样', () => {
    expect(effectivePageMargin(0, 390)).toBe(0)
    expect(effectivePageMargin(20, 390)).toBe(20)
    expect(effectivePageMargin(44, 390)).toBe(44)
  })

  it('设置值高于封顶 → 夹到封顶（手机上拖到 120 也只生效 44）', () => {
    expect(effectivePageMargin(120, 390)).toBe(44)
    expect(effectivePageMargin(PAGE_MARGIN_MAX, 320)).toBe(36)
  })

  it('宽屏下与设置值一致（封顶不起作用，桌面观感不变）', () => {
    expect(effectivePageMargin(120, 1440)).toBe(120)
    expect(effectivePageMargin(80, 1512)).toBe(80)
  })

  it('非法设置值先走 normalize，再封顶', () => {
    expect(effectivePageMargin(Number.NaN, 390)).toBe(DEFAULT_SETTINGS.pageMargin)
    expect(effectivePageMargin(-30, 390)).toBe(0)
  })

  it('单调：视口越宽，生效留白只会更大或不变', () => {
    let prev = effectivePageMargin(120, 200)
    for (const w of [240, 280, 320, 390, 480, 768, 1024, 1440]) {
      const cur = effectivePageMargin(120, w)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
    expect(prev).toBe(120)
  })
})

// 主题跟随系统（P2-5）：默认「跟随系统」，系统深色时进阅读页就该是夜间；
// 用户手点过某个具体主题之后就锁定，不再被系统日夜切换带走。
describe('resolveTheme（auto 解析）', () => {
  it("'auto' 跟随系统偏好：深色 → 夜间，浅色 → 日间", () => {
    expect(resolveTheme('auto', true)).toBe('night')
    expect(resolveTheme('auto', false)).toBe('day')
  })

  it('具体主题原样返回，不受系统偏好影响', () => {
    expect(resolveTheme('night', false)).toBe('night')
    expect(resolveTheme('sepia', true)).toBe('sepia')
    expect(resolveTheme('day', true)).toBe('day')
  })

  it('解析结果里绝不会再出现 auto（否则会挂上 CSS 里不存在的 theme-auto）', () => {
    for (const t of THEME_CHOICES) {
      expect(resolveTheme(t, true)).not.toBe('auto')
      expect(resolveTheme(t, false)).not.toBe('auto')
    }
  })
})

describe('THEME_CHOICES / THEME_LABELS', () => {
  it('「跟随系统」排第一，且每个可选值都有中文标签', () => {
    expect(THEME_CHOICES[0]).toBe('auto')
    expect(THEME_CHOICES).toEqual(['auto', 'day', 'sepia', 'night'])
    for (const t of THEME_CHOICES) {
      expect(THEME_LABELS[t]).toBeTruthy()
    }
  })

  it('默认主题是跟随系统，且默认没被锁定', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('auto')
    expect(DEFAULT_SETTINGS.themeLocked).toBe(false)
  })
})

describe('systemPrefersDark', () => {
  it('拿不到 matchMedia（jsdom / 老浏览器）时当作浅色，不瞎猜深色', () => {
    expect(typeof window.matchMedia).not.toBe('function')
    expect(systemPrefersDark()).toBe(false)
  })

  it('有 matchMedia 时读它的 matches', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const stub = (dark: boolean) =>
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => ({ matches: dark }),
      })
    try {
      stub(true)
      expect(systemPrefersDark()).toBe(true)
      stub(false)
      expect(systemPrefersDark()).toBe(false)
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })
})

describe('loadSettings 主题迁移', () => {
  it('从没存过设置 → 跟随系统 + 未锁定', async () => {
    mockedGet.mockResolvedValue(undefined)
    const s = await loadSettings()
    expect(s.theme).toBe('auto')
    expect(s.themeLocked).toBe(false)
  })

  it('老数据只有 theme、没有 themeLocked → 按「手动选过」处理，保住老用户的夜间', async () => {
    mockedGet.mockResolvedValue({ theme: 'night' })
    const s = await loadSettings()
    expect(s.theme).toBe('night')
    expect(s.themeLocked).toBe(true)
  })

  it('显式存了 themeLocked 就听它的（用户主动切回跟随系统）', async () => {
    mockedGet.mockResolvedValue({ theme: 'auto', themeLocked: false })
    const s = await loadSettings()
    expect(s.theme).toBe('auto')
    expect(s.themeLocked).toBe(false)
  })

  it('非法主题值回落「跟随系统」，不把界面挂成没有配色的状态', async () => {
    mockedGet.mockResolvedValue({ theme: 'midnight' })
    expect((await loadSettings()).theme).toBe('auto')
  })
})
