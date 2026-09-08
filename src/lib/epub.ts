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

function safeCover(epub: EpubFile): string | undefined {
  try {
    const cover = epub.getCoverImage()
    return cover ? cover : undefined
  } catch {
    // 脏 EPUB 常见：没有 cover 或 manifest 里指向不存在的资源，不能因此打不开书
    return undefined
  }
}

export async function openEpub(input: File | string): Promise<OpenedBook> {
  const epub = await initEpubFile(input as unknown as string)
  const metadata = epub.getMetadata()
  const labels = collectTocLabels(epub)

  const chapters: ChapterRef[] = epub.getSpine().map((item, index) => ({
    id: item.id,
    label: labels.get(item.id) ?? `第 ${index + 1} 章`,
  }))

  return {
    meta: {
      title: metadata.title || '未命名',
      author: metadata.creator?.[0]?.contributor ?? '',
      language: metadata.language ?? '',
      cover: safeCover(epub),
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
