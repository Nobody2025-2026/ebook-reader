import { useCallback, useEffect, useRef, useState } from 'react'
import { Library, type LibraryBook } from './components/Library'
import { Reader } from './components/Reader'
import { coverToDataUrl } from './lib/cover'
import { openEpub, type OpenedBook } from './lib/epub'
import { navigate, useHashRoute } from './lib/router'
import {
  deleteBook,
  clearProgress,
  getBookFile,
  listBooks,
  listProgress,
  saveBook,
  updateBookCover,
} from './lib/storage'

/** 正在补封面的书 id，避免 refresh 反复触发时重复解析同一本（70MB 书重复解很贵） */
const backfillingCovers = new Set<string>()

/** 本会话已确认「确实没有封面图」的书 id，避免每次进书库都白解析一遍 */
const noCoverConfirmed = new Set<string>()

/** 后台补封面：早期导入的书 cover 为空，逐个重新解析补上，幂等、不阻塞书库显示 */
async function backfillMissingCovers(
  metas: Awaited<ReturnType<typeof listBooks>>,
  afterOne: () => void,
): Promise<void> {
  for (const meta of metas) {
    if (meta.cover || backfillingCovers.has(meta.id) || noCoverConfirmed.has(meta.id)) continue
    backfillingCovers.add(meta.id)
    try {
      const file = await getBookFile(meta.id, meta.fileName)
      if (!file) continue
      let book: OpenedBook | null = null
      try {
        book = await openEpub(file)
        if (book.meta.cover) {
          const cover = await coverToDataUrl(book.meta.cover)
          if (cover) await updateBookCover(meta.id, cover)
        } else {
          // 这本书压根没封面图，标记一下，本会话不再重试
          noCoverConfirmed.add(meta.id)
        }
      } finally {
        book?.destroy()
      }
    } catch {
      // 补封面失败不影响书库使用，下回 refresh 再试
    } finally {
      backfillingCovers.delete(meta.id)
      afterOne()
    }
  }
}

export default function App() {
  const route = useHashRoute()
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [importing, setImporting] = useState(false)
  const [importHint, setImportHint] = useState('')
  // 后台补封面是异步的，可能在组件卸载后才跑完；卸载后不能再 setState，
  // 否则 React 在 jsdom 环境销毁后仍会调度更新（测试里报 "window is not defined"）。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const [metas, progress] = await Promise.all([listBooks(), listProgress()])
    if (!mountedRef.current) return
    setBooks(metas.map((meta) => ({ ...meta, progress: progress[meta.id] })))
    // 后台补封面：补完一本刷新一次书架，让封面逐个出现，不阻塞首屏
    void backfillMissingCovers(metas, () => {
      if (mountedRef.current) void refresh()
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleImport = useCallback(
    async (file: File) => {
      setImporting(true)
      setImportHint(`正在解析《${file.name}》…`)
      let book: OpenedBook | null = null
      try {
        book = await openEpub(file)
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const cover = book.meta.cover ? await coverToDataUrl(book.meta.cover) : undefined
        await saveBook(
          {
            id,
            title: book.meta.title,
            author: book.meta.author,
            cover,
            fileName: file.name,
            chapterCount: book.chapters.length,
            addedAt: Date.now(),
          },
          file,
        )
        setImportHint('')
        await refresh()
      } catch (err) {
        setImportHint(`导入失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        book?.destroy()
        setImporting(false)
      }
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteBook(id)
      await refresh()
    },
    [refresh],
  )

  const handleRestart = useCallback(
    async (id: string) => {
      await clearProgress(id)
      await refresh()
      navigate(`/read/${encodeURIComponent(id)}`)
    },
    [refresh],
  )

  const goLibrary = useCallback(() => {
    navigate('/')
    void refresh()
  }, [refresh])

  if (route.name === 'read') {
    return <Reader bookId={route.id} onExit={goLibrary} />
  }

  return (
    <Library
      books={books}
      importing={importing}
      importHint={importHint}
      onImport={(file) => void handleImport(file)}
      onOpen={(id) => navigate(`/read/${encodeURIComponent(id)}`)}
      onRestart={(id) => void handleRestart(id)}
      onDelete={(id) => void handleDelete(id)}
    />
  )
}
