import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissStorageHint,
  ensurePersistentStorage,
  isStorageHintDismissed,
  resetPersistCache,
} from '../src/lib/persistence'

/** 造一个假的 navigator.storage；传 undefined 表示这个环境压根没有 storage */
function stubStorage(storage: unknown) {
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage })
}

beforeEach(() => {
  resetPersistCache()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensurePersistentStorage', () => {
  it('已经拿到过持久化：不再重复申请', async () => {
    const persist = vi.fn()
    stubStorage({ persisted: vi.fn().mockResolvedValue(true), persist })
    expect(await ensurePersistentStorage()).toBe('granted')
    expect(persist).not.toHaveBeenCalled()
  })

  it('申请成功 → granted', async () => {
    stubStorage({ persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true) })
    expect(await ensurePersistentStorage()).toBe('granted')
  })

  it('申请被浏览器拒绝 → denied（上层据此决定要不要提示用户）', async () => {
    stubStorage({ persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(false) })
    expect(await ensurePersistentStorage()).toBe('denied')
  })

  // 真机实测：React 严格模式下 effect 跑两遍，persist() 被调了两次。
  // 同一个页面加载里重复申请没有意义，并发调用必须共用一次请求。
  it('并发重复调用只真正申请一次（React 严格模式）', async () => {
    const persist = vi.fn().mockResolvedValue(false)
    stubStorage({ persisted: vi.fn().mockResolvedValue(false), persist })
    const [a, b] = await Promise.all([ensurePersistentStorage(), ensurePersistentStorage()])
    expect([a, b]).toEqual(['denied', 'denied'])
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('申请过一次后再次调用直接复用结果（不重复申请）', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persisted: vi.fn().mockResolvedValue(false), persist })
    await ensurePersistentStorage()
    await ensurePersistentStorage()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('环境没有 navigator.storage → unsupported，不抛错', async () => {
    stubStorage(undefined)
    expect(await ensurePersistentStorage()).toBe('unsupported')
  })

  it('storage 存在但没有 persist 方法 → unsupported', async () => {
    stubStorage({ estimate: vi.fn() })
    expect(await ensurePersistentStorage()).toBe('unsupported')
  })

  it('私密模式 / 存储被禁用时 persist() 抛错 → unsupported，不把启动流程带崩', async () => {
    stubStorage({
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockRejectedValue(new TypeError('storage disabled')),
    })
    expect(await ensurePersistentStorage()).toBe('unsupported')
  })

  it('persisted() 抛错不影响继续申请（它只是"查一下现在状态"）', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage({ persisted: vi.fn().mockRejectedValue(new Error('nope')), persist })
    expect(await ensurePersistentStorage()).toBe('granted')
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('没有 persisted() 的老实现也能走通（直接申请）', async () => {
    stubStorage({ persist: vi.fn().mockResolvedValue(true) })
    expect(await ensurePersistentStorage()).toBe('granted')
  })
})

describe('备份提示的「不再提示」标记', () => {
  it('默认没关过', () => {
    expect(isStorageHintDismissed()).toBe(false)
  })

  it('关过之后记住（刷新页面不再提示）', () => {
    dismissStorageHint()
    expect(isStorageHintDismissed()).toBe(true)
  })

  it('localStorage 不可用（私密模式）时不抛错，视为"没关过"', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => dismissStorageHint()).not.toThrow()
    expect(isStorageHintDismissed()).toBe(false)
    vi.unstubAllGlobals()
  })
})
