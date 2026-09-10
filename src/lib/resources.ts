// 正文资源（图片 / CSS）的地址由我们**自己从 zip 字节生成**。
//
// 为什么不能直接用解析库给的地址？@lingo-reader/epub-parser 0.4.6 用
// **模块级全局**的 imageRecord 暂存图片字节、browserUrlCache 缓存 blob URL，
// 而 destroy() 会 unlink 全部条目 + revoke 全部 blob —— 清的是全局，不是自己那份。
// 本项目 openEpub 会被多次调用（导入 / 进阅读页 / 后台补封面），任何一次 destroy
// 都会把全局状态清空，已经渲染好的 <img src="blob:…"> 当场变成 0 字节空 blob。
// 真浏览器实测：《涛动周期论》46 张图全部 naturalWidth=0，fetch 回来 byteLength=0。
// Node 端走文件落盘、不碰 blob，所以纯 Node 测试永远测不出这个问题。
//
// 自己解 zip 的好处：
//   1. 地址生命周期归我们管，只有这本书 destroy 时才 revoke，跨实例互不干扰；
//   2. 与封面那条路同源（见 epub.ts 的 opfDeclaredCover），行为一致；
//   3. Node 端退化成 data URL，自动化测试能真正校验"图是不是解出来了"。
import { unzipSync } from 'fflate'
import { findOpfPath, resolveZipPath } from './weights'

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
}

/** 单张资源上限：再大就不内联了，别把内存撑爆（脏书里混着几百 MB 的图片不是没见过） */
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024
/** CSS 里 url() 引用的小图单独设限：它只能转成 base64 塞进文本，太贵 */
const MAX_CSS_URL_BYTES = 2 * 1024 * 1024

export function mimeFromExt(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? ''
}

/**
 * 扩展名不可信时按魔数兜底。脏书的 manifest mediaType 和扩展名都可能写错
 * （实测过标成 image/jpeg 实际是 png 的），光看扩展名会让浏览器拒绝渲染。
 */
