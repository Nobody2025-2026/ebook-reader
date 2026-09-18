// 存储「写失败」的行为测试。
//
// 为什么单独一个文件：存储会失败（配额满 / 隐私模式 / 用户清了站点数据），
// 而**写失败不吭声是最坏的一种失败** —— 用户点了「加高亮」，界面上什么都没发生，
// 他以为存住了，下次打开书一条都没有。所以这里的断言只有两条主线：
//   1. 写失败**必须抛**，而且抛的是能给用户看的人话（不是 DOMException 那种只有 name 的）；
//   2. 失败之后**库里确实没变**（严格一致：界面不显示 = 库里没存）。
//
// 手法：把 idb-keyval 的 set/del 挡一层，开关打开时抛指定错误。
// 不 mock 整个存储层——那样测的是 mock，不是我们的代码。
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 会被提升，外部变量拿不到，状态必须放在 hoisted 里
const ctl = vi.hoisted(() => ({
  failWrites: false,
  error: null as unknown,
}))

vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>()
  const maybeFail = async () => {
    if (ctl.failWrites) throw ctl.error
  }
  return {
    ...actual,
    set: async (...args: Parameters<typeof actual.set>) => {
      await maybeFail()
      return actual.set(...args)
    },
    del: async (...args: Parameters<typeof actual.del>) => {
      await maybeFail()
      return actual.del(...args)
    },
  }
})

import { clear } from 'idb-keyval'
import {
  StorageWriteError,
  addAnnotation,
  addBookmark,
  addReadingSeconds,
  clearProgress,
  deleteBook,
  getProgress,
  listAnnotations,
  listBookmarks,
  removeAnnotation,
  removeBookmark,
  saveBook,
  saveProgress,
  touchOpen,
  updateAnnotationColor,
  updateAnnotationNote,
  updateBookCover,
  writeErrorText,
  type Annotation,
  type BookMeta,
} from '../src/lib/storage'
// 排版设置与自定义字体这两个模块**自己** import idb-keyval 落库，
// 曾经绕过守卫（写失败变成未捕获的 rejection，真浏览器复核时才抓到）。
// 这里把它们一并纳入，防止以后有人再把守卫绕开。
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/lib/settings'
import { addCustomFont, listCustomFonts, removeCustomFont } from '../src/lib/customFont'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 3,
  addedAt: 1_000,
}

function ann(): Annotation {
  return {
    id: 'a1',
    bookId: 'b1',
    chapterIndex: 0,
    blockIndex: 0,
    startOffset: 0,
    endOffset: 3,
    text: 'abc',
    createdAt: Date.now(),
  }
}

function bookmark() {
  return {
    id: 'bm1',
    chapterIndex: 0,
    blockIndex: 0,
    excerpt: 'x',
    percent: 0.1,
    createdAt: Date.now(),
  }
}

function progress() {
  return { chapterIndex: 0, blockIndex: 0, percent: 0.1, updatedAt: Date.now() }
}

/** 让后续所有写入失败，cause 用真实浏览器给的那类 DOMException */
function failWith(err: unknown) {
  ctl.error = err
  ctl.failWrites = true
}

function quotaError() {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError')
}

beforeEach(async () => {
  ctl.failWrites = false
  ctl.error = null
  await clear()
  // 先摆一本正常的书进去：updateBookCover 找不到 meta 会直接 return（不是失败），
  // 那样就测不到"真的写"这一下了。
  await saveBook(meta, new Blob(['x']))
})

describe('写失败必须抛得明白', () => {
  it('配额满 → 抛 StorageWriteError，文案说人话而不是 DOMException', async () => {
    failWith(quotaError())
    await expect(addAnnotation('b1', ann())).rejects.toBeInstanceOf(StorageWriteError)
    await expect(addAnnotation('b1', ann())).rejects.toThrow(/添加高亮失败/)
    await expect(addAnnotation('b1', ann())).rejects.toThrow(/存储空间已满/)
  })

  it('隐私模式（InvalidStateError）会被翻译成"浏览器不允许写入"', async () => {
    failWith(new DOMException('The database is not running', 'InvalidStateError'))
    await expect(saveProgress('b1', progress())).rejects.toThrow(/浏览器不允许写入/)
  })

  it('认不出的错误：原样带上，不瞎编原因', async () => {
    failWith(new Error('磁盘坏了'))
    await expect(clearProgress('b1')).rejects.toThrow(/磁盘坏了/)
  })

  it('原始错误留在 cause 上，方便排查（翻译可能不准）', async () => {
    const raw = quotaError()
    failWith(raw)
    await expect(touchOpen('b1')).rejects.toMatchObject({ cause: raw })
  })

  it('13 个写操作无一例外都会抛（新增函数漏加守卫会被这里逮住）', async () => {
    const writes: Array<[string, () => Promise<unknown>]> = [
      ['导入书籍', () => saveBook(meta, new Blob(['x']))],
      ['保存进度', () => saveProgress('b1', progress())],
      ['清除进度', () => clearProgress('b1')],
      ['添加书签', () => addBookmark('b1', bookmark())],
      ['删除书签', () => removeBookmark('b1', 'bm1')],
      ['更新封面', () => updateBookCover('b1', 'data:image/png;base64,AAA', 3)],
      ['删除书籍', () => deleteBook('b1')],
      ['添加高亮', () => addAnnotation('b1', ann())],
      ['保存笔记', () => updateAnnotationNote('b1', 'a1', 'note')],
      ['修改高亮颜色', () => updateAnnotationColor('b1', 'a1', 'red')],
      ['删除高亮', () => removeAnnotation('b1', 'a1')],
      ['记录阅读', () => touchOpen('b1')],
      ['记录阅读时长', () => addReadingSeconds('b1', 30)],
    ]
    expect(writes).toHaveLength(13)
    for (const [label, run] of writes) {
      failWith(quotaError())
      await expect(run(), label).rejects.toBeInstanceOf(StorageWriteError)
    }
  })
})

