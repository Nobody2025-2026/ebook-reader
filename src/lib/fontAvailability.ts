/**
 * 运行时探测「系统字体到底能不能用」。
 *
 * 为什么需要：各平台预装的中文字体差别极大——iOS/Android 都没有「宋体/楷体/仿宋」
 * 这套桌面字体，写 `font-family: "Kaiti SC"` 会被浏览器静默换成默认字体；部分
 * 移动端浏览器（iOS Safari 的字体指纹防护、安卓各家 ROM 的字体裁剪、某些国产
 * 浏览器的 canvas 度量归一化）还会让度量结果失真。用户在设置里点了半天发现
 * "字体完全无效"，而我们无从解释。桌面 Chrome / Tauri 的 WKWebView 不受此限制。
 *
 * 探测办法（业界通用的"宽度比对法"）：
 *   同一段样本文字，分别量「候选字体 + 回退字体」与「只用回退字体」的宽度。
 *   宽度不同 → 候选字体真的被用上了；宽度完全相同 → 候选被浏览器替换掉了。
 *   为降低误判，用两个差异很大的回退字体（monospace / serif）各测一次，
 *   只有两次都"毫无差别"才判定不可用。
 *
 * ⚠️ 探测本身也会失效，所以 `detectFontAvailability` 会先跑一次**自检**
 * （`isProbeReliable`）。校验两个方向：
 *   - 不存在的字体名必须判为"不可用"（否则探测把假的当真的，会误标可用）；
 *   - 三个通用族之间必须能量出宽度差（否则 canvas 度量被浏览器抹平了，
 *     会把真的当假的——表现就是"所有字体全部标灰"，用户以为功能坏了）。
 *   任一方向不成立就认为探针不可信，此时**一律当可用**：宁可让用户点到一个
 *   没效果的字体，也不要在一个测不准的环境里把整个字体功能显示成坏的。
 *
 * 纯逻辑与浏览器 API 分离：宽度从 `FontProbe` 注入，单测里喂假数据即可。
 */

export interface FontProbe {
  /** 量样本文字在给定 CSS font 简写下渲染出来的宽度（px） */
  width(font: string): number
}

/** 样本：中西文混排。纯中文样本在部分系统上三方回退宽度完全相同，测不出差异 */
export const PROBE_SAMPLE = '汉字测量永國AaWwGg123@'

const FALLBACK_A = 'monospace'
const FALLBACK_B = 'serif'

/** 自检用的通用族。它们在任何浏览器里都存在，且彼此的西文宽度必然不同 */
const GENERICS_FOR_SELFCHECK = ['monospace', 'serif', 'sans-serif'] as const

/** 几乎不可能存在的字体名：若它被判为"可用"，说明探针在量宽度时是失真的 */
const ABSENT_FONT_FOR_SELFCHECK = '__no_such_font_9f3c__'

/** 宽度差小于这个值就当"没差别"（亚像素渲染会有浮点噪声） */
const EPSILON = 0.01

/** 用 canvas 量宽度。拿不到 canvas（SSR / jsdom）时返回 null，调用方按"不知道"处理 */
export function canvasProbe(sample = PROBE_SAMPLE): FontProbe | null {
  if (typeof document === 'undefined') return null
  const ctx = document.createElement('canvas').getContext?.('2d')
  if (!ctx) return null
  return {
    width(font: string) {
      ctx.font = font
      return ctx.measureText(sample).width
    },
  }
}

/** 单个字体名是否真的生效 */
export function isFontUsable(family: string, probe: FontProbe, size = 16): boolean {
  const baseA = probe.width(`${size}px ${FALLBACK_A}`)
  if (Math.abs(probe.width(`${size}px "${family}", ${FALLBACK_A}`) - baseA) > EPSILON) return true
  const baseB = probe.width(`${size}px ${FALLBACK_B}`)
  return Math.abs(probe.width(`${size}px "${family}", ${FALLBACK_B}`) - baseB) > EPSILON
}

/**
 * 探针本身可不可信。两个方向都要过，任一条不成立就返回 false。
 * 详见文件头注释——这条是防"所有字体全被标灰"的关键闸门。
 */
export function isProbeReliable(probe: FontProbe, size = 16): boolean {
  // 方向一：不存在的字体名必须量出"与回退字体同宽"，否则探针在把假的当真的
  if (isFontUsable(ABSENT_FONT_FOR_SELFCHECK, probe, size)) return false
  // 方向二：通用族之间必须能量出差异，否则度量被抹平了（真的也会被当假的）
  const widths = GENERICS_FOR_SELFCHECK.map((g) => ({
    g,
    w: probe.width(`${size}px ${g}`),
  }))
  const distinct = widths.some((a, i) =>
    widths.some((b, j) => j > i && Math.abs(a.w - b.w) > EPSILON),
  )
  return distinct
}

/** 候选表里第一个真正生效的字体名；全都不行返回 null */
export function firstUsableFamily(candidates: string[], probe: FontProbe): string | null {
  for (const c of candidates) {
    if (isFontUsable(c, probe)) return c
  }
  return null
}

/**
 * 逐组判定可用性。
 *
 * 判定为「可用」的三种情形：
 *  1. 候选表里至少有一个字体名真的生效；
 *  2. **候选表是空的** —— 这种字体（如「系统默认」）本来就不依赖任何具名字体，
 *     全靠通用族兜底，永远可用；
 *  3. **探针不可用或不可信**（没有 canvas / SSR / 被浏览器抹平）—— 一律当可用。
 */
export function detectFontAvailability(
  groups: Record<string, string[]>,
  probe: FontProbe | null,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const trustworthy = probe !== null && isProbeReliable(probe)
  for (const [key, candidates] of Object.entries(groups)) {
    if (!trustworthy) out[key] = true
    else if (candidates.length === 0) out[key] = true
    else out[key] = firstUsableFamily(candidates, probe) !== null
  }
  return out
}
