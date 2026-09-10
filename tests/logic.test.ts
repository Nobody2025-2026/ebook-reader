// @vitest-environment node
// 纯函数测试：不碰 DOM，跑得最快，优先把可测的逻辑都放这儿
import { describe, expect, it } from 'vitest'
import { lazyLoadImages, prepareChapterHtml, sanitizeChapterHtml } from '../src/lib/sanitize'
import {
  computePercent,
  computeWeightedPercent,
  detectContentRange,
  findAnchorBlock,
} from '../src/lib/progress'
import { parseHash } from '../src/lib/router'
import { isValidCoverDataUrl } from '../src/lib/cover'

describe('isValidCoverDataUrl', () => {
  it('拒绝空串 / undefined / null', () => {
    expect(isValidCoverDataUrl(undefined)).toBe(false)
    expect(isValidCoverDataUrl(null)).toBe(false)
    expect(isValidCoverDataUrl('')).toBe(false)
  })

  it('拒绝只有前缀、没有 base64 数据的废串（早期 bug 产物）', () => {
    expect(isValidCoverDataUrl('data:application/octet-stream;base64,')).toBe(false)
    expect(isValidCoverDataUrl('data:image/jpeg;base64,')).toBe(false)
  })

  it('拒绝非 image 的 data URL', () => {
    expect(isValidCoverDataUrl('data:text/html;base64,PHN2Zz4=')).toBe(false)
  })

  it('接受合法的图片 data URL', () => {
    const base64 = 'x'.repeat(500)
    expect(isValidCoverDataUrl('data:image/jpeg;base64,' + base64)).toBe(true)
  })
})

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

describe('computeWeightedPercent', () => {
  // 真实样本《策略思维》的权重分布：封面 0 字，引言 1361 字，
  // 第 2 章独占 250637 字（全书塞一个 spine 项），附录 13113 字
  const strategyBook = [0, 1361, 250637, 13113]

  it('按字数加权，不再按章平摊', () => {
    // 站在第 2 章（全书正文）开头：旧算法给 50%，加权后只有约 0.5%
    expect(computeWeightedPercent(2, 0, strategyBook)).toBeCloseTo(0.51, 1)
    // 第 2 章读到一半：(1361 + 250637/2) / 265111 ≈ 47.8%
    expect(computeWeightedPercent(2, 0.5, strategyBook)).toBeCloseTo(47.8, 0)
    // 第 2 章读完 ≈ 95%
    expect(computeWeightedPercent(2, 1, strategyBook)).toBeCloseTo(95.5, 0)
  })

  it('均匀分布时与按章算法一致', () => {
    const even = [100, 100, 100, 100]
    expect(computeWeightedPercent(2, 0, even)).toBe(50)
    expect(computeWeightedPercent(1, 0.5, even)).toBeCloseTo(37.5, 5)
  })

  it('权重全 0 时退化为按章等权，不会永远显示 0%', () => {
    expect(computeWeightedPercent(1, 0, [0, 0, 0, 0])).toBe(25)
  })

  it('空权重与越界序号安全处理', () => {
    expect(computeWeightedPercent(0, 0.5, [])).toBe(0)
    // 序号越过末章 = 读到全书末尾，给 100%（边界语义见 computeWeightedPercent 注释）
    expect(computeWeightedPercent(999, 0, strategyBook)).toBe(100)
    expect(computeWeightedPercent(-1, 0, strategyBook)).toBe(0)
  })

  it('章内比例被夹到 0~1，结果夹在 0~100', () => {
    expect(computeWeightedPercent(3, 2, strategyBook)).toBe(100)
    expect(computeWeightedPercent(0, -1, strategyBook)).toBe(0)
  })
})

describe('detectContentRange', () => {
  // 两本真书报过 Bug（2026-09-10）的实际权重分布：
  // 《The Art of Focus》：封面 5 字 / 正文 328893 字 / nav.xhtml（目录）1043 字
  const artOfFocus = [5, 328893, 1043]
  // 《策略思维》：封面 0 字 / 目录 Contents 1361 字 / 正文 250637 字 / 附录 13113 字
  const strategyBook = [0, 1361, 250637, 13113]

  it('去掉首尾的封面 / 目录 / nav 轻量章', () => {
    // 《The Art of Focus》末尾的 nav.xhtml 是"目录"，必须排除，
    // 否则滚到它进度被顶到 100%、恢复位置停在目录页翻不动
    expect(detectContentRange(artOfFocus)).toEqual({ first: 1, last: 1 })
    // 《策略思维》开头的封面 + 目录页都要排除，正文是第 2~3 项
    expect(detectContentRange(strategyBook)).toEqual({ first: 2, last: 3 })
  })

  it('正常书（各章体量相当）不裁剪', () => {
    expect(detectContentRange([12000, 15000, 11000, 13000])).toEqual({ first: 0, last: 3 })
  })

  it('各章都很碎（都低于平均）时不整本裁掉', () => {
    // 阈值是"平均值的 5%"，均匀的小章节都过线，不该被误裁
    expect(detectContentRange([10, 12, 9, 11])).toEqual({ first: 0, last: 3 })
  })

  it('空权重 / 全 0 权重安全返回', () => {
    expect(detectContentRange([])).toEqual({ first: 0, last: -1 })
    expect(detectContentRange([0, 0, 0])).toEqual({ first: 0, last: 2 })
  })
})

describe('computeWeightedPercent（带正文区间）', () => {
  const artOfFocus = [5, 328893, 1043]
  const strategyBook = [0, 1361, 250637, 13113]
  const artRange = detectContentRange(artOfFocus) // { first: 1, last: 1 }
  const strRange = detectContentRange(strategyBook) // { first: 2, last: 3 }

  it('区间之前（封面/目录）算 0%', () => {
    expect(computeWeightedPercent(0, 0, artOfFocus, artRange)).toBe(0)
    // 站在《策略思维》的目录页上 → 0%，不再是 0.5%
    expect(computeWeightedPercent(1, 1, strategyBook, strRange)).toBe(0)
  })

  it('区间之后（nav/尾页）算 100%', () => {
    expect(computeWeightedPercent(2, 0, artOfFocus, artRange)).toBe(100)
  })

  it('区间内按"正文总字数"折算，封面/目录不再稀释分母', () => {
    // 《策略思维》正文区间 {2,3}，区间总字数 = 250637 + 13113 = 263750
    expect(computeWeightedPercent(2, 0, strategyBook, strRange)).toBe(0)
    expect(computeWeightedPercent(2, 0.5, strategyBook, strRange)).toBeCloseTo(
      (250637 * 0.5 * 100) / 263750,
      1,
    )
    // 读完最后一章 = 100%
    expect(computeWeightedPercent(3, 1, strategyBook, strRange)).toBe(100)
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
