import { useState } from 'react'
import { webBookSource } from '../lib/bookSource'
import type { ReadingProgress } from '../lib/progress'
import type { BookMeta } from '../lib/storage'

export interface LibraryBook extends BookMeta {
  progress?: ReadingProgress
}

interface Props {
  books: LibraryBook[]
  importing: boolean
  importHint: string
  onImport: (file: File) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}

export function Library({ books, importing, importHint, onImport, onOpen, onDelete }: Props) {
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
                <button className="book-open" onClick={() => onOpen(book.id)}>
                  <div className="book-cover">
                    {book.cover ? <img src={book.cover} alt="" loading="lazy" /> : <span className="cover-fallback">{(book.title || '?').slice(0, 1)}</span>}
                  </div>
                  <div className="book-info">
                    <span className="book-title">{book.title}</span>
                    <span className="book-author">{book.author || '佚名'}</span>
                  </div>
                  <div className="book-progress">
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="book-percent">
                      {percent > 0 ? `${percent.toFixed(0)}% · 继续阅读` : '尚未开始'}
                    </span>
                  </div>
                </button>
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
