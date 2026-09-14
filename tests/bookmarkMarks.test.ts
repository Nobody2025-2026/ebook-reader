// @vitest-environment jsdom
//
// 书签的正文标记（v0.1.6）：往章节 DOM 的块上打 / 摘 `.has-bookmark`。
//
// 单独一个文件而不是塞进 bookmark.test.ts：那边声明了 `@vitest-environment node`
// （纯逻辑，跑得最快），而这里必须有 DOM。jsdom 里 clientHeight 恒为 0，
// 但标记只依赖块列表，与尺寸无关，所以这里不需要伪造尺寸。
import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_BLOCK_CLASS,
  applyBookmarkMarks,
  countBookmarkMarks,
} from '../src/lib/bookmark'

/** 造一个章节容器：块下标 0..3（p / p / h2 / li，都在 BLOCK_SELECTOR 里） */
function mountArticle(): HTMLElement {
  const art = document.createElement('article')
  art.className = 'chapter'
  art.innerHTML = '<p>一</p><p>二</p><h2>标题</h2><li>列表项</li>'
  document.body.appendChild(art)
  return art
}

function marked(art: HTMLElement): number {
  return art.querySelectorAll(`.${BOOKMARK_BLOCK_CLASS}`).length
}

function blocks(art: HTMLElement): Element[] {
  return Array.from(art.querySelectorAll('p, h2, li'))
}

describe('applyBookmarkMarks', () => {
  it('只给指定块打标记，其他块一个都不碰', () => {
    const art = mountArticle()
    try {
      applyBookmarkMarks(art, [1, 3])
      const b = blocks(art)
      expect(b[0].classList.contains(BOOKMARK_BLOCK_CLASS)).toBe(false)
      expect(b[1].classList.contains(BOOKMARK_BLOCK_CLASS)).toBe(true)
      expect(b[2].classList.contains(BOOKMARK_BLOCK_CLASS)).toBe(false)
      expect(b[3].classList.contains(BOOKMARK_BLOCK_CLASS)).toBe(true)
      expect(marked(art)).toBe(2)
    } finally {
      document.body.removeChild(art)
    }
  })

  it('幂等：重复调用既不叠加、也不会把已有标记弄丢', () => {
    const art = mountArticle()
    try {
      applyBookmarkMarks(art, [0])
      applyBookmarkMarks(art, [0])
      expect(marked(art)).toBe(1)
    } finally {
      document.body.removeChild(art)
    }
  })

  it('传空数组 = 全部摘掉（取消书签后不能留下幽灵竖线）', () => {
    const art = mountArticle()
    try {
      applyBookmarkMarks(art, [0, 2])
      expect(marked(art)).toBe(2)
      applyBookmarkMarks(art, [])
      expect(marked(art)).toBe(0)
    } finally {
      document.body.removeChild(art)
    }
  })

  it('越界 / 负数下标一律忽略（章节内容变了、块数变少时不能崩）', () => {
    const art = mountArticle()
    try {
      applyBookmarkMarks(art, [99, -1])
      expect(marked(art)).toBe(0)
    } finally {
      document.body.removeChild(art)
    }
  })

  it('重复下标只算一次', () => {
    const art = mountArticle()
    try {
      applyBookmarkMarks(art, [1, 1, 1])
      expect(marked(art)).toBe(1)
    } finally {
      document.body.removeChild(art)
    }
  })

  it('只加 class，不动文本内容（正文一个字都不能变）', () => {
    const art = mountArticle()
    try {
      const before = art.textContent
      applyBookmarkMarks(art, [0, 1, 2, 3])
      expect(art.textContent).toBe(before)
      expect(art.querySelectorAll('mark')).toHaveLength(0)
    } finally {
      document.body.removeChild(art)
    }
  })
})

describe('countBookmarkMarks', () => {
  it('数"理应几个块带标记"，越界与重复都剔除 —— 与 applyBookmarkMarks 同口径', () => {
    const art = mountArticle()
    try {
      // 4 个块；1、3 有效且去重，99 越界 → 应有 2 个
      expect(countBookmarkMarks(art, [1, 3, 3, 99])).toBe(2)
      // 脏检查的前提：画完之后，实际数量必须等于这个"应有数量"，
      // 否则每次渲染都会重画（白跑），或者该画的时候不画（标记丢失）
      applyBookmarkMarks(art, [1, 3, 99])
      expect(marked(art)).toBe(countBookmarkMarks(art, [1, 3, 99]))
    } finally {
      document.body.removeChild(art)
    }
  })
})
