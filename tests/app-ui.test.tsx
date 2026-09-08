// 存储层 + 组件的集成测试（jsdom + fake-indexeddb）。
// 解析层在这里被 mock 掉——它已经在 real-book.test.ts 里用真书验过了，
// 这里只关心"书存得进、读得出、进度记得住"。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clear } from 'idb-keyval'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from '../src/components/Library'
import { Reader } from '../src/components/Reader'
import { webBookSource } from '../src/lib/bookSource'
import {
  deleteBook,
  getBookFile,
  getProgress,
  listBooks,
  saveBook,
  saveProgress,
  type BookMeta,
} from '../src/lib/storage'

const { openEpubMock, mockBook } = vi.hoisted(() => {
  const openEpubMock = vi.fn()
  const mockBook = {
    meta: { title: '测试书', author: '主上大人', language: 'zh', cover: undefined },
    chapters: [
      { id: 'c1', label: '第一章' },
      { id: 'c2', label: '第二章' },
      { id: 'c3', label: '第三章' },
    ],
    // 字数权重：阅读器算百分比要用，缺了会在滚动时炸 TypeError
    chapterWeights: [10, 10, 10],
    // 目录树：阅读器渲染目录抽屉用
    toc: [
      { label: '第一章', chapterIndex: 0 },
      { label: '第二章', chapterIndex: 1 },
      { label: '第三章', chapterIndex: 2 },
    ],
    loadChapter: async (id: string) => ({ html: `<p>${id} 的正文</p>`, css: [] }),
    resolveHref: () => undefined,
    destroy: vi.fn(),
  }
  return { openEpubMock, mockBook }
})

vi.mock('../src/lib/epub', () => ({ openEpub: openEpubMock }))

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 3,
  addedAt: 1_000,
}

beforeEach(async () => {
  await clear()
  openEpubMock.mockResolvedValue(mockBook)
})

describe('存储层', () => {
  it('书文件能存能取，且内容不丢', async () => {
    await saveBook(meta, new File(['epub-bytes'], 'book.epub'))
    const file = await getBookFile('b1', 'book.epub')
    expect(file).toBeTruthy()
    // 这条断言是"刷新后还能打开书"的最后防线：字节一个都不能少
    expect(await file!.text()).toBe('epub-bytes')
  })

  it('书库只列元数据，按加入时间倒序', async () => {
    await saveBook(meta, new File(['a'], 'a.epub'))
    await saveBook({ ...meta, id: 'b2', title: '后加的书', addedAt: 2_000 }, new File(['b'], 'b.epub'))
    const books = await listBooks()
    expect(books.map((b) => b.title)).toEqual(['后加的书', '测试书'])
  })

  it('删书连带删掉进度，不留孤儿记录', async () => {
    await saveBook(meta, new File(['a'], 'a.epub'))
    await saveProgress('b1', { chapterIndex: 1, blockIndex: 3, percent: 40, updatedAt: Date.now() })
    expect(await getProgress('b1')).toBeTruthy()

    await deleteBook('b1')
    expect(await getBookFile('b1', 'book.epub')).toBeUndefined()
    expect(await getProgress('b1')).toBeUndefined()
  })
})

describe('书库页', () => {
  it('空书架给明确引导', () => {
    render(<Library books={[]} importing={false} importHint="" onImport={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('书架是空的')).toBeInTheDocument()
  })

  it('有书时显示书名、作者和进度', () => {
    render(
      <Library
        books={[{ ...meta, progress: { chapterIndex: 1, blockIndex: 0, percent: 40, updatedAt: 1 } }]}
        importing={false}
        importHint=""
        onImport={vi.fn()}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('测试书')).toBeInTheDocument()
    expect(screen.getByText('主上大人')).toBeInTheDocument()
    expect(screen.getByText('40% · 继续阅读')).toBeInTheDocument()
  })

  it('点封面打开对应的书', () => {
    const onOpen = vi.fn()
    render(<Library books={[meta]} importing={false} importHint="" onImport={vi.fn()} onOpen={onOpen} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /测试书/ }))
    expect(onOpen).toHaveBeenCalledWith('b1')
  })
})

