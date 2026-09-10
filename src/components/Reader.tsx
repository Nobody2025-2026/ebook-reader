import { useCallback, useEffect, useRef, useState } from 'react'
import { openEpub, type ChapterRef, type OpenedBook, type TocEntry } from '../lib/epub'
import {
  computeWeightedPercent,
  detectContentRange,
  findAnchorBlock,
  type BlockRect,
  type ContentRange,
  type ReadingProgress,
} from '../lib/progress'
import { prepareChapterHtml } from '../lib/sanitize'
import {
  addBookmark,
  addAnnotation,
  exportAnnotations,
  getBookFile,
  getBookMeta,
  getProgress,
  listAnnotations,
  listBookmarks,
  newAnnotationId,
  removeAnnotation,
  removeBookmark,
  saveProgress,
  updateAnnotationNote,
  addReadingSeconds,
  touchOpen,
  type Annotation,
} from '../lib/storage'
import { makeExcerpt, newBookmarkId, type Bookmark } from '../lib/bookmark'
import {
  DEFAULT_SETTINGS,
  FONT_KEYS,
  FONT_LABELS,
  customFontValue,
  fontStack,
  loadSettings,
  saveSettings,
  type CustomFont,
  type ReaderSettings,
} from '../lib/settings'
import {
  addCustomFont,
  registerCustomFonts,
  removeCustomFont,
} from '../lib/customFont'
import { applyHighlights, selectionToAnchor, type BlockAnchor } from '../lib/highlight'
import { extractBookTexts, searchChapters, type SearchHit } from '../lib/search'

