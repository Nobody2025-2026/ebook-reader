// 排版设置：全局共用（所有书共享一套偏好），存 IndexedDB。
// 设计原则：
// 1. 字号/行距/页边距是 CSS 变量的数值，主题是配色 class，字体是 font-family。
// 2. 设置是"外观"，不影响进度锚点（进度锚点是"第几章第几段"，与字号无关），
//    所以改排版不会丢阅读位置。
// 3. 只存用户改过的值，缺省走 DEFAULT，保证老数据兼容。
import { get, set } from 'idb-keyval'

export type Theme = 'day' | 'sepia' | 'night'

// 字体：用直观中文名，内部是语义 key。老版本存的是 'serif'/'sans'，
// 加载时做一次迁移（见 loadSettings 里的 normalize）。
// 'system' 是"不指定字体、交给各平台自己的默认中文字体"，**任何平台都真实可用**，
// 所以它是默认值——其余 5 种依赖系统预装，在 iOS/Android 上大多不存在。
export type FontKey =
  | 'system'
  | 'songti'
  | 'heiti'
  | 'kaiti'
  | 'yuanti'
  | 'fangsong'

// 用户上传的自定义字体：走 FontFace API 注册，不依赖系统预装，
// 跨平台一致（也绕开 Safari 的字体指纹收敛）。二进制存在独立 IDB key 下，
// 这里只存元数据。family 是该字体在 CSS 里的 font-family 名（唯一）。
export interface CustomFont {
  id: string
  family: string
  filename: string // 原始文件名，面板展示用
}

export interface ReaderSettings {
  fontSize: number // px
  lineHeight: number // 无单位倍数
  pageMargin: number // 正文左右留白，px（越大正文越窄）
  fontFamily: string // 内置字体 key，或 'cf:<family>'（自定义字体）
  theme: Theme
  customFonts: CustomFont[] // 用户上传的字体元数据（二进制存在独立 IDB key）
}

// 页边距的取值上限。语义见下：这是"留白"，不是"宽度"。
export const PAGE_MARGIN_MAX = 120
// 正文栏的最大宽度（CSS 里的 --reader-content-max 与之保持一致）。
// 页边距在它之内继续收窄：文字宽 = min(可用宽, CONTENT_MAX) - 2 × pageMargin。
export const CONTENT_MAX_PX = 760

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  // 默认 20px 留白：宽屏下正文 720px（与旧版默认的 680px 视觉接近），
  // 手机上 390−40（reader-scroll 内边距）−40 = 310px，一行约 17 个汉字。
  pageMargin: 20,
  // 默认「系统默认」而不是宋体：宋体只在 macOS / Windows 上存在，
  // 移动端（iOS / Android）压根没有这个字体文件，新用户一进设置就看到"不可用"。
  // 系统默认在四个平台上都是真实生效的，是唯一对所有设备都成立的默认值。
  fontFamily: 'system',
  theme: 'day',
  customFonts: [],
}

// 各字体对应的 font-family 栈（按优先级回退）。
// ⚠️ 除桌面字体名外，**必须写进各移动平台真实存在的字体名**，否则探测会把
// "本可用"的字体判成不可用。移动端常见的内置中文字体：
//   - Android / 原生：Noto Sans CJK SC（默认中文字体，无衬线）、Noto Serif CJK SC
//   - 华为 HarmonyOS / EMUI：HarmonyOS Sans SC
//   - 小米 MIUI / HyperOS：MiSans
//   - 跨平台开源：Source Han Sans/Serif SC（思源）
// 字体栈里西文/数字前置，中文落在对应字重（见 index.css 的 font-feature-settings）。
// 'system' 一项故意留空候选——列表为空即"不指定"，交给通用族（见 fontAvailability）。
export const FONT_STACKS: Record<FontKey, string> = {
  system:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  songti:
    '"Songti SC", "STSong", "SimSun", "宋体-简", "Noto Serif CJK SC", "Source Han Serif SC", serif',
  heiti:
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "HarmonyOS Sans SC", "MiSans", sans-serif',
  kaiti: '"Kaiti SC", "STKaiti", "楷体-简", "KaiTi", "LXGW WenKai", serif',
  yuanti: '"Yuanti SC", "圆体-简", "STYuanti", "YouYuan", sans-serif',
  fangsong: '"STFangsong", "华文仿宋", "FangSong", "仿宋", serif',
}

