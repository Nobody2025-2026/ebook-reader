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

export function prepareChapterHtml(html: string): string {
  return lazyLoadImages(sanitizeChapterHtml(html))
}
