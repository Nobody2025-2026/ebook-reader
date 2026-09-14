import { useCallback, useEffect, useRef, useState } from 'react'
import { webBookSource } from '../lib/bookSource'
import {
  filterBooks,
  sortBooks,
  SORT_KEYS,
  SORT_LABELS,
  type SortKey,
} from '../lib/bookList'
import { isValidCoverDataUrl } from '../lib/cover'
import type { ReadingProgress } from '../lib/progress'
import type { BookMeta, ReadingStats } from '../lib/storage'

export interface LibraryBook extends BookMeta {
  progress?: ReadingProgress
  stats?: ReadingStats
}

/**
 * 「已移除 · 撤销」窗口时长。8 秒参照主流 App（Gmail 5–10 秒）：
 * 够看清自己点错了，又不至于让书架长时间停在"没删干净"的状态。
 */
export const UNDO_DELETE_MS = 8000

function formatReadingTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `已读 ${h} 小时 ${m} 分`
  if (m > 0) return `已读 ${m} 分`
  return `已读 ${totalSeconds} 秒`
}

interface Props {
  books: LibraryBook[]
  importing: boolean
  importHint: string
  /** 浏览器拒绝持久化存储：数据可能被自动清除，提示用户导出备份 */
  storageUnprotected?: boolean
  /** 用户点了「不再提示」 */
  onDismissStorageWarning?: () => void
  onImport: (file: File) => void
  onOpen: (id: string) => void
  /** 从头读：清除进度后打开（区别于「继续阅读」的自动恢复） */
  onRestart: (id: string) => void
  onDelete: (id: string) => void
}

