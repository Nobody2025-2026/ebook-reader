// EPUB 正文是外来 HTML，直接 innerHTML 有风险。
// 这里只做必要的三件事：去脚本、去内联事件、堵 javascript: 链接。
// 不做完整白名单过滤（那需要 DOMPurify 级别的库），MVP 阶段够用。
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi
const EVENT_ATTR_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const JS_HREF_RE = /href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi

export function sanitizeChapterHtml(html: string): string {
  return html
    .replace(SCRIPT_RE, '')
    .replace(EVENT_ATTR_RE, '')
    .replace(JS_HREF_RE, 'href="#"')
}

/**
 * 给所有图片加 loading="lazy"。
 * 真实样本实测单章最多 45 张图（70MB 的书），没有懒加载打开就卡死。
 */
export function lazyLoadImages(html: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\sloading\s*=/i.test(attrs)) return match
    return `<img${attrs} loading="lazy">`
  })
}

/**
 * 摘掉内联 style 里的排版声明（font-size / font-family / line-height /
 * letter-spacing / color），其余声明（如 text-align、font-weight）原样保留。
 *
 * 为什么要摘：真实样本《涛动周期论》每个段落都焊死了
 *   <span style="font-size:16px;font-family:'PingFang SC';color:rgb(0,0,0)">
 * 内联样式的优先级高于阅读器的 .chapter 类规则，结果是——
 *   - 字号被钉死在 16px，调字号滑条完全没反应
 *   - 字体被钉死在苹方，切楷体/圆体毫无变化
 *   - 行距的基准字号固定，怎么调都"不对劲"
 *   - color:rgb(0,0,0) 在夜间模式下直接变成黑底黑字
 * 摘掉之后，标题由 h1~h6 标签 + 阅读器 CSS 的 em 相对值接管，
 * 既恢复了层级，又能跟随读者的字号设置一起缩放。
 */
const TYPO_PROP_RE = /^(font-size|font-family|line-height|letter-spacing|color)\s*:/i

export function stripInlineTypography(html: string): string {
  return html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _quoted, dq, sq) => {
    const raw: string = dq ?? sq ?? ''
    const kept = raw
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl && !TYPO_PROP_RE.test(decl))
      .join('; ')
    // 整个 style 只剩排版声明时，把属性整个丢掉，别留个空的 style=""
    return kept ? ` style="${kept}"` : ''
  })
}

export function prepareChapterHtml(html: string): string {
  return lazyLoadImages(stripInlineTypography(sanitizeChapterHtml(html)))
}