export function sniffMime(bytes: Uint8Array, fallback = ''): string {
  // 注意：不要用 TextDecoder('latin1') 读魔数——latin1 在 WHATWG 里是 windows-1252 的别名，
  // 0x80–0x9F 段和 ISO-8859-1 不一样（0x89 会被解成 ‰），PNG 头就认不出来了。直接比字节。
  const has = (sig: number[], offset = 0): boolean =>
    sig.every((b, i) => bytes[offset + i] === b)
  if (has([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (has([0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  if (has([0x38, 0x42, 0x50, 0x53])) return 'image/vnd.adobe.photoshop'
  // SVG 是文本，UTF-8 解出来看开头（非 ASCII 字节会变成替换字符，不影响 ASCII 判定）
  const head = new TextDecoder().decode(bytes.subarray(0, 200))
  if (/^\s*<\?xml|^\s*<svg/i.test(head)) return 'image/svg+xml'
  return fallback
}

/** 分块转 base64：一次性 String.fromCharCode(...大数组) 会爆栈 */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * 纯类型窄化：TS 5.7 起 Uint8Array 默认带 ArrayBufferLike 泛型，而 BlobPart
 * 只收 ArrayBuffer（SharedArrayBuffer 不算）。运行时就是原对象，零成本。
 */
export function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

/** 已经是绝对地址/内嵌数据的，不要动 */
const ABSOLUTE_RE = /^\s*(?:data|blob|https?|file|about|javascript):/i

export interface ResourceIndex {
  /**
   * 把章节 html 里的图片与外链 CSS 就地换成我们控制的地址。
   * 换不掉的（zip 里找不着、本来就是绝对地址）原样保留。
   */
  inlineAssets(html: string, chapterHref: string): string
  /** 读 zip 里某章的原始 html（没经过解析库，src 还是书里的相对路径） */
  rawChapterHtml(chapterHref: string): string | undefined
  /** 释放全部 blob URL；只影响这一本书，不碰别的实例 */
  revoke(): void
}

/** zip 解压失败时的空实现：书照样能读，只是没图 */
const NOOP_INDEX: ResourceIndex = {
  inlineAssets: (html) => html,
  rawChapterHtml: () => undefined,
  revoke: () => {},
}

export function createResourceIndex(bytes: Uint8Array): ResourceIndex {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    return NOOP_INDEX
  }
  const opfPath = findOpfPath(files)
  const opfDir = opfPath?.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''

  // zipPath → 已生成的地址。同一张图在一章里被引用多次时不必重复转 base64
  const cache = new Map<string, string>()
  const created: string[] = []
  // 浏览器用 blob（比 base64 省 1/3 内存，且能交给浏览器统一回收）；
  // Node（含跑测试时）虽然有 createObjectURL，但没有 window，退化成 data URL ——
  // 这样自动化测试才能把图片字节解出来逐字节校验。
  const canBlob =
    typeof window !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'

  function dirname(path: string): string {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  }

  /** 字节 → 地址。浏览器用 blob（省 1/3 的 base64 开销），Node/jsdom 退化成 data URL */
  function urlFor(zipPath: string, bytesOf: Uint8Array, mime: string): string | undefined {
    const cached = cache.get(zipPath)
    if (cached) return cached
    if (bytesOf.byteLength === 0 || bytesOf.byteLength > MAX_RESOURCE_BYTES) return undefined
    let url: string
    if (canBlob) {
      url = URL.createObjectURL(new Blob([blobPart(bytesOf)], { type: mime }))
      created.push(url)
    } else {
      url = toDataUrl(bytesOf, mime)
    }
    cache.set(zipPath, url)
    return url
  }

  function imageUrl(zipPath: string): string | undefined {
    const entry = files[zipPath]
    if (!entry) return undefined
    return urlFor(zipPath, entry, mimeFromExt(zipPath) || sniffMime(entry, 'image/jpeg'))
  }

  /** 章内相对路径 → zip 条目名 */
  function resolveFrom(chapterHref: string, src: string): string | undefined {
    const raw = src.trim()
    if (!raw || ABSOLUTE_RE.test(raw)) return undefined
    const chapterPath = resolveZipPath(files, opfDir, chapterHref)
    const baseDir = chapterPath ? dirname(chapterPath) : opfDir
    return resolveZipPath(files, baseDir, raw)
  }

  /**
   * 外链 CSS：读出文本，把里面的 url(...) 也换成 data URL，
   * 再整份变成地址。不做的话 CSS 里的相对 url() 会以 blob/data 为基准解析，必然 404。
   */
  function cssUrl(chapterHref: string, href: string): string | undefined {
    const zipPath = resolveFrom(chapterHref, href)
    if (!zipPath) return undefined
    const entry = files[zipPath]
    if (!entry) return undefined
    const cssDir = dirname(zipPath)
    const text = new TextDecoder().decode(entry).replace(
      /url\(\s*['"]?([^)'"]+)['"]?\s*\)/gi,
      (match, ref: string) => {
        if (ABSOLUTE_RE.test(ref)) return match
        const refPath = resolveZipPath(files, cssDir, ref)
        if (!refPath) return match
        const refBytes = files[refPath]
        if (!refBytes || refBytes.byteLength > MAX_CSS_URL_BYTES) return match
        const mime = mimeFromExt(refPath) || sniffMime(refBytes)
        if (!mime) return match
        return `url("${toDataUrl(refBytes, mime)}")`
      },
    )
    const cssBytes = new TextEncoder().encode(text)
    return urlFor(zipPath, cssBytes, 'text/css')
  }

  function inlineAssets(html: string, chapterHref: string): string {
    // ① <img src="…">
    let out = html.replace(/<img\b[^>]*>/gi, (tag) =>
      tag.replace(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i, (match, _q, dq: string, sq: string) => {
        const zipPath = resolveFrom(chapterHref, dq ?? sq ?? '')
        const url = zipPath ? imageUrl(zipPath) : undefined
        return url ? ` src="${url}"` : match
      }),
    )
    // ② SVG 的 <image xlink:href="…"> / <image href="…">（部分书整章插图都是 SVG 包着的）
    out = out.replace(/<image\b[^>]*>/gi, (tag) =>
      tag.replace(
        /\s(?:xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/i,
        (match, _q, dq: string, sq: string) => {
          const zipPath = resolveFrom(chapterHref, dq ?? sq ?? '')
          const url = zipPath ? imageUrl(zipPath) : undefined
          return url ? ` xlink:href="${url}"` : match
        },
      ),
    )
    // ③ 外链 CSS：<link rel="stylesheet" href="…">
    out = out.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
      return tag.replace(
        /\shref\s*=\s*("([^"]*)"|'([^']*)')/i,
        (match, _q, dq: string, sq: string) => {
          const url = cssUrl(chapterHref, dq ?? sq ?? '')
          return url ? ` href="${url}"` : match
        },
      )
    })
    return out
  }

  function rawChapterHtml(chapterHref: string): string | undefined {
    if (!chapterHref) return undefined
    const zipPath = resolveZipPath(files, opfDir, chapterHref)
    if (!zipPath) return undefined
    const entry = files[zipPath]
    if (!entry) return undefined
    return new TextDecoder().decode(entry)
  }

  return {
    inlineAssets,
    rawChapterHtml,
    revoke() {
      if (!canBlob) return
      created.forEach((url) => URL.revokeObjectURL(url))
      created.length = 0
      cache.clear()
    },
  }
}
