// 快捷键表（P1-4）的守门测试。
//
// 这张表是「速查浮层里写出来的键」和「键盘处理真正认的键」的共同来源，
// 所以这里逐个按一遍表里的每一个键位，确认 matchShortcut 都认得出来。
// 哪天有人改了表却没改实现（或反过来），这组用例会先炸——
// 而不是等用户在真机上按了半天没反应才发现说明是假的。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOD_SHORTCUT_KEYS,
  SHORTCUT_GROUPS,
  TOUCH_GESTURES,
  dismissShortcutHint,
  formatKey,
  markShortcutHintSeen,
  matchShortcut,
  modKeyLabel,
  shortcutRows,
  shouldShowShortcutHint,
  type ShortcutId,
} from '../src/lib/shortcuts'

/** 表里所有键盘条目（浮层渲染的就是它们） */
const allItems = SHORTCUT_GROUPS.flatMap((g) => g.items)

describe('快捷键表', () => {
  it('表里写出的每个键，键盘处理都认（文案与实际绑定不许漂移）', () => {
    for (const item of allItems) {
      expect(item.keys.length).toBeGreaterThan(0)
      for (const k of item.keys) {
        expect(matchShortcut({ key: k.key, ctrlKey: !!k.mod })).toBe(item.id)
        // Mac 用户按的是 ⌘（metaKey），代码里同样要认
        if (k.mod) expect(matchShortcut({ key: k.key, metaKey: true })).toBe(item.id)
      }
    }
  })

  it('动作清单固定：增删快捷键必须由人显式改这行，不许悄悄漂移', () => {
    expect(allItems.map((i) => i.id)).toEqual([
      'pageDown',
      'pageUp',
      'chapterTop',
      'bookStart',
      'bookEnd',
      'prevChapter',
      'nextChapter',
      'search',
      'bookmark',
      'help',
      'close',
    ])
  })

  it('一个组合只归一个动作（不许两个动作抢同一个键）', () => {
    const owner = new Map<string, ShortcutId>()
    for (const item of allItems) {
      for (const k of item.keys) {
        const sig = `${k.mod ? 'mod+' : ''}${k.key.toLowerCase()}`
        expect(owner.get(sig) ?? item.id).toBe(item.id)
        owner.set(sig, item.id)
      }
    }
  })

  it('修饰键必须分流：Ctrl+Home 跳书首，Home 只回本章顶部', () => {
    expect(matchShortcut({ key: 'Home' })).toBe('chapterTop')
    expect(matchShortcut({ key: 'Home', ctrlKey: true })).toBe('bookStart')
    expect(matchShortcut({ key: 'PageDown' })).toBe('pageDown')
    expect(matchShortcut({ key: 'PageDown', ctrlKey: true })).toBe('nextChapter')
    expect(matchShortcut({ key: 'PageUp', metaKey: true })).toBe('prevChapter')
  })

  it('字母键不分大小写（按住 Shift 也照常管用）', () => {
    expect(matchShortcut({ key: 'B', ctrlKey: true })).toBe('bookmark')
    expect(matchShortcut({ key: 'b', metaKey: true })).toBe('bookmark')
    expect(matchShortcut({ key: 'F', metaKey: true })).toBe('search')
  })

  it('不认识的键返回 null：浏览器自己的快捷键不许被阅读器吞掉', () => {
    // Tab 走焦点、Cmd+Q 退出、Ctrl+R 刷新、Ctrl+P 打印、F5 刷新
    for (const key of ['Tab', 'q', 'r', 'p', 'a', 'Enter', 'F5', 'Shift']) {
      expect(matchShortcut({ key, ctrlKey: true })).toBeNull()
      expect(matchShortcut({ key })).toBeNull()
    }
    expect(matchShortcut({ key: '' })).toBeNull()
  })

  it('MOD_SHORTCUT_KEYS 与表里实际用到的 mod 键一一对应（没有僵尸定义）', () => {
    const fromTable = allItems
      .flatMap((i) => i.keys)
      .filter((k) => k.mod)
      .map((k) => k.key.toLowerCase())
    expect([...fromTable].sort()).toEqual(Object.values(MOD_SHORTCUT_KEYS).sort())
  })
})

describe('键位文案', () => {
  it('Mac / iOS 显示 ⌘，其它平台显示 Ctrl', () => {
    expect(modKeyLabel('MacIntel')).toBe('⌘')
    expect(modKeyLabel('iPhone')).toBe('⌘')
    expect(modKeyLabel('Win32')).toBe('Ctrl')
    expect(modKeyLabel('Linux x86_64')).toBe('Ctrl')
  })

  it('键名转成人看的写法：方向键画箭头、空格写「空格」', () => {
    expect(formatKey({ key: 'ArrowRight' }, '⌘')).toBe('→')
    expect(formatKey({ key: 'ArrowDown' }, '⌘')).toBe('↓')
    expect(formatKey({ key: ' ' }, '⌘')).toBe('空格')
    expect(formatKey({ key: 'Escape' }, 'Ctrl')).toBe('Esc')
    expect(formatKey({ key: 'PageUp' }, 'Ctrl')).toBe('PageUp')
    expect(formatKey({ key: 'PageUp', mod: true }, '⌘')).toBe('⌘+PageUp')
    expect(formatKey({ key: 'f', mod: true }, 'Ctrl')).toBe('Ctrl+F')
  })

  it('shortcutRows 直接给出最终文案（浮层自己不拼字符串）', () => {
    const rows = shortcutRows('⌘')
    expect(rows.find((r) => r.id === 'pageDown')?.keys).toEqual(['→', '↓', '空格'])
    expect(rows.find((r) => r.id === 'nextChapter')?.keys).toEqual(['⌘+PageDown'])
    expect(rows.find((r) => r.id === 'help')?.keys).toEqual(['?'])
    // 说明文字不能为空——空说明等于没说明
    for (const r of rows) expect(r.action.trim().length).toBeGreaterThan(0)
  })

  it('中文说明都用得上（没有把键位名当说明的偷懒写法）', () => {
    for (const r of shortcutRows('Ctrl')) {
      expect(r.action).not.toBe(r.keys.join(' / '))
    }
  })
})

describe('触屏手势说明', () => {
  it('手势都写了动作描述（手机上没键盘，这份说明是唯一入口）', () => {
    expect(TOUCH_GESTURES.length).toBeGreaterThan(0)
    for (const g of TOUCH_GESTURES) {
      expect(g.move.trim().length).toBeGreaterThan(0)
      expect(g.action.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('首次引导的记账（P1-4）', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('默认要弹；本次会话弹过就不再弹', () => {
    expect(shouldShowShortcutHint()).toBe(true)
    markShortcutHintSeen()
    expect(shouldShowShortcutHint()).toBe(false)
  })

  it('点了「不再提示」→ 换了会话也不弹', () => {
    dismissShortcutHint()
    // 模拟"关掉标签页再开"：会话标记没了，但永久标记还在
    sessionStorage.clear()
    expect(shouldShowShortcutHint()).toBe(false)
  })

  it('storage 直接抛异常（私密模式）时不炸，顶多多弹一次', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })
    try {
      expect(shouldShowShortcutHint()).toBe(true)
      // 写不进去也不该抛出去打断渲染
      expect(() => markShortcutHintSeen()).not.toThrow()
      expect(() => dismissShortcutHint()).not.toThrow()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
