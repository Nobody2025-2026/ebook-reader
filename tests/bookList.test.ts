// @vitest-environment node
// 书库排序 / 筛选：纯逻辑，不碰 DOM。
import { describe, expect, it } from 'vitest'
import { filterBooks, sortBooks } from '../src/lib/bookList'

/** 造一本最小的书；lastReadAt 省略即"从未读过" */
const mk = (title: string, author: string, addedAt: number, lastReadAt?: number) => ({
  title,
  author,
  addedAt,
  ...(lastReadAt != null ? { stats: { lastReadAt } } : {}),
})

describe('sortBooks', () => {
  const books = [
    mk('Banana', 'Zed', 100, 500),
    mk('Apple', 'Ann', 300), // 从未读过
    mk('Cherry', 'Bob', 200, 900),
  ]

  it('导入时间：新的在前（历史默认行为）', () => {
    expect(sortBooks(books, 'added').map((b) => b.title)).toEqual(['Apple', 'Cherry', 'Banana'])
  })

  it('最近阅读：读得晚的在前，从未读过的沉底', () => {
    expect(sortBooks(books, 'recent').map((b) => b.title)).toEqual(['Cherry', 'Banana', 'Apple'])
  })

  it('按书名 / 作者排序', () => {
    expect(sortBooks(books, 'title').map((b) => b.title)).toEqual(['Apple', 'Banana', 'Cherry'])
    expect(sortBooks(books, 'author').map((b) => b.author)).toEqual(['Ann', 'Bob', 'Zed'])
  })

  it('返回新数组，不改动原数组', () => {
    const before = books.map((b) => b.title)
    sortBooks(books, 'title')
    expect(books.map((b) => b.title)).toEqual(before)
  })

  it('作者为空时按「佚名」聚合，不会抛错也不会散开', () => {
    const list = [mk('A', '', 1), mk('B', 'Ann', 2), mk('C', '', 3)]
    const out = sortBooks(list, 'author').map((b) => b.title)
    // 两本没作者的书必须相邻——否则"按作者排序"看起来就是乱的
    expect(Math.abs(out.indexOf('A') - out.indexOf('C'))).toBe(1)
  })
})

describe('filterBooks', () => {
  const books = [mk('Apple', 'Ann', 1), mk('Banana', 'Bob', 2)]

  it('按书名子串筛选', () => {
    expect(filterBooks(books, 'app').map((b) => b.title)).toEqual(['Apple'])
  })

  it('按作者筛选', () => {
    expect(filterBooks(books, 'bob').map((b) => b.title)).toEqual(['Banana'])
  })

  it('大小写不敏感，并忽略首尾空白', () => {
    expect(filterBooks(books, '  BANANA ').map((b) => b.title)).toEqual(['Banana'])
  })

  it('关键词为空时原样返回（不制造无谓拷贝）', () => {
    expect(filterBooks(books, '   ')).toBe(books)
  })

  it('没有命中返回空数组', () => {
    expect(filterBooks(books, 'zzz')).toEqual([])
  })
})
