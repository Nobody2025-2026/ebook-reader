// 排版设置：全局共用（所有书共享一套偏好），存 IndexedDB。
// 设计原则：
// 1. 字号/行距/页边距是 CSS 变量的数值，主题是配色 class，字体是 font-family。
// 2. 设置是"外观"，不影响进度锚点（进度锚点是"第几章第几段"，与字号无关），
//    所以改排版不会丢阅读位置。
// 3. 只存用户改过的值，缺省走 DEFAULT，保证老数据兼容。

export type Theme = 'day' | 'sepia' | 'night'

export interface ReaderSettings {
  fontSize: number // px
  lineHeight: number // 无单位倍数
  pageMargin: number // 正文最大宽度，px
  fontFamily: 'serif' | 'sans'
  theme: Theme
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  pageMargin: 680,
  fontFamily: 'serif',
  theme: 'day',
}

// 各字体对应的 font-family 栈
export const FONT_STACKS: Record<ReaderSettings['fontFamily'], string> = {
  serif:
    'Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", STSong, "SimSun", serif',
  sans: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
}

const KEY_SETTINGS = 'settings:reader'

export async function loadSettings(): Promise<ReaderSettings> {
  const { get } = await import('idb-keyval')
  const stored = await get<Partial<ReaderSettings>>(KEY_SETTINGS)
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const { set } = await import('idb-keyval')
  await set(KEY_SETTINGS, settings)
}
