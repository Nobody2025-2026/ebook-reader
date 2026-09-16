// ---------- 键盘快捷键：键位与说明的**唯一来源**（P1-4）----------
//
// 问题（原话见 docs/UI优化建议意见书.md P1-4）：这些键早就实现了
// ——Ctrl+B / Ctrl+F / Ctrl+Home / Ctrl+End / Ctrl+PageUp / Ctrl+PageDown、
// 方向键、空格、Esc——但**界面上一个入口都没有**。用户不知道有这些键，
// 等于功能白做一半。这跟"剩余时间得点一下才出来"是同一类可发现性坑。
//
// 但仅仅"加一个说明浮层"是不够的：说明如果手写、实现另写，两边迟早对不上
// （改了实现忘改说明 → 说明变成谎话）。所以这里把两件事**绑在一份数据上**：
//
//   ① 浮层渲染：SHORTCUT_GROUPS 里的每一条直接画出来；
//      显示文案由「真正参与匹配的 key」推导（formatKey），
//      不存在"说明写 Ctrl+E、实际绑的是 F"这种漂移。
//   ② 键盘处理：Reader 的 keydown 不再写 `e.key === 'b'` 之类的硬编码，
//      统一调 matchShortcut() 拿一个 ShortcutId 再分发。
//      新增键位忘了接处理器会在编译期炸（switch 上做了穷尽性检查）；
//      新增了表项但没接动作，则会卡在测试里（见 tests/shortcuts.test.ts）。
//
// 触屏手势另算一份数据（TOUCH_GESTURES）：它没有键、也没法"匹配"，
// 但同样属于"用户不知道就不会用"，所以一并放进同一个浮层。

/** 一个键位：怎么匹配（key/mod）+ 怎么显示（由 formatKey 推导） */
export interface ShortcutKey {
  /** KeyboardEvent.key 的原始值（一律填真实值，测试照它派发事件） */
  key: string
  /** 需要 Ctrl（Mac 上是 ⌘）同按 */
  mod?: boolean
}

/** 一条快捷键：一个动作 + 可以触发它的键（同一动作常有多个键，如 → 和 ↓ 和空格） */
export interface ShortcutItem {
  id: ShortcutId
  /** 这个键做什么（浮层里的说明文字） */
  action: string
  keys: ShortcutKey[]
}

export interface ShortcutGroup {
  id: string
  title: string
  items: ShortcutItem[]
}

/** 需要 Ctrl / ⌘ 的动作 → 主键（统一小写，匹配前会归一化） */
export const MOD_SHORTCUT_KEYS = {
  bookmark: 'b',
  search: 'f',
  bookStart: 'home',
  bookEnd: 'end',
  prevChapter: 'pageup',
  nextChapter: 'pagedown',
} as const

/** 无需修饰键的动作 → 可以触发它的键（可多个） */
export const PLAIN_SHORTCUT_KEYS = {
  pageDown: ['arrowright', 'arrowdown', 'pagedown', ' '],
  pageUp: ['arrowleft', 'arrowup', 'pageup'],
  chapterTop: ['home'],
  help: ['?'],
  close: ['escape'],
} as const

export type ModShortcutId = keyof typeof MOD_SHORTCUT_KEYS
export type PlainShortcutId = keyof typeof PLAIN_SHORTCUT_KEYS
export type ShortcutId = ModShortcutId | PlainShortcutId

/**
 * 按键 → 动作。
 *
 * 有修饰键时**只认 MOD_SHORTCUT_KEYS 里的组合**（Ctrl+PageUp = 上一章）；
 * 没有修饰键时只看 PLAIN_SHORTCUT_KEYS（PageUp = 上一屏）。
 * 同一批具名键在两种情况下含义完全不同，所以必须先按修饰键分流，
 * 否则 Ctrl+Home（跳书首）会被当成本章顶部。
 *
 * 返回 null = 我们不认识这个键，交回给浏览器（别乱 preventDefault：
 * 例如 Tab 走焦点、Ctrl+R 刷新、Cmd+Q 退出，都不该被阅读器吞掉）。
 */
export function matchShortcut(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
}): ShortcutId | null {
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : ''
  if (!key) return null

  if (e.ctrlKey || e.metaKey) {
    const hit = (Object.keys(MOD_SHORTCUT_KEYS) as ModShortcutId[]).find(
      (id) => MOD_SHORTCUT_KEYS[id] === key,
    )
    return hit ?? null
  }

  const hit = (Object.keys(PLAIN_SHORTCUT_KEYS) as PlainShortcutId[]).find((id) =>
    (PLAIN_SHORTCUT_KEYS[id] as readonly string[]).includes(key),
  )
  return hit ?? null
}

// ---------- 显示文案 ----------

/** 具名键的显示写法（不在这张表里的按"原样大写"处理，字母键即可） */
const KEY_LABEL: Record<string, string> = {
  arrowright: '→',
  arrowdown: '↓',
  arrowleft: '←',
  arrowup: '↑',
  ' ': '空格',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  escape: 'Esc',
}

/** 把键位渲染成人看的文字：mod+pageup → 「⌘+PageUp」/「Ctrl+PageUp」 */
export function formatKey(k: ShortcutKey, modLabel: string): string {
  const base = KEY_LABEL[k.key.toLowerCase()] ?? k.key.toUpperCase()
  return k.mod ? `${modLabel}+${base}` : base
}

