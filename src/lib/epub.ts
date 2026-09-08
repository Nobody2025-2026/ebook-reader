// EPUB 解析层：封装 @lingo-reader/epub-parser，对上层只暴露"书"的概念。
// 浏览器传 File，Node 传文件路径——同一套 API，为后期套 Tauri 留口。
import { initEpubFile, type EpubFile } from '@lingo-reader/epub-parser'

export interface BookMeta {
  title: string
  author: string
  language: string
  cover?: string
}

export interface ChapterRef {
  id: string
  label: string
}

export interface ChapterContent {
  html: string
  css: { id: string; href: string }[]
}

export interface OpenedBook {
  meta: BookMeta
  chapters: ChapterRef[]
  loadChapter(id: string): Promise<ChapterContent>
  resolveHref(href: string): { id: string; selector: string } | undefined
  destroy(): void
}

/** 目录可能有层级，摊平后按 href 反查章节 id，用来给 spine 补标题 */
function collectTocLabels(epub: EpubFile): Map<string, string> {
  const labels = new Map<string, string>()
  const walk = (nodes: ReturnType<EpubFile['getToc']>) => {
    for (const node of nodes) {
      const resolved = epub.resolveHref(node.href)
      if (resolved && !labels.has(resolved.id)) {
        labels.set(resolved.id, node.label)
      }
      if (node.children?.length) walk(node.children)
    }
  }
  walk(epub.getToc())
  return labels
}

/**
 * 封面兜底链（真实脏书实测得来）：
 * 1. getCoverImage() —— 很多书这里直接返回空串，哪怕 manifest 里明明有 cover.jpg
 * 2. 找封面页 xhtml，loadChapter 后抠第一个 <img src>
 *    —— 借 loadChapter 的资源替换能力拿到可用地址（Node 是文件路径，浏览器是 blob URL）
 */
async function safeCover(epub: EpubFile): Promise<string | undefined> {
  try {
    const cover = epub.getCoverImage()
    if (cover) return cover
  } catch {
    // 脏 EPUB 常见：manifest 指向不存在的资源，不能因此打不开书
  }

  try {
    const manifest = epub.getManifest()
    const coverPage = Object.values(manifest).find(
      (item) =>
        item.mediaType.includes('xhtml') &&
        (item.properties?.includes('cover-image') || /cover/i.test(item.id)),
    )
    if (!coverPage) return undefined
    // 坑：manifest 里的 href 是裸路径，resolveHref 只认带 "epub:" 前缀的；
    // 两样都试，最后退回直接用 manifest id（它本身就是合法的章节 id）
    const resolved =
      epub.resolveHref(coverPage.href) ?? epub.resolveHref(`epub:${coverPage.href}`)
    const { html } = await epub.loadChapter(resolved?.id ?? coverPage.id)
    return html.match(/<img[^>]+src="([^"]+)"/i)?.[1]
  } catch {
    return undefined
  }
}

/**
 * 标题清洗：z-library 之类来源常把文件名当标题塞进 metadata，
 * 例如 "140857_人生财富靠康波_周金涛"。
 */
export function normalizeTitle(raw: string | undefined): string {
  const title = (raw ?? '').trim()
  if (!title) return '未命名'
  const dePrefixed = title.replace(/^\d{3,}[-_\s]+/, '')
  // 下划线当分隔符：只在整串没有空格时动手，避免误伤正常含下划线的标题
  return dePrefixed.includes(' ') ? dePrefixed : dePrefixed.replace(/_/g, ' ').trim() || '未命名'
}

export interface OpenEpubOptions {
  /**
   * 仅 Node 端生效：解析时图片/CSS 的落盘目录，默认当前目录下的 ./images。
   * 浏览器端走 blob URL，不落盘，此参数被忽略。
   * 注意：destroy() 会逐个 unlink 这些文件——放在受管控目录下会慢到几十秒，
   * 所以 Node 端（测试、脚本）请显式指向临时目录。
   */
  resourceSaveDir?: string
}

export async function openEpub(
  input: File | string,
  options: OpenEpubOptions = {},
): Promise<OpenedBook> {
  const epub = await initEpubFile(input as unknown as string, options.resourceSaveDir)
  const metadata = epub.getMetadata()
  const labels = collectTocLabels(epub)

  const chapters: ChapterRef[] = epub.getSpine().map((item, index) => ({
    id: item.id,
    label: labels.get(item.id) ?? `第 ${index + 1} 章`,
  }))

  return {
    meta: {
      title: normalizeTitle(metadata.title),
      author: metadata.creator?.[0]?.contributor ?? '',
      language: metadata.language ?? '',
      cover: await safeCover(epub),
    },
    chapters,
    async loadChapter(id: string) {
      const { html, css } = await epub.loadChapter(id)
      return { html, css: css ?? [] }
    },
    resolveHref: (href: string) => epub.resolveHref(href),
    destroy: () => epub.destroy(),
  }
}
