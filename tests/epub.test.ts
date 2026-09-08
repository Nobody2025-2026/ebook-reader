// @vitest-environment node
// 解析层跑在 Node：initEpubFile 收文件路径，与浏览器传 File 的分支共用同一套代码
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openEpub } from '../src/lib/epub'

const sample = resolve(process.cwd(), 'tests/fixtures/sample.epub')

describe('openEpub', () => {
  it('读出书名与作者', async () => {
    const book = await openEpub(sample)
    expect(book.meta.title).toBe('小喵子的测试书')
    expect(book.meta.author).toBe('主上大人')
    book.destroy()
  })

  it('按 spine 顺序列出章节，并用目录补全标题', async () => {
    const book = await openEpub(sample)
    expect(book.chapters).toHaveLength(2)
    expect(book.chapters.map((c) => c.label)).toEqual(['第一章 开场', '第二章 收尾'])
    book.destroy()
  })

  it('加载章节正文与样式', async () => {
    const book = await openEpub(sample)
    const first = await book.loadChapter(book.chapters[0].id)
    expect(first.html).toContain('这是第一章的正文')
    expect(first.css.length).toBeGreaterThan(0)
    book.destroy()
  })
})
