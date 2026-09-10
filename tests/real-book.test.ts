// @vitest-environment node
// 真实脏样本验收：把《涛动周期论》（70MB，z-library 来源，OCR 图多）当标杆。
// 书不放进仓库（见 .gitignore 的 books/），缺书时这些用例自动跳过——
// 但它必须在本机跑过，否则等于没验收。
import { readFileSync } from 'node:fs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeTitle, openEpub, type OpenedBook } from '../src/lib/epub'
import { computeWeightedPercent, detectContentRange } from '../src/lib/progress'
import { prepareChapterHtml } from '../src/lib/sanitize'
import { findOpfPath, resolveZipPath } from '../src/lib/weights'

/** 直接从 epub（本质是 zip）里按路径后缀读出某个条目的字节，用来校验封面取对了没 */
function readZipEntry(epubPath: string, suffix: string): Uint8Array | undefined {
  const files = unzipSync(new Uint8Array(readFileSync(epubPath)))
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith(suffix)) return bytes
  }
  return undefined
}

/** 把封面 data URL 还原成字节，好跟 zip 里的原图逐字节比对 */
function coverBytes(cover: string | undefined): Uint8Array | undefined {
  const base64 = cover?.split(',')[1]
  if (!base64) return undefined
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
}

const realBook = resolve(process.cwd(), 'books/涛动周期论.epub')
const hasRealBook = existsSync(realBook)

describe('normalizeTitle', () => {
  it('剥掉 z-library 的数字前缀并把下划线还原成空格', () => {
    expect(normalizeTitle('140857_人生财富靠康波_周金涛')).toBe('人生财富靠康波 周金涛')
  })

  it('不动本来就是正常标题的书名', () => {
    expect(normalizeTitle('涛动周期论')).toBe('涛动周期论')
    expect(normalizeTitle('Clean Code')).toBe('Clean Code')
  })

  it('空标题兜底为未命名', () => {
    expect(normalizeTitle('')).toBe('未命名')
    expect(normalizeTitle(undefined)).toBe('未命名')
  })
})

