// 单书全文搜索：从每章 HTML 抽纯文本，做大小写不敏感的关键词检索。
//
// 为什么不走 loadChapter 的"已处理 HTML"？其实也可以，但为稳妥这里只取 html 字段
// 抽文本，不去碰图片 blob（搜索用不到图）。抽取逻辑和 weights.ts 的 textLength 同源，
// 只是保留完整文本而非只数长度。
//
// 范围：单书（主上大人拍板）。跨书全局搜索不在本期。

export interface SearchHit {
  /** 命中所在章节（spine 序号） */
  chapterIndex: number
  /** 命中周围的上下文片段（纯文本） */
  snippet: string
  /** match 在 snippet 中的起止偏移，用于渲染高亮 */
  matchStart: number
  matchEnd: number
  /** match 在整章纯文本中的偏移，预留给精确定位 */
  matchOffset: number
}

/** HTML → 纯文本：去脚本/样式/标签，转义实体，折叠空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 在每章纯文本里检索关键词，返回命中列表。
 * @param texts 按章节顺序的纯文本数组
 * @param query 关键词
 * @param opts.context 命中前后上下文字符数；maxHits 单书上限
 */
export function searchChapters(
  texts: string[],
  query: string,
  opts?: { context?: number; maxHits?: number },
): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  const lower = q.toLowerCase()
  // 中文没有词边界，context 给足；英文同理。
  const context = opts?.context ?? 28
  const maxHits = opts?.maxHits ?? 200
  const hits: SearchHit[] = []
  for (let ci = 0; ci < texts.length; ci++) {
    const text = texts[ci]
    if (!text) continue
    const lowerText = text.toLowerCase()
    let from = 0
    while (hits.length < maxHits) {
      const idx = lowerText.indexOf(lower, from)
      if (idx < 0) break
      const start = Math.max(0, idx - context)
      const end = Math.min(text.length, idx + q.length + context)
      const snippet = text.slice(start, end)
      hits.push({
        chapterIndex: ci,
        snippet,
        matchStart: idx - start,
        matchEnd: idx - start + q.length,
        matchOffset: idx,
      })
      from = idx + q.length
    }
  }
  return hits
}

/**
 * 从已打开的书抽取每章纯文本（按需调用，仅在用户发起搜索时跑一次，结果会缓存）。
 * 结构化的入参类型与 OpenedBook 兼容（只需 chapters + loadChapter）。
 */
export async function extractBookTexts(book: {
  chapters: { id: string }[]
  loadChapter: (id: string) => Promise<{ html: string }>
}): Promise<string[]> {
  const out: string[] = []
  for (const ch of book.chapters) {
    try {
      const { html } = await book.loadChapter(ch.id)
      out.push(htmlToText(html))
    } catch {
      out.push('')
    }
  }
  return out
}
