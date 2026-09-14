// ---------- 浏览器存储保护：申请 persistent storage ----------
//
// 浏览器默认把 IndexedDB 当 "best-effort" 数据：磁盘吃紧、长期不访问、
// 或用户清理站点数据时，**整个 origin 的存储可能被一次性清空**。
// 书、进度、书签、高亮笔记、阅读统计全在里面，丢了没有任何挽回余地——
// 对本项目来说这是一处和「删书无二次确认」同级的风险。
//
// `navigator.storage.persist()` 把当前 origin 的存储桶升级为 "persistent"：
// 之后只有用户显式清理才会消失，浏览器不再自动驱逐。
//
// 但**浏览器可以拒绝**，而且拒绝是常态——Chrome 按"用户参与度 / 是否安装为
// 应用"静默判定，全新访客基本拿不到；Firefox 才会弹窗询问。所以：
//   ① 申请要安静地做（不打断用户）；
//   ② 只在**用户书架上确实有东西可丢**时才提醒，且提醒可一键永久关掉，
//      否则就是"狼来了"，用户很快就会无视所有提示。

/** 申请结果：拿到保护 / 被拒 / 环境不支持（旧浏览器、私密模式、非安全上下文） */
export type PersistState = 'granted' | 'denied' | 'unsupported'

/** 用户点过「不再提示」的标记（localStorage，独立于被清理的 IndexedDB） */
const DISMISS_KEY = 'storage-hint-dismissed'

/**
 * 会话内的去重缓存。
 * React 严格模式会故意把 effect 跑两遍（开发态），两个请求会同时打到
 * persist() 上——真机实测确实调了两次。这个 Promise 让并发调用共用一次申请。
 */
let pendingRequest: Promise<PersistState> | null = null

/**
 * 申请持久化存储。同一次页面加载内只真正申请一次，重复调用拿同一个结果。
 *
 * 不做跨会话缓存：Chrome 的判定会随"用户参与度"变化（常来、加书签、装成应用
 * 之后就可能通过），每次打开重新申请一次才有机会翻盘；已经拿到的情况
 * `persisted()` 会直接返回 true，几乎零成本。
 */
export function ensurePersistentStorage(): Promise<PersistState> {
  if (pendingRequest) return pendingRequest
  pendingRequest = request()
  return pendingRequest
}

async function request(): Promise<PersistState> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
  if (!storage || typeof storage.persist !== 'function') return 'unsupported'

  // persisted() 只是"查一下现在是不是 persistent"，失败不影响后续申请
  let already = false
  if (typeof storage.persisted === 'function') {
    try {
      already = await storage.persisted()
    } catch {
      already = false
    }
  }
  if (already) return 'granted'

  try {
    return (await storage.persist()) ? 'granted' : 'denied'
  } catch {
    // 私密模式 / 用户禁用了存储：persist() 会直接抛，别让启动流程跟着崩
    return 'unsupported'
  }
}

/** 只用于测试/诊断：丢掉会话缓存，下次调用重新申请 */
export function resetPersistCache(): void {
  pendingRequest = null
}

/** 用户是否已经说过"别再提示了" */
export function isStorageHintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    // 私密模式下 localStorage 可能直接抛：拿不到就当没关过（提示仍会出现，只是会再问一次）
    return false
  }
}

/** 记住"别再提示了"。写不进去也不影响本次隐藏（内存态已经改了） */
export function dismissStorageHint(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* 存不下就算了，不为此报错打扰用户 */
  }
}
