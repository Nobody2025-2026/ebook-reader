import { useCallback, useEffect, useRef, useState } from 'react'
import { openEpub, type ChapterRef, type OpenedBook } from '../lib/epub'
import { computePercent, locateCurrent, type ReadingProgress } from '../lib/progress'
import { prepareChapterHtml } from '../lib/sanitize'
import { getBookFile, getBookMeta, getProgress, saveProgress } from '../lib/storage'

interface LoadedChapter {
  index: number
  html: string
  css: { id: string; href: string }[]
}

interface Props {
  bookId: string
  onExit: () => void
}

export function Reader({ bookId, onExit }: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [loaded, setLoaded] = useState<LoadedChapter[]>([])
  const [percent, setPercent] = useState(0)

  const bookRef = useRef<OpenedBook | null>(null)
  const chaptersRef = useRef<ChapterRef[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nodesRef = useRef(new Map<number, HTMLElement>())
  const loadedIdxRef = useRef(new Set<number>())
  const loadingRef = useRef(false)
  const pendingRestore = useRef<{ index: number; offset: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestProgress = useRef<ReadingProgress | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const loadChapter = useCallback(async (index: number) => {
    const book = bookRef.current
    const chapters = chaptersRef.current
    if (!book || !chapters.length) return
    if (index < 0 || index >= chapters.length) return
    if (loadedIdxRef.current.has(index) || loadingRef.current) return

    loadingRef.current = true
    try {
      const { html, css } = await book.loadChapter(chapters[index].id)
      loadedIdxRef.current.add(index)
      setLoaded((prev) => [...prev, { index, html: prepareChapterHtml(html), css }].sort((a, b) => a.index - b.index))
    } catch (err) {
      setError(`第 ${index + 1} 章加载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      loadingRef.current = false
    }
  }, [])

  // 打开书：读文件 → 解析 → 读进度 → 加载起始章节
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError('')

    void (async () => {
      try {
        // 先取元数据，才能知道文件名（书文件是以字节存的，读回来要重建 File）
        const [meta, progress] = await Promise.all([getBookMeta(bookId), getProgress(bookId)])
        const file = await getBookFile(bookId, meta?.fileName ?? 'book.epub')
        if (!file) throw new Error('找不到这本书的内容，可能已被清理')

        const book = await openEpub(file)
        if (cancelled) {
          book.destroy()
          return
        }
        bookRef.current = book
        chaptersRef.current = book.chapters
        setTitle(book.meta.title)

        const start = Math.min(Math.max(progress?.chapterIndex ?? 0, 0), book.chapters.length - 1)
        pendingRestore.current = progress ? { index: start, offset: progress.offset } : null
        setPercent(progress?.percent ?? 0)

        await loadChapter(start)
        if (!cancelled) setStatus('ready')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      }
    })()

    return () => {
      cancelled = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      // 关书时释放 blob URL，否则多本书来回切换内存只涨不降
      bookRef.current?.destroy()
      bookRef.current = null
      loadedIdxRef.current.clear()
      nodesRef.current.clear()
    }
  }, [bookId, loadChapter])

  const applyRestore = useCallback(() => {
    const pending = pendingRestore.current
    const container = containerRef.current
    if (!pending || !container) return
    const el = nodesRef.current.get(pending.index)
    if (!el) return
    container.scrollTop = el.offsetTop + pending.offset
  }, [])

  // 恢复进度：渲染完先跳一次；图片陆续加载会把内容顶下去，所以 600ms 后再补一次
  useEffect(() => {
    if (status !== 'ready' || !pendingRestore.current) return
    applyRestore()
    const raf = requestAnimationFrame(applyRestore)
    const timer = setTimeout(() => {
      applyRestore()
      pendingRestore.current = null
    }, 600)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [status, loaded, applyRestore])

  const flushProgress = useCallback(() => {
    if (!latestProgress.current) return
    void saveProgress(bookId, latestProgress.current)
  }, [bookId])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const blocks = [...nodesRef.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, el]) => ({ index, top: el.offsetTop, height: el.offsetHeight }))
    if (blocks.length === 0) return

    const pos = locateCurrent(blocks.map((b) => b.top), container.scrollTop)
    const current = blocks[pos.chapterIndex]
    const pct = computePercent(current.index, pos.offset, current.height, chaptersRef.current.length)
    setPercent(pct)

    latestProgress.current = {
      chapterIndex: current.index,
      offset: pos.offset,
      percent: pct,
      updatedAt: Date.now(),
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushProgress, 500)

    // 没有 IntersectionObserver 时（如测试环境）退回滚动位置判断
    if (typeof IntersectionObserver === 'undefined') {
      const last = blocks[blocks.length - 1]
      if (container.scrollTop + container.clientHeight > last.top + last.height - 600) {
        void loadChapter(last.index + 1)
      }
    }
  }, [flushProgress, loadChapter])

  // 滚到底部附近就加载下一章：靠哨兵元素观察，比算像素稳
  useEffect(() => {
    const sentinel = sentinelRef.current
    const container = containerRef.current
    if (!sentinel || !container || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          const next = Math.max(...loadedIdxRef.current) + 1
          void loadChapter(next)
        }
      },
      { root: container, rootMargin: '600px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loaded, loadChapter])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  // 离开页面前把最后的进度落盘
  useEffect(() => flushProgress, [flushProgress])

  if (status === 'loading') {
    return (
      <div className="state-page">
        <p className="state-hint">正在打开《{title || '…'}》</p>
        <p className="state-sub">大部头首次解析需要几秒</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="state-page">
        <p className="state-hint state-error">打不开这本书</p>
        <p className="state-sub">{error}</p>
        <button className="btn" onClick={onExit}>
          回书库
        </button>
      </div>
    )
  }

  return (
    <div className="reader">
      <header className="reader-bar">
        <button className="btn btn-ghost" onClick={onExit} title="返回书库（Esc）">
          ← 书库
        </button>
        <span className="reader-title">{title}</span>
        <span className="reader-percent">{percent.toFixed(1)}%</span>
      </header>

      <div className="reader-scroll" ref={containerRef} onScroll={handleScroll}>
        {loaded.map((chapter) => (
          <article
            key={chapter.index}
            className="chapter"
            data-chapter-index={chapter.index}
            ref={(el) => {
              if (el) nodesRef.current.set(chapter.index, el)
              else nodesRef.current.delete(chapter.index)
            }}
          >
            {chapter.css.map((sheet) => (
              <link key={sheet.id} rel="stylesheet" href={sheet.href} />
            ))}
            <div dangerouslySetInnerHTML={{ __html: chapter.html }} />
          </article>
        ))}
        <div ref={sentinelRef} className="chapter-sentinel">
          加载下一章…
        </div>
      </div>
    </div>
  )
}
