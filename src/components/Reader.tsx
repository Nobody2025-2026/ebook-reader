import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
  buildAnnotationMarkdown,
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
import {
  applyHighlights,
  countSegments,
  selectionToAnchor,
  type BlockAnchor,
} from '../lib/highlight'
import { extractBookTexts, searchChapters, type SearchHit } from '../lib/search'
import {
  detectSwipe,
  isTap,
  resolveTapZone,
  type TouchPoint,
} from '../lib/gestures'

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
  //
  // 浮层两种形态：
  // - mode='create'：刚框选完、**还没入库**。必须点「加高亮」才真正创建，
  //   点「取消」/浮层外/Esc 就放弃 —— 选错了不会留下垃圾高亮。
  // - mode='view'：点已有高亮弹出的编辑框（保存 / 删除 / 关闭）。
  const [activeAnn, setActiveAnn] = useState<{
    id: string
    top: number
    left: number
    mode: 'create' | 'view'
    excerpt: string
    anchor?: {
      chapterIndex: number
      blockIndex: number
      startOffset: number
      endOffset: number
      text: string
    }
  } | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  // 导出面板：先选再导出，避免"点了就静默下个文件、不知道导了啥"
  const [exportOpen, setExportOpen] = useState(false)
  const [exportChecked, setExportChecked] = useState<Record<string, boolean>>({})
  // 导出结果提示（原来完全没有反馈，被当成"没生效"）
  const [toast, setToast] = useState('')

  // ---- 单书全文搜索（P1）----
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  // 搜索文本抽取结果缓存（一本书只抽一次）
  const bookTextsRef = useRef<string[] | null>(null)

  // ---- 触屏手势（P0-3）----
  // 顶栏是否隐藏：手机上这条栏占掉一整行，点正文中间即可收起/唤出。
  const [chromeHidden, setChromeHidden] = useState(false)
  // 手指按下时的坐标与时间，抬手时用来判断是"点"还是"划"
  const touchStartRef = useRef<TouchPoint | null>(null)

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
  // 高亮重绘函数的"最新引用"。跳转这类异步回调要拿到最新的闭包，
  // 直接捕获 useCallback 的旧值会用到过期的 annotations。
  const repaintHighlightsRef = useRef<(() => void) | null>(null)

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
        setActiveAnn({
          id,
          top: rect.top + 8,
          left: rect.left,
          mode: 'view',
          excerpt: ann?.text ?? markEl.textContent ?? '',
        })
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

  /** 滚一屏。dir=1 下一屏，-1 上一屏；触屏用平滑，键盘沿用瞬时 */
  const scrollPage = useCallback((dir: 1 | -1, smooth = false) => {
    const container = containerRef.current
    if (!container) return
    const page = Math.max(container.clientHeight - 48, 200) // 与键盘翻页同一步长，留 48px 视觉衔接
    container.scrollBy({ top: dir * page, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // ---- 触屏手势（P0-3）----
  // 只认 touch：鼠标点正文有"选词/放光标/关浮层"的语义，
  // 若把鼠标点击也当翻页，选词点一下就翻页了，等于把 P1 的高亮功能废掉。
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.changedTouches[0]
    if (!t) return
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }, [])

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      const t = e.changedTouches[0]
      if (!start || !t) return

      const end: TouchPoint = { x: t.clientX, y: t.clientY, t: Date.now() }

      // 1) 左右滑动翻屏（纵向为主的是普通滚动，交给原生）
      const swipe = detectSwipe(start, end)
      if (swipe !== 'none') {
        // 拦掉抬手后的合成 click，否则可能连带点到链接/高亮
        e.preventDefault()
        scrollPage(swipe === 'next' ? 1 : -1, true)
        return
      }

      if (!isTap(start, end)) return

      const target = e.target as HTMLElement | null
      // 2) 落在链接 / 按钮 / 高亮 / 图片上的点按，一律交给原来的点击逻辑，
      //    不能"点脚注顺便翻一屏"
      if (target?.closest?.('a, button, mark, img, input, textarea, .ann-popover, .sel-popover')) return
      // 3) 有选区说明用户在选词加高亮，别动
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
      if (sel && !sel.isCollapsed) return

      // 4) 侧栏开着时，点正文 = 关掉侧栏（手机上没有别的地方可点）
      if (tocOpen || settingsOpen || bookmarksOpen || searchOpen || exportOpen) {
        e.preventDefault()
        setTocOpen(false)
        setSettingsOpen(false)
        setBookmarksOpen(false)
        setSearchOpen(false)
        setExportOpen(false)
        return
      }

      const container = containerRef.current
      if (!container) return

      const zone = resolveTapZone(t.clientX - container.getBoundingClientRect().left, container.clientWidth)
      if (zone === 'center') {
        e.preventDefault()
        setChromeHidden((v) => !v)
        return
      }
      e.preventDefault()
      scrollPage(zone === 'next' ? 1 : -1, true)
    },
    [scrollPage, tocOpen, settingsOpen, bookmarksOpen, searchOpen, exportOpen],
  )

  // 侧栏一开就必须把顶栏叫回来，否则按钮被藏起来了还没法再点开
  useEffect(() => {
    if (tocOpen || settingsOpen || bookmarksOpen || searchOpen || exportOpen) setChromeHidden(false)
  }, [tocOpen, settingsOpen, bookmarksOpen, searchOpen, exportOpen])

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

  //
  // 框选 → **只弹确认浮层，不落库**。
  // 之前是"一选中就立刻写进 IndexedDB"，用户框错一段（或只是想选中复制）
  // 也会留下一条高亮，只能事后去面板里删 —— 这是本轮最被吐槽的一点。
  // 现在改成显式确认：点「加高亮」才入库，取消/点别处/Esc 一律放弃。
  const openSelectionPopover = useCallback(() => {
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
    // 与已有高亮完全重叠 → 提示，不再弹框重复创建
    const dup = annotations.find(
      (a) =>
        a.chapterIndex === chapterIndex &&
        a.blockIndex === anchor.blockIndex &&
        a.startOffset === anchor.startOffset &&
        a.endOffset === anchor.endOffset,
    )
    // jsdom 没实现 Range.getBoundingClientRect，浏览器里有；做存在性保护，
    // 浮层定位拿不到真实坐标时退化为 (0,0)，不影响高亮本身。
    let rectTop = 0
    let rectLeft = 0
    if (typeof range.getBoundingClientRect === 'function') {
      const r = range.getBoundingClientRect()
      rectTop = r.top
      rectLeft = r.left
    }
    sel.removeAllRanges()
    if (dup) {
      setToast('这段已经高亮过了')
      return
    }
    setActiveAnn({
      id: '',
      top: rectTop + 8,
      left: rectLeft,
      mode: 'create',
      excerpt: anchor.text,
      anchor: {
        chapterIndex,
        blockIndex: anchor.blockIndex,
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        text: anchor.text,
      },
    })
    setNoteDraft('')
  }, [annotations])

  /** 确认加高亮：只有点了「加高亮」才真正写库（可同时带上笔记） */
  const confirmHighlight = useCallback(async () => {
    if (!activeAnn || activeAnn.mode !== 'create' || !activeAnn.anchor) return
    const a = activeAnn.anchor
    const id = newAnnotationId()
    const note = noteDraft.trim()
    const ann: Annotation = {
      id,
      bookId,
      chapterIndex: a.chapterIndex,
      blockIndex: a.blockIndex,
      startOffset: a.startOffset,
      endOffset: a.endOffset,
      text: a.text,
      note: note || undefined,
      color: 'rgba(255, 224, 102, 0.6)',
      createdAt: Date.now(),
    }
    const ok = await addAnnotation(bookId, ann)
    if (ok) setAnnotations((prev) => [...prev, ann])
    setActiveAnn(null)
    setToast(note ? '已添加高亮和笔记' : '已添加高亮')
  }, [activeAnn, bookId, noteDraft])

  /** 保存当前浮层里正在编辑的笔记（已有高亮的 view 模式） */
  const saveNote = useCallback(async () => {
    if (!activeAnn || activeAnn.mode !== 'view') return
    await updateAnnotationNote(bookId, activeAnn.id, noteDraft)
    setAnnotations((prev) => prev.map((a) => (a.id === activeAnn.id ? { ...a, note: noteDraft } : a)))
    setActiveAnn(null)
    setToast(noteDraft.trim() ? '笔记已保存' : '笔记已清空')
  }, [activeAnn, bookId, noteDraft])

  /**
   * 删一条高亮。管理面板的逐条删除、批量删除、浮层里的删除都走这里，
   * 保证「库里删干净 + 列表同步 + 勾选态同步 + 浮层关闭」四件事一起做，
   * 不会出现"删了却还勾着/浮层还挂着"的残留。
   */
  const deleteAnnotations = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      const set = new Set(ids)
      await Promise.all(ids.map((id) => removeAnnotation(bookId, id)))
      setAnnotations((prev) => prev.filter((a) => !set.has(a.id)))
      setExportChecked((prev) => {
        const next: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(prev)) if (!set.has(k)) next[k] = v
        return next
      })
      setActiveAnn((cur) => (cur && cur.id && set.has(cur.id) ? null : cur))
      setToast(ids.length > 1 ? `已删除 ${ids.length} 条高亮` : '已删除 1 条高亮')
    },
    [bookId],
  )

  /**
   * 从管理面板跳到某条高亮所在的正文位置。
   * 章节没加载过就先加载（和书签跳转同一套节奏），加载完成后补一次高亮重绘，
   * 保证跳过去就能看到那一段是黄的（懒加载图片会把布局顶动，所以重试几次）。
   */
  const goToAnnotation = useCallback(
    async (ann: Annotation) => {
      setExportOpen(false)
      setSearchOpen(false)
      if (!loadedIdxRef.current.has(ann.chapterIndex)) {
        await loadChapter(ann.chapterIndex)
      }
      const tries = [0, 80, 250, 700, 1800]
      tries.forEach((delay) =>
        setTimeout(() => {
          const chapterEl = nodesRef.current.get(ann.chapterIndex)
          const block = chapterEl?.querySelectorAll(BLOCK_SELECTOR)[ann.blockIndex] as
            | HTMLElement
            | undefined
          if (block && typeof block.scrollIntoView === 'function') {
            block.scrollIntoView({ block: 'center', behavior: 'auto' })
          }
          repaintHighlightsRef.current?.()
        }, delay),
      )
    },
    [loadChapter],
  )

  /** 删除当前浮层对应的高亮 */
  const deleteActive = useCallback(async () => {
    if (!activeAnn || !activeAnn.id) return
    await deleteAnnotations([activeAnn.id])
  }, [activeAnn, deleteAnnotations])

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

  /** 打开导出面板：默认全选本书所有高亮，用户可取消不想导出的 */
  const openExportPanel = useCallback(() => {
    setSearchOpen(false)
    setTocOpen(false)
    setSettingsOpen(false)
    setBookmarksOpen(false)
    const all: Record<string, boolean> = {}
    for (const a of annotations) all[a.id] = true
    setExportChecked(all)
    setExportOpen(true)
    setToast('')
  }, [annotations])

  /** 导出勾选的高亮笔记为 Markdown（纯本地下载，不联网） */
  const exportNotes = useCallback(
    async (ids: string[]) => {
      const chosen = annotations.filter((a) => ids.includes(a.id))
      if (chosen.length === 0) {
        setToast('还没勾选任何高亮')
        return
      }
      const md = buildAnnotationMarkdown(chosen, title)
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title || '阅读笔记'}-笔记.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      // 明确的成功反馈 + 数量，替代原来的静默下载
      const withNote = chosen.filter((x) => x.note?.trim()).length
      setToast(
        `已导出 ${chosen.length} 条高亮${withNote ? `（含 ${withNote} 条笔记）` : ''}`,
      )
    },
    [annotations, title],
  )

  // 导出提示 2.5 秒后自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2500)
    return () => clearTimeout(t)
  }, [toast])

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

  //
  // 重绘高亮（幂等：先拆旧 <mark> 再按锚点重新包裹）。
  // **带脏检查**：先数一数这一章"理应"有多少个 <mark>（countSegments），
  // 跟实际数量一致就什么都不做，只有对不上才重画。
  const repaintHighlights = useCallback(() => {
    for (const ch of loaded) {
      const article = nodesRef.current.get(ch.index)
      if (!article) continue
      const anns = annotations.filter((a) => a.chapterIndex === ch.index)
      if (article.querySelectorAll('mark.hl').length === countSegments(article, anns)) continue
      applyHighlights(article, anns)
    }
  }, [loaded, annotations])

  //
  // ⚠️ 这个 effect **故意不写依赖数组**——每次 React 渲染后都要守一次。
  // 原因（"一滚动高亮就没了"的真因）：滚动会 setPercent 触发重渲染，
  // 章节内容是用 dangerouslySetInnerHTML 灌进去的，React 重渲染时会把
  // innerHTML 重新设一遍，我们画的 <mark> 就被整段冲掉了；
  // 而依赖 [loaded, annotations] 的 effect 此时根本不会重跑（两个依赖都没变），
  // 于是高亮消失、且再也回不来——直到下次增删高亮才被重新画出来
  // （正是用户说的"再创建一次，之前的又出现了"）。
  // 每次渲染后比对数量、缺了就补画，才能扛住任意次数的重渲染。
  useEffect(() => {
    repaintHighlightsRef.current = repaintHighlights
    repaintHighlights()
  })

  // 点浮层外面就关掉笔记浮层。
  // 之前只有浮层里的"关闭"按钮能关，点正文其他地方浮层会一直挂着，
  // 看着像"关不掉"；这里补一条最符合直觉的关闭路径。
  useEffect(() => {
    if (!activeAnn) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.ann-popover')) return
      setActiveAnn(null)
    }
    // 用捕获阶段，避免正文里的 handler 先 stopPropagation 导致收不到
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [activeAnn])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const container = containerRef.current
      if (!container) return
      const page = Math.max(container.clientHeight - 48, 200) // 一屏高度，留 48px 视觉衔接

      if (e.key === 'Escape') {
        // 有浮层/面板开着时，Esc 先关它们，不要一按就把整本书关掉。
        // 尤其是刚框选完的确认浮层：Esc = "我选错了，取消"，最符合直觉。
        if (activeAnn) {
          setActiveAnn(null)
          return
        }
        if (exportOpen || searchOpen || bookmarksOpen || settingsOpen || tocOpen) {
          setExportOpen(false)
          setSearchOpen(false)
          setBookmarksOpen(false)
          setSettingsOpen(false)
          setTocOpen(false)
          return
        }
        onExit()
        return
      }
      // 目录/排版面板开着时，方向键不应滚动正文（避免误操作）
      if (tocOpen || settingsOpen) return

      switch (e.key) {
        // ↓/↑ 与 ←/→ 同义（Thorium 的约定：方向键 = 翻页单位）。
        // 原先只接了左右，用户下意识按上下键毫无反应，看着像"软件坏了"。
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          container.scrollBy({ top: page, behavior: 'auto' })
          break
        case 'ArrowLeft':
        case 'ArrowUp':
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
    <div
      className={`reader theme-${settings.theme}${chromeHidden ? ' is-chrome-hidden' : ''}`}
      // 顶栏收起后给它一个可发现性提示：手机用户不知道"点中间能叫回来"
      data-chrome-hidden={chromeHidden ? 'true' : undefined}
    >
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
          onClick={openExportPanel}
          title="管理高亮与笔记：勾选后可导出或删除"
          disabled={annotations.length === 0}
        >
          笔记{annotations.length > 0 ? ` ${annotations.length}` : ''}
        </button>
        <span className="reader-percent">{percent.toFixed(1)}%</span>
      </header>

      <div className="reader-body">
        <div
          className="reader-scroll"
          ref={containerRef}
          // tabIndex=0：让正文区本身可聚焦。既补了键盘可达性（Tab 能进正文），
          // 也让浏览器的原生滚动有落点，不再"按了没反应"。
          tabIndex={0}
          aria-label="正文"
          onScroll={handleScroll}
          onClick={handleContentClick}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onMouseUp={() => openSelectionPopover()}
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
              {/* memo 化：html/css 引用不变时 React 不会碰这个子树，
                  避免父组件（滚动更新进度）一重渲染就把整章 innerHTML 重写一遍、
                  把画好的高亮冲掉。 */}
              <ChapterBody html={chapter.html} css={chapter.css} />
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

        {exportOpen && (
          <aside className="search-panel export-panel">
            <div className="search-header">
              <span>高亮与笔记管理</span>
              <button
                className="btn btn-ghost"
                onClick={() => setExportOpen(false)}
                title="关闭"
              >
                ×
              </button>
            </div>
            <div className="export-toolbar">
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={
                    annotations.length > 0 &&
                    annotations.every((a) => exportChecked[a.id])
                  }
                  onChange={(e) => {
                    const next: Record<string, boolean> = {}
                    for (const a of annotations) next[a.id] = e.target.checked
                    setExportChecked(next)
                  }}
                />
                全选（{annotations.length} 条）
              </label>
            </div>
            <div className="search-list">
              {annotations.length === 0 ? (
                <p className="search-empty">还没有高亮。</p>
              ) : (
                annotations.map((a) => (
                  <div key={a.id} className="export-item">
                    <input
                      type="checkbox"
                      checked={!!exportChecked[a.id]}
                      onChange={(e) =>
                        setExportChecked((prev) => ({ ...prev, [a.id]: e.target.checked }))
                      }
                      aria-label="选择这条高亮"
                    />
                    {/* 点条目正文 = 跳到书中这一处（章节没加载会自动加载） */}
                    <button
                      className="export-item__body"
                      onClick={() => void goToAnnotation(a)}
                      title="跳到书中这一处"
                    >
                      <span className="search-item__chapter">第 {a.chapterIndex + 1} 章</span>
                      <span className="export-item__text">
                        {a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text}
                      </span>
                      {a.note?.trim() ? (
                        <span className="export-item__note">📝 {a.note}</span>
                      ) : null}
                    </button>
                    {/* 管理面板直接删：以前只能导出，想删得回正文里点高亮再删 */}
                    <button
                      className="export-del"
                      title="删除这条高亮"
                      onClick={() => void deleteAnnotations([a.id])}
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="export-footer">
              <span className="export-count">
                已选 {annotations.filter((a) => exportChecked[a.id]).length} 条
              </span>
              <div className="export-footer__actions">
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    void deleteAnnotations(
                      annotations.filter((a) => exportChecked[a.id]).map((a) => a.id),
                    )
                  }
                  disabled={annotations.filter((a) => exportChecked[a.id]).length === 0}
                >
                  删除选中
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    void exportNotes(annotations.filter((a) => exportChecked[a.id]).map((a) => a.id))
                  }
                  disabled={annotations.filter((a) => exportChecked[a.id]).length === 0}
                >
                  导出选中
                </button>
              </div>
            </div>
          </aside>
        )}

        {toast && <div className="export-toast">{toast}</div>}

        {activeAnn && (
          <div
            className="ann-popover"
            style={{ position: 'fixed', top: activeAnn.top, left: Math.min(activeAnn.left, window.innerWidth - 320) }}
          >
            <div className="ann-popover__excerpt">{activeAnn.excerpt}</div>
            <textarea
              className="ann-popover__note"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={activeAnn.mode === 'create' ? '写点笔记（可留空）…' : '写点笔记…'}
              autoFocus={activeAnn.mode === 'create'}
            />
            <div className="ann-popover__actions">
              {activeAnn.mode === 'create' ? (
                <>
                  <button className="btn" onClick={() => void confirmHighlight()}>
                    加高亮
                  </button>
                  <button className="btn btn-ghost" onClick={() => setActiveAnn(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => void saveNote()}>
                    保存
                  </button>
                  <button className="btn btn-ghost" onClick={() => void deleteActive()}>
                    删除
                  </button>
                  <button className="btn btn-ghost" onClick={() => setActiveAnn(null)}>
                    关闭
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export interface ChapterCss {
  id: string
  href: string
}

/**
 * 章节正文（memo 化）。
 *
 * 为什么必须 memo：章节 HTML 是 dangerouslySetInnerHTML 灌进去的，父组件每次
 * 重渲染（滚动更新进度就会）都可能把这段 innerHTML 重设一遍，我们画在上面的
 * <mark> 高亮就被整段冲掉。给 html / css 加引用稳定性后，React 会跳过这个子树，
 * DOM 不再被重写 —— 这是"一滚动高亮就没了"的根治手段（守卫重绘是兜底）。
 */
const ChapterBody = memo(function ChapterBody({
  html,
  css,
}: {
  html: string
  css: ChapterCss[]
}) {
  return (
    <>
      {css.map((sheet) => (
        <link key={sheet.id} rel="stylesheet" href={sheet.href} />
      ))}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
})

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