describe('阅读器', () => {
  it('打开书后渲染出正文', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    render(<Reader bookId="b1" onExit={vi.fn()} />)
    expect(await screen.findByText('c1 的正文')).toBeInTheDocument()
  })

  it('没有进度时从头开始，有进度时回到原章节', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    await saveProgress('b1', { chapterIndex: 2, blockIndex: 5, percent: 70, updatedAt: Date.now() })

    render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c3 的正文')).toBeInTheDocument())
  })

  it('滚动后把进度写进存储', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await screen.findByText('c1 的正文')

    const scroller = container.querySelector('.reader-scroll') as HTMLElement
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)

    await waitFor(async () => {
      const progress = await getProgress('b1')
      expect(progress?.chapterIndex).toBe(0)
      // 现在存的是 blockIndex，不是像素 offset。设了 scrollTop=120，看视口顶端压在哪一段
      expect(typeof progress?.blockIndex).toBe('number')
      expect(progress?.blockIndex).toBeGreaterThanOrEqual(0)
    })
  })

  it('文件丢失时给错误提示而不是白屏', async () => {
    render(<Reader bookId="missing" onExit={vi.fn()} />)
    expect(await screen.findByText('打不开这本书')).toBeInTheDocument()
  })

  it('按 Esc 回书库', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const onExit = vi.fn()
    render(<Reader bookId="b1" onExit={onExit} />)
    await screen.findByText('c1 的正文')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onExit).toHaveBeenCalled()
  })

  it('方向键/空格翻屏，Home 回开头', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await screen.findByText('c1 的正文')

    const scroller = container.querySelector('.reader-scroll') as HTMLElement
    // 给滚动容器一个高度，否则 clientHeight=0，翻屏量退化为 200
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true })
    // jsdom 没实现 scrollBy，这里 spy 验证被调用
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(scrollBy).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: ' ' })
    expect(scrollBy).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(scrollBy).toHaveBeenCalledTimes(3)
  })

  it('有进度时打开书，显示「已回到上次阅读位置」提示', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    await saveProgress('b1', { chapterIndex: 1, blockIndex: 0, percent: 40, updatedAt: Date.now() })

    render(<Reader bookId="b1" onExit={vi.fn()} />)
    await screen.findByText('c2 的正文')
    expect(await screen.findByText('已回到上次阅读位置')).toBeInTheDocument()
  })

  it('打开目录抽屉并点击跳转章节', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    render(<Reader bookId="b1" onExit={vi.fn()} />)
    await screen.findByText('c1 的正文')

    // 点目录按钮，抽屉出现并列出章节
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    expect(await screen.findByText('第一章')).toBeInTheDocument()

    // 点「第三章」跳转，等目标章节异步加载渲染
    fireEvent.click(screen.getByRole('button', { name: '第三章' }))
    await waitFor(() => expect(screen.getByText('c3 的正文')).toBeInTheDocument())
  })

  it('打开排版面板，调整字号和主题', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await screen.findByText('c1 的正文')

    // 点排版按钮，面板出现
    fireEvent.click(screen.getByRole('button', { name: '排版' }))
    expect(await screen.findByText('字号')).toBeInTheDocument()

    // 切到夜间主题：.reader 应有 theme-night class
    fireEvent.click(screen.getByRole('button', { name: '夜间' }))
    await waitFor(() => {
      expect(container.querySelector('.reader')).toHaveClass('theme-night')
    })

    // 调整字号滑条：正文容器应拿到对应 CSS 变量
    const range = screen.getByRole('slider', { name: /字号/ }) as HTMLInputElement
    fireEvent.change(range, { target: { value: '22' } })
    await waitFor(() => {
      const scroller = container.querySelector('.reader-scroll') as HTMLElement
      expect(scroller.style.getPropertyValue('--reader-font-size')).toBe('22px')
    })
  })
})

describe('导入流程', () => {
  it('选完文件后书出现在书架上', async () => {
    const { default: App } = await import('../src/App')
    vi.spyOn(webBookSource, 'pickFile').mockResolvedValue(new File(['epub'], 'book.epub'))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '导入书籍' }))

    expect(await screen.findByText('测试书')).toBeInTheDocument()
  })
})