// 显示名（面板按钮用）
export const FONT_LABELS: Record<FontKey, string> = {
  system: '系统默认',
  songti: '宋体',
  heiti: '黑体',
  kaiti: '楷体',
  yuanti: '圆体',
  fangsong: '仿宋',
}

// 内置字体按面板顺序渲染。「系统默认」排第一，因为它是唯一到处都能用的
export const FONT_KEYS: FontKey[] = ['system', 'songti', 'heiti', 'kaiti', 'yuanti', 'fangsong']

// 运行时探测用的候选字体名（与 FONT_STACKS 里的具名候选一一对应，**不含** serif/sans-serif
// 这类通用族——通用族一定会命中，拿它探测等于永远"可用"）。
// 用途：设置面板据此把点了没反应的字体标灰。
// 'system' 故意留空数组：它不依赖任何具名字体，空候选表在 detectFontAvailability 里
// 语义为"永远可用"（用空数组表达，别在这里塞通用族）。
export const FONT_PROBE_FAMILIES: Record<FontKey, string[]> = {
  system: [],
  songti: ['Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'],
  heiti: [
    'PingFang SC',
    'Hiragino Sans GB',
    'Microsoft YaHei',
    'Noto Sans CJK SC',
    'Source Han Sans SC',
    'HarmonyOS Sans SC',
    'MiSans',
  ],
  kaiti: ['Kaiti SC', 'STKaiti', 'KaiTi', 'LXGW WenKai'],
  yuanti: ['Yuanti SC', 'STYuanti', 'YouYuan'],
  fangsong: ['STFangsong', 'FangSong'],
}

// 把存储的 fontFamily 值解析成 CSS font-family 栈：
// 内置字体查表；自定义字体 'cf:<family>' 直接用该 family 名（FontFace 已注册）。
export function fontStack(fontFamily: string): string {
  if (fontFamily.startsWith('cf:')) {
    const family = fontFamily.slice(3)
    return `"${family}", ${FONT_STACKS.system}`
  }
  return FONT_STACKS[fontFamily as FontKey] ?? FONT_STACKS.system
}

// 自定义字体的 settings.fontFamily 值前缀（family 是 FontFace 注册名）
export function customFontValue(family: string): string {
  return `cf:${family}`
}

const KEY_SETTINGS = 'settings:reader'

// 老版本存 'serif'/'sans'，这里迁移到新 key（宋体/黑体）。
// 早期 7 字体版本的 hiragino/siyuanhei 是 Mac 独占，统一回落到 heiti。
// 自定义字体 'cf:<family>' 原样保留。
function normalizeFont(v: unknown): string {
  if (v === 'serif') return 'songti'
  if (v === 'sans') return 'heiti'
  if (v === 'hiragino' || v === 'siyuanhei') return 'heiti'
  if (typeof v === 'string') {
    if ((FONT_KEYS as string[]).includes(v)) return v
    if (v.startsWith('cf:')) return v
  }
  return DEFAULT_SETTINGS.fontFamily
}

// ⚠️ pageMargin 的语义变过一次，这里必须迁移：
// 旧版把它当「正文最大宽度」（取值 480–900，越大越宽），
// 而它挂在 .chapter 的 max-width 上 —— 手机视口才 390px，
// 最小值 480 就已经超出屏宽，滑块拖到底正文宽度纹丝不动（用户报「页边距无效」）。
// 现在改成「左右留白」（0–120，越大越窄），两个值域几乎不重叠，
// 旧值一律回落默认，否则 680 会被当成 680px 留白，正文被挤成一条线。
// 新增取值只需略增；仍以「超过上限就回默认」为唯一判据，不引入魔法常量。
function normalizePageMargin(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.pageMargin
  if (v > PAGE_MARGIN_MAX) return DEFAULT_SETTINGS.pageMargin
  return Math.min(Math.max(0, Math.round(v)), PAGE_MARGIN_MAX)
}

export async function loadSettings(): Promise<ReaderSettings> {
  const stored = await get<Partial<ReaderSettings>>(KEY_SETTINGS)
  const merged: ReaderSettings = {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    customFonts: stored?.customFonts ?? [],
  }
  merged.fontFamily = normalizeFont(stored?.fontFamily)
  merged.pageMargin = normalizePageMargin(stored?.pageMargin)
  return merged
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  await set(KEY_SETTINGS, settings)
}