describe.skipIf(!hasRealBook)('真实样本《涛动周期论》', () => {
  // 70MB 的书打开一次要 8 秒上下，整组共用一次，别每个用例重开
  let book: OpenedBook
  // 资源落盘必须指到系统临时目录：项目目录下删文件单个要 60ms，
  // 解析这本书会落盘几百个文件，destroy() 会卡 20 秒以上（实测）。
  const saveDir = mkdtempSync(join(tmpdir(), 'reader-test-'))

  beforeAll(async () => {
    book = await openEpub(realBook, { resourceSaveDir: saveDir })
  }, 120_000)

  afterAll(() => {
    book?.destroy()
    rmSync(saveDir, { recursive: true, force: true })
  })

  it('元数据可用，且标题被清洗过', () => {
    expect(book.meta.title).toBe('人生财富靠康波 周金涛')
    expect(book.meta.author).toBe('周金涛')
  })

  it('目录标题能从 TOC 补全，而不是退化成"第 N 章"', () => {
    const labels = book.chapters.map((c) => c.label)
    expect(labels.length).toBeGreaterThan(20)
    expect(labels).toContain('版权信息')
    // 退化成占位标题的比例必须很低，否则目录功能等于废了
    const placeholder = labels.filter((l) => /^第 \d+ 章$/.test(l))
    expect(placeholder.length).toBeLessThan(labels.length * 0.2)
  })

  it('封面与 OPF 声明的那张图字节一致（访达/Quick Look 同款规则）', () => {
    // 这本书 OPF 里 <meta name="cover" content="cover.jpg"> + properties="cover-image"。
    // 最强断言：解出的封面必须和 zip 里 images/cover.jpg 一模一样，
    // 防止再出现"抠到题名图/占位图还自我感觉良好"的情况。
    const declared = readZipEntry(realBook, 'images/cover.jpg')
    expect(declared).toBeTruthy()
    expect(coverBytes(book.meta.cover)).toEqual(declared)
  })

  it('正文清洗后不残留内联字号/字体（否则读者调字号、切字体都会被压过）', async () => {
    const target = book.chapters.find((c) => c.id === 'Chapter4_1') ?? book.chapters[1]
    const { html } = await book.loadChapter(target.id)
    // 清洗前确实焊着内联排版样式——这正是字号调不动的根因
    expect(html).toMatch(/font-size/)
    // 清洗后必须干净，字号与字体交回给阅读器
    const prepared = prepareChapterHtml(html)
    expect(prepared).not.toMatch(/font-size/)
    expect(prepared).not.toMatch(/font-family/)
  })

  it('含图章节的图片全部换成可加载地址，且内容与 zip 原图逐字节一致', async () => {
    // 这一条守的是"正文图片一张都显示不出来"那个 P0：
    // 解析库给的 blob URL 会被 destroy() 全局 revoke，真浏览器里全是 0 字节空图。
    // 所以我们自己从 zip 解字节（Node 端退化成 data URL，可以逐字节校验）。
    const target = book.chapters.find((c) => c.id === 'Chapter4_1') ?? book.chapters[1]
    const { html } = await book.loadChapter(target.id)
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1])
    expect(srcs.length).toBeGreaterThan(0)

    // 一张都不许留相对路径（那样必然 404），也不许是解析库的 blob
    for (const src of srcs) expect(src).toMatch(/^data:image\//)

    // 逐字节比对：拿原章节 html 里的第一张图，确认输出里存在与之完全相同的字节
    const files = unzipSync(new Uint8Array(readFileSync(realBook)))
    const opfPath = findOpfPath(files)
    expect(opfPath).toBeTruthy()
    const chapterName = Object.keys(files).find((n) => /Chapter4_1/.test(n))
    expect(chapterName).toBeTruthy()
    const rawHtml = new TextDecoder().decode(files[chapterName!])
    const firstSrc = rawHtml.match(/<img[^>]+src="([^"]+)"/i)?.[1]
    expect(firstSrc).toBeTruthy()
    const originPath = resolveZipPath(files, chapterName!.slice(0, chapterName!.lastIndexOf('/')), firstSrc!)
    expect(originPath).toBeTruthy()
    const originBytes = files[originPath!]
    expect(originBytes.byteLength).toBeGreaterThan(1000)

    const decoded = srcs
      .map((s) => s.split(',')[1])
      .filter((b64): b64 is string => !!b64)
      .map((b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))
    expect(decoded.some((bytes) => bytes.length === originBytes.length &&
      bytes.every((b, i) => b === originBytes[i]))).toBe(true)
  })
})

// 第二本真实样本：Kindle 风格转换产物。页面全叫 part0000.xhtml，一个 cover 字样都没有；
// 封面改由 OPF <meta name="cover"> 声明，且那张图不被任何页面引用 ——
// 正是它暴露了「只找 cover 命名的封面页」这条兜底链的盲区。
const metaCoverBook = resolve(process.cwd(), 'books/博弈与社会.epub')
const hasMetaCoverBook = existsSync(metaCoverBook)

describe.skipIf(!hasMetaCoverBook)('真实样本《博弈与社会》（封面走 OPF meta 声明）', () => {
  let book: OpenedBook
  const saveDir = mkdtempSync(join(tmpdir(), 'reader-test-'))

  beforeAll(async () => {
    book = await openEpub(metaCoverBook, { resourceSaveDir: saveDir })
  }, 120_000)

  afterAll(() => {
    book?.destroy()
    rmSync(saveDir, { recursive: true, force: true })
  })

  it('封面与 OPF 声明的孤立图字节一致，不是书名页那张题名图', () => {
    // 真封面 image00509.jpeg 全书只有 OPF 声明引用它，任何页面都不用这张图；
    // 书名页 part0000.xhtml 用的是 image00346.jpeg（白底题名图，曾经被误当封面）
    const declared = readZipEntry(metaCoverBook, 'Images/image00509.jpeg')
    expect(declared).toBeTruthy()
    expect(coverBytes(book.meta.cover)).toEqual(declared)
  })

  it('标题是正常书名，不是文件名', () => {
    expect(book.meta.title).toBeTruthy()
    expect(book.meta.title).not.toMatch(/\.epub$/i)
  })
})

