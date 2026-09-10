// 高亮 DOM 工具测试（jsdom）：选区→锚点、applyHighlights 包裹与幂等、unwrapAll。
// 直接对构造的 DOM 操作，不依赖 React 渲染，确定性高。
import { describe, expect, it } from 'vitest'
import { applyHighlights, BLOCK_SELECTOR, selectionToAnchor, unwrapAll } from '../src/lib/highlight'

function mountArticle(html: string): HTMLElement {
  const art = document.createElement('article')
  art.setAttribute('data-chapter-index', '0')
  art.innerHTML = html
  document.body.appendChild(art)
  return art
}

function selectText(el: HTMLElement, start: number, end: number) {
  const textNode = el.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, start)
  range.setEnd(textNode, end)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  return sel
}

describe('highlight DOM', () => {
  it('selectionToAnchor 把单块选区换算成字符偏移', () => {
    const art = mountArticle('<p>hello world foo</p><p>second para</p>')
    try {
      const p = art.querySelectorAll(BLOCK_SELECTOR)[0] as HTMLElement
      const sel = selectText(p, 0, 5)
      const anchor = selectionToAnchor(art, sel)!
      expect(anchor).not.toBeNull()
      expect(anchor.blockIndex).toBe(0)
      expect(anchor.startOffset).toBe(0)
      expect(anchor.endOffset).toBe(5)
      expect(anchor.text).toBe('hello')
    } finally {
      document.body.removeChild(art)
    }
  })

  it('跨块选区返回 null（字符级只支持单块）', () => {
    const art = mountArticle('<p>aaa</p><p>bbb</p>')
    try {
      const p0 = art.querySelectorAll(BLOCK_SELECTOR)[0] as HTMLElement
      const p1 = art.querySelectorAll(BLOCK_SELECTOR)[1] as HTMLElement
      const range = document.createRange()
      range.setStart(p0.firstChild as Text, 1)
      range.setEnd(p1.firstChild as Text, 1)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      expect(selectionToAnchor(art, sel)).toBeNull()
    } finally {
      document.body.removeChild(art)
    }
  })

  it('applyHighlights 包裹 + 幂等（重复调用不产生嵌套 / 不变文本）', () => {
    const art = mountArticle('<p>abcdefghij</p>')
    document.body.appendChild(art)
    try {
      applyHighlights(art, [{ id: '1', blockIndex: 0, startOffset: 0, endOffset: 3, color: 'yellow' }])
      let mark = art.querySelector('mark.hl') as HTMLElement
      expect(mark).toBeTruthy()
      expect(mark.textContent).toBe('abc')

      // 再跑一次同样的：不应嵌套，文本不变
      applyHighlights(art, [{ id: '1', blockIndex: 0, startOffset: 0, endOffset: 3 }])
      expect(art.querySelectorAll('mark.hl').length).toBe(1)
      expect(art.textContent).toBe('abcdefghij')
    } finally {
      document.body.removeChild(art)
    }
  })

  it('applyHighlights 多段高亮互不重叠时都画上', () => {
    const art = mountArticle('<p>abcdefghij</p>')
    document.body.appendChild(art)
    try {
      applyHighlights(art, [
        { id: '1', blockIndex: 0, startOffset: 0, endOffset: 3 },
        { id: '2', blockIndex: 0, startOffset: 5, endOffset: 8 },
      ])
      const marks = art.querySelectorAll('mark.hl')
      expect(marks.length).toBe(2)
      expect(marks[0].textContent).toBe('abc')
      expect(marks[1].textContent).toBe('fgh')
    } finally {
      document.body.removeChild(art)
    }
  })

  it('unwrapAll 清除所有高亮并恢复纯文本', () => {
    const art = mountArticle('<p>abcdefghij</p>')
    document.body.appendChild(art)
    try {
      applyHighlights(art, [{ id: '1', blockIndex: 0, startOffset: 2, endOffset: 6 }])
      expect(art.querySelector('mark.hl')).toBeTruthy()
      unwrapAll(art)
      expect(art.querySelector('mark.hl')).toBeNull()
      expect(art.textContent).toBe('abcdefghij')
    } finally {
      document.body.removeChild(art)
    }
  })
})
