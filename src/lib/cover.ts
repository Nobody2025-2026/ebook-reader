// 封面是解析库给的 blob URL，书一 destroy 就失效。
// 所以导入时把它转成 data URL 存起来——代价是体积变大，
// 换来的是封面不依赖任何生命周期，书库页随时能显示。

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
