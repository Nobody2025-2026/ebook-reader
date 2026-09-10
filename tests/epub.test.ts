// @vitest-environment node
// 解析层跑在 Node：initEpubFile 收文件路径，与浏览器传 File 的分支共用同一套代码
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openEpub, type OpenedBook } from '../src/lib/epub'

const sample = resolve(process.cwd(), 'tests/fixtures/sample.epub')

describe('openEpub', () => {
  // 资源落盘指到临时目录，避免在项目里留下 images/，也让 destroy() 不至于慢到卡住
  const saveDir = mkdtempSync(join(tmpdir(), 'reader-fixture-'))
  let book: OpenedBook

  beforeAll(async () => {
    book = await openEpub(sample, { resourceSaveDir: saveDir })
  })

  afterAll(() => {
    book?.destroy()
    rmSync(saveDir, { recursive: true, force: true })
  })

  it('读出书名与作者', () => {
    expect(book.meta.title).toBe('小喵子的测试书')
    expect(book.meta.author).toBe('主上大人')
  })

  it('按 spine 顺序列出章节，并用目录补全标题', () => {
    expect(book.chapters).toHaveLength(2)
    expect(book.chapters.map((c) => c.label)).toEqual(['第一章 开场', '第二章 收尾'])
  })

  it('加载章节正文，并把外链 CSS 就地内联成可靠地址', async () => {
    const first = await book.loadChapter(book.chapters[0].id)
    expect(first.html).toContain('这是第一章的正文')
    // CSS 由我们自己从 zip 解出并内联（Node 端没有 createObjectURL，退化成 data URL），
    // 不再依赖解析库那套会被 destroy() 清空的全局 blob 缓存
    const inlined = first.html.match(/<link[^>]+href="(data:text\/css;base64,[^"]+)"/i)
    expect(inlined).toBeTruthy()
    const css = Buffer.from(inlined![1].split(',')[1], 'base64').toString('utf8')
    expect(css).toContain('line-height:1.8')
  })

  it('章节正文里的 XML 声明与 DOCTYPE 已剥掉（否则 innerHTML 会当文本显示）', async () => {
    const first = await book.loadChapter(book.chapters[0].id)
    expect(first.html.startsWith('<html')).toBe(true)
  })

  it('算出每章的纯文字权重', () => {
    expect(book.chapterWeights).toHaveLength(2)
    // 不逐字断言（fixture 改了不用跟着改），但必须有字；
    // 样本第一章有两段正文，明显比只有一段的第二章长
    expect(book.chapterWeights[0]).toBeGreaterThan(0)
    expect(book.chapterWeights[1]).toBeGreaterThan(0)
    expect(book.chapterWeights[0]).toBeGreaterThan(book.chapterWeights[1])
  })

  it('解析出可跳转的目录树（chapterIndex + selector）', () => {
    expect(book.toc).toHaveLength(2)
    expect(book.toc.map((t) => t.label)).toEqual(['第一章 开场', '第二章 收尾'])
    expect(book.toc[0].chapterIndex).toBe(0)
    expect(book.toc[1].chapterIndex).toBe(1)
  })
})
