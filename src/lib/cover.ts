// 封面是解析库给的 blob URL，书一 destroy 就失效。
// 所以导入时把它转成 data URL 存起来——代价是体积变大，
// 换来的是封面不依赖任何生命周期，书库页随时能显示。

/**
 * 封面提取算法的版本号。
 *
 * 为什么需要：封面是从脏 EPUB 里"猜"出来的，算法每次修正（比如改用 OPF 权威声明）
 * 都会让一部分书的结果变对，但旧封面已经以 data URL 存进书库了——它看起来完全
 * 合法，代码无从判断对错。所以给每份存下来的封面打上当时的版本号，
 * 算法一改就 +1，书库加载时自动给旧版本的书重取封面，用户什么都不用做。
 */
export const COVER_VERSION = 2

/** 判一个字符串是不是「可用」的封面 data URL（非空、是图片、且真有 base64 数据） */
export function isValidCoverDataUrl(s: string | undefined | null): boolean {
  if (!s || typeof s !== 'string') return false
  if (!s.startsWith('data:image/')) return false
  // 逗号后的 base64 至少要有点内容（真封面图通常 > 1KB；这里给个宽松下限挡空串）
  const body = s.split(',')[1] ?? ''
  return body.length > 200
}

export async function coverToDataUrl(url: string): Promise<string | undefined> {
  if (!url || typeof fetch === 'undefined') return undefined
  // 已经是 data URL 就原样返回：省一次 fetch，也避开部分浏览器对 fetch(data:) 的兼容坑
  if (isValidCoverDataUrl(url)) return url
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    const blob = await response.blob()
    // 空 blob（比如早期 fetch 到空资源）会读成 "data:...;base64," 这种只有前缀的废串，
    // 这里提前拦掉，免得把无效封面存进书库。
    if (blob.size === 0) return undefined
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('封面读取失败'))
      reader.readAsDataURL(blob)
    })
    return isValidCoverDataUrl(dataUrl) ? dataUrl : undefined
  } catch {
    // 封面拿不到不该影响导入，书库页会显示占位首字
    return undefined
  }
}
