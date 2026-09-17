import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openEpub, type ChapterRef, type OpenedBook, type TocEntry } from '../lib/epub'
import {
  chapterFromPercent,
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
  updateAnnotationColor,
  addReadingSeconds,
  getStats,
  touchOpen,
  type Annotation,
} from '../lib/storage'
import {
  BOOKMARK_BLOCK_CLASS,
  applyBookmarkMarks,
  countBookmarkMarks,
  makeExcerpt,
  newBookmarkId,
  type Bookmark,
} from '../lib/bookmark'
import {
  DEFAULT_SETTINGS,
  FONT_KEYS,
  FONT_LABELS,
  THEME_CHOICES,
  THEME_LABELS,
  customFontValue,
  contentWidthFactor,
  effectivePageMargin,
  pageMarginCapPx,
  resolveTheme,
  systemPrefersDark,
  FONT_PROBE_FAMILIES,
  fontStack,
  loadSettings,
  PAGE_MARGIN_MAX,
  PAGE_MARGIN_STEP,
  saveSettings,
  type CustomFont,
  type FontKey,
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
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  isHighlightColorKey,
  type BlockAnchor,
  type HighlightColorKey,
} from '../lib/highlight'
import { extractBookTexts, searchChapters, type SearchHit } from '../lib/search'
import {
  detectSwipe,
  isTap,
  prefersTouch,
  resolveTapZone,
  type TouchPoint,
} from '../lib/gestures'
import { resolvePopoverPosition, type PopoverAnchorRect } from '../lib/popover'
import { canvasProbe, detectFontAvailability } from '../lib/fontAvailability'
import {
  estimateChapterRemainMinutes,
  formatPercentLine,
} from '../lib/readingTime'
import {
  SHORTCUT_GROUPS,
  TOUCH_GESTURES,
  dismissShortcutHint,
  formatKey,
  markShortcutHintSeen,
  matchShortcut,
  modKeyLabel,
  shouldShowShortcutHint,
} from '../lib/shortcuts'

// 块级元素选择器：覆盖小说/学术书里绝大多数情况。
// 真实样本《涛动周期论》里就是这几种在撑页面。
// 注意：必须与 highlight.ts / progress.ts 里用的是**同一个**选择器，
// 否则高亮的 blockIndex 和进度锚点的 blockIndex 对不上，高亮会画错位置。
// 所以这里不再重复定义，直接复用 highlight.ts 的 BLOCK_SELECTOR。
import { BLOCK_SELECTOR } from '../lib/highlight'

/**
 * 当前是否有一段**可用的**选区（触屏选词的判据，P0-1）。
 *
 * 要三个条件同时成立：
 * - 非折叠：折叠＝只是放了个光标，不是选词；
 * - rangeCount > 0：真有 Range 才能取坐标、算锚点（有些环境只给一个空的 Selection）；
 * - getRangeAt 可用：选区的具体内容由 openSelectionPopover 读取。
 *
 * 只做判断不做副作用，方便在 touchstart/touchend 里随手调用。
 */
function hasUsableSelection(): boolean {
  if (typeof window === 'undefined') return false
  const sel = window.getSelection?.()
  return (
    !!sel &&
    !sel.isCollapsed &&
    sel.rangeCount > 0 &&
    typeof sel.getRangeAt === 'function'
  )
}

/**
 * 触屏划词"选区定稳"的等待时长（selectionchange 兜底的防抖窗口）。
 *
 * 250ms 是权衡出来的：拖选区手柄时浏览器会连发 selectionchange，
 * 太短会在手柄还没放稳时就抢着弹浮层（还会清掉选区，手感直接崩）；
 * 太长则划完词要干等，像卡住了。
 */
const SELECTION_SETTLE_MS = 250

/**
 * 浮层宽度上限，必须与 index.css 里 `.ann-popover` 的 `width` 保持一致。
 * 定位时要用它算左右边界，写岔了会让浮层在窄屏上贴错边。
 */
const POPOVER_WIDTH = 300

interface LoadedChapter {
  index: number
  html: string
  css: { id: string; href: string }[]
}

interface Props {
  bookId: string
  onExit: () => void
}

