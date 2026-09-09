// @vitest-environment node
// 书签纯逻辑测试：不碰 DOM / IndexedDB，跑得最快。
// 存储读写和 UI 交互在 app-ui.test.tsx 里验。
import { describe, expect, it } from 'vitest'
import {
  hasBookmarkAt,
  makeExcerpt,
  newBookmarkId,
  sortBookmarks,
  type Bookmark,
} from '../src/lib/bookmark'

function bm(chapterIndex: number, blockIndex: number, createdAt = 0): Bookmark {
  return {
    id: `bm-${chapterIndex}-${blockIndex}-${createdAt}`,
    chapterIndex,
    blockIndex,
    excerpt: 'x',
    percent: 0,
    createdAt,
  }
}

describe('makeExcerpt', () => {
  it('压平多余空白（换行/连续空格都收成一个空格）', () => {
    expect(makeExcerpt('开头   中间\n\n结尾')).toBe('开头 中间 结尾')
  })

  it('超过上限就截断并加省略号', () => {
    const out = makeExcerpt('一二三四五六七八九十甲乙丙丁', 5)
    expect(out).toBe('一二三四五…')
    expect(out.length).toBe(6)
  })

  it('不超过上限时原样返回，不加省略号', () => {
    expect(makeExcerpt('短句')).toBe('短句')
  })

  it('空段落给兜底文案（纯图片页/章节标题页不会变成认不出的空白项）', () => {
    expect(makeExcerpt('')).toBe('（此页无文字）')
    expect(makeExcerpt('   \n\t ')).toBe('（此页无文字）')
    expect(makeExcerpt(null)).toBe('（此页无文字）')
    expect(makeExcerpt(undefined)).toBe('（此页无文字）')
  })
})

describe('sortBookmarks', () => {
  it('按正文顺序排：先按章、再按块', () => {
    const list = [bm(1, 5), bm(0, 9), bm(1, 0), bm(0, 2)]
    expect(sortBookmarks(list).map((b) => [b.chapterIndex, b.blockIndex])).toEqual([
      [0, 2],
      [0, 9],
      [1, 0],
      [1, 5],
    ])
  })

  it('同一位置按添加时间先后排', () => {
    const list = [bm(0, 1, 200), bm(0, 1, 100)]
    expect(sortBookmarks(list).map((b) => b.createdAt)).toEqual([100, 200])
  })

  it('返回新数组，不打乱原数组', () => {
    const list = [bm(2, 0), bm(0, 0)]
    const sorted = sortBookmarks(list)
    expect(list[0].chapterIndex).toBe(2)
    expect(sorted[0].chapterIndex).toBe(0)
  })

  it('空数组不炸', () => {
    expect(sortBookmarks([])).toEqual([])
  })
})

describe('hasBookmarkAt', () => {
  it('同章同块视为已有（防连点重复添加）', () => {
    expect(hasBookmarkAt([bm(1, 3)], 1, 3)).toBe(true)
  })

  it('同章不同块、不同章同块都不算重复', () => {
    expect(hasBookmarkAt([bm(1, 3)], 1, 4)).toBe(false)
    expect(hasBookmarkAt([bm(1, 3)], 2, 3)).toBe(false)
  })
})

describe('newBookmarkId', () => {
  it('连开 200 个都不重复（id 要在同一本书内唯一）', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newBookmarkId()))
    expect(ids.size).toBe(200)
  })
})
