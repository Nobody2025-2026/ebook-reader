import { useState } from 'react'
import { webBookSource } from '../lib/bookSource'
import { isValidCoverDataUrl } from '../lib/cover'
import type { ReadingProgress } from '../lib/progress'
import type { BookMeta, ReadingStats } from '../lib/storage'

export interface LibraryBook extends BookMeta {
  progress?: ReadingProgress
  stats?: ReadingStats
}

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
  onImport: (file: File) => void
  onOpen: (id: string) => void
  /** 从头读：清除进度后打开（区别于「继续阅读」的自动恢复） */
  onRestart: (id: string) => void
  onDelete: (id: string) => void
}

export function Library({ books, importing, importHint, onImport, onOpen, onRestart, onDelete }: Props) {
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = webBookSource.fromDrop(e.dataTransfer)
    if (file) onImport(file)
  }

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

      {books.length === 0 ? (
        <div className="empty">
          <p className="empty-title">书架是空的</p>
          <p className="empty-sub">把 EPUB 拖进来，或者点上面的「导入书籍」</p>
        </div>
      ) : (
        <ul className="shelf">
          {books.map((book) => {
            const percent = book.progress?.percent ?? 0
            return (
              <li key={book.id} className="book-card">
                <div
                  className="book-open"
                  role="button"
                  tabIndex={0}
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
                <button className="book-delete" onClick={() => onDelete(book.id)} title="从书架移除">
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
