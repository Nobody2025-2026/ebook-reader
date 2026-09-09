// 内联排版样式的剥离：真实样本《涛动周期论》把字号/字体/颜色全焊死在
// <span style="..."> 上，内联样式优先级高于 .chapter，会让读者的排版设置失效。
// 这里验证「排版声明摘干净、语义样式留得住」。
import { describe, expect, it } from 'vitest'
import { prepareChapterHtml, stripInlineTypography } from '../src/lib/sanitize'

describe('stripInlineTypography', () => {
  it('摘掉 font-size（读者调字号失效的根因）', () => {
    const html = '<p><span style="font-size:16px">正文</span></p>'
    expect(stripInlineTypography(html)).toBe('<p><span>正文</span></p>')
  })

  it('摘掉 font-family，且不影响带引号的字体名', () => {
    const html = `<p><span style="font-family:'PingFang SC'">正文</span></p>`
    expect(stripInlineTypography(html)).toBe('<p><span>正文</span></p>')
  })

  it('摘掉 color（夜间模式下内联黑色会变成黑底黑字）', () => {
    const html = '<p><span style="color:rgb(0, 0, 0)">正文</span></p>'
    expect(stripInlineTypography(html)).toBe('<p><span>正文</span></p>')
  })

  it('一次摘掉多个排版声明：只留非排版的', () => {
    const html =
      '<p><span style="font-size:16px;color:rgb(0, 0, 0);font-family:\'PingFang SC\';text-align:center">正文</span></p>'
    expect(stripInlineTypography(html)).toBe(
      '<p><span style="text-align:center">正文</span></p>',
    )
  })

  it('保留语义样式：粗体、斜体、对齐方式不该被摘掉', () => {
    const html = '<p><span style="font-weight: bold;font-style:italic">正文</span></p>'
    const out = stripInlineTypography(html)
    expect(out).toContain('font-weight: bold')
    expect(out).toContain('font-style:italic')
  })

  it('style 里全是排版声明时，整个属性丢掉而不是留个空 style', () => {
    const html = '<p><span style="font-size:16px;line-height:1.5">正文</span></p>'
    const out = stripInlineTypography(html)
    expect(out).toBe('<p><span>正文</span></p>')
    expect(out).not.toContain('style')
  })

  it('单引号写的 style 属性同样处理', () => {
    const html = "<p><span style='font-size:16px'>正文</span></p>"
    expect(stripInlineTypography(html)).toBe('<p><span>正文</span></p>')
  })

  it('没有 style 属性的 HTML 原样返回', () => {
    const html = '<p>纯文本</p><h2>标题</h2>'
    expect(stripInlineTypography(html)).toBe(html)
  })

  it('标题摘掉内联字号后仍是 h2——层级交给阅读器 CSS 的 em 值接管', () => {
    const html = '<h2><span style="font-size:19px;font-weight: bold">第一章</span></h2>'
    const out = stripInlineTypography(html)
    expect(out).toContain('<h2>')
    expect(out).toContain('font-weight: bold')
    expect(out).not.toContain('font-size')
  })
})

describe('prepareChapterHtml 组合行为', () => {
  it('既摘排版样式，又给图片加懒加载', () => {
    const html = '<p style="font-size:16px">正文</p><img src="a.jpg">'
    const out = prepareChapterHtml(html)
    expect(out).not.toContain('font-size')
    expect(out).toContain('loading="lazy"')
  })

  it('仍然挡住脚本', () => {
    const out = prepareChapterHtml('<p>正文</p><script>alert(1)</script>')
    expect(out).not.toContain('alert(1)')
  })
})
