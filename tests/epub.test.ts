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

  it('加载章节正文与样式', async () => {
    const first = await book.loadChapter(book.chapters[0].id)
    expect(first.html).toContain('这是第一章的正文')
    expect(first.css.length).toBeGreaterThan(0)
  })
})
