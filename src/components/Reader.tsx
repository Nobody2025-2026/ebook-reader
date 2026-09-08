import { useCallback, useEffect, useRef, useState } from 'react'
import { openEpub, type ChapterRef, type OpenedBook } from '../lib/epub'
import {
  computeWeightedPercent,
  findAnchorBlock,
  type BlockRect,
  type ReadingProgress,
} from '../lib/progress'
import { prepareChapterHtml } from '../lib/sanitize'
import { getBookFile, getBookMeta, getProgress, saveProgress } from '../lib/storage'

// 块级元素选择器：覆盖小说/学术书里绝大多数情况。
// 真实样本《涛动周期论》里就是这几种在撑页面。
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre'

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
  const weightsRef = useRef<number[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nodesRef = useRef(new Map<number, HTMLElement>())
  const loadedIdxRef = useRef(new Set<number>())
  const loadingRef = useRef(false)
  // 待恢复的进度：chapter + block 双重定位。delta 不存（懒加载图片会让像素位置飘）。
  const pendingRestore = useRef<{ chapterIndex: number; blockIndex: number } | null>(null)
  // 是否已经尝试过恢复——避免后续懒加载新章节时把读者强行拽回去
  const hasRestoredRef = useRef(false)
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
      setLoaded((prev) =>
        [...prev, { index, html: prepareChapterHtml(html), css }].sort((a, b) => a.index - b.index),
      )
    } catch (err) {
      setError(`第 ${index + 1} 章加载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      loadingRef.current = false
    }
  }, [])

  // 打开书
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError('')

    void (async () => {
      try {
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
        weightsRef.current = book.chapterWeights
        setTitle(book.meta.title)

        const start = Math.min(Math.max(progress?.chapterIndex ?? 0, 0), book.chapters.length - 1)
        if (progress) {
          pendingRestore.current = {
            chapterIndex: start,
            blockIndex: Math.max(progress.blockIndex, 0),
          }
        }
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
      bookRef.current?.destroy()
      bookRef.current = null
      loadedIdxRef.current.clear()
      nodesRef.current.clear()
      hasRestoredRef.current = false
    }
  }, [bookId, loadChapter])

  // 收集所有 chapter 内的块级元素视口坐标
  const collectBlocks = useCallback((): BlockRect[] => {
    const blocks: BlockRect[] = []
    for (const [chapterIndex, node] of nodesRef.current.entries()) {
      node.querySelectorAll(BLOCK_SELECTOR).forEach((el, i) => {
        const rect = el.getBoundingClientRect()
        blocks.push({
          top: rect.top,
          bottom: rect.bottom,
          chapterIndex,
          blockIndex: i,
        })
      })
    }
    blocks.sort((a, b) => a.top - b.top)
    return blocks
  }, [])

  // 进度恢复：把目标段落 scrollIntoView，多次重试以抗住懒加载图片陆续撑开布局
  useEffect(() => {
    if (status !== 'ready' || !pendingRestore.current) return
    if (hasRestoredRef.current) return
    const { chapterIndex, blockIndex } = pendingRestore.current
    hasRestoredRef.current = true // 立刻标记，避免后续懒加载触发回拽

    const tryRestore = () => {
      const chapterEl = nodesRef.current.get(chapterIndex)
      if (!chapterEl) return false
      const block = chapterEl.querySelectorAll(BLOCK_SELECTOR)[blockIndex] as HTMLElement | undefined
      if (!block) return false
      // block:'start' = 把元素顶部对齐到视口顶部。图片后续加载会顶下去，
      // 所以重试几次。
      block.scrollIntoView({ block: 'start', behavior: 'auto' })
      return true
    }

    const tries = [0, 80, 250, 700, 1800]
    const timers = tries.map((delay) => setTimeout(tryRestore, delay))
    return () => timers.forEach(clearTimeout)
  }, [status, loaded])

  const flushProgress = useCallback(() => {
    if (!latestProgress.current) return
    void saveProgress(bookId, latestProgress.current)
  }, [bookId])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const blocks = collectBlocks()
    if (blocks.length === 0) return

    const containerTop = container.getBoundingClientRect().top
    const anchor = findAnchorBlock(blocks, containerTop)

    // 当前章节内已加载的块数（用于章内比例，可能为 0，做兜底）
    const currentBlocks =
      nodesRef.current.get(anchor.chapterIndex)?.querySelectorAll(BLOCK_SELECTOR).length ?? 0
    const withinRatio = currentBlocks > 0 ? anchor.blockIndex / currentBlocks : 0
    const pct = computeWeightedPercent(anchor.chapterIndex, withinRatio, weightsRef.current)
    setPercent(pct)

    latestProgress.current = {
      chapterIndex: anchor.chapterIndex,
      blockIndex: anchor.blockIndex,
      percent: pct,
      updatedAt: Date.now(),
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushProgress, 500)
  }, [collectBlocks, flushProgress])

  // 滚到底部附近就加载下一章
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
