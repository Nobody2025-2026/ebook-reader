// EPUB 解析层：封装 @lingo-reader/epub-parser，对上层只暴露"书"的概念。
// 浏览器传 File，Node 传文件路径——同一套 API、共用全部解析逻辑（4 本真实
// EPUB 的自动验收就是靠 Node 路径跑的）。注意：Node 路径**仅测试 / 脚本**在用，
// Tauri 桌面端走的是 File —— webview 里没有 Node 运行时，将来若要支持"直接打开
// 本地书"，应当接 @tauri-apps/plugin-fs，别照着这条给它传字符串路径。
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
  /**
   * 把正文里的书内链接（脚注 / 目录锚点）解析成「章序号 + 章内锚点选择器」。
   * fromChapterIndex = 链接所在的那一章，用来解析相对路径——
   * 正文里的 href 是相对**当前章文件**的（如 part0003.xhtml 里的
   * `href="part0004.xhtml#a005"`），不是相对 OPF 的。
   * 解析不出来返回 undefined；调用方仍须阻止默认跳转，否则 hash 被改会踢回书库。
   */
  resolveHrefToChapter(
    href: string,
    fromChapterIndex?: number,
  ): { chapterIndex: number; selector?: string } | undefined
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

/* ---------- 给正文图片补 alt（无障碍） ---------- */

/** 无 g 标志，可安全用于 test()；下面每条各自单开，免得踩 RegExp.lastIndex 的坑 */
const IMG_ANY_RE = /<img\b/i
const IMG_COUNT_G = /<img\b/gi
const IMG_TAG_G = /<img\b[^>]*?>/gi
/** 判断标签里有没有 alt 属性：要求属性名前是空白，免得把 data-alt= 认成 alt= */
const ALT_ATTR_RE = /\salt\s*=/i

/** 转义将要放进 HTML 属性值的文本（书名里可能带 & 或引号） */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 给正文里的 <img> 补 alt —— 书里绝大多数图片都不写，读屏用户只能听到一句
 * 「图片」。封面尤其糟：那是读者对一本书的第一印象，却完全不可读。
 *
 * 分三档，按"我们究竟知道多少"来给：
 * 1. 书里写了 alt 的 → 原样不动（尊重作者）
 * 2. **首章**里只有这一张图、且剥掉标签后几乎没有文字 → 判定为封面页，
 *    给「《书名》封面」
 * 3. 其余没写 alt 的 → 「插图」：不假装知道画的是什么，但让读屏知道此处有图，
 *    比一声不吭地跳过有用（WCAG 要求非装饰性图片必须有替代文本）
 *
 * 第 2 条为什么必须带「首章」：中间章节里"一张大图 + 没文字"很常见，那是整页
 * 插图而不是封面。只看"单图无字"会把它误标成封面。
 *
 * 为什么用正则而不是 DOMParser：这段 html 是字符串进字符串出，走一遍 DOM 再
 * 序列化会把书里的命名空间声明、自闭合写法改得面目全非。补一个属性**不动块结构**，
 * 因此不影响高亮锚点（chapterIndex + blockIndex + 块内字符偏移）。
 * 也**不要在 render 里调用**：每次生成新字符串会冲掉 ChapterBody 的 memo，
 * 连带把画好的高亮 <mark> 一起重绘掉。这里是数据层，一章只处理一次。
 */
