// 存储层 + 组件的集成测试（jsdom + fake-indexeddb）。
// 解析层在这里被 mock 掉——它已经在 real-book.test.ts 里用真书验过了，
// 这里只关心"书存得进、读得出、进度记得住"。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clear } from 'idb-keyval'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Library, UNDO_DELETE_MS } from '../src/components/Library'
import { Reader } from '../src/components/Reader'
import { webBookSource } from '../src/lib/bookSource'
import {
  addBookmark,
  clearProgress,
  deleteBook,
  getBookFile,
  getProgress,
  getStats,
  listAnnotations,
  listBookmarks,
  listBooks,
  removeBookmark,
  saveBook,
  saveProgress,
  type BookMeta,
} from '../src/lib/storage'

const { openEpubMock, mockBook, furnitureBook, divOnlyBook, linkBook } = vi.hoisted(() => {
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
  // 脏书样本：正文只在中间一项，末尾挂一个轻量 nav.xhtml（目录页）。
  // 复现 2026-09-10 报的 Bug：进度被存到 nav 上 → 下次打开"只有目录页、翻不动"。
  const furnitureBook = {
    meta: { title: '脏书', author: 'x', language: 'zh', cover: undefined },
    chapters: [
      { id: 'cover', label: '封面' },
      { id: 'body', label: '正文' },
      { id: 'nav', label: '目录' },
    ],
    // nav 只有 1000 字，远低于平均 → detectContentRange 判为正文区间之外
    chapterWeights: [5, 300000, 1000],
    toc: [],
    loadChapter: async (id: string) => ({ html: `<p>${id} 的正文</p>`, css: [] }),
    resolveHref: () => undefined,
    destroy: vi.fn(),
  }
  // 首章整页只有 <div>/<a>（calibre 生成的目录页就长这样），一个 BLOCK_SELECTOR
  // 都匹配不到。复现 2026-09-10 的 Bug：这种章一出现，"滚动→补加载"这条路就断，
  // 后面几章永远加载不出来（《策略思维》"打开只有目录页、翻不动"）。
  const divOnlyBook = {
    meta: { title: '纯div首章', author: 'x', language: 'zh', cover: undefined },
    chapters: [
      { id: 'tocdiv', label: '目录' },
      { id: 'c1', label: '第一章' },
    ],
    chapterWeights: [10, 10],
    toc: [],
    loadChapter: async (id: string) => ({
      html: id === 'tocdiv' ? '<div class="toc-page"><a href="#x">目录项</a></div>' : `<p>${id} 的正文</p>`,
      css: [],
    }),
    resolveHref: () => undefined,
    destroy: vi.fn(),
  }
  // 脚注书样本：正文里带书内链接（同章锚点 + 跨章锚点），守
  // "点脚注不能把路由踢回书库" —— HashRouter 会把 <a href="#fn1"> 的默认跳转
  // 当成路由变更，parseHash 认不出 read/xxx 就直接渲染书库。
  const linkBook = {
    meta: { title: '脚注书', author: 'x', language: 'zh', cover: undefined },
    chapters: [
      { id: 'c1', label: '第一章' },
      { id: 'c2', label: '第二章' },
    ],
    chapterWeights: [100, 100],
    toc: [],
    loadChapter: async (id: string) => ({
      html:
        id === 'c1'
          ? '<p>正文一<a href="#fn1">同章注</a></p><p><a href="c2.xhtml#fn2">跨章注</a></p>'
          : '<p>c2 的正文</p><p id="fn2">这是注释</p>',
      css: [],
    }),
    // 真实实现由 epub 层解析；mock 用固定映射模拟同样的语义
    resolveHrefToChapter: (href: string, from?: number) => {
      const at = href.indexOf('#')
      const path = at >= 0 ? href.slice(0, at) : href
      const frag = at >= 0 ? href.slice(at + 1) : ''
      const selector = frag ? `[id="${frag}"]` : undefined
      if (!path) return from === undefined ? undefined : { chapterIndex: from, selector }
      const map: Record<string, number> = { 'c1.xhtml': 0, 'c2.xhtml': 1 }
      const index = map[path]
      return index === undefined ? undefined : { chapterIndex: index, selector }
    },
    resolveHref: () => undefined,
    destroy: vi.fn(),
  }
  return { openEpubMock, mockBook, furnitureBook, divOnlyBook, linkBook }
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
  // 有些用例会改 hash（验证路由不被劫持），这里统一复位，避免污染后续用例
  window.location.hash = ''
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

  it('clearProgress 只清进度，不删书', async () => {
    await saveBook(meta, new File(['a'], 'a.epub'))
    await saveProgress('b1', { chapterIndex: 1, blockIndex: 3, percent: 40, updatedAt: Date.now() })

    await clearProgress('b1')
    expect(await getProgress('b1')).toBeUndefined()
    expect(await getBookFile('b1', 'book.epub')).toBeTruthy()
  })
})

