/**
 * 运行时探测「系统字体到底能不能用」。
 *
 * 为什么需要：iPhone 的 Safari 出于字体指纹防护，会屏蔽一部分系统字体名
 * ——写 `font-family: "Kaiti SC"` 得到的可能还是默认黑体，用户在设置里点了半天
 * 发现"字体完全无效"，而我们无从解释。桌面 Chrome / Tauri 的 WKWebView 不受此限制。
 *
 * 探测办法（业界通用的"宽度比对法"）：
 *   同一段样本文字，分别量「候选字体 + 回退字体」与「只用回退字体」的宽度。
 *   宽度不同 → 候选字体真的被用上了；宽度完全相同 → 候选被浏览器替换掉了。
 *   为降低误判，用两个差异很大的回退字体（monospace / serif）各测一次，
 *   只有两次都"毫无差别"才判定不可用。
 *
 * 纯逻辑与浏览器 API 分离：宽度从 `FontProbe` 注入，单测里喂假数据即可。
 */

export interface FontProbe {
  /** 量样本文字在给定 CSS font 简写下渲染出来的宽度（px） */
  width(font: string): number
}

/** 样本：中西文混排。纯中文样本在 Mac/Windows 上三方回退宽度常常都一样，测不出差异 */
export const PROBE_SAMPLE = '汉字测量永國AaWwGg123@'

const FALLBACK_A = 'monospace'
const FALLBACK_B = 'serif'

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

/** 候选表里第一个真正生效的字体名；全都不行返回 null */
export function firstUsableFamily(candidates: string[], probe: FontProbe): string | null {
  for (const c of candidates) {
    if (isFontUsable(c, probe)) return c
  }
  return null
}

/**
 * 逐组判定可用性。probe 为 null（测不了）时**一律返回 true**——
 * 宁可让用户点到一个没效果的字体，也不要在测不出的环境里把选择全禁用掉。
 */
export function detectFontAvailability(
  groups: Record<string, string[]>,
  probe: FontProbe | null,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, candidates] of Object.entries(groups)) {
    out[key] = probe ? firstUsableFamily(candidates, probe) !== null : true
  }
  return out
}
