// EPUB 解析层：封装 @lingo-reader/epub-parser，对上层只暴露"书"的概念。
// 浏览器传 File，Node 传文件路径——同一套 API，为后期套 Tauri 留口。
import { initEpubFile, type EpubFile } from '@lingo-reader/epub-parser'
import { unzipSync, zipSync } from 'fflate'
import { createResourceIndex } from './resources'
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
 * 书名页抠图也不可靠（《博弈与社会》二次打脸）：书名页里那张图是白底题名图
 * （一行作者名），访达/Quick Look 显示的真封面是 OPF 声明的那张。
 *
 * ================================ 最终顺序 ================================
 * 不再"每本书各补一条规则"，而是跟访达/Quick Look 一样**认 OPF 的权威声明**，
 * 一把梭覆盖所有书（实測两本真书都吃这套）：
 *
 *   ① OPF 声明的封面图（meta name="cover" / properties="cover-image"）→ 直读 zip 字节
 *      这是规范里唯一"官方指定"的封面，访达就是这么取的，优先级最高。
 *   ② 封面页抠图：id/href 含 cover/titlepage 的 html 页里抠 img（脏书的常见写法）
 *   ③ 书名页抠图：spine 首项，最后保底（可能抠到题名图，聊胜于无）
 * =========================================================================
 */
