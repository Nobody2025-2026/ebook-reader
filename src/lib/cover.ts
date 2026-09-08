// 封面是解析库给的 blob URL，书一 destroy 就失效。
// 所以导入时把它转成 data URL 存起来——代价是体积变大，
// 换来的是封面不依赖任何生命周期，书库页随时能显示。
export async function coverToDataUrl(url: string): Promise<string | undefined> {
  if (!url || typeof fetch === 'undefined') return undefined
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('封面读取失败'))
      reader.readAsDataURL(blob)
    })
  } catch {
    // 封面拿不到不该影响导入，书库页会显示占位首字
    return undefined
  }
}
