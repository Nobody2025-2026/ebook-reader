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
export type FontKey =
  | 'songti'
  | 'heiti'
  | 'kaiti'
  | 'yuanti'
  | 'fangsong'
  | 'siyuanhei'
  | 'hiragino'

export interface ReaderSettings {
  fontSize: number // px
  lineHeight: number // 无单位倍数
  pageMargin: number // 正文最大宽度，px
  fontFamily: FontKey
  theme: Theme
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  pageMargin: 680,
  fontFamily: 'songti',
  theme: 'day',
}

// 各字体对应的 font-family 栈（Mac 上真实可用的字体族，按优先级回退）。
// 中文优先落在对应字重，西文/数字交给前面的西文字体（衬线用 Georgia，
// 等宽数字用 system 的 tabular 特性，见 index.css 的 font-feature-settings）。
export const FONT_STACKS: Record<FontKey, string> = {
  songti: '"Songti SC", "STSong", "SimSun", "宋体-简", serif',
  heiti: '"PingFang SC", "Hiragino Sans GB", "冬青黑体简体中文", "Microsoft YaHei", sans-serif',
  kaiti: '"Kaiti SC", "STKaiti", "楷体-简", "华文楷体", "KaiTi", serif',
  yuanti: '"Yuanti SC", "圆体-简", "STYuanti", "YouYuan", sans-serif',
  fangsong: '"STFangsong", "华文仿宋", "FangSong", "仿宋", serif',
  siyuanhei: '"Source Han Sans CN", "思源黑体 CN", "PingFang SC", sans-serif',
  hiragino: '"Hiragino Sans GB", "冬青黑体简体中文", "PingFang SC", sans-serif',
}

// 显示名（面板按钮用）
export const FONT_LABELS: Record<FontKey, string> = {
  songti: '宋体',
  heiti: '黑体',
  kaiti: '楷体',
  yuanti: '圆体',
  fangsong: '仿宋',
  siyuanhei: '思源黑体',
  hiragino: '冬青黑体',
}

const KEY_SETTINGS = 'settings:reader'

// 老版本存 'serif'/'sans'，这里迁移到新 key（宋体/黑体）
function normalizeFont(v: unknown): FontKey {
  if (v === 'serif') return 'songti'
  if (v === 'sans') return 'heiti'
  const valid: FontKey[] = [
    'songti',
    'heiti',
    'kaiti',
    'yuanti',
    'fangsong',
    'siyuanhei',
    'hiragino',
  ]
  if (valid.includes(v as FontKey)) return v as FontKey
  return DEFAULT_SETTINGS.fontFamily
}

export async function loadSettings(): Promise<ReaderSettings> {
  const stored = await get<Partial<ReaderSettings>>(KEY_SETTINGS)
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
  merged.fontFamily = normalizeFont(stored?.fontFamily)
  return merged
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  await set(KEY_SETTINGS, settings)
}
