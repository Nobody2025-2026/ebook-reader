// 字符级高亮：基于章节 DOM 的块级元素锚点（与进度定位共用 BLOCK_SELECTOR）。
//
// 核心思路：高亮**不靠一次性 DOM 包裹**——章节用 dangerouslySetInnerHTML 渲染，
// 任何 React 重渲染都会把包裹冲掉。所以这里只负责「存锚点 + 章节加载后 effect 重绘」：
// 把 (chapterIndex, blockIndex, startOffset, endOffset) 存进 IndexedDB，
// 章节进 DOM 后由 applyHighlights() 重新把对应文本区间包裹成 <mark>。
//
// 重绘是幂等的：每次先把旧 <mark> 拆掉（unwrapAll），再按锚点重新包裹，
// 所以多次调用、多次重渲染都不会累积、不会错位。

/** 与 progress.ts / Reader.tsx 的 collectBlocks 共用同一套块级选择器 */
export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre'

/** 块的纯文本（按文档顺序拼接所有文本节点） */
export function blockText(block: HTMLElement): string {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let t = ''
  let n: Node | null
  while ((n = walker.nextNode())) t += (n as Text).data
  return t
}

/** 取容器内某节点/偏移，相对容器文本的字符偏移量（UTF-16 码元，与 text 节点 .data.length 一致） */
function offsetWithin(block: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(node, offset)
  return range.toString().length
}

/** 找到节点所在的块元素（必须是 BLOCK_SELECTOR，且属于 blocks 列表） */
function closestBlock(node: Node, blocks: HTMLElement[]): HTMLElement | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const found = el?.closest?.(BLOCK_SELECTOR) as HTMLElement | null
  if (found && blocks.includes(found)) return found
  return null
}

export interface BlockAnchor {
  blockIndex: number
  startOffset: number
  endOffset: number
  text: string
}

/** 把当前选区换算成块内字符锚点；跨块 / 选空 / 选到非块元素返回 null */
export function selectionToAnchor(article: HTMLElement, selection: Selection): BlockAnchor | null {
  if (selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (range.collapsed) return null
  const blocks = Array.from(article.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[]
  if (!blocks.length) return null
  const startBlock = closestBlock(range.startContainer, blocks)
  const endBlock = closestBlock(range.endContainer, blocks)
  if (!startBlock || startBlock !== endBlock) return null
  const blockIndex = blocks.indexOf(startBlock)
  const startOffset = offsetWithin(startBlock, range.startContainer, range.startOffset)
  const endOffset = offsetWithin(startBlock, range.endContainer, range.endOffset)
  if (startOffset < 0 || endOffset <= startOffset) return null
  const text = blockText(startBlock).slice(startOffset, endOffset)
  if (!text.trim()) return null
  return { blockIndex, startOffset, endOffset, text }
}

/** 把块内字符偏移换算成 (文本节点, 节点内偏移) */
function locateInBlock(
  block: HTMLElement,
  charOffset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let count = 0
  let n: Node | null
  let last: Text | null = null
  while ((n = walker.nextNode())) {
    const len = (n as Text).data.length
    if (count + len >= charOffset) {
      return { node: n as Text, offset: charOffset - count }
    }
    count += len
    last = n as Text
  }
  // 落在末尾：用最后一个文本节点末尾
  if (last) return { node: last, offset: last.data.length }
  return null
}

/** 在块上包裹 [start,end) 为 <mark class="hl">（调用前需先 unwrapAll 保证幂等） */
function wrapRange(
  block: HTMLElement,
  start: number,
  end: number,
  annId: string,
  color?: string,
): void {
  const a = locateInBlock(block, start)
  const b = locateInBlock(block, end)
  if (!a || !b) return
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
  } catch {
    return
  }
  if (range.collapsed) return
  const frag = range.extractContents()
  const mark = document.createElement('mark')
  mark.className = 'hl'
  mark.dataset.annId = annId
  if (color) mark.style.backgroundColor = color
  mark.appendChild(frag)
  range.insertNode(mark)
}

/** 清除一个 article 内所有我们加的 <mark.hl>（保留文本），并合并文本节点 */
export function unwrapAll(article: HTMLElement): void {
  const marks = Array.from(article.querySelectorAll('mark.hl'))
  for (const m of marks) {
    const parent = m.parentNode
    if (!parent) continue
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    ;(parent as HTMLElement).normalize?.()
  }
}

/** 对一章重绘所有高亮（先清除再包裹，幂等） */
export function applyHighlights(
  article: HTMLElement,
  anns: { id: string; blockIndex: number; startOffset: number; endOffset: number; color?: string }[],
): void {
  unwrapAll(article)
  const blocks = Array.from(article.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[]
  const byBlock = new Map<number, typeof anns>()
  for (const a of anns) {
    if (!byBlock.has(a.blockIndex)) byBlock.set(a.blockIndex, [])
    byBlock.get(a.blockIndex)!.push(a)
  }
  for (const [blockIndex, list] of byBlock) {
    const block = blocks[blockIndex]
    if (!block) continue
    const sorted = [...list].sort((x, y) => x.startOffset - y.startOffset)
    // 简单重叠保护：跳过与已包裹区间重叠的高亮，避免嵌套 <mark>
    let coveredEnd = -1
    for (const ann of sorted) {
      if (ann.startOffset < coveredEnd) continue
      wrapRange(block, ann.startOffset, ann.endOffset, ann.id, ann.color)
      coveredEnd = ann.endOffset
    }
  }
}

/** 在某章内找到首个文本包含 keyword 的块，滚到它（搜索结果跳转用） */
export function scrollBlockToText(article: HTMLElement, keyword: string): boolean {
  if (!keyword) return false
  const lower = keyword.toLowerCase()
  const blocks = Array.from(article.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[]
  const target = blocks.find((b) => b.textContent?.toLowerCase().includes(lower))
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start', behavior: 'auto' })
    return true
  }
  return false
}
