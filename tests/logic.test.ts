// @vitest-environment node
// 纯函数测试：不碰 DOM，跑得最快，优先把可测的逻辑都放这儿
import { describe, expect, it } from 'vitest'
import { lazyLoadImages, prepareChapterHtml, sanitizeChapterHtml } from '../src/lib/sanitize'
import { computePercent, locateCurrent } from '../src/lib/progress'
import { parseHash } from '../src/lib/router'

describe('sanitizeChapterHtml', () => {
  it('去掉 script 标签', () => {
    const dirty = '<p>正文</p><script>alert(1)</script>'
    expect(sanitizeChapterHtml(dirty)).toBe('<p>正文</p>')
  })

  it('去掉内联事件属性', () => {
    const dirty = '<p onclick="steal()" onmouseover=\'x()\'>正文</p>'
    expect(sanitizeChapterHtml(dirty)).toBe('<p>正文</p>')
  })

  it('堵掉 javascript: 链接', () => {
    expect(sanitizeChapterHtml('<a href="javascript:alert(1)">点我</a>')).toBe('<a href="#">点我</a>')
  })

  it('正常正文不受影响', () => {
    const clean = '<p>正常段落</p><a href="chapter2.xhtml">下一章</a>'
    expect(sanitizeChapterHtml(clean)).toBe(clean)
  })
})

describe('lazyLoadImages', () => {
  it('给没有 loading 属性的图片补上 lazy', () => {
    expect(lazyLoadImages('<img src="a.jpg">')).toBe('<img src="a.jpg" loading="lazy">')
  })

  it('已经有 loading 属性的不重复添加', () => {
    const html = '<img src="a.jpg" loading="eager">'
    expect(lazyLoadImages(html)).toBe(html)
  })
})

describe('prepareChapterHtml', () => {
  it('一次做完消毒和图片懒加载', () => {
    const dirty = '<img src="a.jpg" onerror="x()"><script>bad()</script>'
    expect(prepareChapterHtml(dirty)).toBe('<img src="a.jpg" loading="lazy">')
  })
})

describe('locateCurrent', () => {
  const tops = [0, 1000, 2500]

  it('滚动位置落在哪一章就报哪一章', () => {
    expect(locateCurrent(tops, 0)).toEqual({ chapterIndex: 0, offset: 0 })
    expect(locateCurrent(tops, 500)).toEqual({ chapterIndex: 0, offset: 500 })
    expect(locateCurrent(tops, 1200)).toEqual({ chapterIndex: 1, offset: 200 })
  })

  it('正好落在章节分界上算后一章的开头', () => {
    expect(locateCurrent(tops, 1000)).toEqual({ chapterIndex: 1, offset: 0 })
  })

  it('没有章节时安全返回 0', () => {
    expect(locateCurrent([], 500)).toEqual({ chapterIndex: 0, offset: 0 })
  })
})

describe('computePercent', () => {
  it('按章节序号 + 章内比例折算全书百分比', () => {
    expect(computePercent(0, 0, 1000, 10)).toBe(0)
    expect(computePercent(0, 500, 1000, 10)).toBe(5)
    expect(computePercent(1, 0, 1000, 10)).toBe(10)
  })

  it('结果永远夹在 0~100 之间', () => {
    expect(computePercent(0, -100, 1000, 10)).toBe(0)
    expect(computePercent(99, 99999, 10, 2)).toBe(100)
    expect(computePercent(0, 0, 1000, 0)).toBe(0)
  })
})

describe('parseHash', () => {
  it('空 hash 或未识别的一律回书库', () => {
    expect(parseHash('')).toEqual({ name: 'library' })
    expect(parseHash('#/')).toEqual({ name: 'library' })
    expect(parseHash('#/whatever')).toEqual({ name: 'library' })
  })

  it('识别阅读页并还原转义过的 id', () => {
    expect(parseHash('#/read/abc-123')).toEqual({ name: 'read', id: 'abc-123' })
    expect(parseHash('#/read/a%20b')).toEqual({ name: 'read', id: 'a b' })
  })
})
