// 存储「读失败」的行为测试。
//
// 与写失败不同，读失败的处置是**降级 + 留痕**（不是抛出去）：
// 书签或笔记没读出来，不该把整本书判死刑；但也不能默默给个空列表 ——
// 用户看到"书签是空的"会以为书签丢了。所以降级的同时通知订阅者。
//
// 唯一的例外是**书库本身**和**书文件**：那两样读不出来是致命的，
// 降级成空书架等于骗用户说"你没书了"，必须抛出去让 UI 显示错误态。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ctl = vi.hoisted(() => ({
  failReads: false,
  error: null as unknown,
}))

vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>()
  const maybeFail = async () => {
    if (ctl.failReads) throw ctl.error
  }
  return {
    ...actual,
    get: async (...args: Parameters<typeof actual.get>) => {
      await maybeFail()
      return actual.get(...args)
    },
    keys: async (...args: Parameters<typeof actual.keys>) => {
      await maybeFail()
      return actual.keys(...args)
    },
  }
})

import { clear } from 'idb-keyval'
import {
  addAnnotation,
  addBookmark,
  getBookFile,
  getBookMeta,
  getProgress,
  getStats,
  listAnnotations,
  listBookmarks,
  listBooks,
  listProgress,
  listStats,
  onStorageFailure,
  saveBook,
  saveProgress,
  type Annotation,
  type BookMeta,
} from '../src/lib/storage'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 1,
  addedAt: 1_000,
}

function ann(): Annotation {
  return {
    id: 'a1',
    bookId: 'b1',
    chapterIndex: 0,
    blockIndex: 0,
    startOffset: 0,
    endOffset: 3,
    text: 'abc',
    createdAt: Date.now(),
  }
}

beforeEach(async () => {
  ctl.failReads = false
  ctl.error = null
  await clear()
  await saveBook(meta, new File(['epub-bytes'], 'book.epub'))
  await addAnnotation('b1', ann())
  await addBookmark('b1', {
    id: 'bm1',
    chapterIndex: 0,
    blockIndex: 0,
    excerpt: 'x',
    percent: 0.1,
    createdAt: Date.now(),
  })
  await saveProgress('b1', { chapterIndex: 0, blockIndex: 0, percent: 0.1, updatedAt: Date.now() })
})

describe('次要读：降级但不静默', () => {
  it('书签读不出来 → 空列表，而不是抛错把书判死刑', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await expect(listBookmarks('b1')).resolves.toEqual([])
  })

  it('高亮笔记读不出来 → 空列表', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await expect(listAnnotations('b1')).resolves.toEqual([])
  })

  it('进度 / 统计读不出来 → 空对象或 undefined，不会炸', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await expect(listProgress()).resolves.toEqual({})
    await expect(listStats()).resolves.toEqual({})
    await expect(getProgress('b1')).resolves.toBeUndefined()
    await expect(getStats('b1')).resolves.toBeUndefined()
  })

  it('降级会通知订阅者（用户得知道"没读出来"不是"真没有"）', async () => {
    const seen: string[] = []
    const off = onStorageFailure((label) => seen.push(label))

    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await listBookmarks('b1')
    await listAnnotations('b1')

    expect(seen).toEqual(['读取书签', '读取高亮笔记'])
    off()
    // 取消订阅后不再收到
    await listBookmarks('b1')
    expect(seen).toHaveLength(2)
  })

  it('恢复后数据照旧读得出来（降级没把库搞坏）', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await listBookmarks('b1')

    ctl.failReads = false
    expect(await listBookmarks('b1')).toHaveLength(1)
    expect(await listAnnotations('b1')).toHaveLength(1)
  })
})

describe('书库与书文件：读不出来必须抛，绝不降级成"你没有书"', () => {
  it('listBooks 读不出来 → 抛错（空书架会被当成"书没了"）', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await expect(listBooks()).rejects.toThrow(/db broken/)
  })

  it('书的元数据 / 文件读不出来 → 同样抛错，交给阅读页显示"打不开这本书"', async () => {
    ctl.failReads = true
    ctl.error = new DOMException('db broken', 'InvalidStateError')
    await expect(getBookMeta('b1')).rejects.toThrow(/db broken/)
    await expect(getBookFile('b1', 'book.epub')).rejects.toThrow(/db broken/)
  })
})