describe('失败之后库里确实没变（严格一致的前提）', () => {
  it('高亮没存进去，恢复后读出来是空的', async () => {
    failWith(quotaError())
    await expect(addAnnotation('b1', ann())).rejects.toBeInstanceOf(StorageWriteError)

    ctl.failWrites = false
    expect(await listAnnotations('b1')).toEqual([])
  })

  it('书签没存进去，恢复后读出来是空的', async () => {
    failWith(quotaError())
    await expect(addBookmark('b1', bookmark())).rejects.toBeInstanceOf(StorageWriteError)

    ctl.failWrites = false
    expect(await listBookmarks('b1')).toEqual([])
  })

  it('进度没存进去，恢复后读不到进度', async () => {
    failWith(quotaError())
    await expect(saveProgress('b1', progress())).rejects.toBeInstanceOf(StorageWriteError)

    ctl.failWrites = false
    expect(await getProgress('b1')).toBeUndefined()
  })
})

describe('读操作不受影响（本轮只管写）', () => {
  it('写失败时读依然正常，不会因为"库坏了"而误报空书库', async () => {
    failWith(quotaError())
    await expect(addAnnotation('b1', ann())).rejects.toBeInstanceOf(StorageWriteError)
    // 读走的是另一条路（get/keys），本轮没给它加降级，但至少不能被写失败污染
    ctl.failWrites = false
    expect(await listAnnotations('b1')).toEqual([])
  })
})

describe('writeErrorText（调用方统一用它生成提示文案）', () => {
  it('StorageWriteError 直接用人话原文', async () => {
    failWith(quotaError())
    const err = await addBookmark('b1', bookmark()).catch((e: unknown) => e)
    expect(writeErrorText(err, '添加书签')).toBe('添加书签失败：存储空间已满，删几本书再试')
  })

  it('别的错误走 fallback，不会串味', () => {
    expect(writeErrorText(new Error('解析炸了'), '导入书籍')).toBe('导入书籍：解析炸了')
    expect(writeErrorText('字符串错误', '删除书籍')).toBe('删除书籍：字符串错误')
  })
})

// ---------------------------------------------------------------------------
// 排版设置 / 自定义字体：曾经绕过守卫的两个模块
//
// 背景：真浏览器复核（.workbuddy/tools/reader-quota-check.py）时，把"写满"开关
// 一打开，页面立刻冒出未捕获的 `The quota has been exceeded.` —— 顺着查到
// settings.ts 与 customFont.ts 直接 import idb-keyval，写失败没人接。
// 守卫已抽到 src/lib/idb-guard.ts 由三个模块共用，这几条负责钉住它。
// ---------------------------------------------------------------------------
describe('排版设置（settings.ts 走同一套守卫）', () => {
  it('保存失败必须抛 StorageWriteError，不说人话就没人知道字号没存上', async () => {
    failWith(quotaError())
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toBeInstanceOf(StorageWriteError)
    const err = await saveSettings(DEFAULT_SETTINGS).catch((e: unknown) => e)
    expect((err as Error).message).toContain('保存排版设置失败')
    expect((err as Error).message).toContain('存储空间已满')
  })

  it('读取失败降级为默认设置——进不去书比排版回到默认严重得多', async () => {
    ctl.failWrites = false
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 读走 get：让它抛，验证是降级而不是把页面搞崩
    const getSpy = vi.spyOn(await import('idb-keyval'), 'get')
    getSpy.mockRejectedValueOnce(new DOMException('boom', 'InvalidStateError'))
    const s = await loadSettings()
    expect(s).toEqual(DEFAULT_SETTINGS)
    getSpy.mockRestore()
    spy.mockRestore()
  })

  it('写入正常时能存能读', async () => {
    ctl.failWrites = false
    await expect(saveSettings({ ...DEFAULT_SETTINGS, fontSize: 24 })).resolves.toBeUndefined()
    expect((await loadSettings()).fontSize).toBe(24)
  })
})

describe('自定义字体（customFont.ts 走同一套守卫）', () => {
  const fontFile = () =>
    new File([new Uint8Array([1, 2, 3, 4])], 'test.ttf', { type: 'font/ttf' })

  it('字体二进制保存失败必须抛（几 MB 的东西最撞配额）', async () => {
    failWith(quotaError())
    await expect(addCustomFont(fontFile())).rejects.toBeInstanceOf(StorageWriteError)
    const err = await addCustomFont(fontFile()).catch((e: unknown) => e)
    expect((err as Error).message).toContain('保存字体文件失败')
  })

  it('删除失败也必须抛——否则界面上没了、刷新又冒出来', async () => {
    failWith(quotaError())
    await expect(removeCustomFont('f1')).rejects.toBeInstanceOf(StorageWriteError)
  })

  it('读取失败降级为空列表（没有自定义字体照样能读书）', async () => {
    ctl.failWrites = false
    const getSpy = vi.spyOn(await import('idb-keyval'), 'get')
    getSpy.mockRejectedValueOnce(new DOMException('boom', 'InvalidStateError'))
    await expect(listCustomFonts()).resolves.toEqual([])
    getSpy.mockRestore()
  })
})