// 块级元素选择器：覆盖小说/学术书里绝大多数情况。
// 真实样本《涛动周期论》里就是这几种在撑页面。
// 注意：必须与 highlight.ts / progress.ts 里用的是**同一个**选择器，
// 否则高亮的 blockIndex 和进度锚点的 blockIndex 对不上，高亮会画错位置。
// 所以这里不再重复定义，直接复用 highlight.ts 的 BLOCK_SELECTOR。
import { BLOCK_SELECTOR } from '../lib/highlight'

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
  const [toc, setToc] = useState<TocEntry[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [currentChapter, setCurrentChapter] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  // 恢复位置提示 toast：短暂显示后自动消失
  const [showRestoreHint, setShowRestoreHint] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  // 书签操作反馈（"已添加" / "这个位置已经有了"），2 秒后自动消失
  const [bookmarkHint, setBookmarkHint] = useState('')

  // ---- 高亮与笔记（P1）----
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  // 笔记编辑浮层：框选生成时 mode='create'，点已有高亮时 mode='view'
  const [activeAnn, setActiveAnn] = useState<{
    id: string
    top: number
    left: number
    mode: 'create' | 'view'
  } | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  // ---- 单书全文搜索（P1）----
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  // 搜索文本抽取结果缓存（一本书只抽一次）
  const bookTextsRef = useRef<string[] | null>(null)

  const bookRef = useRef<OpenedBook | null>(null)
  const chaptersRef = useRef<ChapterRef[]>([])
  const weightsRef = useRef<number[]>([])
  const contentRangeRef = useRef<ContentRange>({ first: 0, last: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nodesRef = useRef(new Map<number, HTMLElement>())
  const loadedIdxRef = useRef(new Set<number>())
  // 正在加载中的章节（按 index 记，不再是"全局忙"的布尔量）。
  // 用布尔量的老写法会把并发的加载请求**直接丢掉**，详见 pump() 上方注释。
  const inFlightRef = useRef(new Set<number>())
  // 加载链是否正在跑（防止重入；注意它只挡重入，不丢弃请求）
  const pumpRef = useRef(false)
  // 待恢复的进度：chapter + block 双重定位。delta 不存（懒加载图片会让像素位置飘）。
  const pendingRestore = useRef<{ chapterIndex: number; blockIndex: number } | null>(null)
  // 目录点击要跳转的章内锚点选择器（空 = 跳章开头）
  const pendingJump = useRef<{ chapterIndex: number; selector?: string } | null>(null)
  // 是否已经尝试过恢复——避免后续懒加载新章节时把读者强行拽回去
  const hasRestoredRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestProgress = useRef<ReadingProgress | null>(null)

  /** @returns 这一章是否真的被加载了（重复请求 / 失败都返回 false） */
  const loadChapter = useCallback(async (index: number): Promise<boolean> => {
    const book = bookRef.current
    const chapters = chaptersRef.current
    if (!book || !chapters.length) return false
    if (index < 0 || index >= chapters.length) return false
    if (loadedIdxRef.current.has(index)) return false
    // 同一章只发一次请求；但**不同章**可以排队，不再像以前那样直接丢弃
    if (inFlightRef.current.has(index)) return false
    inFlightRef.current.add(index)
    try {
      const { html, css } = await book.loadChapter(chapters[index].id)
      loadedIdxRef.current.add(index)
      setLoaded((prev) =>
        [...prev, { index, html: prepareChapterHtml(html), css }].sort((a, b) => a.index - b.index),
      )
      return true
    } catch (err) {
      setError(`第 ${index + 1} 章加载失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      inFlightRef.current.delete(index)
    }
  }, [])

  // ===================== 连续加载下一章（替代旧的 IntersectionObserver） =====================
  //
  // 旧实现有两个致命缺陷，合起来就是"翻页卡死、只能上翻"：
  //   1. 守卫 `|| loadingRef.current` 会把**正在忙时的并发请求直接丢掉**——
  //      不是排队，是丢弃；
  //   2. IntersectionObserver 只在**交叉状态发生变化**时回调。effect 依赖 [loaded]，
  //      每加载一章就 disconnect + 重新 observe，若此时哨兵仍在视口内（状态没变），
  //     浏览器不会再补发一次 isIntersecting。
  // 于是"请求被丢弃 + 之后再也没有回调" → 加载链永久断开，滚到底就顶住；
  // 只有把哨兵滚出视口再滚回来（状态变化）才有概率恢复 —— 正好对上主上大人描述的
  // "下滚一段距离后有概率恢复，又有概率继续卡住"。
  //
  // 新方案：滚动位置是**连续可查**的（不依赖事件是否补发），
  // 每次加载完再复查一次，天然自愈；忙的时候靠串行循环排队，不会丢请求。
  const PRELOAD_REMAIN_PX = 1200

  /** 等浏览器把新章节渲染进 DOM，否则量到的 scrollHeight 还是旧的 */
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })

  const needMore = useCallback((): boolean => {
    const chapters = chaptersRef.current
    if (!chapters.length) return false
    if (!loadedIdxRef.current.size) return false // 首章由打开流程负责，pump 不抢
    const next = Math.max(...loadedIdxRef.current) + 1
    // 不把正文区间**之后**的章节（nav / 索引 / 版权页）当正文加载：
    // ① 它们渲染成一长串链接很丑；② 滚到它们时进度会被顶到 100%；
    // ③ 进度可能被存到这些页上，下次打开就"只有目录页、翻不动"。
    if (next > contentRangeRef.current.last) return false
    if (next >= chapters.length) return false
    const container = containerRef.current
    if (!container) return true
    const remain = container.scrollHeight - container.scrollTop - container.clientHeight
    return remain < PRELOAD_REMAIN_PX
  }, [])

  const pump = useCallback(async () => {
    if (pumpRef.current) return
    pumpRef.current = true
    try {
      // 上限兜底：极端情况（全是空章）也不至于把整本书一次塞进 DOM
      for (let guard = 0; guard < 50; guard++) {
        if (!needMore()) break
        const next = Math.max(...loadedIdxRef.current) + 1
        const ok = await loadChapter(next)
        if (!ok) break
        await nextFrame()
      }
    } finally {
      pumpRef.current = false
    }
  }, [loadChapter, needMore])

  // 打开书
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError('')

    void (async () => {
      try {
        const [meta, progress, savedSettings] = await Promise.all([
          getBookMeta(bookId),
          getProgress(bookId),
          loadSettings(),
        ])
        if (!cancelled) setSettings(savedSettings)
        // 把用户上传的自定义字体注册进 document.fonts（FontFace API），
        // 否则选中自定义字体时 CSS 找不到该 family 会回落到 sans-serif。
        void registerCustomFonts(savedSettings.customFonts)
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
        contentRangeRef.current = detectContentRange(book.chapterWeights)
        setToc(book.toc)
        setTitle(book.meta.title)
        bookTextsRef.current = null // 换书了，搜索文本缓存作废
        setBookmarks(await listBookmarks(bookId))
        setAnnotations(await listAnnotations(bookId))

        // 恢复进度时把位置夹到正文区间，避免打开后落在封面/目录/版权/索引页
        // （脏 EPUB 常把 nav.xhtml 放在 spine 末尾，存进去后下次打开就"只有目录、翻不动"）。
        // 首次打开（无进度）仍从封面 0 开始，不要一上来就跳过封面。
        const range = contentRangeRef.current
        const rawStart = progress?.chapterIndex ?? 0
        const start = progress ? Math.min(Math.max(rawStart, range.first), range.last) : 0
        const startBlock = rawStart === start ? Math.max(progress?.blockIndex ?? 0, 0) : 0
        setCurrentChapter(start)
        if (progress) {
          pendingRestore.current = {
            chapterIndex: start,
            blockIndex: startBlock,
          }
        }
        setPercent(progress?.percent ?? 0)

        await loadChapter(start)
        // 恢复位置较深时，也加载靠前章节，避免只能往后翻、回不去。
        // start 较小（<=10）时把 0..start 全前置加载，中间无空洞。
        if (start > 0 && start <= 10) {
          for (let i = 0; i < start; i++) {
            if (!loadedIdxRef.current.has(i)) await loadChapter(i)
          }
        } else if (start > 0 && !loadedIdxRef.current.has(0)) {
          await loadChapter(0)
        }
        if (!cancelled) {
          setStatus('ready')
          void touchOpen(bookId)
        }
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
    // 有进度 = 从上次位置恢复，提示一下（2.5 秒后自动消失）
    setShowRestoreHint(true)
    const hideTimer = setTimeout(() => setShowRestoreHint(false), 2500)
    return () => {
      timers.forEach(clearTimeout)
      clearTimeout(hideTimer)
    }
  }, [status, loaded])

  const flushProgress = useCallback(() => {
    if (!latestProgress.current) return
    void saveProgress(bookId, latestProgress.current)
  }, [bookId])

  // 阅读时长统计（P1）：书进入 ready 后开始计时；切到后台/息屏暂停（不计），
  // 周期（30s）与卸载/退出时把已读时长持久化；切回前台/重新 ready 恢复计时。
  // 注意：记「会话数」由打开书流程里的 touchOpen 负责，这里只管计时与持久化，
  // 避免 status 在 loading↔ready 间反复变化导致重复计数。
  const readingStartRef = useRef<number | null>(null)
  useEffect(() => {
    if (status !== 'ready') return
    const flushReading = () => {
      if (readingStartRef.current == null) return
      const secs = Math.floor((Date.now() - readingStartRef.current) / 1000)
      if (secs > 0) {
        void addReadingSeconds(bookId, secs)
        readingStartRef.current = Date.now()
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        flushReading()
        readingStartRef.current = null
      } else {
        readingStartRef.current = Date.now()
      }
    }
    readingStartRef.current = Date.now()
    const timer = setInterval(flushReading, 30_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      flushReading()
    }
  }, [status, bookId])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    // ⚠️ 先补加载，再看能不能记进度——**这两步的顺序不能反**。
    // 有些章整页是 <div>/<a> 排版（calibre 生成的目录页就是这样，一个
    // BLOCK_SELECTOR 都匹配不到），若把补加载放在 `blocks.length === 0`
    // 的提前返回之后，滚动就永远推不动加载链 → 卡在"只有目录页、翻不动"
    // （真实样本：《策略思维》spine[1] 的 Contents 页）。
    void pump()

    const blocks = collectBlocks()
    if (blocks.length === 0) return

    const containerTop = container.getBoundingClientRect().top
    const anchor = findAnchorBlock(blocks, containerTop)

    // 当前章节内已加载的块数（用于章内比例，可能为 0，做兜底）
    const currentBlocks =
      nodesRef.current.get(anchor.chapterIndex)?.querySelectorAll(BLOCK_SELECTOR).length ?? 0
    const withinRatio = currentBlocks > 0 ? anchor.blockIndex / currentBlocks : 0
    const range = contentRangeRef.current
    const pct = computeWeightedPercent(anchor.chapterIndex, withinRatio, weightsRef.current, range)
    // 存进度时把位置夹回正文区间：即使读者滚到封面/目录/nav 上，
    // 落盘的仍是最近的正文位置，下次打开不会停在目录页。
    const reportChapter = Math.min(Math.max(anchor.chapterIndex, range.first), range.last)
    const reportBlock = anchor.chapterIndex === reportChapter ? anchor.blockIndex : 0
    setPercent(pct)
    setCurrentChapter(reportChapter)

    latestProgress.current = {
      chapterIndex: reportChapter,
      blockIndex: reportBlock,
      percent: pct,
      updatedAt: Date.now(),
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushProgress, 500)
  }, [collectBlocks, flushProgress, pump])

  // 更新排版设置：立即生效 + 防抖落盘（拖动滑条会高频触发）
  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      // 落盘（不阻塞渲染）
      void saveSettings(next)
      return next
    })
  }, [])

  // 自定义字体：隐藏的 file input + 选择/删除处理器
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleFontFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = '' // 允许重复选同一文件
      if (!file) return
      try {
        const meta = await addCustomFont(file)
        await registerCustomFonts([meta])
        updateSettings({
          customFonts: [...settings.customFonts, meta],
          fontFamily: customFontValue(meta.family),
        })
      } catch (err) {
        setError(`字体加载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [settings.customFonts],
  )

  const handleRemoveFont = useCallback(
    async (id: string) => {
      const target = settings.customFonts.find((f) => f.id === id)
      await removeCustomFont(id)
      const patch: Partial<ReaderSettings> = {
        customFonts: settings.customFonts.filter((f) => f.id !== id),
      }
      // 删掉当前选中的自定义字体时，回落到默认宋体
      if (target && settings.fontFamily === customFontValue(target.family)) {
        patch.fontFamily = DEFAULT_SETTINGS.fontFamily
      }
      updateSettings(patch)
    },
    [settings.customFonts, settings.fontFamily],
  )

  // 目录跳转：标记目标，加载目标章（若未加载），定位滚动统一由下方 effect 处理
  const jumpTo = useCallback(
    async (chapterIndex: number, selector?: string) => {
      pendingJump.current = { chapterIndex, selector }
      if (!loadedIdxRef.current.has(chapterIndex)) {
        await loadChapter(chapterIndex)
      }
      // 数据已加载时，DOM 可能尚未挂载（React 异步重渲染）。
      // 尝试手动滚一次；滚成功就收尾，否则把 pendingJump 留给 effect。
      const chapterEl = nodesRef.current.get(chapterIndex)
      const target = selector
        ? (chapterEl?.querySelector(selector) as HTMLElement | null)
        : null
      const el = target ?? chapterEl
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'auto' })
        pendingJump.current = null
        setTocOpen(false)
      }
      // 没滚成（DOM 未挂载 / 锚点未渲染）：pendingJump 保留，等 effect 在 loaded 变化后滚动
    },
    [loadChapter],
  )

  /**
   * 正文里的 <a> 统一在容器上做事件委托：书内脚注 / 目录锚点自己跳转，
   * 外链新标签打开。
   *
   * ⚠️ 关键：必须 preventDefault。本项目用 HashRouter，路由就存在
   * location.hash 里；一旦让浏览器执行 <a href="#fn1"> 的默认跳转，
   * hash 会变成 "#fn1"，parseHash 认不出 read/xxx → 直接渲染书库。
   * 这就是"点脚注没跳注释、反而回到书库"的根因。
   */
  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 点高亮 → 弹笔记浮层（看/改/删）。必须在 <a> 判断之前，
      // 否则高亮里若包了链接会被当成书内链接处理。
      const markEl = (e.target as HTMLElement | null)?.closest?.('mark.hl') as HTMLElement | null
      if (markEl) {
        e.preventDefault()
        const id = markEl.getAttribute('data-ann-id') ?? ''
        const rect = markEl.getBoundingClientRect()
        const ann = annotations.find((a) => a.id === id)
        setActiveAnn({ id, top: rect.top + 8, left: rect.left, mode: 'view' })
        setNoteDraft(ann?.note ?? '')
        return
      }

      const link = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
      if (!link) return
      const href = link.getAttribute('href') ?? ''

      // 外链：新标签页打开，绝不让它改当前页 hash
      if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
        e.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
        return
      }

      // 其余（含空 href / "#" / "javascript:"）一律拦住默认跳转
      e.preventDefault()

      const article = link.closest('article[data-chapter-index]') as HTMLElement | null
      const rawIndex = article?.getAttribute('data-chapter-index')
      const fromIndex = rawIndex != null ? Number(rawIndex) : Number.NaN
      const target = bookRef.current?.resolveHrefToChapter(
        href,
        Number.isFinite(fromIndex) ? fromIndex : undefined,
      )
      if (target) void jumpTo(target.chapterIndex, target.selector)
    },
    [jumpTo, annotations],
  )

  /** 当前视口顶压着的块。和滚动记进度用同一套定位，保证书签落在读者看到的位置 */
  const getCurrentAnchor = useCallback((): { chapterIndex: number; blockIndex: number } => {
    const container = containerRef.current
    const blocks = collectBlocks()
    if (!container || blocks.length === 0) {
      // 还没滚过（刚打开）：退回当前章开头，至少不会存个瞎位置
      return { chapterIndex: currentChapter, blockIndex: 0 }
    }
    return findAnchorBlock(blocks, container.getBoundingClientRect().top)
  }, [collectBlocks, currentChapter])

  /** 取某一块的文字做摘录，书签列表靠它认位置 */
  const getBlockExcerpt = useCallback((chapterIndex: number, blockIndex: number): string => {
    const chapterEl = nodesRef.current.get(chapterIndex)
    const block = chapterEl?.querySelectorAll(BLOCK_SELECTOR)[blockIndex]
    return makeExcerpt(block?.textContent)
  }, [])

  const flashBookmarkHint = useCallback((msg: string) => {
    setBookmarkHint(msg)
    setTimeout(() => setBookmarkHint(''), 2000)
  }, [])

  const addCurrentBookmark = useCallback(async () => {
    const anchor = getCurrentAnchor()
    const added = await addBookmark(bookId, {
      id: newBookmarkId(),
      chapterIndex: anchor.chapterIndex,
      blockIndex: anchor.blockIndex,
      excerpt: getBlockExcerpt(anchor.chapterIndex, anchor.blockIndex),
      percent,
      createdAt: Date.now(),
    })
    setBookmarks(await listBookmarks(bookId))
    flashBookmarkHint(added ? '已添加书签' : '这个位置已经有书签了')
  }, [bookId, getCurrentAnchor, getBlockExcerpt, percent, flashBookmarkHint])

  const removeBm = useCallback(
    async (id: string) => {
      await removeBookmark(bookId, id)
      setBookmarks(await listBookmarks(bookId))
    },
    [bookId],
  )

  // ===================== 高亮与笔记（P1）=====================
  //
  // 字符级：选区 → 锚点(chapterIndex, blockIndex, startOffset, endOffset) → 存 IndexedDB。
  // 章节进 DOM 后由 applyHighlights 重绘 <mark>，任何重渲染都冲不掉（见 highlight.ts）。
  // 点已有高亮 → 浮层看/改/删笔记；框选 → 生成高亮并弹出笔记浮层。

  /** 选区生成高亮：在 .reader-scroll 的 onMouseUp 里调用 */
  const createHighlightFromSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const anchorEl =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : (range.commonAncestorContainer as Element)
    const article = anchorEl?.closest?.('article[data-chapter-index]') as HTMLElement | null
    if (!article) return
    const anchor: BlockAnchor | null = selectionToAnchor(article, sel)
    if (!anchor) return
    const chapterIndex = Number(article.getAttribute('data-chapter-index'))
    const id = newAnnotationId()
    const ann: Annotation = {
      id,
      bookId,
      chapterIndex,
      blockIndex: anchor.blockIndex,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      text: anchor.text,
      color: 'rgba(255, 224, 102, 0.6)',
      createdAt: Date.now(),
    }
    void addAnnotation(bookId, ann).then((ok) => {
      if (ok) setAnnotations((prev) => [...prev, ann])
    })
    // jsdom 没实现 Range.getBoundingClientRect，浏览器里有；做存在性保护，
    // 浮层定位拿不到真实坐标时退化为 (0,0)，不影响高亮本身。
    let rectTop = 0
    let rectLeft = 0
    if (typeof range.getBoundingClientRect === 'function') {
      const r = range.getBoundingClientRect()
      rectTop = r.top
      rectLeft = r.left
    }
    setActiveAnn({ id, top: rectTop + 8, left: rectLeft, mode: 'create' })
    setNoteDraft('')
    sel.removeAllRanges()
  }, [bookId])

  /** 保存当前浮层里正在编辑的笔记 */
  const saveNote = useCallback(async () => {
    if (!activeAnn) return
    await updateAnnotationNote(bookId, activeAnn.id, noteDraft)
    setAnnotations((prev) => prev.map((a) => (a.id === activeAnn.id ? { ...a, note: noteDraft } : a)))
    setActiveAnn(null)
  }, [activeAnn, bookId, noteDraft])

  /** 删除当前浮层对应的高亮 */
  const deleteActive = useCallback(async () => {
    if (!activeAnn) return
    await removeAnnotation(bookId, activeAnn.id)
    setAnnotations((prev) => prev.filter((a) => a.id !== activeAnn.id))
    setActiveAnn(null)
  }, [activeAnn, bookId])

  /** 跳转搜索结果：先确保章节已加载，再定位到含关键词的块 */
  const jumpToHit = useCallback(
    async (hit: SearchHit) => {
      await jumpTo(hit.chapterIndex)
      const tries = [0, 80, 250, 700, 1800]
      tries.forEach((delay) =>
        setTimeout(() => {
          const article = nodesRef.current.get(hit.chapterIndex)
          if (!article) return
          const blocks = Array.from(article.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[]
          const target = blocks.find((b) => b.textContent?.toLowerCase().includes(query.trim().toLowerCase()))
          if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ block: 'start', behavior: 'auto' })
          }
        }, delay),
      )
    },
    [jumpTo, query],
  )

  /** 跑单书全文搜索（文本抽取结果缓存到 bookTextsRef，一本书只抽一次） */
  const runSearch = useCallback(async (q: string) => {
    setQuery(q)
    if (!q.trim()) {
      setResults([])
      return
    }
    const book = bookRef.current
    if (!book) return
    if (!bookTextsRef.current) bookTextsRef.current = await extractBookTexts(book)
    setResults(searchChapters(bookTextsRef.current, q))
  }, [])

  /** 导出本书高亮笔记为 Markdown（纯本地下载，不联网） */
  const exportNotes = useCallback(async () => {
    const md = await exportAnnotations(bookId, title)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || '阅读笔记'}-笔记.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [bookId, title])

  /** 跳到书签位置：先确保章节已加载，再滚到那一块 */
  const goToBookmark = useCallback(
    async (bm: Bookmark) => {
      setBookmarksOpen(false)
      if (!loadedIdxRef.current.has(bm.chapterIndex)) {
        await loadChapter(bm.chapterIndex)
      }
      // 和"恢复上次阅读位置"同一套重试节奏：
      // 懒加载图片会陆续把内容顶下去，只滚一次往往不准。
      const tries = [0, 80, 250, 700, 1800]
      tries.forEach((delay) =>
        setTimeout(() => {
          const chapterEl = nodesRef.current.get(bm.chapterIndex)
          const block = chapterEl?.querySelectorAll(BLOCK_SELECTOR)[bm.blockIndex] as
            | HTMLElement
            | undefined
          if (block && typeof block.scrollIntoView === 'function') {
            block.scrollIntoView({ block: 'start', behavior: 'auto' })
          }
        }, delay),
      )
    },
    [loadChapter],
  )

  // 加载完新章节后，若有待处理的目录跳转锚点，滚过去（锚点未就绪则重试）
  useEffect(() => {
    if (!pendingJump.current) return
    const target = pendingJump.current
    const tryScroll = (): boolean => {
      const chapterEl = nodesRef.current.get(target.chapterIndex)
      if (!chapterEl) return false
      const anchor = target.selector
        ? (chapterEl.querySelector(target.selector) as HTMLElement | null)
        : null
      if (!anchor && target.selector) return false // 锚点元素还没渲染出来
      const el = anchor ?? chapterEl
      // jsdom 没实现 scrollIntoView，真实浏览器才有；测试里跳过即可
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'auto' })
      }
      return true
    }
    if (tryScroll()) {
      pendingJump.current = null
      setTocOpen(false)
      return
    }
    // 大章（如 25 万字）渲染慢，重试几轮直到锚点就绪
    const timers = [0, 80, 250, 700, 1800].map((delay) =>
      setTimeout(() => {
        if (pendingJump.current && tryScroll()) {
          pendingJump.current = null
          setTocOpen(false)
        }
      }, delay),
    )
    return () => timers.forEach(clearTimeout)
  }, [loaded])

  // 每加载完一章就复查一次是否还需要下一章。
  // 关键是这个复查**由 loaded 驱动**：即使上一次因为各种时序错过了触发条件，
  // 只要内容有变化就会重新尝试，加载链断不了。
  useEffect(() => {
    void pump()
  }, [loaded, pump])

  // 章节进 DOM 后重绘高亮（幂等：先拆旧 <mark> 再按锚点重新包裹）。
  // 依赖 loaded 与 annotations：新章节加载、或增删高亮时都重画。
  useEffect(() => {
    for (const ch of loaded) {
      const article = nodesRef.current.get(ch.index)
      if (!article) continue
      applyHighlights(
        article,
        annotations.filter((a) => a.chapterIndex === ch.index),
      )
    }
  }, [loaded, annotations])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const container = containerRef.current
      if (!container) return
      const page = Math.max(container.clientHeight - 48, 200) // 一屏高度，留 48px 视觉衔接

      if (e.key === 'Escape') {
        onExit()
        return
      }
      // 目录/排版面板开着时，方向键不应滚动正文（避免误操作）
      if (tocOpen || settingsOpen) return

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          container.scrollBy({ top: page, behavior: 'auto' })
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          container.scrollBy({ top: -page, behavior: 'auto' })
          break
        case 'Home':
          e.preventDefault()
          container.scrollTo({ top: 0, behavior: 'auto' })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit, tocOpen, settingsOpen])

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
    <div className={`reader theme-${settings.theme}`}>
      <header className="reader-bar">
        <button className="btn btn-ghost" onClick={onExit} title="返回书库（Esc）">
          ← 书库
        </button>
        <span className="reader-title">{title}</span>
        <button
          className="btn btn-ghost"
          onClick={() => setTocOpen((v) => !v)}
          title="目录"
          disabled={toc.length === 0}
        >
          目录
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setSettingsOpen((v) => !v)}
          title="排版"
        >
          排版
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setTocOpen(false)
            setSettingsOpen(false)
            setBookmarksOpen((v) => !v)
          }}
          title="书签"
        >
          书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setTocOpen(false)
            setSettingsOpen(false)
            setBookmarksOpen(false)
            setSearchOpen((v) => !v)
          }}
          title="搜索本书"
        >
          搜索
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => void exportNotes()}
          title="导出高亮与笔记（Markdown）"
          disabled={annotations.length === 0}
        >
          导出
        </button>
        <span className="reader-percent">{percent.toFixed(1)}%</span>
      </header>

      <div className="reader-body">
        <div
          className="reader-scroll"
          ref={containerRef}
          onScroll={handleScroll}
          onClick={handleContentClick}
          onMouseUp={() => createHighlightFromSelection()}
          style={{
            '--reader-font-size': `${settings.fontSize}px`,
            '--reader-line-height': `${settings.lineHeight}`,
            '--reader-page-margin': `${settings.pageMargin}px`,
            '--reader-font-family': fontStack(settings.fontFamily),
          } as React.CSSProperties}
        >
          {showRestoreHint && (
            <div className="restore-hint">已回到上次阅读位置</div>
          )}
          {bookmarkHint && <div className="restore-hint">{bookmarkHint}</div>}
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
        </div>

        {tocOpen && (
          <aside className="toc-panel">
            <div className="toc-header">
              <span>目录</span>
              <button
                className="btn btn-ghost"
                onClick={() => setTocOpen(false)}
                title="关闭目录"
              >
                ×
              </button>
            </div>
            <nav className="toc-list">
              {toc.map((entry, i) => (
                <TocNode
                  key={i}
                  entry={entry}
                  depth={0}
                  currentChapter={currentChapter}
                  onJump={jumpTo}
                />
              ))}
            </nav>
          </aside>
        )}

        {settingsOpen && (
          <aside className="settings-panel">
            <div className="settings-header">
              <span>排版</span>
              <button
                className="btn btn-ghost"
                onClick={() => setSettingsOpen(false)}
                title="关闭排版"
              >
                ×
              </button>
            </div>
            <div className="settings-body">
              <div className="settings-group">
                <div className="settings-label">
                  <span>字号</span>
                  <span className="settings-value">{settings.fontSize}px</span>
                </div>
                <input
                  type="range"
                  min="14"
                  max="28"
                  step="1"
                  value={settings.fontSize}
                  aria-label="字号"
                  onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                />
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>行距</span>
                  <span className="settings-value">{settings.lineHeight.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="1.4"
                  max="2.8"
                  step="0.1"
                  value={settings.lineHeight}
                  aria-label="行距"
                  onChange={(e) => updateSettings({ lineHeight: Number(e.target.value) })}
                />
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>页边距（正文宽度）</span>
                  <span className="settings-value">{settings.pageMargin}px</span>
                </div>
                <input
                  type="range"
                  min="480"
                  max="900"
                  step="20"
                  value={settings.pageMargin}
                  aria-label="页边距"
                  onChange={(e) => updateSettings({ pageMargin: Number(e.target.value) })}
                />
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>字体</span>
                </div>
                <div className="settings-row">
                  {FONT_KEYS.map((f) => (
                    <button
                      key={f}
                      className={`settings-pill settings-pill--font${settings.fontFamily === f ? ' active' : ''}`}
                      onClick={() => updateSettings({ fontFamily: f })}
                    >
                      {FONT_LABELS[f]}
                    </button>
                  ))}
                  {settings.customFonts.map((cf: CustomFont) => {
                    const active = settings.fontFamily === customFontValue(cf.family)
                    return (
                      <span
                        key={cf.id}
                        className={`settings-pill settings-pill--font settings-pill--custom${active ? ' active' : ''}`}
                      >
                        <button
                          type="button"
                          className="settings-pill__label"
                          title={cf.filename}
                          onClick={() => updateSettings({ fontFamily: customFontValue(cf.family) })}
                        >
                          {cf.filename.replace(/\.[^.]+$/, '')}
                        </button>
                        <button
                          type="button"
                          className="settings-pill__remove"
                          aria-label="删除自定义字体"
                          title="删除该字体"
                          onClick={() => void handleRemoveFont(cf.id)}
                        >
                          ×
                        </button>
                      </span>
                    )
                  })}
                  <button
                    type="button"
                    className="settings-pill settings-pill--font settings-pill--add"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    ＋自定义
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                    style={{ display: 'none' }}
                    onChange={(e) => void handleFontFile(e)}
                  />
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>主题</span>
                </div>
                <div className="settings-row">
                  {([
                    ['day', '日间'],
                    ['sepia', '护眼'],
                    ['night', '夜间'],
                  ] as const).map(([t, label]) => (
                    <button
                      key={t}
                      className={`settings-pill${settings.theme === t ? ' active' : ''}`}
                      onClick={() => updateSettings({ theme: t })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        )}

        {bookmarksOpen && (
          <aside className="bookmark-panel">
            <div className="bookmark-header">
              <span>书签{bookmarks.length > 0 ? `（${bookmarks.length}）` : ''}</span>
              <button
                className="btn btn-ghost"
                onClick={() => setBookmarksOpen(false)}
                title="关闭书签"
              >
                ×
              </button>
            </div>
            <div className="bookmark-actions">
              <button className="btn" onClick={() => void addCurrentBookmark()}>
                ＋ 添加当前位置
              </button>
            </div>
            <div className="bookmark-list">
              {bookmarks.length === 0 ? (
                <p className="bookmark-empty">
                  还没有书签。读到想记住的地方，点上面的「添加当前位置」。
                </p>
              ) : (
                bookmarks.map((bm) => (
                  <div key={bm.id} className="bookmark-item">
                    <button
                      className="bookmark-jump"
                      onClick={() => void goToBookmark(bm)}
                      title={bm.excerpt}
                    >
                      <span className="bookmark-excerpt">{bm.excerpt}</span>
                      <span className="bookmark-meta">
                        第 {bm.chapterIndex + 1} 章 · {bm.percent.toFixed(1)}%
                      </span>
                    </button>
                    <button
                      className="bookmark-del"
                      onClick={() => void removeBm(bm.id)}
                      title="删除书签"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        {searchOpen && (
          <aside className="search-panel">
            <div className="search-header">
              <span>搜索本书</span>
              <button className="btn btn-ghost" onClick={() => setSearchOpen(false)} title="关闭搜索">
                ×
              </button>
            </div>
            <div className="search-box">
              <input
                type="search"
                className="search-input"
                placeholder="输入关键词，回车搜索"
                value={query}
                onChange={(e) => void runSearch(e.target.value)}
                aria-label="搜索本书"
              />
            </div>
            <div className="search-list">
              {query.trim() === '' ? (
                <p className="search-empty">输入关键词检索本书正文。</p>
              ) : results.length === 0 ? (
                <p className="search-empty">没找到「{query}」。</p>
              ) : (
                results.map((hit, i) => {
                  const before = hit.snippet.slice(0, hit.matchStart)
                  const mid = hit.snippet.slice(hit.matchStart, hit.matchEnd)
                  const after = hit.snippet.slice(hit.matchEnd)
                  const label = chaptersRef.current[hit.chapterIndex]?.label ?? `第 ${hit.chapterIndex + 1} 章`
                  return (
                    <button
                      key={`${hit.chapterIndex}-${hit.matchOffset}-${i}`}
                      className="search-item"
                      onClick={() => void jumpToHit(hit)}
                      title={label}
                    >
                      <span className="search-item__chapter">第 {hit.chapterIndex + 1} 章</span>
                      <span className="search-snippet">
                        {before}
                        <mark>{mid}</mark>
                        {after}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </aside>
        )}

        {activeAnn && (
          <div
            className="ann-popover"
            style={{ position: 'fixed', top: activeAnn.top, left: Math.min(activeAnn.left, window.innerWidth - 320) }}
          >
            <div className="ann-popover__excerpt">
              {annotations.find((a) => a.id === activeAnn.id)?.text}
            </div>
            <textarea
              className="ann-popover__note"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="写点笔记…"
              autoFocus={activeAnn.mode === 'create'}
            />
            <div className="ann-popover__actions">
              <button className="btn" onClick={() => void saveNote()}>
                保存
              </button>
              <button className="btn btn-ghost" onClick={() => void deleteActive()}>
                删除
              </button>
              <button className="btn btn-ghost" onClick={() => setActiveAnn(null)}>
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 递归渲染目录条目 */
function TocNode({
  entry,
  depth,
  currentChapter,
  onJump,
}: {
  entry: TocEntry
  depth: number
  currentChapter: number
  onJump: (chapterIndex: number, selector?: string) => void
}) {
  const active = entry.chapterIndex === currentChapter && !entry.children?.length
  return (
    <>
      <button
        className={`toc-item${active ? ' toc-active' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onJump(entry.chapterIndex, entry.selector)}
        title={entry.label}
      >
        {entry.label}
      </button>
      {entry.children?.map((child, i) => (
        <TocNode
          key={i}
          entry={child}
          depth={depth + 1}
          currentChapter={currentChapter}
          onJump={onJump}
        />
      ))}
    </>
  )
}