/** 首次引导气泡在屏幕上停留多久（自动消失，不拦着人看书） */
const SHORTCUT_HINT_MS = 8000

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
  // 视口宽：留白要按屏宽封顶（每侧 ≤ 12%），所以它必须跟着 resize / 转屏重算。
  // 用 state 而非每次渲染现读 innerWidth —— 重渲染的时机与窗口尺寸变化无关，
  // 现读会在别的 state 变化时读到"恰好此刻"的值，逻辑上不可预期。
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  )
  // 系统是否偏好深色（P2-5）。初值同步取一次，之后由 matchMedia 的 change 事件驱动 ——
  // 系统在日落时自动切深色、或用户改系统设置，页面不用刷新就跟着走。
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark)
  // 实际要挂到 .reader 上的主题：'auto' 在这里被解析成 day / night。
  const resolvedTheme = resolveTheme(settings.theme, prefersDark)
  // 本屏的留白上限（桌面 = PAGE_MARGIN_MAX，手机按其屏宽的 12%）。
  // 渲染期算一次即可，纯函数无副作用；滑块的 max、注入值、提示文案共用它。
  const marginCap = pageMarginCapPx(viewportWidth)
  // 恢复位置提示 toast：短暂显示后自动消失
  const [showRestoreHint, setShowRestoreHint] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  // 书签操作反馈（"已添加" / "这个位置已经有了"），2 秒后自动消失
  const [bookmarkHint, setBookmarkHint] = useState('')
  // 当前视口位置是否已有书签 —— 顶栏「一键书签」按钮的激活态（P1-3）。
  // 书签列表放一份 ref：handleScroll 每次滚动都要判断，但没必要把 bookmarks
  // 写进它的依赖数组（那会让滚动回调随书签增删反复重建）。
  const bookmarksRef = useRef<Bookmark[]>([])
  const [atBookmark, setAtBookmark] = useState(false)

  // ---- 高亮与笔记（P1）----
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  //
  // 浮层两种形态：
  // - mode='create'：刚框选完、**还没入库**。必须点「加高亮」才真正创建，
  //   点「取消」/浮层外/Esc 就放弃 —— 选错了不会留下垃圾高亮。
  // - mode='view'：点已有高亮弹出的编辑框（保存 / 删除 / 关闭）。
  const [activeAnn, setActiveAnn] = useState<{
    id: string
    /**
     * 锚点几何（视口 fixed 坐标）。
     *
     * 这里刻意**不存算好的 top**：浮层的最终位置要等它渲染出来、量到真实高度
     * 才能定（"下面塞不下就翻上去"必须知道浮层多高）。存锚点、渲染时现算，
     * 顺带让浮层能跟着窗口尺寸变化自我修正。
     */
    anchorTop: number
    anchorBottom: number
    anchorLeft: number
    mode: 'create' | 'view'
    excerpt: string
    /** 这次浮层是触屏划词弹出来的（P0-1）：定位规则与"要不要抢焦点"都跟着它变 */
    fromTouch?: boolean
    anchor?: {
      chapterIndex: number
      blockIndex: number
      startOffset: number
      endOffset: number
      text: string
    }
  } | null>(null)
  // 浮层的实测高度：量到之前先按 0 算（useLayoutEffect 在绘制前跑，用户看不到中间态）
  const [popH, setPopH] = useState(0)
  const popRef = useRef<HTMLDivElement | null>(null)
  /**
   * 手指是否还按在屏幕上。
   *
   * selectionchange 兜底自动弹浮层时要用它把门：拖选区的两个手柄时浏览器会
   * 持续派发 selectionchange，若中途把浮层弹出来（还会清掉选区），用户手一松
   * 发现"选区没了、手柄也没了"，等于把选词过程打断在半路。
   */
  const touchingRef = useRef(false)
  /** 上一次已经弹过浮层的选区签名，用于 selectionchange 去重（见 openSelectionPopover） */
  const lastSelKeyRef = useRef('')
  // activeAnn 的镜像：给事件回调读最新值用，避免把 activeAnn 塞进依赖数组导致监听器反复重挂
  const activeAnnRef = useRef(activeAnn)
  activeAnnRef.current = activeAnn
  const [noteDraft, setNoteDraft] = useState('')
  // 新框选要用的高亮颜色（P1-7）。刻意保留上一次的选择——连划几处同色时不至于每次重选。
  const [activeColor, setActiveColor] = useState<HighlightColorKey>(DEFAULT_HIGHLIGHT_COLOR)
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

  // ---- 快捷键速查表 + 首次引导（P1-4）----
  //
  // 现状是"10+ 个键都实现了、界面上零入口"，用户不知道等于白做。
  // 这里补两条可发现路径：顶栏常驻「?」按钮（随时可查）、首次进阅读页弹一次轻引导。
  // 键位内容全部来自 src/lib/shortcuts.ts —— 与键盘处理共用一份数据，不会说过时的话。
  const [helpOpen, setHelpOpen] = useState(false)
  // 首次引导气泡：只在"没点过不再提示 + 本次会话还没弹过"时为 true
  const [showShortcutHint, setShowShortcutHint] = useState(shouldShowShortcutHint)
  // 焦点归位用：开着时焦点进浮层的「×」，关掉后还给触发它的「?」按钮
  // （与 P1-3 删除确认框同一套规矩：键盘用户不该被扔到页面某处）
  const helpBtnRef = useRef<HTMLButtonElement | null>(null)
  const helpCloseRef = useRef<HTMLButtonElement | null>(null)

  // ---- 触屏手势（P0-3）----
  // 顶栏是否隐藏：手机上这条栏占掉一整行，点正文中间即可收起/唤出。
  const [chromeHidden, setChromeHidden] = useState(false)
  // 手指按下时的坐标与时间，抬手时用来判断是"点"还是"划"
  const touchStartRef = useRef<TouchPoint | null>(null)

  // 内置字体在本机的真实可用性（移动端普遍没有宋体/楷体这套桌面字体，且部分
  // 浏览器会屏蔽系统字体名 → 点了没反应）。探测不可信时这里全是 true，即不标灰。
  const [fontUsable, setFontUsable] = useState<Record<string, boolean>>({})

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
  // 书签正文标记的重绘入口（同高亮：供"滚到某处之后"主动补画）
  const repaintBookmarkMarksRef = useRef<(() => void) | null>(null)

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

  // 视口宽跟随窗口变化（含手机转屏）：留白的屏宽封顶靠它算，
  // 不监听的话转屏后封顶值还是转屏前的，窄屏→宽屏会残留过紧的限制。
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 系统深色偏好变化（P2-5）。只有「跟随系统」时才看得出效果，但监听一直挂着：
  // 为它做条件挂载／卸载要多一套分支，而这里只是听着一个媒体查询，代价可以忽略。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    // 老 Safari 的 MediaQueryList 只有 addListener（已废弃）。没有 addEventListener
    // 就直接放弃实时跟随——初值仍是对的，只是不再随系统变化刷新。
    if (typeof mq.addEventListener !== 'function') return
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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
        // 剩余时间估算（P1-2）要用累计阅读时长。这里读到的是"本次进来之前"的值，
        // 够用——估算本就只是参考，随后每次计时 flush 都会把它补新。
        readSecondsRef.current = (await getStats(bookId))?.totalSeconds ?? 0

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
        // 同步给"剩余时间估算"用的那份（P1-2）：读得越久，速度估计越接近真实
        readSecondsRef.current += secs
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
    // 顶栏「一键书签」按钮的激活态（P1-3）。滚动高频调用，但布尔值不变时
    // React 会跳过重渲染，不构成额外负担。
    setAtBookmark(
      bookmarksRef.current.some(
        (b) => b.chapterIndex === reportChapter && b.blockIndex === reportBlock,
      ),
    )
    // 本章剩余时间估算（P1-2）。样本不足时得到 null，UI 显示"估算中"而不是瞎猜一个数。
    setRemainMinutes(
      estimateChapterRemainMinutes({
        weights: weightsRef.current,
        chapterIndex: reportChapter,
        withinRatio,
        contentRange: range,
        readSeconds: readSecondsRef.current,
        percent: pct,
      }),
    )

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

  /**
   * 恢复默认排版（P2-4）。
   *
   * 只重置"看书的观感"（字号/行距/页边距/字体/主题，含 themeLocked → 回到跟随系统），
   * **保留用户上传的自定义字体**：DEFAULT_SETTINGS.customFonts 是空数组，直接整体套用
   * 会让已注册的字体从面板上消失 —— 二进制还在 IndexedDB 里，等于凭空"丢"了用户的文件。
   */
  const resetSettings = useCallback(() => {
    setSettings((prev) => {
      const next: ReaderSettings = { ...DEFAULT_SETTINGS, customFonts: prev.customFonts }
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
   * 上一章 / 下一章（P1-1 进度条两端与 P1-4 的 Ctrl+PageUp/PageDown 共用）。
   * 以「最近正文位置」为基准，并把目标夹回正文区间——脏 EPUB 的封面 / 目录 /
   * nav 页不该成为跳转目标，否则用户会停在只有一串链接的页面上。
   */
  const goAdjacentChapter = useCallback(
    (delta: number) => {
      if (!chaptersRef.current.length) return
      const range = contentRangeRef.current
      const base = Math.min(Math.max(currentChapter, range.first), range.last)
      const target = Math.min(Math.max(base + delta, range.first), range.last)
      if (target === base) return
      void jumpTo(target)
    },
    [currentChapter, jumpTo],
  )

  // ---- 书级可拖进度条（P1-1）----
  //
  // 之前全屏唯一的位置反馈是顶栏一个百分比，厚书想跳到某处只能一路滚。
  // 注意：**不能用 .reader-scroll 的原生滚动条顶替**——它只覆盖"已加载的章节"，
  // 拖到 100% 不是读到书末，而是触发加载下一章（scrollHeight 会突然翻几十倍、
  // 拇指从 100% 缩回 1.5%，看起来像"进度倒退"）。
  // 所以这里是一条按章节折算的**书级**滑条：拖到 x% → jumpTo(对应章)。
  // 拖动过程中只更新视觉（数字 + 滑条），松手才真正跳章 —— 每移一格都 jumpTo
  // 会在厚书上疯狂加载章节。
  const [dragPercent, setDragPercent] = useState<number | null>(null)
  const dragPercentRef = useRef<number | null>(null)

  const onProgressDrag = useCallback((value: number) => {
    dragPercentRef.current = value
    setDragPercent(value)
  }, [])

  const commitProgressDrag = useCallback(() => {
    const target = dragPercentRef.current
    if (target == null) return
    dragPercentRef.current = null
    setDragPercent(null)
    void jumpTo(chapterFromPercent(target, weightsRef.current, contentRangeRef.current))
  }, [jumpTo])

  // ---- 本章剩余时间估算（P1-2）----
  //
  // 复用已有的累计阅读时长（`stats:` 的 totalSeconds，与计时器同口径、只算前台时间）
  // 配合当前进度倒推阅读速度，再乘"本章还剩多少字"。点击顶栏百分比可在
  // 「百分比 / 剩余时间」之间循环显示（照搬 Kindle 的做法）。
  // 本章剩余时间（P1-2）。原先要点顶栏百分比才切出来，绝大多数人根本不知道能点，
  // 现在改成**常驻**：百分比后面直接跟一句「· 剩约 X 分」。样本不足时为 null，
  // 此时只显示百分比（绝不编一个数出来）。
  const [remainMinutes, setRemainMinutes] = useState<number | null>(null)
  // 累计阅读秒数放 ref：handleScroll 每次滚动都要拿它估算，但没必要进依赖数组
  const readSecondsRef = useRef(0)

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
          anchorTop: rect.top,
          anchorBottom: rect.bottom,
          anchorLeft: rect.left,
          mode: 'view',
          excerpt: ann?.text ?? markEl.textContent ?? '',
        })
        setNoteDraft(ann?.note ?? '')
        // 浮层里的色块要反映这条高亮当前的颜色。老数据存的是 rgba 值（不是键），
        // 这时保持上一次的选择，不去改它本来的颜色。
        if (isHighlightColorKey(ann?.color)) setActiveColor(ann.color)
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

  // ---- 侧栏互斥（手机上的硬伤）----
  // 之前「目录」「排版」两个按钮各自 toggle 自己，谁都不关对方：手机上
  // 280px 目录 + 300px 排版 = 580px > 屏幕宽，正文被挤成一条缝、右边的排版还被裁掉一半。
  // 现在统一走一个入口：**一次只允许开一个面板**。
  const closeAllPanels = useCallback(() => {
    setTocOpen(false)
    setSettingsOpen(false)
    setBookmarksOpen(false)
    setSearchOpen(false)
    setExportOpen(false)
    setHelpOpen(false)
    // 笔记浮层也算"浮着的东西"：点遮罩 / 点正文 / 开别的面板时一并收起。
    // 它不是面板（没有自己的开合状态），但留着它悬在半空同样碍事。
    setActiveAnn(null)
  }, [])

  const togglePanel = useCallback(
    (name: 'toc' | 'settings' | 'bookmarks' | 'search' | 'help') => {
      setTocOpen((v) => (name === 'toc' ? !v : false))
      setSettingsOpen((v) => (name === 'settings' ? !v : false))
      setBookmarksOpen((v) => (name === 'bookmarks' ? !v : false))
      setSearchOpen((v) => (name === 'search' ? !v : false))
      setHelpOpen((v) => (name === 'help' ? !v : false))
      setExportOpen(false)
      setActiveAnn(null)
    },
    [],
  )

  // 开机（含上传自定义字体后）探一次内置字体的真实可用性。
  // 等 fonts.ready：自定义字体是 FontFace 注册的，抢跑会把刚传的字体误判成不可用。
  useEffect(() => {
    let alive = true
    const run = () => {
      if (!alive) return
      setFontUsable(detectFontAvailability(FONT_PROBE_FAMILIES, canvasProbe()))
    }
    const ready = typeof document !== 'undefined' ? document.fonts?.ready : undefined
    if (ready) void ready.then(run).catch(run)
    else run()
    return () => {
      alive = false
    }
  }, [settings.customFonts.length])

  // 本机不可用的内置字体（面板把这些标灰；数量用于折叠说明的摘要文案）
  const unavailableFonts = FONT_KEYS.filter((f) => fontUsable[f] === false)

  // 选中的内置字体本机不可用（自定义字体一定会被 FontFace 注册，不参与判定）
  const isSelectedFontUnavailable =
    (FONT_KEYS as string[]).includes(settings.fontFamily) && fontUsable[settings.fontFamily] === false

  /** 滚一屏。dir=1 下一屏，-1 上一屏；触屏用平滑，键盘沿用瞬时 */
  const scrollPage = useCallback((dir: 1 | -1, smooth = false) => {
    const container = containerRef.current
    if (!container) return
    const page = Math.max(container.clientHeight - 48, 200) // 与键盘翻页同一步长，留 48px 视觉衔接
    container.scrollBy({ top: dir * page, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  //
  // 框选 → **只弹确认浮层，不落库**。
  // 之前是"一选中就立刻写进 IndexedDB"，用户框错一段（或只是想选中复制）
  // 也会留下一条高亮，只能事后去面板里删 —— 这是本轮最被吐槽的一点。
  // 现在改成显式确认：点「加高亮」才入库，取消/点别处/Esc 一律放弃。
  //
  // 两个入口共用它：桌面 mouseup（onMouseUp）与触屏 touchend（P0-1），
  // 区别只在 fromTouch —— 见下面定位那段的说明。
  const openSelectionPopover = useCallback(
    (fromTouch = false) => {
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
      // rangeCount / getRangeAt 都做存在性判断：有些环境（测试桩、极少见的浏览器）
      // 只会给一个空壳 Selection，直接在它上面取 Range 会抛。
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      if (typeof sel.getRangeAt !== 'function') return
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

      // 同一个选区只弹一次。
      //
      // 为什么需要：触屏划词现在有**两个**触发源（touchend 与 selectionchange 兜底），
      // 而 selectionchange 一次划词会连发好几遍。不去重的话，每次回调都要
      // setNoteDraft('')，用户刚敲了一半的笔记会被清空 —— 比"弹不出来"还气人。
      const selKey = `${chapterIndex}:${anchor.blockIndex}:${anchor.startOffset}:${anchor.endOffset}`
      const cur = activeAnnRef.current
      if (cur && cur.mode === 'create' && lastSelKeyRef.current === selKey) return

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
      let rect: PopoverAnchorRect = { top: 0, bottom: 0, left: 0 }
      if (typeof range.getBoundingClientRect === 'function') {
        const r = range.getBoundingClientRect()
        rect = { top: r.top, bottom: r.bottom, left: r.left }
      }
      sel.removeAllRanges()
      if (dup) {
        setToast('这段已经高亮过了')
        return
      }
      lastSelKeyRef.current = selKey
      setActiveAnn({
        id: '',
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        anchorLeft: rect.left,
        mode: 'create',
        excerpt: anchor.text,
        // 触屏判定交给设备能力，而不是"哪个事件调起来的"：
        // 触屏上合成 mouseup、键盘辅助操作也可能触发这条路径，
        // 光看调用点会把触屏设备误判成桌面（浮层就挂到系统菜单上去了）。
        fromTouch: fromTouch || prefersTouch(),
        anchor: {
          chapterIndex,
          blockIndex: anchor.blockIndex,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
          text: anchor.text,
        },
      })
      setNoteDraft('')
    },
    [annotations],
  )

  // ---- 触屏手势（P0-3）----
  // 只认 touch：鼠标点正文有"选词/放光标/关浮层"的语义，
  // 若把鼠标点击也当翻页，选词点一下就翻页了，等于把 P1 的高亮功能废掉。
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.changedTouches[0]
    if (!t) return
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
    // 手指按着 = 划词可能还在进行中。selectionchange 兜底要靠它把门，
    // 免得拖选区手柄拖到一半，浮层跳出来把选区清掉（见下面那个 effect）。
    touchingRef.current = true
  }, [])

  /** 触摸被系统打断（来电、手势返回、多指切走）——必须把门重新关上，否则兜底再也不弹 */
  const handleTouchCancel = useCallback(() => {
    touchStartRef.current = null
    touchingRef.current = false
  }, [])

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      // 手指抬起 → 划词动作结束，selectionchange 兜底可以放行了。
      // 这一幕很关键：touchend 时选区**常常还没成型**（见下面那个兜底 effect 的说明），
      // 兜底那条路就是靠"手指已松开"这个信号，才敢在稍后替用户把浮层弹出来。
      touchingRef.current = false
      const t = e.changedTouches[0]
      if (!start || !t) return

      const end: TouchPoint = { x: t.clientX, y: t.clientY, t: Date.now() }

      // 0) 触屏选词（P0-1）：手指抬起时若还留着一段非折叠选区，说明用户在划词加高亮。
      //
      // 这一条**必须排在滑动手势之前**，两个原因：
      //   a) 手机上压根不会触发 mouseup —— 这里是移动端高亮的唯一入口。
      //      原先走到第 3 步「有选区就 return」，等于把半数用户的核心功能挡在门外。
      //   b) 拖动选区把手本身就是横向位移。若先走 detectSwipe，用户每拖一次把手
      //      就会顺带翻一屏，选词根本没法完成。
      // preventDefault 拦掉抬手后的合成 click（否则选词会连带点到底下的链接/高亮）。
      // 注意：它拦不住 iOS 的系统「复制/共享」气泡，那是选区自身的产物 ——
      // 我们的浮层因此改挂到选区**下沿**（见 openSelectionPopover 的 fromTouch）。
      if (hasUsableSelection()) {
        e.preventDefault()
        openSelectionPopover(true)
        return
      }

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
      // 3) 上面已经把"有选区"当成选词处理掉了（第 0 步），这里只兜底一种情况：
      //    选区在 touchend 之后才成型（部分浏览器先派发 touchend 再更新 selection），
      //    此时同样不能翻页。
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
      if (sel && !sel.isCollapsed) return

      // 4) 侧栏开着时，点正文 = 关掉侧栏（手机上没有别的地方可点）
      if (tocOpen || settingsOpen || bookmarksOpen || searchOpen || exportOpen || helpOpen) {
        e.preventDefault()
        closeAllPanels()
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
    [
      scrollPage,
      openSelectionPopover,
      tocOpen,
      settingsOpen,
      bookmarksOpen,
      searchOpen,
      exportOpen,
      helpOpen,
      closeAllPanels,
    ],
  )

  // ---- 触屏划词的兜底触发：不赌 touchend 那一帧（P0-1 真机回归）----
  //
  // 真机实测（iPhone Safari / 安卓夸克 / 荣耀浏览器）三个问题里最要命的一个：
  // 划完词**得再点一下**才弹浮层，而且时灵时不灵，iOS 尤其难触发。
  //
  // 根因是**时间竞速**：触屏划词的选区是异步成型的 —— 浏览器先派发 touchend，
  // 之后才更新 Selection、才弹系统菜单。抬手那一瞬间 getSelection() 还是折叠的，
  // hasUsableSelection() 为 false，于是掉进后面的"点按"分支（收顶栏 / 翻页），
  // 浮层压根没机会出现。用户再点一下，这时选区已成型，才终于弹出来。
  // iOS 上这个窗口最大，所以它最难触发 —— 和真机反馈完全吻合。
  //
  // 修法：补一条 selectionchange 兜底，选区一稳定就自己弹，不再跟浏览器抢时间。
  // 两道必须的门：
  //   a) 手指还按在屏幕上时不弹。拖选区手柄会连发 selectionchange，
  //      中途弹出浮层（还会清掉选区）＝ 把选词过程打断在半路，手柄都不见了；
  //   b) 防抖 250ms，等选区定稳，避免拖到一半抢跑。
  useEffect(() => {
    if (typeof document === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onSelectionChange = () => {
      if (timer != null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (touchingRef.current) return
        if (!hasUsableSelection()) return
        openSelectionPopover()
      }, SELECTION_SETTLE_MS)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      if (timer != null) clearTimeout(timer)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [openSelectionPopover])

  // ---- 正文一滚动就收起笔记浮层 ----
  //
  // 浮层是 fixed 定位的，**不跟着内容走**：用户一滚动/一翻页，它还悬在原地，
  // 和它要注释的那段文字已经脱钩了。留着只会让人以为"卡住了"，
  // 或者手一滑点到「加高亮」，把高亮加到已经翻走的那一段上。
  // 同类产品（微信读书 / Kindle / 系统原生菜单）都是滚动即收起，跟着做不会错。
  //
  // 唯一的例外：笔记框里**已经写了东西**时不动它。软键盘弹起/收起会引发视口与
  // 滚动变化，照关不误的话，用户会被自己的输入动作关掉写了一半的笔记。
  // 注意条件用的是"有内容"而不是"有焦点"：桌面端浮层会自动聚焦输入框
  // （鼠标端敲笔记更顺），那种情况下用户什么都没写，滚动就该照常收起 ——
  // 只认焦点会让桌面端的浮层永远关不掉。
  // （浮层内部的滚动不会冒泡到正文容器，天然不受影响，不用额外挡。）
  //
  // 依赖 status：容器是 status==='ready' 之后才挂载的，ref 到位了才挂得上监听。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => {
      if (!activeAnnRef.current) return
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
      const typing =
        !!el &&
        (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
        typeof el.value === 'string' &&
        el.value.trim().length > 0
      if (typing) return
      setActiveAnn(null)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [status])

  // ---- 量浮层的真实高度，供定位判断"下面还塞不塞得下" ----
  // useLayoutEffect 在浏览器绘制前同步跑，所以 setPopH 触发的重渲染
  // 不会被用户看到：浮层不会先出现在错位置、再跳一下。
  useLayoutEffect(() => {
    if (!activeAnn) {
      if (popH !== 0) setPopH(0)
      return
    }
    const h = popRef.current?.offsetHeight ?? 0
    if (h > 0 && h !== popH) setPopH(h)
  }, [activeAnn, popH])

  // 侧栏一开就必须把顶栏叫回来，否则按钮被藏起来了还没法再点开
  useEffect(() => {
    if (tocOpen || settingsOpen || bookmarksOpen || searchOpen || exportOpen || helpOpen) {
      setChromeHidden(false)
      // 顺带收起首次引导：桌面端面板是静态元素、气泡是定位元素，
      // 只靠 z-index 压不住，两个浮层叠一起很难看。用户既然已经在自己探索面板了，
      // 这个气泡也就没用了（本次会话的记账早已完成，不会再来打扰）。
      setShowShortcutHint(false)
    }
  }, [tocOpen, settingsOpen, bookmarksOpen, searchOpen, exportOpen, helpOpen])

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
    // 提示里直接告诉用户"去哪儿看"——原先只回一句"已添加书签"，
    // 用户加完不知道在哪查看，只能干瞪眼（实测反馈）。
    flashBookmarkHint(added ? '已添加书签 · 点顶栏「书签」可查看' : '这个位置已经有书签了')
  }, [bookId, getCurrentAnchor, getBlockExcerpt, percent, flashBookmarkHint])

  // 书签列表一变就同步给 ref（handleScroll 读它判断按钮激活态）
  useEffect(() => {
    bookmarksRef.current = bookmarks
  }, [bookmarks])

  /**
   * 一键书签（P1-3）：单击 = 把当前位置存为书签，同一位置再点 = 取消（toggle）。
   * 原先得「开书签面板 → 点添加当前位置」两步，入口太深；顶栏按钮与 Ctrl+B 都走这里。
   */
  const toggleCurrentBookmark = useCallback(async () => {
    const anchor = getCurrentAnchor()
    const existing = bookmarks.find(
      (b) => b.chapterIndex === anchor.chapterIndex && b.blockIndex === anchor.blockIndex,
    )
    if (existing) {
      await removeBookmark(bookId, existing.id)
      setBookmarks(await listBookmarks(bookId))
      setAtBookmark(false) // 立刻反映到按钮上，不必等下一次滚动
      flashBookmarkHint('已取消这个位置的书签')
      return
    }
    const added = await addBookmark(bookId, {
      id: newBookmarkId(),
      chapterIndex: anchor.chapterIndex,
      blockIndex: anchor.blockIndex,
      excerpt: getBlockExcerpt(anchor.chapterIndex, anchor.blockIndex),
      percent,
      createdAt: Date.now(),
    })
    setBookmarks(await listBookmarks(bookId))
    setAtBookmark(true) // 同上：点了就是"这个位置有书签"（重复添加时本来也有）
    // 提示里直接告诉用户"去哪儿看"——原先只回一句"已添加书签"，
    // 用户加完不知道在哪查看，只能干瞪眼（实测反馈）。
    flashBookmarkHint(added ? '已添加书签 · 点顶栏「书签」可查看' : '这个位置已经有书签了')
  }, [bookId, bookmarks, getCurrentAnchor, getBlockExcerpt, percent, flashBookmarkHint])

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
  // ⚠️ openSelectionPopover 的**定义**在下面「触屏手势」之前（它既是 mouseup 的处理器，
  //    也是 touchend 的处理器，必须排在手势回调进依赖数组之前，否则踩 TDZ）。

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
      // 颜色存"键"（yellow/red/blue/green），具体色值由 CSS 按主题决定（P1-7）
      color: activeColor,
      createdAt: Date.now(),
    }
    const ok = await addAnnotation(bookId, ann)
    if (ok) setAnnotations((prev) => [...prev, ann])
    setActiveAnn(null)
    setToast(note ? '已添加高亮和笔记' : '已添加高亮')
  }, [activeAnn, bookId, noteDraft, activeColor])

  /** 保存当前浮层里正在编辑的笔记（已有高亮的 view 模式） */
  const saveNote = useCallback(async () => {
    if (!activeAnn || activeAnn.mode !== 'view') return
    await updateAnnotationNote(bookId, activeAnn.id, noteDraft)
    setAnnotations((prev) => prev.map((a) => (a.id === activeAnn.id ? { ...a, note: noteDraft } : a)))
    setActiveAnn(null)
    setToast(noteDraft.trim() ? '笔记已保存' : '笔记已清空')
  }, [activeAnn, bookId, noteDraft])

  /**
   * 换高亮颜色（P1-7）。
   * - `create` 模式：只是选色，等点「加高亮」才落库（与"显式确认"的约定一致）；
   * - `view` 模式：立刻落库并更新内存，重画交给既有那个守卫 effect。
   */
  const changeActiveColor = useCallback(
    async (color: HighlightColorKey) => {
      setActiveColor(color)
      if (!activeAnn || activeAnn.mode !== 'view' || !activeAnn.id) return
      const id = activeAnn.id
      await updateAnnotationColor(bookId, id, color)
      setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, color } : a)))
    },
    [activeAnn, bookId],
  )

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
          repaintBookmarkMarksRef.current?.()
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
  // 书签的正文标记（v0.1.6）：在书签所在块上画一条左侧竖线。
  // 之前正文里**完全没有书签的痕迹**，用户标完往下滚就找不到自己标了哪儿。
  // 脏检查口径与高亮一致：实际带标记的块数对得上就一个 DOM 都不碰。
  const repaintBookmarkMarks = useCallback(() => {
    for (const ch of loaded) {
      const article = nodesRef.current.get(ch.index)
      if (!article) continue
      const idx = bookmarks.filter((b) => b.chapterIndex === ch.index).map((b) => b.blockIndex)
      if (
        article.querySelectorAll(`.${BOOKMARK_BLOCK_CLASS}`).length ===
        countBookmarkMarks(article, idx)
      ) {
        continue
      }
      applyBookmarkMarks(article, idx)
    }
  }, [loaded, bookmarks])

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
    repaintBookmarkMarksRef.current = repaintBookmarkMarks
    repaintHighlights()
    repaintBookmarkMarks()
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

      // 按键 → 动作的翻译只有一处：src/lib/shortcuts.ts 的 matchShortcut。
      // 这里不再出现 `e.key === 'b'` 这种硬编码 —— 速查浮层渲染的正是同一张表，
      // 所以"说明里写的键"与"实际生效的键"不可能再对不上。
      const hit = matchShortcut(e)

      if (hit === 'close') {
        // 有浮层/面板开着时，Esc 先关它们，不要一按就把整本书关掉。
        // 尤其是刚框选完的确认浮层：Esc = "我选错了，取消"，最符合直觉。
        if (activeAnn) {
          setActiveAnn(null)
          return
        }
        if (exportOpen || searchOpen || bookmarksOpen || settingsOpen || tocOpen || helpOpen) {
          setExportOpen(false)
          setSearchOpen(false)
          setBookmarksOpen(false)
          setSettingsOpen(false)
          setTocOpen(false)
          setHelpOpen(false)
          return
        }
        onExit()
        return
      }

      // 焦点在输入框 / 文本域里（搜索框、笔记框）时一律让路：那里的 Home/End/方向键
      // 有自己的语义（移动光标），抢过来只会让用户打字出错。
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return
      }

      switch (hit) {
        // Ctrl/Cmd+B：一键书签（P1-3），与顶栏按钮同一动作。
        // 放在下面那条"面板开着就 return"之前——面板开着时也照常可用。
        case 'bookmark':
          e.preventDefault()
          void toggleCurrentBookmark()
          return

        // ---- 标准快捷键（P1-4，约定照抄 Thorium）----
        case 'search':
          e.preventDefault()
          togglePanel('search')
          return
        case 'bookStart':
          e.preventDefault()
          void jumpTo(contentRangeRef.current.first)
          return
        case 'bookEnd':
          e.preventDefault()
          void jumpTo(contentRangeRef.current.last)
          return
        case 'prevChapter':
          e.preventDefault()
          goAdjacentChapter(-1)
          return
        case 'nextChapter':
          e.preventDefault()
          goAdjacentChapter(1)
          return

        // 「?」（P1-4）：随手就能查出还有哪些键。同一个键再按一次收起。
        case 'help':
          e.preventDefault()
          togglePanel('help')
          return

        // ↓/↑ 与 ←/→ 同义（Thorium 的约定：方向键 = 翻页单位）。
        // 原先只接了左右，用户下意识按上下键毫无反应，看着像"软件坏了"。
        case 'pageDown':
        case 'pageUp':
        case 'chapterTop': {
          // 目录/排版面板开着时，方向键不应滚动正文（避免误操作）
          if (tocOpen || settingsOpen) return
          e.preventDefault()
          if (hit === 'chapterTop') container.scrollTo({ top: 0, behavior: 'auto' })
          else container.scrollBy({ top: hit === 'pageDown' ? page : -page, behavior: 'auto' })
          return
        }

        // Esc 在上面已经处理掉了（它得能关掉浮动层，不能被输入框那条让路规则挡下）。
        // 这里不用再写 case 'close'：TS 看得出那段提前返回是穷尽的，
        // 写了反而会报"类型不可比较"（也正好证明"Esc 一定被拦住了"）。

        // 不认识的键：交回浏览器（Tab 走焦点、Cmd+Q 退出，都不该被阅读器吞掉）
        case null:
          return

        default: {
          // 穷尽性检查：shortcuts.ts 里新增了键位却忘了在这里接处理器，
          // 这一行会直接编译不过 —— 比"用户按了没反应"早得多地暴露问题。
          const unhandled: never = hit
          void unhandled
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    onExit,
    // ⚠️ 这几个面板状态**必须**在依赖里（2026-09-16 真浏览器复核抓到的存量 bug）：
    // 原先只列了 tocOpen / settingsOpen，于是"搜索 / 书签 / 笔记"面板打开时，
    // 处理器还拿着"面板没开"的旧闭包，按 Esc 直接走进 onExit() 退回书库，
    // 而不是关掉面板（activeAnn 同理：框选浮层按 Esc 也会整本书关掉）。
    // 目录/排版因为在依赖里所以一直正常 —— 这就是它长期没被发现的原因。
    activeAnn,
    tocOpen,
    settingsOpen,
    bookmarksOpen,
    searchOpen,
    exportOpen,
    helpOpen,
    toggleCurrentBookmark,
    togglePanel,
    jumpTo,
    goAdjacentChapter,
  ])

  // 速查浮层的焦点管理（P1-4，规矩同 P1-3 的删除确认框）：
  // 打开时把焦点送进浮层（键盘用户不必再 Tab 找），关闭后还给触发它的那个「?」按钮。
  // 刻意**不做焦点陷阱**：这是一张只读说明表，浮层里唯一的可聚焦元素就是「×」，
  // 把 Tab 锁死反而成了新的坑（想直接离开的人会被困住）。
  const prevHelpOpen = useRef(false)
  useEffect(() => {
    if (helpOpen) {
      // 打开浮层本身就说明用户已经找到了入口，首次引导到此为止
      setShowShortcutHint(false)
      helpCloseRef.current?.focus()
    } else if (prevHelpOpen.current) {
      helpBtnRef.current?.focus()
    }
    prevHelpOpen.current = helpOpen
  }, [helpOpen])

  // 首次进阅读页的轻引导（P1-4）：只弹一次（判据见 shortcuts.ts），
  // 出现即记账，N 秒后自己消失 —— 它是提示不是弹窗，不该杵在那儿等用户来点。
  useEffect(() => {
    if (!showShortcutHint) return
    markShortcutHintSeen()
    const timer = window.setTimeout(() => setShowShortcutHint(false), SHORTCUT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [showShortcutHint])

  // 离开页面前把最后的进度落盘
  useEffect(() => flushProgress, [flushProgress])

  // 修饰键该显示成 ⌘ 还是 Ctrl 看当前平台（Mac 用户在键盘上找的是 ⌘ 键）；
  // 引导文案里的「?」也从同一张表里取，免得哪天改了帮助键、文案还写着旧键。
  const modLabel = modKeyLabel()
  const helpKey = SHORTCUT_GROUPS.flatMap((g) => g.items).find((i) => i.id === 'help')?.keys[0]
  const helpKeyLabel = helpKey ? formatKey(helpKey, modLabel) : '?'

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

  // 浮层摆哪儿：渲染时现算（"下面塞不下就翻上去"必须先知道浮层多高，见 lib/popover.ts）。
  // 首次渲染时 popH 还是 0，会先按"下面放得下"摆一次；useLayoutEffect 紧接着
  // 量到真实高度并在**绘制前**纠正 —— 用户看不到中间态，不会先错后跳。
  const annPos = activeAnn
    ? resolvePopoverPosition(
        {
          top: activeAnn.anchorTop,
          bottom: activeAnn.anchorBottom,
          left: activeAnn.anchorLeft,
        },
        // 宽度取 CSS 的实际上限：.ann-popover 是 width:300px + max-width:calc(100vw - 24px)
        { width: Math.min(POPOVER_WIDTH, window.innerWidth - 24), height: popH },
        { width: window.innerWidth, height: window.innerHeight },
      )
    : null

  return (
    <div
      className={`reader theme-${resolvedTheme}${chromeHidden ? ' is-chrome-hidden' : ''}`}
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
          onClick={() => togglePanel('toc')}
          title="目录"
          disabled={toc.length === 0}
          aria-expanded={tocOpen}
        >
          目录
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => togglePanel('settings')}
          title="排版"
          aria-expanded={settingsOpen}
        >
          排版
        </button>
        {/* 一键书签（P1-3）：单击把当前位置存为书签，同一位置再点取消（toggle）。
            原先必须「开书签面板 → 点添加当前位置」两步，入口太深；现绑 Ctrl+B。

            ⚠️ 文案（v0.1.6 改）：这里**不能再叫「书签」**——原来它和右边那个
            「书签 N」（打开列表）同名又相邻，用户压根分不清哪个是"加"、哪个是"看"，
            实测反馈就是"只能加书签、没办法查看书签"。现在动词化：
            本按钮 = 「标记」（动作），右边 = 「书签 N」（查看）。动作词与名词各占一个。 */}
        <button
          className={`btn btn-ghost${atBookmark ? ' is-active' : ''}`}
          onClick={() => void toggleCurrentBookmark()}
          title={atBookmark ? '取消当前位置的书签（Ctrl+B）' : '把当前位置加为书签（Ctrl+B）'}
          aria-pressed={atBookmark}
        >
          {atBookmark ? '已标记' : '＋ 标记'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => togglePanel('bookmarks')}
          title="书签"
          aria-expanded={bookmarksOpen}
        >
          书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => togglePanel('search')}
          title="搜索本书"
          aria-expanded={searchOpen}
        >
          搜索
        </button>
        {/* 不再在"零笔记"时禁用。原先 disabled={annotations.length === 0} 的后果是：
            新用户从未用过这个功能，也就永远看不到入口存在 —— 功能不可发现。
            所有"新功能入口"都不该在用户用过之前隐藏；空态里给一句引导即可。 */}
        <button
          className="btn btn-ghost"
          onClick={openExportPanel}
          title="管理高亮与笔记：勾选后可导出或删除"
        >
          笔记{annotations.length > 0 ? ` ${annotations.length}` : ''}
        </button>
        {/* 百分比 + 本章剩余时间（P1-2；v0.1.6 改为**常驻**）。
            原先必须点这串数字才切出剩余时间，而它长得跟纯文本一样（特意去掉了
            按钮的边框与底色），几乎没人发现它能点 —— 实测反馈"没看到这个功能"。
            现在两者并排显示：`62.3% · 剩约 12 分`。
            - 拖动进度条时只显示拖动值（那会儿剩余时间算出来是错的）；
            - 样本不足（remainMinutes 为 null）时只显示百分比，绝不编一个数。 */}
        <span className="reader-percent" title="全书阅读进度 · 本章剩余时间">
          {dragPercent == null
            ? formatPercentLine(percent, remainMinutes)
            : `${dragPercent.toFixed(1)}%`}
        </span>
        {/* 快捷键入口（P1-4）：10+ 个键早就实现了，界面上却一个说明都没有，
            用户不知道有这些键 = 功能白做一半。这个「?」就是那个"入口"：
            常驻顶栏，随时可查；右键位（? 本身）也能开。
            挂在最右端的原因：手机顶栏是横向可滑的，把高频按钮往左挤不值当；
            而桌面端顶栏右侧本来就是"帮助"的常规位置。 */}
        <button
          ref={helpBtnRef}
          className="btn btn-ghost reader-help"
          onClick={() => togglePanel('help')}
          title="键盘快捷键与触屏手势（按 ?）"
          aria-label="键盘快捷键与触屏手势"
          aria-expanded={helpOpen}
        >
          ?
        </button>
      </header>

      {/* 书级可拖进度条（P1-1）：拖到 x% 跳到对应章，两端是上一章 / 下一章。
          它与顶栏同属"外壳"，手机点正文中间收起顶栏时一并隐藏。 */}
      <div className="reader-progressbar">
        <button
          className="btn btn-ghost"
          onClick={() => goAdjacentChapter(-1)}
          title="上一章（Ctrl+PageUp）"
        >
          上一章
        </button>
        <input
          type="range"
          className="progress-slider"
          min={0}
          max={1000}
          step={1}
          value={Math.round((dragPercent ?? percent) * 10)}
          onChange={(e) => onProgressDrag(Number(e.target.value) / 10)}
          // 松手才真正跳章：鼠标 / 触屏 / 键盘各挂一种，覆盖三类输入
          onPointerUp={commitProgressDrag}
          onTouchEnd={commitProgressDrag}
          onKeyUp={commitProgressDrag}
          onBlur={commitProgressDrag}
          aria-label="阅读进度"
          aria-valuetext={`${(dragPercent ?? percent).toFixed(1)}%`}
        />
        <button
          className="btn btn-ghost"
          onClick={() => goAdjacentChapter(1)}
          title="下一章（Ctrl+PageDown）"
        >
          下一章
        </button>
      </div>

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
          onTouchCancel={handleTouchCancel}
          onMouseUp={() => openSelectionPopover()}
          style={{
            '--reader-font-size': `${settings.fontSize}px`,
            '--reader-line-height': `${settings.lineHeight}`,
            // 生效留白 = min(设置值, 屏宽封顶 12%)：手机上把 120 拖到底也不会
            // 把正文压成一条线（见 settings.ts 的 pageMarginCapPx）
            '--reader-page-margin': `${effectivePageMargin(settings.pageMargin, viewportWidth)}px`,
            // 栏宽系数：留白 20px 及以上 = 1（标准 760px 栏宽），往 0 拖线性放宽，
            // 0 时为 0 → .chapter 的 max-width 变成 100%，正文真正铺满（见 index.css）
            '--reader-content-t': `${contentWidthFactor(settings.pageMargin)}`,
            '--reader-font-family': fontStack(settings.fontFamily),
          } as React.CSSProperties}
        >
          {showRestoreHint && (
            <div className="restore-hint" role="status" aria-live="polite">
              已回到上次阅读位置
            </div>
          )}
          {bookmarkHint && (
            <div className="restore-hint" role="status" aria-live="polite">
              {bookmarkHint}
            </div>
          )}
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

        {/* 手机上侧栏是从底部升起的浮层，这层遮罩负责"点空白处关掉"；
            桌面端两个面板是并排的侧栏，遮罩在 CSS 里被隐藏。 */}
        {(tocOpen || settingsOpen || bookmarksOpen || searchOpen || exportOpen || helpOpen) && (
          <div className="panel-backdrop" onClick={closeAllPanels} aria-hidden="true" />
        )}

        {/* 首次进阅读页的轻引导（P1-4）：先让用户知道"有快捷键这回事"，
            再给一个直接的下一步入口（点正文即开速查表）。
            8 秒后自己消失；「不再提示」与「×」的区别是"永久"与"仅本次会话"。 */}
        {showShortcutHint && (
          <div className="shortcut-hint" role="status" aria-live="polite">
            <button
              type="button"
              className="shortcut-hint__body"
              onClick={() => togglePanel('help')}
              title="查看全部快捷键与手势"
            >
              <span className="shortcut-hint__title">键盘也能翻书</span>
              <span className="shortcut-hint__text">
                按 {helpKeyLabel} 或点顶栏「?」，查看全部快捷键与触屏手势
              </span>
            </button>
            <div className="shortcut-hint__actions">
              <button
                type="button"
                className="shortcut-hint__dismiss"
                onClick={() => {
                  dismissShortcutHint()
                  setShowShortcutHint(false)
                }}
                title="以后不再提示"
              >
                不再提示
              </button>
              <button
                type="button"
                className="shortcut-hint__close"
                aria-label="关闭提示"
                onClick={() => setShowShortcutHint(false)}
              >
                ×
              </button>
            </div>
          </div>
        )}

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
                  <span>页边距</span>
                  <span className="settings-value">{settings.pageMargin}px</span>
                </div>
                {/* 语义是「左右留白」：值越大正文越窄。
                    旧版这里是「正文最大宽度」（480–900），在手机上恒大于屏宽，
                    滑块怎么拖正文都一样宽；现在 0–120 全程可见地生效。
                    另外栏宽上限也跟着滑块走（contentWidthFactor）：留白 ≥ 20px 时
                    是标准 760px 栏宽，越往 0 拖上限越放宽，0 就是铺满可用宽度。
                    滑块上限按屏宽收（min(120, 12% 屏宽)）：否则手机上滑块右半段
                    全是"拖了没反应"的死区（屏幕只认 44px，却让你拖到 120）。 */}
                <input
                  type="range"
                  min="0"
                  max={marginCap}
                  step={PAGE_MARGIN_STEP}
                  value={effectivePageMargin(settings.pageMargin, viewportWidth)}
                  aria-label="页边距"
                  onChange={(e) => updateSettings({ pageMargin: Number(e.target.value) })}
                />
                <p className="settings-hint">
                  往右拖两侧留白变宽、每行字数变少；拖到 0 正文铺满
                  {marginCap < PAGE_MARGIN_MAX
                    ? `（本屏每侧最多 ${marginCap}px：再往里挤就放不下一行了）`
                    : ''}
                </p>
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>字体</span>
                </div>
                <div className="settings-row">
                  {FONT_KEYS.map((f) => {
                    // 本机没有这个字体文件（iOS / Android 都没有宋体、楷体这套桌面字体，
                    // 部分浏览器还会屏蔽系统字体名）：点了也不会有任何变化，
                    // 直接禁用（淡化即"不可用"的通用视觉语言），原因放在下面的折叠说明里。
                    // 不再逐个按钮挂"不可用"角标——手机面板本来就窄，5 个角标太吵。
                    const usable = fontUsable[f] !== false
                    return (
                      <button
                        key={f}
                        className={`settings-pill settings-pill--font${settings.fontFamily === f ? ' active' : ''}`}
                        disabled={!usable}
                        aria-label={usable ? undefined : `${FONT_LABELS[f]}（本机不可用）`}
                        title={usable ? undefined : `${FONT_LABELS[f]}在本机不可用`}
                        onClick={() => updateSettings({ fontFamily: f })}
                      >
                        {FONT_LABELS[f]}
                      </button>
                    )
                  })}
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
                {unavailableFonts.length > 0 && (
                  <details className="settings-details">
                    <summary>{unavailableFonts.length} 种字体在本机不可用</summary>
                    <p className="settings-details__body">
                      本机没有这些字体文件，选了也不会有变化。想固定字形，用「＋自定义」上传
                      <code>.ttf</code> / <code>.otf</code> 字体文件，各平台表现一致。
                    </p>
                  </details>
                )}
                {isSelectedFontUnavailable && (
                  <p className="settings-hint settings-hint--warn">
                    「{FONT_LABELS[settings.fontFamily as FontKey]}」在本机不生效，正文用的是系统替代字体。
                  </p>
                )}
              </div>

              <div className="settings-group">
                <div className="settings-label">
                  <span>主题</span>
                </div>
                <div className="settings-row">
                  {/* 「跟随系统」排第一（P2-5）：它是默认值，新用户不必先找到
                      「夜间」按钮 —— 系统已是深色时进阅读页就是深色。
                      手点任何一个具体主题 = 显式选择，从此锁定，不再被系统日夜切换带走。 */}
                  {THEME_CHOICES.map((t) => (
                    <button
                      key={t}
                      className={`settings-pill${settings.theme === t ? ' active' : ''}`}
                      aria-pressed={settings.theme === t}
                      onClick={() =>
                        updateSettings(
                          t === 'auto'
                            ? { theme: 'auto', themeLocked: false }
                            : { theme: t, themeLocked: true },
                        )
                      }
                    >
                      {THEME_LABELS[t]}
                    </button>
                  ))}
                </div>
                {settings.theme === 'auto' && (
                  <p className="settings-hint">
                    正在跟随系统，当前显示为「{THEME_LABELS[resolvedTheme]}」。
                  </p>
                )}
              </div>

              {/* 恢复默认（P2-4）：滑到一半想回头，原先只能记住默认值一个个手调回来。
                  刻意**不动自定义字体**——字体是用户上传的文件，清空元数据会让它从面板上
                  凭空消失（二进制还在库里，等于丢文件）。 */}
              <div className="settings-group settings-group--reset">
                <button className="btn settings-reset" onClick={resetSettings}>
                  恢复默认排版
                </button>
                <p className="settings-hint">
                  字号 {DEFAULT_SETTINGS.fontSize}px · 行距 {DEFAULT_SETTINGS.lineHeight} ·
                  页边距 {DEFAULT_SETTINGS.pageMargin}px · 字体与主题回到初始（自定义字体保留）
                </p>
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
                <p className="search-empty">
                  还没有高亮。在正文里选中一段文字，点浮层里的「加高亮」就有了；
                  之后随时回到这里导出或删除。
                </p>
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

        {/* 快捷键速查表（P1-4）。内容全部来自 src/lib/shortcuts.ts ——
            与上面那个键盘处理函数共用一份数据，所以"这张表里写的键"
            就是"按下去真管用的键"，不会各说各话。 */}
        {helpOpen && (
          <aside
            className="search-panel shortcut-sheet"
            role="dialog"
            aria-label="键盘快捷键与触屏手势"
          >
            <div className="search-header">
              <span>快捷键</span>
              <button
                ref={helpCloseRef}
                className="btn btn-ghost"
                onClick={() => setHelpOpen(false)}
                title="关闭（Esc）"
              >
                ×
              </button>
            </div>
            {/* tabIndex=0：这层是滚动容器，里面全是不可聚焦的文字，不给它键盘焦点
                的话键盘用户根本滚不动（axe 报的 scrollable-region-focusable）。 */}
            <div className="shortcut-body" tabIndex={0}>
              {SHORTCUT_GROUPS.map((group) => (
                <section className="shortcut-group" key={group.id}>
                  <div className="shortcut-group__title">{group.title}</div>
                  <ul className="shortcut-list">
                    {group.items.map((item) => (
                      <li className="shortcut-row" key={item.id}>
                        <span className="shortcut-keys">
                          {item.keys.map((k) => (
                            <kbd key={k.key}>{formatKey(k, modLabel)}</kbd>
                          ))}
                        </span>
                        <span className="shortcut-action">{item.action}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}

              {/* 触屏用户没有键盘，但"不知道就能不用"是同一个坑，一并写清 */}
              <section className="shortcut-group">
                <div className="shortcut-group__title">触屏手势</div>
                <ul className="shortcut-list">
                  {TOUCH_GESTURES.map((g) => (
                    <li className="shortcut-row" key={g.move}>
                      <span className="shortcut-keys shortcut-keys--text">{g.move}</span>
                      <span className="shortcut-action">{g.action}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </aside>
        )}

        {/* 结果提示（P1-2）：这几条之前是纯 <div>，读屏用户完全听不到
            （"导出完了没""这段是不是已经高亮过"全成了静默操作）。
            对齐 Library 的 shelf-toast：role=status + aria-live=polite，
            不打断当前朗读、等一句读完再播报。 */}
        {toast && (
          <div className="export-toast" role="status" aria-live="polite">
            {toast}
          </div>
        )}

        {activeAnn && (
          <div
            className="ann-popover"
            ref={popRef}
            // 位置由 resolvePopoverPosition 算好（含"下方放不下就翻上去"），
            // 不再是一句 top: rect.bottom + 8 —— 那正是手机划词靠底部时
            // 浮层下半截被工具栏吃掉、「加高亮 / 取消」按不到的原因。
            style={{ position: 'fixed', top: annPos?.top ?? 0, left: annPos?.left ?? 0 }}
          >
            <div className="ann-popover__excerpt">{activeAnn.excerpt}</div>
            {/* 颜色选择（P1-7 / P1-1）：create 时只是选色；view 时点了立刻改色。
                色块上直接写语义文字（重点/疑问/待查/喜欢）—— 原先四个 26px 纯色圆点
                对明眼色盲用户等于四个一样的灰点，只能靠猜。
                读屏层本来就有 label，这次补的是**视觉层**（WCAG 1.4.1 非颜色传达）。 */}
            <div className="ann-popover__colors" role="group" aria-label="高亮颜色">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`ann-color${activeColor === c.key ? ' active' : ''}`}
                  data-color={c.key}
                  title={c.label}
                  aria-pressed={activeColor === c.key}
                  onClick={() => void changeActiveColor(c.key)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <textarea
              className="ann-popover__note"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={activeAnn.mode === 'create' ? '写点笔记（可留空）…' : '写点笔记…'}
              // 触屏弹出来的浮层**不抢焦点**：一抢就弹起软键盘，正好盖住浮层本身
              // （想写笔记的用户自己点一下输入框即可）。桌面维持原样，鼠标端敲笔记更顺。
              autoFocus={activeAnn.mode === 'create' && !activeAnn.fromTouch}
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
