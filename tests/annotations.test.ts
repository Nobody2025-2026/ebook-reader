// 高亮与笔记的存储层测试（fake-indexeddb）。
import { beforeEach, describe, expect, it } from 'vitest'
import { clear } from 'idb-keyval'
import {
  addAnnotation,
  deleteBook,
  exportAnnotations,
  listAnnotations,
  newAnnotationId,
  removeAnnotation,
  saveBook,
  updateAnnotationNote,
  type Annotation,
  type BookMeta,
} from '../src/lib/storage'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 3,
  addedAt: 1_000,
}

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: newAnnotationId(),
    bookId: 'b1',
    chapterIndex: 1,
    blockIndex: 2,
    startOffset: 0,
    endOffset: 5,
    text: 'hello',
    color: 'rgba(255, 224, 102, 0.6)',
    createdAt: Date.now(),
    ...over,
  }
}

beforeEach(async () => {
  await clear()
})

describe('annotations storage', () => {
  it('add / list / update / remove 全链路', async () => {
    const a = ann()
    expect(await addAnnotation('b1', a)).toBe(true)
    // 同一区间重复添加被去重
    expect(await addAnnotation('b1', { ...a, id: 'other' })).toBe(false)
    let list = await listAnnotations('b1')
    expect(list.length).toBe(1)

    await updateAnnotationNote('b1', a.id, '我的笔记')
    list = await listAnnotations('b1')
    expect(list[0].note).toBe('我的笔记')

    await removeAnnotation('b1', a.id)
    expect(await listAnnotations('b1')).toEqual([])
  })

  it('按章节排序返回', async () => {
    await addAnnotation('b1', ann({ chapterIndex: 2, startOffset: 0, endOffset: 1, text: 'c' }))
    await addAnnotation('b1', ann({ chapterIndex: 0, startOffset: 0, endOffset: 1, text: 'a' }))
    const list = await listAnnotations('b1')
    expect(list.map((x) => x.chapterIndex)).toEqual([0, 2])
  })

  it('exportAnnotations 生成 Markdown（含笔记）', async () => {
    await saveBook(meta, new File(['x'], 'b.epub'))
    await addAnnotation('b1', ann({ id: '1', chapterIndex: 0, blockIndex: 0, startOffset: 0, endOffset: 4, text: 'abcd' }))
    await addAnnotation(
      'b1',
      ann({ id: '2', chapterIndex: 0, blockIndex: 1, startOffset: 0, endOffset: 3, text: 'xyz', note: '笔记一' }),
    )
    const md = await exportAnnotations('b1', '测试书')
    expect(md).toContain('# 测试书')
    expect(md).toContain('> abcd')
    expect(md).toContain('笔记一')
  })

  it('空书导出也给出友好提示', async () => {
    const md = await exportAnnotations('b1', '空书')
    expect(md).toContain('还没有高亮或笔记')
  })

  it('deleteBook 级联删高亮，不留孤儿', async () => {
    await saveBook(meta, new File(['x'], 'b.epub'))
    await addAnnotation('b1', ann({ id: '1' }))
    await deleteBook('b1')
    expect(await listAnnotations('b1')).toEqual([])
  })
})