export function Library({
  books,
  importing,
  importHint,
  storageUnprotected,
  onDismissStorageWarning,
  onImport,
  onOpen,
  onRestart,
  onDelete,
}: Props) {
  const [dragging, setDragging] = useState(false)
  // 待确认删除的书：点 × 先弹确认框，**不再一键直删**（删掉的是书+进度+书签+笔记+统计）
  const [confirmBook, setConfirmBook] = useState<LibraryBook | null>(null)
  // 撤销窗口内被"乐观移除"的书（仅用于渲染时隐藏，IndexedDB 里还没动）
  const [pendingBook, setPendingBook] = useState<LibraryBook | null>(null)
  // 计时器与"待落库的书"都放 ref：状态更新不该牵连计时器重建
  const pendingRef = useRef<{ book: LibraryBook; timer: number } | null>(null)

  // onDelete 来自 App 的箭头函数，每次渲染都是新引用。若直接写进 effect 依赖数组，
  // 清理函数会在每次 App 重渲染时触发，撤销窗口会被当场冲掉 → 一律走 ref。
  const onDeleteRef = useRef(onDelete)
  useEffect(() => {
    onDeleteRef.current = onDelete
  })

  /** 立刻把撤销窗口里的删除落库（窗口到期 / 出现新的删除 / 离开书库时调用） */
  const flushPending = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRef.current = null
    setPendingBook(null)
    void onDeleteRef.current(pending.book.id)
  }, [])

  /** 撤销：窗口内 IndexedDB 压根没写，所以只需取消计时器 + 让卡片重新显示 */
  const undoRemove = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRef.current = null
    setPendingBook(null)
  }, [])

  const removeWithUndo = (book: LibraryBook) => {
    setConfirmBook(null)
    // 只保留一个撤销窗口：上一个立即落库，避免"撤销"按钮指向哪本书产生歧义
    flushPending()
    const timer = window.setTimeout(() => {
      pendingRef.current = null
      setPendingBook(null)
      void onDeleteRef.current(book.id)
    }, UNDO_DELETE_MS)
    pendingRef.current = { book, timer }
    setPendingBook(book)
  }

  // 离开书库（比如去打开另一本书）时补齐未到期的删除。
  // 否则用户"看着它删了"，下次回到书库书又在那儿 —— 正是我们要消灭的那种困惑。
  // 代价：8 秒内直接关掉标签页，这次删除不会发生（书留着）。宁可少删，不可错删。
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (pending) {
        clearTimeout(pending.timer)
        void onDeleteRef.current(pending.book.id)
      }
    },
    [],
  )

  // 确认框开着时按 Esc = 取消（默认焦点给「取消」，回车也不会误删）
  useEffect(() => {
    if (!confirmBook) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmBook(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmBook])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = webBookSource.fromDrop(e.dataTransfer)
    if (file) onImport(file)
  }

  // 撤销窗口内的书先藏起来（乐观移除）；此时 books 里其实还有它
  const visibleBooks = pendingBook ? books.filter((b) => b.id !== pendingBook.id) : books

  // ---- 排序 / 筛选（P1-6）----
  // 原先只有"导入时间倒序"一种排法。书一多（>20 本）就找不到想读的那本。
  const [sortKey, setSortKey] = useState<SortKey>('added')
  const [filterText, setFilterText] = useState('')
  const shownBooks = sortBooks(filterBooks(visibleBooks, filterText), sortKey)

  return (
    <div
      className={`library${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <header className="library-bar">
        <h1 className="library-heading">自制阅读器</h1>
        <button className="btn" disabled={importing} onClick={() => void webBookSource.pickFile().then((f) => f && onImport(f))}>
          {importing ? '导入中…' : '导入书籍'}
        </button>
      </header>

      {importHint && <p className="library-hint">{importHint}</p>}

      {/* 空书架时不说这些：没东西可丢，先提示只会让人以为软件有问题。
          有书了再说，并且允许一键永久关掉——否则天天见面就成了噪音，用户会连其他提示一起无视。 */}
      {storageUnprotected && visibleBooks.length > 0 && (
        <p className="library-hint library-hint--warn">
          浏览器没有把本站数据列为「永久保留」，磁盘紧张或清理缓存时可能连书架一起清掉。
          重要笔记建议在阅读页用「笔记 → 导出」备份。
          <button className="library-hint__dismiss" onClick={onDismissStorageWarning}>
            不再提示
          </button>
        </p>
      )}

      {/* 排序 / 筛选工具条（P1-6）。书架非空才出现——空书架时它只是噪音。 */}
      {visibleBooks.length > 0 && (
        <div className="library-tools">
          <input
            type="search"
            className="library-tools__filter"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="按书名 / 作者筛选"
            aria-label="筛选书籍"
          />
          <label className="library-tools__sort">
            <span>排序</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="排序方式"
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {visibleBooks.length === 0 ? (
        <div className="empty">
          <p className="empty-title">书架是空的</p>
          <p className="empty-sub">把 EPUB 拖进来，或者点上面的「导入书籍」</p>
        </div>
      ) : shownBooks.length === 0 ? (
        // 有书、只是筛不出来。这时候还说"书架是空的"就是误导。
        <div className="empty">
          <p className="empty-title">没有匹配的书</p>
          <p className="empty-sub">换个关键词，或者清空筛选</p>
        </div>
      ) : (
        <ul className="shelf">
          {shownBooks.map((book) => {
            const percent = book.progress?.percent ?? 0
            return (
              <li key={book.id} className="book-card">
                <div
                  className="book-open"
                  role="button"
                  tabIndex={0}
                  aria-label={`打开《${book.title}》`}
                  onClick={() => onOpen(book.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpen(book.id)
                    }
                  }}
                >
                  <div className="book-cover">
                    {isValidCoverDataUrl(book.cover) ? <img src={book.cover} alt="" loading="lazy" /> : <span className="cover-fallback">{(book.title || '?').slice(0, 1)}</span>}
                  </div>
                  <div className="book-info">
                    <span className="book-title">{book.title}</span>
                    <span className="book-author">{book.author || '佚名'}</span>
                  </div>
                  <div className="book-progress">
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${percent}%` }} />
                    </div>
                    <div className="book-progress-row">
                      <span className="book-percent">
                        {percent > 0 ? `${percent.toFixed(0)}% · 继续阅读` : '尚未开始'}
                      </span>
                      {percent > 0 && (
                        <button
                          className="book-restart"
                          onClick={(e) => {
                            e.stopPropagation()
                            onRestart(book.id)
                          }}
                          title="从头读这本书"
                        >
                          从头读
                        </button>
                      )}
                    </div>
                    {book.stats && book.stats.totalSeconds > 0 && (
                      <div className="book-stats">
                        {formatReadingTime(book.stats.totalSeconds)} · 读了 {book.stats.sessions} 次
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="book-delete"
                  onClick={() => setConfirmBook(book)}
                  aria-label={`移除《${book.title}》`}
                  title={`移除《${book.title}》`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {confirmBook && (
        <div className="modal-backdrop" onClick={() => setConfirmBook(null)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="confirm-title" id="confirm-delete-title">
              移除《{confirmBook.title}》？
            </h2>
            <p className="confirm-body">
              会一并删掉这本书的<strong>阅读进度、书签、全部高亮与笔记、阅读统计</strong>。
              <br />
              移除后 8 秒内还能撤销。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmBook(null)} autoFocus>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => removeWithUndo(confirmBook)}>
                移除
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingBook && (
        <div className="shelf-toast" role="status">
          <span>已移除《{pendingBook.title}》</span>
          <button className="shelf-toast__undo" onClick={undoRemove}>
            撤销
          </button>
        </div>
      )}
    </div>
  )
}
