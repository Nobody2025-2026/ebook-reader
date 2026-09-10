import { clear } from 'idb-keyval'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addReadingSeconds,
  deleteBook,
  getStats,
  listStats,
  saveBook,
  touchOpen,
  type BookMeta,
} from '../src/lib/storage'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: 'x',
  fileName: 'book.epub',
  chapterCount: 3,
  addedAt: 1_000,
}

beforeEach(async () => {
  await clear()
})

describe('阅读时长统计（存储层）', () => {
  it('touchOpen 首次创建记录，再次调用只累加会话数', async () => {
    await touchOpen('b1')
    let s = await getStats('b1')
    expect(s).toBeTruthy()
    expect(s!.sessions).toBe(1)
    expect(s!.totalSeconds).toBe(0)
    expect(s!.firstOpenedAt).toBeGreaterThan(0)
    const first = s!.firstOpenedAt

    await touchOpen('b1')
    s = await getStats('b1')
    expect(s!.sessions).toBe(2)
    // 首次打开时间不变，最后阅读时间更新
    expect(s!.firstOpenedAt).toBe(first)
    expect(s!.lastReadAt).toBeGreaterThanOrEqual(first)
  })

  it('addReadingSeconds 累加总时长', async () => {
    await addReadingSeconds('b1', 60)
    await addReadingSeconds('b1', 30)
    const s = await getStats('b1')
    expect(s!.totalSeconds).toBe(90)
    // 没 touchOpen 过，不强行造会话
    expect(s!.sessions).toBe(0)
  })

  it('addReadingSeconds 忽略非正数，不建记录', async () => {
    await addReadingSeconds('b1', 0)
    await addReadingSeconds('b1', -5)
    expect(await getStats('b1')).toBeUndefined()
  })

  it('listStats 返回全部书统计并按 id 索引', async () => {
    await touchOpen('b1')
    await addReadingSeconds('b1', 100)
    await touchOpen('b2')
    const all = await listStats()
    expect(Object.keys(all).sort()).toEqual(['b1', 'b2'])
    expect(all['b1'].totalSeconds).toBe(100)
    expect(all['b2'].totalSeconds).toBe(0)
  })

  it('删书连带删掉统计，不留孤儿', async () => {
    await saveBook(meta, new File(['x'], 'book.epub'))
    await touchOpen('b1')
    await addReadingSeconds('b1', 50)
    expect(await getStats('b1')).toBeTruthy()

    await deleteBook('b1')
    expect(await getStats('b1')).toBeUndefined()
  })
})