describe('阅读时长统计（集成）', () => {
  it('打开书进入阅读页会记录一次阅读会话', async () => {
    await saveBook(meta, new File(['x'], 'book.epub'))
    render(<Reader bookId="b1" onExit={vi.fn()} />)
    // 进入 ready 后正文渲染出来，此时 touchOpen 应已记入一次会话
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())
    await waitFor(async () => {
      const s = await getStats('b1')
      expect(s?.sessions).toBe(1)
    })
  })
})

describe('书库页', () => {
  it('空书架给明确引导', () => {
    render(<Library books={[]} importing={false} importHint="" onImport={vi.fn()} onOpen={vi.fn()} onRestart={vi.fn()} onDelete={vi.fn()} />)
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
        onRestart={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('测试书')).toBeInTheDocument()
    expect(screen.getByText('主上大人')).toBeInTheDocument()
    expect(screen.getByText('40% · 继续阅读')).toBeInTheDocument()
    // 有进度的书应有「从头读」入口
    expect(screen.getByText('从头读')).toBeInTheDocument()
  })

  it('点封面打开对应的书', () => {
    const onOpen = vi.fn()
    render(<Library books={[meta]} importing={false} importHint="" onImport={vi.fn()} onOpen={onOpen} onRestart={vi.fn()} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开《测试书》' }))
    expect(onOpen).toHaveBeenCalledWith('b1')
  })

  it('点「从头读」清除进度并打开书', async () => {
    const onRestart = vi.fn()
    render(
      <Library
        books={[{ ...meta, progress: { chapterIndex: 1, blockIndex: 0, percent: 40, updatedAt: 1 } }]}
        importing={false}
        importHint=""
        onImport={vi.fn()}
        onOpen={vi.fn()}
        onRestart={onRestart}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '从头读' }))
    expect(onRestart).toHaveBeenCalledWith('b1')
  })
})