/**
 * 修饰键该显示成什么：Mac 用 ⌘，其它平台用 Ctrl。
 * 真读平台，而不是猜浏览器名 —— 用户在 Mac 上看到「Ctrl+B」会去按 Control 键，
 * 那个键在本项目里确实也能用（我们同时认 ctrlKey 与 metaKey），但只有 ⌘ 才符合直觉。
 */
export function modKeyLabel(platformHint?: string): string {
  if (typeof platformHint === 'string' && platformHint) {
    return /mac|iphone|ipad|ipod/i.test(platformHint) ? '⌘' : 'Ctrl'
  }
  if (typeof navigator === 'undefined') return 'Ctrl'
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const raw = uaData?.platform ?? navigator.platform ?? navigator.userAgent ?? ''
  return /mac|iphone|ipad|ipod/i.test(raw) ? '⌘' : 'Ctrl'
}

// ---------- 实际键位（浮层直接渲染这些，测试直接按这些）----------

/** 需要 Ctrl / ⌘ 同按的键 */
function modKey(key: string): ShortcutKey {
  return { key, mod: true }
}

/** 阅读器里的键盘操作，按"在哪用得上"分组 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'scroll',
    title: '翻屏',
    items: [
      {
        id: 'pageDown',
        action: '下一屏',
        keys: [{ key: 'ArrowRight' }, { key: 'ArrowDown' }, { key: ' ' }],
      },
      { id: 'pageUp', action: '上一屏', keys: [{ key: 'ArrowLeft' }, { key: 'ArrowUp' }] },
      { id: 'chapterTop', action: '回到本章顶部', keys: [{ key: 'Home' }] },
    ],
  },
  {
    id: 'position',
    title: '章节与位置',
    items: [
      { id: 'bookStart', action: '跳到全书开头', keys: [modKey('Home')] },
      { id: 'bookEnd', action: '跳到全书结尾', keys: [modKey('End')] },
      { id: 'prevChapter', action: '上一章', keys: [modKey('PageUp')] },
      { id: 'nextChapter', action: '下一章', keys: [modKey('PageDown')] },
    ],
  },
  {
    id: 'panel',
    title: '面板与操作',
    items: [
      { id: 'search', action: '开关「搜索本书」', keys: [modKey('f')] },
      { id: 'bookmark', action: '在当前位置加 / 取消书签', keys: [modKey('b')] },
      { id: 'help', action: '开关这张速查表', keys: [{ key: '?' }] },
      { id: 'close', action: '关掉开着的浮层 / 面板；都没开时回书库', keys: [{ key: 'Escape' }] },
    ],
  },
]

/** 触屏手势：没有"键"可匹配，纯说明（触屏上这三条是唯一的操作方式） */
export interface GestureItem {
  /** 显示用的动作描述 */
  move: string
  action: string
}

export const TOUCH_GESTURES: GestureItem[] = [
  { move: '点屏幕左 / 右边缘', action: '上一屏 / 下一屏' },
  { move: '左右滑动', action: '上一屏 / 下一屏' },
  { move: '点中间', action: '收起 / 唤出顶栏（沉浸阅读）' },
  { move: '长按选中一段文字', action: '弹出「加高亮」浮层' },
]

/** 把键位表里的显示文案都算好（浮层只需要渲染，不再自己拼字符串） */
export function shortcutRows(modLabel: string): {
  id: ShortcutId
  action: string
  keys: string[]
}[] {
  return SHORTCUT_GROUPS.flatMap((g) =>
    g.items.map((item) => ({
      id: item.id,
      action: item.action,
      keys: item.keys.map((k) => formatKey(k, modLabel)),
    })),
  )
}

// ---------- 首次引导：只弹一次，可永久关掉 ----------

/**
 * 「不再提示」的标记。
 *
 * 为什么用 localStorage：它跟持久化存储提示（persistence.ts）一样属于
 * "界面偏好"，不该混进被用户清理的书籍数据里 —— IndexedDB 被清空时
 * 重新弹一次引导是可以接受的，但为它丢掉读者的书则完全不可接受。
 */
const DISMISS_KEY = 'shortcut-hint-dismissed'

/** 「本次会话已经弹过」的标记：sessionStorage，关掉标签页就忘 */
const SEEN_KEY = 'shortcut-hint-seen'

/**
 * 要不要弹首次引导。两层判断：
 *
 * - 已点过「不再提示」→ 永不弹（localStorage，跨会话）；
 * - 本次会话已经弹过 → 不弹（sessionStorage）。
 *
 * 第二层的意义：引导会自己消失，但如果只在"用户点掉"时才记账，
 * 没理它的用户每次开书都会被弹一次（persistence.ts 里吐槽过的"狼来了"）。
 * 反过来如果弹过一次就永久记账，那个「不再提示」按钮又变成多余的装饰。
 * 所以拆成"本次会话最多一次 + 显式点击才永久关闭"，两个入口各有各的意思。
 */
export function shouldShowShortcutHint(): boolean {
  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return false
    if (sessionStorage.getItem(SEEN_KEY) === '1') return false
    return true
  } catch {
    // 私密模式下 storage 可能直接抛：拿不到标记就当没弹过（顶多多弹一次）
    return true
  }
}

/** 记下"本次会话弹过了"（引导出现时调用） */
export function markShortcutHintSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* 存不下不影响本次显示 */
  }
}

/** 记下"别再提示了"（用户点「不再提示」时调用） */
export function dismissShortcutHint(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* 同上：写不进去也只是下次会再弹一遍 */
  }
}