async function safeCover(epub: EpubFile, input: File | string): Promise<string | undefined> {
  try {
    // ① OPF 权威声明的封面图（访达/Quick Look 同款）
    const declared = await opfDeclaredCover(epub, input)
    if (declared) return declared

    const manifest = epub.getManifest()

    // ② 封面页抠图
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

    // ③ 兜底：书名页。加长度门槛：书名页很短，正文第一章很长，
    //    别把正文里的插图抠成封面。
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
 * ① 读 OPF 声明的封面图（访达/Quick Look 同款规则）：
 * 这张图常常**不被任何页面引用**，解析库便不给它发地址，只能自己解 zip 拿字节。
 * 返回 data URL（浏览器/Node 通用，且不像 blob URL 那样刷新即失效）。
 */
async function opfDeclaredCover(
  epub: EpubFile,
  input: File | string,
): Promise<string | undefined> {
  return coverFromOpfBytes(epub, await readInputBytes(input))
}

/**
 * 按字节取 OPF 声明的封面图（拆出来是为了能脱离文件环境单测）。
 * 候选按权威性排序：meta name="cover" 指定的 item → properties 含 cover-image
 * → id/href 含 cover 的图片 item。
 */
export function coverFromOpfBytes(
  epub: EpubFile,
  bytes: Uint8Array,
): string | undefined {
  try {
    const manifest = epub.getManifest()
    const isImage = (item?: ManifestItemLike): boolean =>
      !!item && /^image\//i.test(item.mediaType ?? '')

    // ① <meta name="cover" content="X"> 指向的 item（最权威）
    const coverId = epub.getMetadata().metas?.['cover']
    const byMeta = coverId ? (manifest[coverId] as ManifestItemLike | undefined) : undefined
    // ② properties="cover-image" 的图片 item（EPUB 3 规范写法）
    const byProperties = Object.values(manifest).find(
      (item) => isImage(item) && item.properties?.includes('cover-image'),
    )
    // ③ id/href 带 cover 的图片 item（有些转换工具只靠命名）
    const byName = Object.values(manifest).find(
      (item) => isImage(item) && /cover/i.test(`${item.id} ${item.href ?? ''}`),
    )

    const item = [byMeta, byProperties, byName].find(isImage)
    if (!item) return undefined

    const EXT_MIME: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    }
    const ext = (/\.([a-z0-9]+)$/i.exec(item.href ?? '')?.[1] ?? '').toLowerCase()
    const mime = /^image\//i.test(item.mediaType ?? '') ? item.mediaType! : EXT_MIME[ext]
    if (!mime) return undefined

    const files = unzipSync(bytes)
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

/** ManifestItem 的最小可用形状（只为类型约束，不依赖解析库的具体实现） */
interface ManifestItemLike {
  id: string
  href?: string
  mediaType?: string
  properties?: string
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

// ============================ OPF 预处理（让脏书能打开） ============================
//
// 解析库 0.4.6 的 parseGuide() 见到 <guide> 里没有 <reference> 子元素会**直接抛错**，
// 于是一本书整本打不开。但空的 <guide></guide> 是**完全合法的 EPUB 2 结构**
// （calibre 早期版本的转换产物里很常见）——样本：《巴菲特致股东的信（原书第4版）》。
// 库把"可选结构缺失"当成了致命错误，我们只能自己先把 OPF 修干净再交给它。
const EMPTY_GUIDE_RE = /<guide\b[^>]*>\s*<\/guide\s*>/i
const SELF_CLOSING_GUIDE_RE = /<guide\b[^>]*\/>/i

/**
 * 把会让解析库炸掉的 OPF 结构修掉，重新打包成新的 epub 字节。
 * @returns 修复后的字节；无需修复或修复失败时返回 undefined（调用方用原文件）
 */
export function fixEpubBytes(bytes: Uint8Array): Uint8Array | undefined {
  try {
    const files = unzipSync(bytes)
    const opfPath = findOpfPath(files)
    const opfEntry = opfPath ? files[opfPath] : undefined
    if (!opfPath || !opfEntry) return undefined

    const opf = new TextDecoder().decode(opfEntry)
    if (!EMPTY_GUIDE_RE.test(opf) && !SELF_CLOSING_GUIDE_RE.test(opf)) return undefined

    const fixed = opf.replace(EMPTY_GUIDE_RE, '').replace(SELF_CLOSING_GUIDE_RE, '')
    if (fixed === opf) return undefined

    files[opfPath] = new TextEncoder().encode(fixed)
    // level 0 = 只打包不压缩：70MB 的书重压一遍要几十秒，没意义
    return zipSync(files, { level: 0 })
  } catch {
    return undefined
  }
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

/**
 * 把修复后的字节变回解析库能吃的输入形态：
 * 浏览器重建 File；Node 只能吃路径，落到临时目录再传给库（destroy 时删掉）。
 */
async function materialize(
  bytes: Uint8Array,
  input: File | string,
): Promise<{ input: File | string; tempPath?: string }> {
  if (typeof input !== 'string') {
    return { input: new File([bytes as unknown as BlobPart], input.name, { type: input.type }) }
  }
  const [{ mkdtempSync }, { tmpdir }, { join }, { writeFile }] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('node:fs/promises'),
  ])
  const tempPath = join(mkdtempSync(join(tmpdir(), 'epub-fix-')), 'fixed.epub')
  await writeFile(tempPath, bytes)
  return { input: tempPath, tempPath }
}

/** XHTML 文件头的 XML 声明 / DOCTYPE：直接塞进 innerHTML 会被当成文本显示出来 */
const XML_PROLOG_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?/i

export async function openEpub(
  input: File | string,
  options: OpenEpubOptions = {},
): Promise<OpenedBook> {
  // 整个打开过程只读一次原始字节：权重、封面、资源解析都要用
  const bytes = await readInputBytes(input)

  // 先把会炸的 OPF 结构修掉（绝大多数书这里返回 undefined，零开销）
  const fixed = fixEpubBytes(bytes)
  const materialized = fixed ? await materialize(fixed, input) : { input }
  const tempPath = materialized.tempPath

  const epub = await initEpubFile(
    materialized.input as unknown as string,
    options.resourceSaveDir,
  )
  const metadata = epub.getMetadata()
  const labels = collectTocLabels(epub)
  const spine = epub.getSpine()

  const chapters: ChapterRef[] = spine.map((item, index) => ({
    id: item.id,
    label: labels.get(item.id) ?? `第 ${index + 1} 章`,
  }))

  const idToIndex = new Map(spine.map((item, index) => [item.id, index]))
  const hrefById = new Map(spine.map((item) => [item.id, String(item.href ?? '')]))

  // 字数权重：只解 zip 里的 xhtml 数字，不碰图片，比逐章 loadChapter 便宜得多
  const chapterWeights = computeChapterTextLengths(
    bytes,
    spine.map((item) => String(item.href ?? '')),
  )

  // 图片/CSS 地址自己从 zip 生成，不碰解析库那套会被 destroy 清空的全局缓存
  const resources = createResourceIndex(bytes)

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
      const href = hrefById.get(id) ?? ''
      // 优先用 zip 里的原始 html：src 还是书里的相对路径，能自己解析成可靠地址。
      // 解析库那份里的 src 已经被换成它自己的 blob URL，一旦被 destroy() revoke 就全废了。
      const raw = resources.rawChapterHtml(href)
      if (raw) {
        return { html: resources.inlineAssets(raw.replace(XML_PROLOG_RE, ''), href), css: [] }
      }
      // zip 里定位不到（href 太脏）才退回解析库的输出，老行为兜底
      const { html, css } = await epub.loadChapter(id)
      return { html, css: css ?? [] }
    },
    resolveHref: (href: string) => epub.resolveHref(href),
    destroy() {
      epub.destroy()
      resources.revoke()
      if (tempPath) {
        void import('node:fs').then((fs) => fs.rmSync(tempPath, { force: true }))
      }
    },
  }
}
