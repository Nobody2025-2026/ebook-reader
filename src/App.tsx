import { useCallback, useEffect, useState } from 'react'
import { Library, type LibraryBook } from './components/Library'
import { Reader } from './components/Reader'
import { coverToDataUrl } from './lib/cover'
import { openEpub, type OpenedBook } from './lib/epub'
import { navigate, useHashRoute } from './lib/router'
import { deleteBook, listBooks, listProgress, saveBook } from './lib/storage'

export default function App() {
  const route = useHashRoute()
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [importing, setImporting] = useState(false)
  const [importHint, setImportHint] = useState('')

  const refresh = useCallback(async () => {
    const [metas, progress] = await Promise.all([listBooks(), listProgress()])
    setBooks(metas.map((meta) => ({ ...meta, progress: progress[meta.id] })))
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
      onDelete={(id) => void handleDelete(id)}
    />
  )
}
