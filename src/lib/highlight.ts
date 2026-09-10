// 字符级高亮：基于章节 DOM 的块级元素锚点（与进度定位共用 BLOCK_SELECTOR）。
//
// 核心思路：高亮**不靠一次性 DOM 包裹**——章节用 dangerouslySetInnerHTML 渲染，
// 任何 React 重渲染都会把包裹冲掉。所以这里只负责「存锚点 + 章节加载后 effect 重绘」：
// 把 (chapterIndex, blockIndex, startOffset, endOffset) 存进 IndexedDB，
// 章节进 DOM 后由 applyHighlights() 重新把对应文本区间包裹成 <mark>。
//
// 重绘是幂等的：每次先把旧 <mark> 拆掉（unwrapAll），再按锚点重新包裹，
// 所以多次调用、多次重渲染都不会累积、不会错位。
//
// ⚠️ 偏移口径一致性（曾导致「其他段落被高亮」的 Bug）：
// 创建选区时算偏移、与重绘时还原偏移，必须使用**同一套计数**——
// 即「块内所有文本节点的 .data.length 累加」。
// 早期版本创建时用了 range.toString().length，而重绘用的是文本节点累加；
// range.toString() 会把 <br> 渲染成 \n、折叠/转换空白，两者对不上，
// 于是高亮偏移错位、wrapRange 越界跨块，把不相关的段落也高亮了。
// 现在统一走文本节点累加，并在越界处 clamp，杜绝跨块包裹。

/** 与 progress.ts / Reader.tsx 的 collectBlocks 共用同一套块级选择器 */
export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre'

/** 块内所有文本节点的字符总长（UTF-16 码元）。与 offsetWithin / locateInBlock 同一口径 */
function blockTextLength(block: HTMLElement): number {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let total = 0
  let n: Node | null
  while ((n = walker.nextNode())) total += (n as Text).data.length
  return total
}

/** 块的纯文本（按文档顺序拼接所有文本节点） */
export function blockText(block: HTMLElement): string {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let t = ''
  let n: Node | null
  while ((n = walker.nextNode())) t += (n as Text).data
  return t
}

/**
 * 取容器内某节点/偏移，相对容器文本的字符偏移量。
 * 必须用文本节点 .data.length 累加（和定位/重绘一致），
 * 不能用 range.toString()（详见文件头说明）。
 */
function offsetWithin(block: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let count = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n === node) return count + offset
    count += (n as Text).data.length
  }
  return count
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
  const total = blockTextLength(startBlock)
  const startOffset = offsetWithin(startBlock, range.startContainer, range.startOffset)
  const endOffset = offsetWithin(startBlock, range.endContainer, range.endOffset)
  // clamp 到 [0, total]：越界会让 wrapRange 跨块或塌缩，必须拦掉
  const s = Math.max(0, Math.min(startOffset, total))
  const e = Math.max(0, Math.min(endOffset, total))
  if (e <= s) return null
  const text = blockText(startBlock).slice(s, e)
  if (!text.trim()) return null
  return { blockIndex, startOffset: s, endOffset: e, text }
}

/** 把块内字符偏移换算成 (文本节点, 节点内偏移)；超出总长则 clamp 到末尾 */
function locateInBlock(
  block: HTMLElement,
  charOffset: number,
): { node: Text; offset: number } | null {
  const total = blockTextLength(block)
  const clamped = Math.max(0, Math.min(charOffset, total))
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let count = 0
  let n: Node | null
  let last: Text | null = null
  while ((n = walker.nextNode())) {
    const len = (n as Text).data.length
    if (count + len >= clamped) return { node: n as Text, offset: clamped - count }
    count += len
    last = n as Text
  }
  // 落在末尾：用最后一个文本节点末尾
  if (last) return { node: last, offset: last.data.length }
  return null
}

/** 在块上包裹 [start,end) 为 <mark class="hl">。调用前需先 unwrapAll 保证幂等。 */
function wrapRange(
  block: HTMLElement,
  start: number,
  end: number,
  annId: string,
  color?: string,
  allIds?: string[],
): void {
  const a = locateInBlock(block, start)
  const b = locateInBlock(block, end)
  if (!a || !b) return
  // 两个端点都必须在这个 block 内，杜绝跨块包裹（曾导致其他段落被高亮）
  if (!block.contains(a.node) || !block.contains(b.node)) return
  // 同节点且起点>=终点 → 塌缩，跳过
  if (a.node === b.node && a.offset >= b.offset) return
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
  } catch {
    return
  }
  if (range.collapsed) return
  // extractContents / insertNode 在个别脏 HTML 结构下会抛（半截标签、异常嵌套）。
  // 这里必须吞掉：否则异常会顺着 applyHighlights 往上冒，
  // 而 unwrapAll 已经执行过了 → 整章高亮全被清空且再也画不回来。
  try {
    const frag = range.extractContents()
    const mark = document.createElement('mark')
    mark.className = 'hl'
    mark.dataset.annId = annId
    if (allIds && allIds.length) mark.dataset.annIds = allIds.join(',')
    if (color) mark.style.backgroundColor = color
    mark.appendChild(frag)
    range.insertNode(mark)
  } catch {
    /* 单段包裹失败：跳过这一段，其余高亮照常绘制 */
  }
}

/** 清除一个 article 内所有我们加的 <mark.hl>（保留文本），并合并文本节点 */
export function unwrapAll(article: HTMLElement): void {
  const marks = Array.from(article.querySelectorAll('mark.hl'))
  for (const m of marks) {
    const parent = m.parentNode
    if (!parent) continue
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    try {
      ;(parent as HTMLElement).normalize?.()
    } catch {
      /* noop */
    }
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
    try {
      const total = blockTextLength(block)
      const sorted = [...list].sort((x, y) => x.startOffset - y.startOffset)
      //
      // 重叠区间**合并**而不是丢弃。
      // 早期版本用「跳过与前面重叠的」保护嵌套，结果是：先选一小段、再选一大段把它包住时，
      // 大段先画、小段因起点落在已覆盖区内被丢弃 → 用户看到"之前的高亮消失了"。
      // 合并成一段连续 <mark> 后，视觉上稳定，被合并的 id 记在 data-ann-ids 上，
      // 导出/删除仍按原始多条处理（数据一条不少）。
      const merged: { start: number; end: number; ids: string[]; color?: string }[] = []
      for (const ann of sorted) {
        const s = Math.max(0, Math.min(ann.startOffset, total))
        const e = Math.max(0, Math.min(ann.endOffset, total))
        if (e <= s) continue
        const last = merged[merged.length - 1]
        if (last && s <= last.end) {
          last.end = Math.max(last.end, e)
          last.ids.push(ann.id)
        } else {
          merged.push({ start: s, end: e, ids: [ann.id], color: ann.color })
        }
      }
      for (const seg of merged) {
        // 单段失败不能影响其他段（见 wrapRange 里的说明）
        try {
          wrapRange(block, seg.start, seg.end, seg.ids[0], seg.color, seg.ids)
        } catch {
          /* 继续画下一段 */
        }
      }
    } catch {
      // 整个块出问题也只丢这一块，不中断其他块的重绘
      continue
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
