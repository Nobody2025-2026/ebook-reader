// @vitest-environment node
// 真实脏样本验收：把《涛动周期论》（70MB，z-library 来源，OCR 图多）当标杆。
// 书不放进仓库（见 .gitignore 的 books/），缺书时这些用例自动跳过——
// 但它必须在本机跑过，否则等于没验收。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeTitle, openEpub, type OpenedBook } from '../src/lib/epub'
import { prepareChapterHtml } from '../src/lib/sanitize'

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

  it('封面兜底能拿到地址（getCoverImage 在这本书上返回空串）', () => {
    expect(book.meta.cover).toBeTruthy()
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

  it('含图章节的图片 src 被换成可加载地址，而不是原始相对路径', async () => {
    const target = book.chapters.find((c) => c.id === 'Chapter4_1') ?? book.chapters[1]
    const { html } = await book.loadChapter(target.id)
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1])
    expect(srcs.length).toBeGreaterThan(0)
    // 原始 EPUB 里是相对路径（如 EPUB/images/xxx.jpg），库必须已换成绝对地址
    for (const src of srcs) expect(src.startsWith('EPUB/')).toBe(false)
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

  it('封面兜底能拿到地址：该书没有 cover 命名的页面，只能走书名页', () => {
    expect(book.meta.cover).toBeTruthy()
  })

  it('标题是正常书名，不是文件名', () => {
    expect(book.meta.title).toBeTruthy()
    expect(book.meta.title).not.toMatch(/\.epub$/i)
  })
})
