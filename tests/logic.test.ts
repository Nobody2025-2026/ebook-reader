// @vitest-environment node
// 纯函数测试：不碰 DOM，跑得最快，优先把可测的逻辑都放这儿
import { describe, expect, it } from 'vitest'
import { lazyLoadImages, prepareChapterHtml, sanitizeChapterHtml } from '../src/lib/sanitize'
import { computePercent, findAnchorBlock } from '../src/lib/progress'
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

describe('findAnchorBlock', () => {
  it('空数组安全返回 0', () => {
    expect(findAnchorBlock([], 0)).toEqual({ chapterIndex: 0, blockIndex: 0 })
  })

  it('视口顶压着第一块就报第一块', () => {
    const blocks = [
      { top: 0, bottom: 50, chapterIndex: 0, blockIndex: 0 },
      { top: 100, bottom: 200, chapterIndex: 0, blockIndex: 1 },
    ]
    expect(findAnchorBlock(blocks, 0)).toEqual({ chapterIndex: 0, blockIndex: 0 })
  })

  it('视口顶压着中间某块就报那一块', () => {
    const blocks = [
      { top: 0, bottom: 50, chapterIndex: 0, blockIndex: 0 },
      { top: 100, bottom: 200, chapterIndex: 0, blockIndex: 1 },
      { top: 300, bottom: 400, chapterIndex: 0, blockIndex: 2 },
    ]
    expect(findAnchorBlock(blocks, 150)).toEqual({ chapterIndex: 0, blockIndex: 1 })
  })

  it('跨章节时返回对应章节内的块下标', () => {
    const blocks = [
      { top: 0, bottom: 50, chapterIndex: 0, blockIndex: 0 },
      { top: 100, bottom: 200, chapterIndex: 0, blockIndex: 1 },
      { top: 500, bottom: 600, chapterIndex: 1, blockIndex: 0 },
      { top: 700, bottom: 800, chapterIndex: 1, blockIndex: 1 },
    ]
    expect(findAnchorBlock(blocks, 550)).toEqual({ chapterIndex: 1, blockIndex: 0 })
    expect(findAnchorBlock(blocks, 750)).toEqual({ chapterIndex: 1, blockIndex: 1 })
  })

  it('视口比所有块都靠下时返回最后一块', () => {
    const blocks = [
      { top: 0, bottom: 50, chapterIndex: 0, blockIndex: 0 },
      { top: 100, bottom: 200, chapterIndex: 0, blockIndex: 1 },
    ]
    expect(findAnchorBlock(blocks, 9999)).toEqual({ chapterIndex: 0, blockIndex: 1 })
  })
})

describe('computePercent', () => {
  it('按章节序号 + 章内比例折算全书百分比', () => {
    // 10 章，读到第 1 章开头 = 10%
    expect(computePercent(1, 10, 0)).toBe(10)
    // 读到第 1 章的一半 = 15%
    expect(computePercent(1, 10, 0.5)).toBeCloseTo(15, 5)
    // 读到第 5 章开头 = 50%
    expect(computePercent(5, 10, 0)).toBe(50)
  })

  it('章内比例被夹到 0~1', () => {
    expect(computePercent(0, 10, -1)).toBe(0)
    expect(computePercent(0, 10, 2)).toBe(10)
  })

  it('总章节为 0 时安全返回 0', () => {
    expect(computePercent(0, 0, 0.5)).toBe(0)
  })

  it('结果永远夹在 0~100 之间', () => {
    expect(computePercent(99, 100, 0.5)).toBeCloseTo(99.5, 1)
    expect(computePercent(0, 1, 0)).toBe(0)
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