// 曾经点一下 × 就直删：书 + 进度 + 书签 + 全部笔记 + 统计一次性蒸发，无确认、无撤销。
// 现在两步：先确认框，再给 8 秒撤销窗口（窗口内 IndexedDB 压根没写，撤销只是取消计时器）。
describe('书库：移除书籍有确认、且可撤销', () => {
  const renderLibrary = (onDelete = vi.fn()) => {
    const utils = render(
      <Library
        books={[meta]}
        importing={false}
        importHint=""
        onImport={vi.fn()}
        onOpen={vi.fn()}
        onRestart={vi.fn()}
        onDelete={onDelete}
      />,
    )
    return { ...utils, onDelete }
  }

  /** 点 × → 弹确认框 → 点「移除」 */
  const confirmRemove = () => {
    fireEvent.click(screen.getByRole('button', { name: '移除《测试书》' }))
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
  }

  // 只伪造 setTimeout/clearTimeout：把 MessageChannel / rAF 也伪掉会让 React 调度卡住
  const useUndoTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  it('点 × 只弹确认框，不再一键直删', () => {
    const { onDelete } = renderLibrary()
    fireEvent.click(screen.getByRole('button', { name: '移除《测试书》' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('移除《测试书》？')).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('点「取消」或按 Esc 都只是关掉弹窗，书还在', () => {
    const { onDelete } = renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: '移除《测试书》' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('测试书')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移除《测试书》' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('测试书')).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('确认后书立刻从书架消失，但还没落库；点「撤销」书回来', () => {
    useUndoTimers()
    try {
      const { onDelete } = renderLibrary()
      confirmRemove()

      expect(screen.queryByText('测试书')).toBeNull()
      expect(screen.getByText('已移除《测试书》')).toBeInTheDocument()
      expect(onDelete).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
      expect(screen.getByText('测试书')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()

      // 撤销之后即使把窗口走完，也不该再删
      act(() => {
        vi.advanceTimersByTime(UNDO_DELETE_MS * 2)
      })
      expect(onDelete).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('撤销窗口过期后，才真正把删除落库', () => {
    useUndoTimers()
    try {
      const { onDelete } = renderLibrary()
      confirmRemove()
      expect(onDelete).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(UNDO_DELETE_MS)
      })
      expect(onDelete).toHaveBeenCalledWith('b1')
      expect(screen.queryByText('已移除《测试书》')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('撤销窗口内离开书库（组件卸载）会立刻补齐删除', () => {
    useUndoTimers()
    try {
      const { onDelete, unmount } = renderLibrary()
      confirmRemove()
      expect(onDelete).not.toHaveBeenCalled()

      // 否则用户"看着它删了"，下次回书库书又在那儿
      unmount()
      expect(onDelete).toHaveBeenCalledWith('b1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('阅读器', () => {
  it('打开书后渲染出正文', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    render(<Reader bookId="b1" onExit={vi.fn()} />)
    // 比 findByText 更稳：expect 找不到时抛错，waitFor 据此重试，
    // 避免 jsdom 下 openEpub 异步渲染与查询首检的偶发竞态。
    await waitFor(
      () => expect(screen.getByText('c1 的正文')).toBeInTheDocument(),
      { timeout: 5000 },
    )
  })

  it('没有进度时从头开始，有进度时回到原章节', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    await saveProgress('b1', { chapterIndex: 2, blockIndex: 5, percent: 70, updatedAt: Date.now() })

    render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c3 的正文')).toBeInTheDocument())
  })

  // ↓↓ 回归用例：2026-09-10 报的"进度存到末尾目录页 → 打开只有目录、翻不动"
  it('恢复进度落在末尾 nav（目录页）时，夹回正文而不是停在目录', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    // 模拟 Bug 现场：脏书把进度存到了 nav（spine 最后一项，轻量目录页）
    await saveProgress('b1', { chapterIndex: 2, blockIndex: 0, percent: 100, updatedAt: Date.now() })
    openEpubMock.mockResolvedValue(furnitureBook)

    render(<Reader bookId="b1" onExit={vi.fn()} />)
    // 打开的是正文那章（index 1），不是 nav（index 2）
    await waitFor(() => expect(screen.getByText('body 的正文')).toBeInTheDocument())
    expect(screen.queryByText('nav 的正文')).not.toBeInTheDocument()
  })

  it('正文区间之后的 nav 页不会被当正文自动加载', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    openEpubMock.mockResolvedValue(furnitureBook)

    render(<Reader bookId="b1" onExit={vi.fn()} />)
    // 首屏从封面开始，pump 补加载到正文；nav 在正文区间之外，不该被拉进来
    await waitFor(() => expect(screen.getByText('body 的正文')).toBeInTheDocument())
    expect(screen.getByText('cover 的正文')).toBeInTheDocument()
    expect(screen.queryByText('nav 的正文')).not.toBeInTheDocument()
  })

  it('首章整页只有 <div>/<a>（无块级元素）时，滚动仍能推动加载下一章', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    openEpubMock.mockResolvedValue(divOnlyBook)

    // 给滚动容器真实尺寸。jsdom 里 scrollHeight 恒为 0 → remain 永远低于阈值 →
    // pump 挂载后一口气加载完，就测不出"靠滚动推动加载"这条路了。
    const SH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    const CH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 10000 })
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    try {
      const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
      // 只加载了首章（纯 div 的目录页）：离底部还远，pump 按阈值设计停住
      await waitFor(() => expect(screen.getByText('目录项')).toBeInTheDocument())
      expect(screen.queryByText('c1 的正文')).not.toBeInTheDocument()

      // 滚到底：handleScroll 必须**先**跑 pump 再判 blocks，
      // 否则 blocks 为空就会提前返回，加载链断在这里（回归点）
      const scroller = container.querySelector('.reader-scroll') as HTMLElement
      scroller.scrollTop = 9400
      fireEvent.scroll(scroller)

      await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())
    } finally {
      if (SH) Object.defineProperty(Element.prototype, 'scrollHeight', SH)
      else Reflect.deleteProperty(Element.prototype, 'scrollHeight')
      if (CH) Object.defineProperty(Element.prototype, 'clientHeight', CH)
      else Reflect.deleteProperty(Element.prototype, 'clientHeight')
    }
  })

  // ↓↓ 回归用例：2026-09-10 报的"点脚注不跳注释、反而回到书库"
  it('点书内脚注链接不会把路由踢回书库（hash 不能被改）', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    openEpubMock.mockResolvedValue(linkBook)
    window.location.hash = '#/read/b1'

    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('a[href="#fn1"]')).toBeTruthy())

    // 取当前 DOM 里的元素点击：别用 findByText —— 它在 React 异步重渲染的间隙
    // 会返回已脱离文档的 stale 引用（实测 inBody=false），事件冒泡不到 React root，
    // onClick 根本不触发，测试会得出"功能没实现"的假结论。
    const live = container.querySelector('a[href="#fn1"]') as HTMLAnchorElement
    // 浏览器默认跳转被拦住：fireEvent 返回 false == defaultPrevented
    expect(fireEvent.click(live)).toBe(false)
    // hash 仍是阅读页路由，没被改成 "#fn1"（否则 App 会渲染书库）
    expect(window.location.hash).toContain('read')
    expect(window.location.hash).not.toContain('fn1')
  })

  it('点跨章脚注会加载并跳到目标章', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    openEpubMock.mockResolvedValue(linkBook)

    // 给滚动容器真实尺寸：jsdom 里 scrollHeight 恒为 0 → remain 永远低于阈值 →
    // pump 会把后续章节一口气补完，就测不出"靠点击触发跨章加载"了。
    const SH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    const CH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 10000 })
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    try {
      const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
      await waitFor(() => expect(container.querySelector('a[href="c2.xhtml#fn2"]')).toBeTruthy())
      // 此时目标章尚未加载（证明后面的加载确实是"点击"引发的）
      expect(screen.queryByText('c2 的正文')).not.toBeInTheDocument()

      const live = container.querySelector('a[href="c2.xhtml#fn2"]') as HTMLAnchorElement
      fireEvent.click(live)
      // 目标章（c2）被异步加载并渲染出来
      await waitFor(() => expect(screen.getByText('c2 的正文')).toBeInTheDocument())
    } finally {
      if (SH) Object.defineProperty(Element.prototype, 'scrollHeight', SH)
      else Reflect.deleteProperty(Element.prototype, 'scrollHeight')
      if (CH) Object.defineProperty(Element.prototype, 'clientHeight', CH)
      else Reflect.deleteProperty(Element.prototype, 'clientHeight')
    }
  })

  it('滚动后把进度写进存储', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

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

  // ↓↓ P1：字符级高亮 —— 框选正文生成高亮并持久化（回归点：dangerouslySetInnerHTML 重渲染不能冲掉高亮）
  // 框选后**不**立即入库：先弹确认浮层，点「加高亮」才写库（用户选错可直接取消）
  it('框选正文后需点「加高亮」才写入 IndexedDB', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

    const p = container.querySelector('article[data-chapter-index="0"] p') as HTMLElement
    const textNode = p.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 2) // "c1"
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const scroller = container.querySelector('.reader-scroll') as HTMLElement
    fireEvent.mouseUp(scroller)

    // 只弹确认浮层：此时还没有入库、正文也没被染黄
    await waitFor(() => expect(screen.getByText('加高亮')).toBeInTheDocument())
    expect(await listAnnotations('b1')).toHaveLength(0)
    expect(container.querySelector('mark.hl')).toBeNull()

    // 点「加高亮」→ 才真正写入并画出高亮
    fireEvent.click(screen.getByText('加高亮'))
    await waitFor(() =>
      expect(container.querySelector('article[data-chapter-index="0"] mark.hl')).toBeTruthy(),
    )
    await waitFor(async () => {
      const list = await listAnnotations('b1')
      expect(list.length).toBe(1)
      expect(list[0].text).toBe('c1')
    })
  })

  it('框选后点取消：不留下任何高亮', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

    const p = container.querySelector('article[data-chapter-index="0"] p') as HTMLElement
    const textNode = p.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 2)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const scroller = container.querySelector('.reader-scroll') as HTMLElement
    fireEvent.mouseUp(scroller)
    await waitFor(() => expect(screen.getByText('取消')).toBeInTheDocument())

    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByText('取消')).toBeNull())
    expect(await listAnnotations('b1')).toHaveLength(0)
    expect(container.querySelector('mark.hl')).toBeNull()
  })

  it('笔记管理面板可以逐条删除高亮', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

    // 先建一条高亮
    const p = container.querySelector('article[data-chapter-index="0"] p') as HTMLElement
    const textNode = p.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 2)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(container.querySelector('.reader-scroll') as HTMLElement)
    await waitFor(() => expect(screen.getByText('加高亮')).toBeInTheDocument())
    fireEvent.click(screen.getByText('加高亮'))
    await waitFor(async () => expect(await listAnnotations('b1')).toHaveLength(1))

    // 打开管理面板删掉它
    fireEvent.click(screen.getByRole('button', { name: /^笔记/ }))
    await waitFor(() => expect(screen.getByText('高亮与笔记管理')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('删除这条高亮'))

    await waitFor(async () => expect(await listAnnotations('b1')).toHaveLength(0))
    // 正文里的 <mark> 也应随之消失
    await waitFor(() => expect(container.querySelector('mark.hl')).toBeNull())
  })

  // 回归点：滚动会 setPercent → React 重渲染 → 章节 innerHTML 被重写，
  // 画好的 <mark> 被整段冲掉，而依赖 [loaded, annotations] 的 effect 不会重跑
  // → 高亮"一滚就没"，直到下次增删高亮才又出现。
  it('反复滚动（触发重渲染）后高亮依然在', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const SH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    const CH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 10000,
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    })
    try {
      const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

      const p = container.querySelector('article[data-chapter-index="0"] p') as HTMLElement
      const textNode = p.firstChild as Text
      const range = document.createRange()
      range.setStart(textNode, 0)
      range.setEnd(textNode, 2)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      fireEvent.mouseUp(container.querySelector('.reader-scroll') as HTMLElement)
      await waitFor(() => expect(screen.getByText('加高亮')).toBeInTheDocument())
      fireEvent.click(screen.getByText('加高亮'))
      await waitFor(() => expect(container.querySelector('mark.hl')).toBeTruthy())

      const scroller = container.querySelector('.reader-scroll') as HTMLElement
      for (let i = 0; i < 3; i++) {
        scroller.scrollTop = 500 + i * 300
        fireEvent.scroll(scroller)
        await waitFor(() => expect(container.querySelector('mark.hl')).toBeTruthy())
      }
    } finally {
      if (SH) Object.defineProperty(Element.prototype, 'scrollHeight', SH)
      else Reflect.deleteProperty(Element.prototype, 'scrollHeight')
      if (CH) Object.defineProperty(Element.prototype, 'clientHeight', CH)
      else Reflect.deleteProperty(Element.prototype, 'clientHeight')
    }
  })

  it('点笔记条目会关掉管理面板并跳到正文', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

    const p = container.querySelector('article[data-chapter-index="0"] p') as HTMLElement
    const textNode = p.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 2)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(container.querySelector('.reader-scroll') as HTMLElement)
    await waitFor(() => expect(screen.getByText('加高亮')).toBeInTheDocument())
    fireEvent.click(screen.getByText('加高亮'))
    await waitFor(async () => expect(await listAnnotations('b1')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: /^笔记/ }))
    await waitFor(() => expect(screen.getByText('高亮与笔记管理')).toBeInTheDocument())

    // 点条目正文 → 关闭面板（并异步滚到对应段落）
    fireEvent.click(container.querySelector('.export-item__body') as HTMLElement)
    await waitFor(() => expect(screen.queryByText('高亮与笔记管理')).toBeNull())
    expect(container.querySelector('mark.hl')).toBeTruthy()
  })

  // ↓↓ P1：单书全文搜索 —— 打开搜索面板、输入关键词返回命中并可跳转
  it('搜索本书返回命中结果', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    const input = container.querySelector('.search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '正文' } })

    // 三章都有"正文"二字 → 三条命中
    await waitFor(() => expect(container.querySelectorAll('.search-item').length).toBeGreaterThan(0))
    expect(container.querySelectorAll('.search-item').length).toBe(3)
    // 命中词被高亮包裹
    expect(container.querySelector('.search-snippet mark')).toBeTruthy()
  })

  it('按 Esc 回书库', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const onExit = vi.fn()
    render(<Reader bookId="b1" onExit={onExit} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onExit).toHaveBeenCalled()
  })

  it('方向键/空格翻屏，Home 回开头', async () => {
    await saveBook(meta, new File(['a'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

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
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

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
    await waitFor(() => expect(screen.getByText('c1 的正文')).toBeInTheDocument())

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

describe('书签存储', () => {
  it('能加能列，且按正文顺序排（先章后块）', async () => {
    await addBookmark('b1', {
      id: 'x1',
      chapterIndex: 1,
      blockIndex: 0,
      excerpt: '后',
      percent: 50,
      createdAt: 2,
    })
    await addBookmark('b1', {
      id: 'x2',
      chapterIndex: 0,
      blockIndex: 3,
      excerpt: '前',
      percent: 10,
      createdAt: 1,
    })
    expect((await listBookmarks('b1')).map((b) => b.excerpt)).toEqual(['前', '后'])
  })

  it('同一位置重复添加会被挡掉', async () => {
    const base = {
      chapterIndex: 0,
      blockIndex: 2,
      excerpt: '同位置',
      percent: 5,
      createdAt: 1,
    }
    expect(await addBookmark('b1', { ...base, id: 'a' })).toBe(true)
    expect(await addBookmark('b1', { ...base, id: 'b' })).toBe(false)
    expect((await listBookmarks('b1')).length).toBe(1)
  })

  it('删除只删指定那条', async () => {
    await addBookmark('b1', {
      id: 'k1',
      chapterIndex: 0,
      blockIndex: 0,
      excerpt: '留',
      percent: 1,
      createdAt: 1,
    })
    await addBookmark('b1', {
      id: 'k2',
      chapterIndex: 0,
      blockIndex: 1,
      excerpt: '删',
      percent: 2,
      createdAt: 2,
    })
    await removeBookmark('b1', 'k2')
    expect((await listBookmarks('b1')).map((b) => b.id)).toEqual(['k1'])
  })

  it('删书连带删书签，不留孤儿记录', async () => {
    await saveBook(meta, new File(['a'], 'a.epub'))
    await addBookmark('b1', {
      id: 'k1',
      chapterIndex: 0,
      blockIndex: 0,
      excerpt: 'x',
      percent: 1,
      createdAt: 1,
    })
    expect((await listBookmarks('b1')).length).toBe(1)

    await deleteBook('b1')
    expect(await listBookmarks('b1')).toEqual([])
  })

  it('没加过书签的书返回空数组，不炸', async () => {
    expect(await listBookmarks('不存在的书')).toEqual([])
  })
})

describe('阅读页书签', () => {
  it('点「添加当前位置」后书签出现在列表里，再点删除可移除', async () => {
    await saveBook(meta, new File(['epub-bytes'], 'book.epub'))
    const { container } = render(<Reader bookId="b1" onExit={() => {}} />)

    // 等书打开（工具栏按钮出现）
    await waitFor(() => expect(screen.getByTitle('书签')).toBeTruthy())
    fireEvent.click(screen.getByTitle('书签'))

    // 空态
    expect(await screen.findByText(/还没有书签/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加当前位置' }))

    // 书签条目出现。摘录取自当前段落（mock 第一章正文就是 "c1 的正文"），
    // 注意：正文里也有同样文字，所以只查书签面板内部，不用全局 getByText
    await waitFor(() => {
      expect(container.querySelectorAll('.bookmark-item').length).toBe(1)
    })
    expect(container.querySelector('.bookmark-excerpt')?.textContent).toBe('c1 的正文')

    // 工具栏按钮上显示数量
    await waitFor(() => {
      expect(screen.getByTitle('书签').textContent).toContain('1')
    })

    // 删掉它，回到空态
    fireEvent.click(screen.getByTitle('删除书签'))
    await waitFor(() => {
      expect(container.querySelectorAll('.bookmark-item').length).toBe(0)
    })
  })
})
