// EPUB 解析层：封装 @lingo-reader/epub-parser，对上层只暴露"书"的概念。
// 浏览器传 File，Node 传文件路径——同一套 API，为后期套 Tauri 留口。
import { initEpubFile, type EpubFile } from '@lingo-reader/epub-parser'
import { unzipSync } from 'fflate'
import { computeChapterTextLengths, findEntry, findOpfPath } from './weights'

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

/** 目录条目：label 显示名，chapterIndex 指向 spine 序号，selector 是章内锚点 */
export interface TocEntry {
  label: string
  chapterIndex: number
  /** 章内锚点（CSS 选择器，如 `[id="sigil_toc_id_1"]`），空则跳到章节开头 */
  selector?: string
  children?: TocEntry[]
}

export interface OpenedBook {
  meta: BookMeta
  chapters: ChapterRef[]
  /** 每章纯文字数，用于字数加权的阅读百分比（见 weights.ts 顶部注释） */
  chapterWeights: number[]
  /** 目录树（已把 href 解析成 chapterIndex + selector），无目录时为空数组 */
  toc: TocEntry[]
  loadChapter(id: string): Promise<ChapterContent>
  resolveHref(href: string): { id: string; selector: string } | undefined
  destroy(): void
}

/**
 * 把解析器的 TOC 树转换成「chapterIndex + selector」的扁平可跳转结构。
 * spine id → 序号的映射先建好，遍历 TOC 时反查。
 * 解析不出章节的条目（脏书常见）直接丢弃，绝不因为一条坏目录让整本书打不开。
 */
