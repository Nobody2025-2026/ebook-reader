// 单书全文搜索纯函数测试（不依赖浏览器，直接验证 htmlToText / searchChapters）。
import { describe, expect, it } from 'vitest'
import { htmlToText, searchChapters } from '../src/lib/search'

describe('search', () => {
  it('htmlToText 去标签 / 实体 / 折叠空白', () => {
    expect(htmlToText('<p>Hello  <b>World</b></p>')).toBe('Hello World')
    expect(htmlToText('<p>a&nbsp;b&amp;c</p>')).toBe('a b&c')
    expect(htmlToText('<p>括号：&lt;x&gt;</p>')).toBe('括号：<x>')
    expect(htmlToText('<script>var x=1;</script><p>text</p>')).toBe('text')
    // 多空白折叠为单空格
    expect(htmlToText('<p>a\n\n   b\t\tc</p>')).toBe('a b c')
  })

  it('searchChapters 大小写不敏感，返回上下文片段与偏移', () => {
    const texts = ['第一章讲 alpha。第二章讲 beta。', 'Beta 再次出现。']
    const hits = searchChapters(texts, 'beta')
    expect(hits.length).toBe(2)

    const h0 = hits[0]
    expect(h0.chapterIndex).toBe(0)
    expect(h0.snippet.slice(h0.matchStart, h0.matchEnd)).toBe('beta')

    const h1 = hits[1]
    expect(h1.chapterIndex).toBe(1)
    expect(h1.snippet.slice(h1.matchStart, h1.matchEnd)).toBe('Beta')
  })

  it('同一章多命中全部列出', () => {
    const texts = ['苹果 苹果 苹果']
    const hits = searchChapters(texts, '苹果')
    expect(hits.length).toBe(3)
    // 命中位置递增
    expect(hits[0].matchOffset).toBeLessThan(hits[1].matchOffset)
    expect(hits[1].matchOffset).toBeLessThan(hits[2].matchOffset)
  })

  it('空查询返回空', () => {
    expect(searchChapters(['abc'], '   ')).toEqual([])
  })

  it('maxHits 限制单书上限', () => {
    const texts = [Array.from({ length: 1000 }, () => 'x').join(' x ')]
    const hits = searchChapters(texts, 'x', { maxHits: 50 })
    expect(hits.length).toBe(50)
  })
})