export function ensureImageAlt(
  html: string,
  options: { bookTitle?: string; isFirstChapter?: boolean } = {},
): string {
  if (!IMG_ANY_RE.test(html)) return html

  const imgCount = html.match(IMG_COUNT_G)?.length ?? 0
  const textOnly = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
  const isCoverPage = !!options.isFirstChapter && imgCount === 1 && textOnly.length < 20
  const fallback = isCoverPage
    ? options.bookTitle
      ? `《${options.bookTitle}》封面`
      : '封面'
    : '插图'

  let changed = false
  const out = html.replace(IMG_TAG_G, (tag) => {
    if (ALT_ATTR_RE.test(tag)) return tag
    changed = true
    return tag.replace(/^<img\b/i, `<img alt="${escapeAttr(fallback)}"`)
  })
  return changed ? out : html
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

// ============================ 书内链接解析 ============================
//
// 正文里的脚注 / 目录锚点链接是"相对当前章文件"的路径：
//   part0003.xhtml 里的 <a href="part0004.xhtml#a005">
// 而 spine 记的是"相对 OPF"的路径（Text/part0004.xhtml）。
// 解析库的 resolveHref 对正文里的这类 href 一律返回 undefined（2026-09-10 实测，
// 连它自己文档里的 `epub:` 前缀写法也不认），所以这里自己归一化匹配。
//
// 这直接决定"点脚注能不能跳到注释"：解析不出目标就跳不了；而点击又必须
// 拦掉浏览器默认行为，否则 hash 被改成 "#a005" 后 HashRouter 会把读者踢回书库。

/** 归一化 zip 内路径：统一分隔符、解析 . 与 ..、去掉首尾斜杠 */
function normalizePath(path: string): string {
  const out: string[] = []
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** 取路径的目录部分 */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

/** 章内锚点选择器：id 与 name 两种写法都试（老书常用 <a name="…"> 做跳转目标） */
function anchorSelector(frag: string): string {
  const esc = frag.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[id="${esc}"], [name="${esc}"]`
}

/** 解码 URI 片段；脏百分号转义（如孤立的 %）会抛错，退回原串 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
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

/**
 * 取一个 Node 内置模块。**故意**用变量 + `@vite-ignore` 绕开打包器的静态分析。
 *
 * 背景写清楚，免得后人好心"优化"回去：
 * - 这几条 import 只在 `typeof input === 'string'`（Node 测试 / 脚本）时执行，
 *   浏览器与 Tauri 永远传 File、根本走不到这里。
 * - 但打包器一看到字面量 `'node:fs'`，就会把它 externalize 成浏览器 stub，
 *   构建时刷 4 条 "has been externalized for browser compatibility" 警告。
 * - 原先"用动态 import 就不会打进 bundle"的意图其实是**落空的**：解析库依赖的
 *   sax.js 早已把同一个 stub 静态引了进来（构建日志里的 INEFFECTIVE_DYNAMIC_IMPORT
 *   说的就是这件事），拆都拆不出去。
 * - 换成变量之后，打包器不再处理这几条，警告消失；运行时行为**完全不变**
 *   （Node 下 import() 照常解析内置模块）。
 *
 * 附带好处：浏览器里若真走到这条分支（只可能是有人给 openEpub 传了字符串路径），
 * 会拿到一句明确报错，而不是 stub 的 undefined 崩在调用点后面。
 */
async function nodeModule<T>(name: string): Promise<T> {
  if (typeof window !== 'undefined') {
    throw new Error(
      `nodeModule("${name}") 仅在 Node 环境可用 —— 浏览器 / 桌面端请传 File，不要传文件路径`,
    )
  }
  return (await import(/* @vite-ignore */ name)) as T
}

/* 只声明真正用到的那几个 API，免得把 Node 类型引进浏览器侧代码 */
interface NodeFsPromises {
  readFile: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
}
interface NodeFsSync {
  mkdtempSync: (prefix: string) => string
  rmSync: (path: string, options?: { force?: boolean }) => void
}
interface NodeOs {
  tmpdir: () => string
}
interface NodePath {
  join: (...parts: string[]) => string
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

/** 读取输入的原始字节：浏览器 File 走 arrayBuffer，Node 路径走 fs。 */
async function readInputBytes(input: File | string): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const fs = await nodeModule<NodeFsPromises>('node:fs/promises')
    return new Uint8Array(await fs.readFile(input))
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
  const [fsSync, os, path, fs] = await Promise.all([
    nodeModule<NodeFsSync>('node:fs'),
    nodeModule<NodeOs>('node:os'),
    nodeModule<NodePath>('node:path'),
    nodeModule<NodeFsPromises>('node:fs/promises'),
  ])
  const tempPath = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), 'epub-fix-')), 'fixed.epub')
  await fs.writeFile(tempPath, bytes)
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

  // 书内链接解析表：归一化 href → 章序号。
  // 除完整路径外，还收 basename（脏书里 href 的目录前缀常和 spine 对不上）
  // 与全小写两种兜底键（大小写不一致很常见）。先到先得，冲突取第一张。
  const spineHrefs = spine.map((item) => String(item.href ?? ''))
  const hrefLookup = new Map<string, number>()
  const putLookup = (key: string, index: number) => {
    if (key && !hrefLookup.has(key)) hrefLookup.set(key, index)
  }
  spineHrefs.forEach((href, index) => {
    const norm = normalizePath(href.split(/[?#]/)[0])
    putLookup(norm, index)
    putLookup(norm.toLowerCase(), index)
    const base = norm.slice(norm.lastIndexOf('/') + 1)
    putLookup(base, index)
    putLookup(base.toLowerCase(), index)
  })

  // 字数权重：只解 zip 里的 xhtml 数字，不碰图片，比逐章 loadChapter 便宜得多
  const chapterWeights = computeChapterTextLengths(
    bytes,
    spine.map((item) => String(item.href ?? '')),
  )

  // 图片/CSS 地址自己从 zip 生成，不碰解析库那套会被 destroy 清空的全局缓存
  const resources = createResourceIndex(bytes)

  // 书名提前算出来：补图片 alt 要用。loadChapter 是同一对象字面量上的方法，
  // 回头读 this.meta 又脆又绕，不如先落到局部变量。
  const bookTitle = normalizeTitle(metadata.title)

  return {
    meta: {
      title: bookTitle,
      author: metadata.creator?.[0]?.contributor ?? '',
      language: metadata.language ?? '',
      cover: await safeCover(epub, input),
    },
    chapters,
    chapterWeights,
    toc: collectToc(epub, idToIndex),
    async loadChapter(id: string) {
      const href = hrefById.get(id) ?? ''
      // 补图片 alt 用：只有"首章 + 单图 + 无文字"才当封面（规则见 ensureImageAlt）
      const altOptions = { bookTitle, isFirstChapter: idToIndex.get(id) === 0 }
      // 优先用 zip 里的原始 html：src 还是书里的相对路径，能自己解析成可靠地址。
      // 解析库那份里的 src 已经被换成它自己的 blob URL，一旦被 destroy() revoke 就全废了。
      const raw = resources.rawChapterHtml(href)
      if (raw) {
        const inlined = resources.inlineAssets(raw.replace(XML_PROLOG_RE, ''), href)
        return { html: ensureImageAlt(inlined, altOptions), css: [] }
      }
      // zip 里定位不到（href 太脏）才退回解析库的输出，老行为兜底
      const { html, css } = await epub.loadChapter(id)
      return { html: ensureImageAlt(html, altOptions), css: css ?? [] }
    },
    resolveHref: (href: string) => epub.resolveHref(href),
    resolveHrefToChapter(href: string, fromChapterIndex?: number) {
      const raw = (href ?? '').trim()
      if (!raw) return undefined
      const hashAt = raw.indexOf('#')
      const pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw
      const fragPart = hashAt >= 0 ? raw.slice(hashAt + 1) : ''
      const selector = fragPart ? anchorSelector(safeDecode(fragPart)) : undefined

      // 纯章内锚点（href="#fn1"）：留在当前章
      if (!pathPart) {
        return fromChapterIndex === undefined
          ? undefined
          : { chapterIndex: fromChapterIndex, selector }
      }

      const decoded = safeDecode(pathPart).split('?')[0]
      const base = fromChapterIndex === undefined ? '' : dirOf(spineHrefs[fromChapterIndex] ?? '')
      const candidates = [
        normalizePath(base ? `${base}/${decoded}` : decoded),
        normalizePath(decoded),
        decoded.slice(decoded.lastIndexOf('/') + 1),
      ]
      for (const candidate of candidates) {
        const hit = hrefLookup.get(candidate) ?? hrefLookup.get(candidate.toLowerCase())
        if (hit !== undefined) return { chapterIndex: hit, selector }
      }
      return undefined
    },
    destroy() {
      epub.destroy()
      resources.revoke()
      if (tempPath) {
        // 临时文件清理失败不该冒泡到用户（文件落在系统 tmp 目录，兜底有系统回收）
        void nodeModule<NodeFsSync>('node:fs')
          .then((fs) => fs.rmSync(tempPath, { force: true }))
          .catch(() => {})
      }
    },
  }
}
