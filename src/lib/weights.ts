// 章节字数权重：EPUB 本质是 zip，直接解开各章 xhtml 数纯文字。
//
// 为什么不用 loadChapter 来数？loadChapter 会给图片建 blob URL（Node 端落盘），
// 一本 70MB 的书全部加载又慢又占内存。我们只想要"这章有多少字"，
// 解 zip + 去标签是最便宜的做法，浏览器和 Node 通用。
//
// 为什么需要权重？转换版 EPUB（z-library 常见）会把全书塞进一个 spine 项，
// 《策略思维》spine 只有 4 项而第 2 项独占 25 万字——按"章号/总章数"算百分比，
// 目录页就敢显示 50%。按字数加权后同一位置约为 0.5%。
import { unzipSync } from 'fflate'

/** 从 container.xml 抠出 OPF 路径（EPUB 规范的固定入口） */
function findOpfPath(files: Record<string, Uint8Array>): string | undefined {
  const container = files['META-INF/container.xml']
  if (!container) return undefined
  const xml = new TextDecoder().decode(container)
  return xml.match(/full-path="([^"]+)"/)?.[1]
}

/** 规范化 zip 内路径：处理 ./ 和 ../（manifest href 是相对 OPF 目录的） */
function normalizeZipPath(path: string): string {
  const parts = path.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** 去掉 script/style/标签，数纯文字长度（空白折叠后） */
export function textLength(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '').length
}

/**
 * 在 zip 条目里找章节文件。解析器返回的 href 很"脏"，实测见过这些形态：
 * - "epub:OEBPS/text00001.html"（带前缀且已是 zip 根路径，《策略思维》）
 * - "chapter1.xhtml"（相对 OPF 目录，规范写法）
 * - 中文文件名可能是 percent-encoded
 * 所以按候选清单逐个试，找不到就放弃这章。
 */
function findEntry(
  files: Record<string, Uint8Array>,
  opfDir: string,
  href: string,
): Uint8Array | undefined {
  const clean = href.split('#')[0].replace(/^epub:/, '')
  const candidates = [
    normalizeZipPath(clean),
    normalizeZipPath(opfDir ? `${opfDir}/${clean}` : clean),
  ]
  try {
    const decoded = decodeURIComponent(clean)
    if (decoded !== clean) {
      candidates.push(
        normalizeZipPath(decoded),
        normalizeZipPath(opfDir ? `${opfDir}/${decoded}` : decoded),
      )
    }
  } catch {
    // 非法编码就跳过解码候选
  }
  for (const name of candidates) {
    if (files[name]) return files[name]
  }
  return undefined
}

/**
 * 计算每个 spine 项的纯文字长度。
 * @param bytes epub 文件的完整字节
 * @param spineHrefs 按 spine 顺序的 manifest href（形态见 findEntry 注释）
 * 找不到的条目按 0 计，绝不让一本脏书打不开。
 */
export function computeChapterTextLengths(
  bytes: Uint8Array,
  spineHrefs: string[],
): number[] {
  try {
    const files = unzipSync(bytes)
    const opfPath = findOpfPath(files)
    const opfDir = opfPath?.includes('/')
      ? opfPath.slice(0, opfPath.lastIndexOf('/'))
      : ''
    return spineHrefs.map((href) => {
      const entry = findEntry(files, opfDir, href)
      if (!entry) return 0
      return textLength(new TextDecoder().decode(entry))
    })
  } catch {
    // 解压失败就全员 0，调用方退化为"每章等权"
    return spineHrefs.map(() => 0)
  }
}
