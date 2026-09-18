import { useCallback, useEffect, useRef, useState } from 'react'
import { Library, type LibraryBook } from './components/Library'
import { Reader } from './components/Reader'
import { COVER_VERSION, coverToDataUrl, isValidCoverDataUrl } from './lib/cover'
import { openEpub, type OpenedBook } from './lib/epub'
import { dismissStorageHint, ensurePersistentStorage, isStorageHintDismissed } from './lib/persistence'
import { navigate, useHashRoute } from './lib/router'
import {
  deleteBook,
  clearProgress,
  getBookFile,
  listBooks,
  listProgress,
  listStats,
  saveBook,
  updateBookCover,
  writeErrorText,
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
    // 跳过条件：封面有效**且**是用当前版本的算法提取的。
    // 只看"有没有封面"不够——封面提错了也是合法 data URL，代码无从判断对错，
    // 所以靠版本号识别：算法一改（COVER_VERSION +1），旧封面自动重取。
    const coverIsCurrent =
      isValidCoverDataUrl(meta.cover) && (meta.coverVersion ?? 0) >= COVER_VERSION
    if (coverIsCurrent || backfillingCovers.has(meta.id) || noCoverConfirmed.has(meta.id)) {
      continue
    }
    backfillingCovers.add(meta.id)
    try {
      const file = await getBookFile(meta.id, meta.fileName)
      if (!file) continue
      let book: OpenedBook | null = null
      try {
        book = await openEpub(file)
        if (book.meta.cover) {
          const cover = await coverToDataUrl(book.meta.cover)
          if (cover) await updateBookCover(meta.id, cover, COVER_VERSION)
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
  // 浏览器拒绝持久化存储时（磁盘紧张会连带把书、进度、笔记一起清掉），
  // 书库给一条常驻提示，引导用户用导出做备份。拿不到保护是真事，不该瞒着用户。
  const [storageUnprotected, setStorageUnprotected] = useState(false)
  /**
   * 书库**读不出来**与「书库是空的」是两回事，绝不能混为一谈：
   * 数据库打不开时降级成空书架，用户看到的是"我的书全没了"。
   * 所以要单独一个错误态，并且明确告诉他"书还在浏览器里"。
   */
  const [libraryError, setLibraryError] = useState('')
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
    // listBooks 是**唯一没降级**的读操作：书库读不出来必须让这里拿到错误，
    // 降级成空书架 = 骗用户说"你没书了"。进度和统计读不出来则无妨（列表已降级）。
    let metas: Awaited<ReturnType<typeof listBooks>>
    try {
      metas = await listBooks()
    } catch (err) {
      if (mountedRef.current) setLibraryError(writeErrorText(err, '打开书库'))
      return
    }
    const [progress, stats] = await Promise.all([listProgress(), listStats()])
    if (!mountedRef.current) return
    setLibraryError('')
    setBooks(metas.map((meta) => ({ ...meta, progress: progress[meta.id], stats: stats[meta.id] })))
    // 后台补封面：补完一本刷新一次书架，让封面逐个出现，不阻塞首屏
    void backfillMissingCovers(metas, () => {
      if (mountedRef.current) void refresh()
    })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 启动时安静地申请一次持久化存储。只有明确被拒才留痕；
  // 'unsupported'（老浏览器 / 私密模式）提示了用户也无能为力，只会添噪音。
  // 用户说过"不再提示"就直接跳过，连申请都省了。
  useEffect(() => {
    if (isStorageHintDismissed()) return
    void ensurePersistentStorage().then((state) => {
      if (mountedRef.current && state === 'denied') setStorageUnprotected(true)
    })
  }, [])

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
            coverVersion: cover ? COVER_VERSION : undefined,
            fileName: file.name,
            chapterCount: book.chapters.length,
            addedAt: Date.now(),
          },
          file,
        )
        setImportHint('')
        await refresh()
      } catch (err) {
        setImportHint(writeErrorText(err, '导入书籍'))
      } finally {
        book?.destroy()
        setImporting(false)
      }
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteBook(id)
        await refresh()
      } catch (err) {
        // 删不掉必须说：一声不吭的话，用户看着书还在、却以为删了（或反过来）
        setImportHint(writeErrorText(err, '删除书籍'))
      }
    },
    [refresh],
  )

  const handleRestart = useCallback(
    async (id: string) => {
      try {
        await clearProgress(id)
        await refresh()
        navigate(`/read/${encodeURIComponent(id)}`)
      } catch (err) {
        // 进度没清掉就别进阅读页——否则用户翻回第一页才发现"从头读"没生效
        setImportHint(writeErrorText(err, '清除进度'))
      }
    },
    [refresh],
  )

  const goLibrary = useCallback(() => {
    navigate('/')
    void refresh()
  }, [refresh])

  const dismissStorageWarning = useCallback(() => {
    dismissStorageHint()
    setStorageUnprotected(false)
  }, [])

  if (route.name === 'read') {
    return <Reader bookId={route.id} onExit={goLibrary} />
  }

  if (libraryError) {
    return (
      <div className="state-page" role="alert">
        <h1 className="state-hint state-error">书库打不开</h1>
        <p className="state-sub">{libraryError}</p>
        <p className="state-sub">
          你的书还在这台设备上，<strong>没有丢失</strong>。请别清理浏览器数据，过一会儿再试。
        </p>
        <div className="state-actions">
          <button className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <Library
      books={books}
      importing={importing}
      importHint={importHint}
      storageUnprotected={storageUnprotected}
      onDismissStorageWarning={dismissStorageWarning}
      onImport={(file) => void handleImport(file)}
      onOpen={(id) => navigate(`/read/${encodeURIComponent(id)}`)}
      onRestart={(id) => void handleRestart(id)}
      onDelete={(id) => void handleDelete(id)}
    />
  )
}
