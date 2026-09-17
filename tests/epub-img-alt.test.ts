// @vitest-environment node
// ensureImageAlt 是纯函数（字符串进、字符串出，不碰文件系统），但 import 的模块
// 会拖进 EPUB 解析库，所以跟 epub.test.ts 一样跑在 node 环境，省得跟 jsdom 较劲。
import { describe, expect, it } from 'vitest'
import { ensureImageAlt } from '../src/lib/epub'

const coverPage = '<div><title>Cover</title><center><img src="cover.jpg"></center></div>'

describe('ensureImageAlt（给正文图片补 alt）', () => {
  it('没有图片时原样返回', () => {
    const html = '<p>纯文字章节</p>'
    expect(ensureImageAlt(html, { bookTitle: '书' })).toBe(html)
  })

  it('书里写了 alt 的，一个字都不动（尊重作者）', () => {
    const html = '<p><img src="a.jpg" alt="作者自己写的说明"></p>'
    expect(ensureImageAlt(html, { bookTitle: '书', isFirstChapter: true })).toBe(html)
  })

  it('首章 + 单图 + 无文字 → 判定为封面，用书名做 alt', () => {
    const out = ensureImageAlt(coverPage, { bookTitle: '策略思维', isFirstChapter: true })
    expect(out).toContain('alt="《策略思维》封面"')
  })

  // 这条是这份实现最容易写错的地方：只看"单图无文字"会把整页插图误标成封面
  it('同样的「单图无文字」出现在中间章节 → 是整页插图，不能误标成封面', () => {
    const out = ensureImageAlt('<div><img src="plate.jpg"></div>', {
      bookTitle: '策略思维',
      isFirstChapter: false,
    })
    expect(out).toContain('alt="插图"')
    expect(out).not.toContain('封面')
  })

  it('首章但正文很长 → 那不是封面页，图按插图算', () => {
    const html = '<p>这是第一章的正文，讲了很多很多东西，字数远远超过二十个字符。</p><img src="a.jpg">'
    const out = ensureImageAlt(html, { bookTitle: '书', isFirstChapter: true })
    expect(out).toContain('alt="插图"')
    expect(out).not.toContain('封面')
  })

  it('首章放了两张图 → 不是封面页', () => {
    const out = ensureImageAlt('<div><img src="a.jpg"><img src="b.jpg"></div>', {
      bookTitle: '书',
      isFirstChapter: true,
    })
    expect(out.match(/alt="插图"/g)).toHaveLength(2)
    expect(out).not.toContain('封面')
  })

  it('缺书名时封面兜底成「封面」', () => {
    expect(ensureImageAlt(coverPage, { isFirstChapter: true })).toContain('alt="封面"')
  })

  it('书名里的 & 引号 尖括号会被转义，不会撑破属性', () => {
    const out = ensureImageAlt(coverPage, { bookTitle: 'A&B "卷" <1>', isFirstChapter: true })
    // 断言属性值本身而不是整串：证明引号被转义后没把属性截断
    // （`>` 在带引号的属性值里合法、无需转义，所以这里只管 & " <）
    const altValue = out.match(/alt="([^"]*)"/)?.[1]
    expect(altValue).toBe('《A&amp;B &quot;卷&quot; &lt;1>》封面')
  })

  it('data-alt 不算 alt（属性名要看词边界）', () => {
    const out = ensureImageAlt('<img src="a.jpg" data-alt="x">', { isFirstChapter: false })
    expect(out).toContain('alt="插图"')
    expect(out).toContain('data-alt="x"')
  })

  it('只多一个 alt，其余属性与结构原样保留', () => {
    const html = '<div class="wrap"><img src="a.jpg" loading="lazy"></div>'
    expect(ensureImageAlt(html, { isFirstChapter: false })).toBe(
      '<div class="wrap"><img alt="插图" src="a.jpg" loading="lazy"></div>',
    )
  })

  it('幂等：处理过的结果再处理一次不变（同一章可能被加载多次）', () => {
    const once = ensureImageAlt(coverPage, { bookTitle: '书', isFirstChapter: true })
    expect(ensureImageAlt(once, { bookTitle: '书', isFirstChapter: true })).toBe(once)
  })
})