// 第三、四本真实样本：转换版 EPUB 的"轻量边缘章"陷阱（z-library 常见）。
// 两本书都把**全书正文塞进单个 spine 项**，另外挂一个只有千把字的目录页。
// 2026-09-10 的 Bug 就出在这里：进度被存到那个目录页上 → 下次打开
// "只有目录页、翻不动"。修复靠 detectContentRange 把这页划出正文区间。
const artOfFocus = resolve(process.cwd(), 'books/The Art of Focus.epub')
const hasArtOfFocus = existsSync(artOfFocus)

describe.skipIf(!hasArtOfFocus)('真实样本《The Art of Focus》（末尾挂 nav 目录页）', () => {
  let book: OpenedBook
  const saveDir = mkdtempSync(join(tmpdir(), 'reader-test-'))

  beforeAll(async () => {
    book = await openEpub(artOfFocus, { resourceSaveDir: saveDir })
  }, 60_000)

  afterAll(() => {
    book?.destroy()
    rmSync(saveDir, { recursive: true, force: true })
  })

  it('结构就是"封面 + 全书正文 + nav"，正文区间必须排除末尾 nav', () => {
    // spine：[cover.xhtml, Section0001.xhtml(全书正文), nav.xhtml(目录)]
    expect(book.chapters.length).toBe(3)
    expect(book.chapterWeights[1]).toBeGreaterThan(100_000)
    expect(book.chapterWeights[2]).toBeLessThan(5_000)
    expect(detectContentRange(book.chapterWeights)).toEqual({ first: 1, last: 1 })
  })

  it('站在末尾 nav 上算 100%；恢复位置会被夹回正文章（1），不会停在 nav（2）', () => {
    const range = detectContentRange(book.chapterWeights)
    expect(computeWeightedPercent(2, 0, book.chapterWeights, range)).toBe(100)
    expect(Math.min(Math.max(2, range.first), range.last)).toBe(1)
  })
})

const strategyThinking = resolve(process.cwd(), 'books/策略思维.epub')
const hasStrategyThinking = existsSync(strategyThinking)

describe.skipIf(!hasStrategyThinking)('真实样本《策略思维》（开头挂轻量目录页）', () => {
  let book: OpenedBook
  const saveDir = mkdtempSync(join(tmpdir(), 'reader-test-'))

  beforeAll(async () => {
    book = await openEpub(strategyThinking, { resourceSaveDir: saveDir })
  }, 60_000)

  afterAll(() => {
    book?.destroy()
    rmSync(saveDir, { recursive: true, force: true })
  })

  it('正文区间跳过开头的封面与目录页（Contents），落在真正的正文上', () => {
    // spine：[cover, Contents(目录), 全书正文, 部分页]；目录页只有 1300 字上下
    expect(book.chapters.length).toBe(4)
    expect(book.chapterWeights[1]).toBeLessThan(10_000)
    expect(book.chapterWeights[2]).toBeGreaterThan(100_000)
    expect(detectContentRange(book.chapterWeights)).toEqual({ first: 2, last: 3 })
  })

  it('目录页（index 1）算 0%，不再是"开篇就 0.5%"；正文开头为 0%', () => {
    const range = detectContentRange(book.chapterWeights)
    expect(computeWeightedPercent(1, 1, book.chapterWeights, range)).toBe(0)
    expect(computeWeightedPercent(2, 0, book.chapterWeights, range)).toBe(0)
  })
})
