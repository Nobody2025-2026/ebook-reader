// 存储写失败时，界面必须"有回音、不假装成功"（UI 层）。
//
// 存储层的抛错在 storage-write-failure.test.ts 里验过；这里验的是另一半：
// 用户在界面上点完，到底看到了什么。断言两条：
//   1. 失败 → 出现明说"失败"的提示，**绝不能出现"已添加"**；
//   2. 成功 → 才出现"已添加"。
// 只测书签（Ctrl+B 一键触发，路径最短最可靠）；高亮要模拟选区，
// jsdom 里没有真实排版，留给真机/真浏览器复核。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openEpubMock, mockBook } = vi.hoisted(() => {
  const openEpubMock = vi.fn()
  const mockBook = {
    meta: { title: '测试书', author: '主上大人', language: 'zh', cover: undefined },
    chapters: [{ id: 'c1', label: '第一章' }],
    chapterWeights: [10],
    toc: [{ label: '第一章', chapterIndex: 0 }],
    loadChapter: async (id: string) => ({ html: `<p>${id} 的正文</p>`, css: [] }),
    resolveHref: () => undefined,
    destroy: vi.fn(),
  }
  return { openEpubMock, mockBook }
})

vi.mock('../src/lib/epub', () => ({ openEpub: openEpubMock }))

// 字体探测依赖 canvas（jsdom 里恒为"探测不出"），固定结论免得无关逻辑掺和
vi.mock('../src/lib/fontAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/fontAvailability')>()
  return {
    ...actual,
    canvasProbe: () => null,
    detectFontAvailability: () => ({
      system: true,
      songti: true,
      heiti: true,
      kaiti: false,
      yuanti: false,
      fangsong: false,
    }),
  }
})

const ctl = vi.hoisted(() => ({ failWrites: false, error: null as unknown }))

vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>()
  const maybeFail = async () => {
    if (ctl.failWrites) throw ctl.error
  }
  return {
    ...actual,
    set: async (...args: Parameters<typeof actual.set>) => {
      await maybeFail()
      return actual.set(...args)
    },
    del: async (...args: Parameters<typeof actual.del>) => {
      await maybeFail()
      return actual.del(...args)
    },
  }
})

import { clear } from 'idb-keyval'
import { Reader } from '../src/components/Reader'
import { listBookmarks, saveBook, type BookMeta } from '../src/lib/storage'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 1,
  addedAt: 1_000,
}

async function renderReady() {
  render(<Reader bookId="b1" onExit={vi.fn()} />)
  // 等正文出现 = status 已 ready（书签按钮要靠当前锚点，锚点得先有块）
  await waitFor(() => expect(screen.getByText('c1 的正文')).toBeTruthy())
}

function pressAddBookmark() {
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
}

beforeEach(async () => {
  ctl.failWrites = false
  ctl.error = null
  await clear()
  openEpubMock.mockResolvedValue(mockBook)
  await saveBook(meta, new File(['epub-bytes'], 'book.epub'))
})

describe('写失败时界面怎么表现', () => {
  it('一键书签失败：明说失败，绝不出现"已添加"', async () => {
    await renderReady()

    ctl.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    ctl.failWrites = true
    pressAddBookmark()

    await waitFor(() => expect(screen.getByText(/添加书签失败/)).toBeTruthy())
    expect(screen.queryByText(/已添加书签/)).toBeNull()
    // 严格一致：库里没存进去
    expect(await listBookmarks('b1')).toEqual([])
  })

  it('恢复后重试就成功了（说明上一条不是把功能改坏了）', async () => {
    await renderReady()

    ctl.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    ctl.failWrites = true
    pressAddBookmark()
    await waitFor(() => expect(screen.getByText(/添加书签失败/)).toBeTruthy())

    ctl.failWrites = false
    pressAddBookmark()
    await waitFor(() => expect(screen.getByText(/已添加书签/)).toBeTruthy())
    expect(await listBookmarks('b1')).toHaveLength(1)
  })
})