function collectToc(epub: EpubFile, idToIndex: Map<string, number>): TocEntry[] {
  const walk = (nodes: ReturnType<EpubFile['getToc']>): TocEntry[] => {
    const out: TocEntry[] = []
    for (const node of nodes) {
      const resolved = epub.resolveHref(node.href)
      const chapterIndex = resolved ? idToIndex.get(resolved.id) : undefined
      if (chapterIndex === undefined) continue
      const entry: TocEntry = {
        label: node.label,
        chapterIndex,
        selector: resolved?.selector,
      }
      if (node.children?.length) {
        const children = walk(node.children)
        if (children.length) entry.children = children
      }
      out.push(entry)
    }
    return out
  }
  return walk(epub.getToc())
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

/** 书名页体积上限：超过这个长度基本是正文，不该拿来当封面抠图 */
const COVER_PAGE_MAX_LEN = 10_000

/**
 * 封面兜底链（真实脏书实测得来，多本书各暴露一个坑）：
 *
 * 关键认知：epub-parser 的 getCoverImage() 在 guide 里找 type="cover" 的引用，
 * 但那个引用通常指向的是「封面页」(.xhtml/.html)，而不是「封面图」(.jpg/.jpeg)。
 * 所以它的返回值常常是一个 html 文件路径/blob URL，绝不能直接当图片用。
 *
 * 正确做法：始终「加载封面页 → 抠里面的 img / image 标签 src」拿到真图。
 * 借 loadChapter 的资源替换能力，抠出来的 src 就是可用地址（Node 是文件路径，浏览器是 blob URL）。
 *
 * 抠图正则要同时兼容：
 *   - <img src="...">（《涛动周期论》《策略思维》）
 *   - SVG <image xlink:href="...">（《认知世界的经济学》）
 *
 * 另一个坑（《博弈与社会》暴露的）：有些书用 OPF 的
 *   <meta name="cover" content="cover_img"/> + <item id="cover_img" href="…/x.jpeg"/>
 * 声明封面图，但那张图**不被任何页面引用**。解析库只把章节引用到的资源转成
 * blob URL，孤立资源根本没有地址可拿，于是"找封面页→抠图"这条路整个落空。
 * 这类书退而求其次：加载 spine 首个章节（书名页）抠图。
 *
 * 且慢——书名页抠图也不可靠（《博弈与社会》二次打脸）：
 * 书名页里那张图是**白底题名图**（作者名一行字），访达/系统 Quick Look 显示的
 * 真封面是 OPF meta 声明的那张。所以 OPF 显式声明必须排在书名页**之前**：
 * 声明是权威的，书名页只是碰运气。
 */
async function safeCover(epub: EpubFile, input: File | string): Promise<string | undefined> {
  try {
    const manifest = epub.getManifest()

    // ① 找封面页：优先 properties="cover-image"，其次 id/href 含 cover/titlepage 的 html
    const coverPage = Object.entries(manifest).find(([, item]) => {
      const isHtml = /(xhtml|html)/i.test(item.mediaType ?? '')
      if (!isHtml) return false
      const name = `${item.id} ${item.href ?? ''}`
      return item.properties?.includes('cover-image') || /cover|titlepage/i.test(name)
    })
    if (coverPage) {
      const url = await imageFromChapter(epub, coverPage[0], coverPage[1].href ?? '')
      if (url) return url
    }

    // ② OPF 显式声明的孤立封面图（自行解 zip 直读字节，绕过解析库的地址限制）
    const declared = await opfDeclaredCover(epub, input)
    if (declared) return declared

    // ③ 兜底：书名页。spine 首项通常是书名页/封面页，但里面的图可能是题名图而非封面
    //    （《博弈与社会》书名页就是白底"作者名"图）。加长度门槛：书名页很短，
    //    正文第一章很长，别把正文里的插图抠成封面。
    const first = epub.getSpine()[0]
    if (first) {
      const { html } = await epub.loadChapter(first.id)
      if (html.length < COVER_PAGE_MAX_LEN) return matchChapterImage(html)
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 封面图字节数上限：正常封面几十~几百 KB，超大的多半不是封面，别做天价 data URL */
const COVER_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * ② 读 OPF 声明的孤立封面图：
 * <meta name="cover" content="X"/> 指向 manifest 里 id=X 的图片 item，
 * 该图不被任何页面引用 → 解析库不给它发地址 → 只能自己解 zip 拿字节。
 * 返回 data URL（浏览器/Node 通用，且不像 blob URL 那样刷新即失效）。
 */
async function opfDeclaredCover(
  epub: EpubFile,
  input: File | string,
): Promise<string | undefined> {
  try {
    const coverId = epub.getMetadata().metas?.['cover']
    if (!coverId) return undefined
    const item = epub.getManifest()[coverId]
    if (!item) return undefined
    const mime = /^image\//i.test(item.mediaType ?? '')
      ? item.mediaType!
      : /\.(png|jpe?g|gif|webp|svg)$/i.exec(item.href ?? '')?.[1]?.replace(/^jpeg$/i, 'jpeg')
        ? `image/${(/\.([a-z0-9]+)$/i.exec(item.href ?? '')?.[1] ?? '').toLowerCase().replace('jpg', 'jpeg')}`
        : undefined
    if (!mime) return undefined

    const files = unzipSync(await readInputBytes(input))
    const opfPath = findOpfPath(files)
    const opfDir = opfPath?.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
    const entry = findEntry(files, opfDir, item.href ?? '')
    if (!entry || entry.byteLength === 0 || entry.byteLength > COVER_IMAGE_MAX_BYTES) {
      return undefined
    }

    // 分块转 binary，避免 apply 栈溢出
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < entry.length; i += CHUNK) {
      binary += String.fromCharCode(...entry.subarray(i, i + CHUNK))
    }
    return `data:${mime};base64,${btoa(binary)}`
  } catch {
    return undefined
  }
}

/** 兼容 <img src> 与 SVG <image xlink:href> 两种写法 */
function matchChapterImage(html: string): string | undefined {
  return (
    html.match(/<img[^>]+src="([^"]+)"/i)?.[1] ??
    html.match(/<image[^>]+(?:xlink:href|href)="([^"]+)"/i)?.[1]
  )
}

/**
 * 加载某个 manifest 项对应的章节并抠图。
 * 坑：manifest 里的 href 是裸路径，resolveHref 只认带 "epub:" 前缀的；
 * 两种都试，最后退回直接用 manifest 的 id（它本身就是合法的章节 id）。
 */
async function imageFromChapter(
  epub: EpubFile,
  id: string,
  href: string,
): Promise<string | undefined> {
  const resolved = epub.resolveHref(href) ?? epub.resolveHref(`epub:${href}`)
  const { html } = await epub.loadChapter(resolved?.id ?? id)
  return matchChapterImage(html)
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

/**
 * 读取输入的原始字节：浏览器 File 走 arrayBuffer，Node 路径走 fs。
 * 动态 import node:fs 是为了浏览器 bundle 不被打进 Node 内置模块。
 */
async function readInputBytes(input: File | string): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const { readFile } = await import('node:fs/promises')
    return new Uint8Array(await readFile(input))
  }
  return new Uint8Array(await input.arrayBuffer())
}

export async function openEpub(
  input: File | string,
  options: OpenEpubOptions = {},
): Promise<OpenedBook> {
  const epub = await initEpubFile(input as unknown as string, options.resourceSaveDir)
  const metadata = epub.getMetadata()
  const labels = collectTocLabels(epub)
  const spine = epub.getSpine()

  const chapters: ChapterRef[] = spine.map((item, index) => ({
    id: item.id,
    label: labels.get(item.id) ?? `第 ${index + 1} 章`,
  }))

  const idToIndex = new Map(spine.map((item, index) => [item.id, index]))

  // 字数权重：只解 zip 里的 xhtml 数字，不碰图片，比逐章 loadChapter 便宜得多
  const chapterWeights = computeChapterTextLengths(
    await readInputBytes(input),
    spine.map((item) => item.href),
  )

  return {
    meta: {
      title: normalizeTitle(metadata.title),
      author: metadata.creator?.[0]?.contributor ?? '',
      language: metadata.language ?? '',
      cover: await safeCover(epub, input),
    },
    chapters,
    chapterWeights,
    toc: collectToc(epub, idToIndex),
    async loadChapter(id: string) {
      const { html, css } = await epub.loadChapter(id)
      return { html, css: css ?? [] }
    },
    resolveHref: (href: string) => epub.resolveHref(href),
    destroy: () => epub.destroy(),
  }
}
