// 存储守卫：IndexedDB 读写失败怎么处理。**单一来源。**
//
// 为什么单独一个文件：
// 这些守卫最初写在 storage.ts 里，但 storage.ts 之外还有两个模块直接 import
// idb-keyval 自己落库 —— settings.ts（排版设置）与 customFont.ts（自定义字体二进制）。
// 它们没法复用 storage.ts 里的守卫（会把依赖方向绕成环），于是**压根没兜底**：
// 写失败直接变成未捕获的 rejection，除了控制台一行，用户毫不知情。
// （这是真浏览器复核时抓出来的：打开"写满"开关后页面立刻冒出未捕获错误。）
// 现在守卫放这里，三个模块一起用；以后新增落库模块也不会再漏。

// ---- 写入失败怎么处理（别在这一层吞掉）----
//
// 存储是会失败的：磁盘配额满、隐私模式禁用 IndexedDB、用户清了站点数据、
// 另一个标签页正在写同一个库…… 而**写失败不吭声是最坏的一种失败**：
// 用户点了「加高亮」，界面上什么都没发生，他以为存住了，下次打开书一条都没有。
// 所以定死一条规则：
//
//   **写失败一律抛出去，由调用方给回音**（toast / 提示条），绝不静默吞掉。
//
// 所有 `set` / `del` 都过 `writeGuard`，以后新增函数自动覆盖 ——
// 不用指望谁记得逐个加 try/catch（三个模块、二十几个函数一个没加就是前车之鉴）。
//
// 注意本层只负责「抛得明白」：把 DOMException 那种只有一个 name 的错误
// 翻译成人话（配额满 / 隐私模式 / 其他），并在控制台留下原始错误供排查。

/** 写入失败。调用方必须捕获并给用户回音，不能任其变成未捕获的 rejection。 */
export class StorageWriteError extends Error {
  /** 原始错误（浏览器给的多半只有 name，翻译可能不准，排查要看它） */
  readonly cause: unknown

  constructor(label: string, cause: unknown) {
    super(`${label}失败：${describeStorageFailure(cause)}`)
    this.name = 'StorageWriteError'
    this.cause = cause
  }
}

/**
 * 浏览器抛的是 DOMException，而**它不是 Error 的实例** ——
 * 用 `instanceof Error` 取 name/message 会全落空（只能拿到 String(err) 那种
 * "QuotaExceededError: xxx" 的拼接串）。配额那条就是靠"串里含 Quota"误打误撞
 * 才对的，换个错就翻车。这里统一按属性读。
 */
export function errorField(err: unknown, field: 'name' | 'message'): string {
  if (err instanceof Error) return err[field]
  const v = (err as { [k: string]: unknown } | null | undefined)?.[field]
  return typeof v === 'string' ? v : ''
}

function describeStorageFailure(cause: unknown): string {
  const name = errorField(cause, 'name')
  const msg = errorField(cause, 'message') || String(cause ?? '')
  if (name === 'QuotaExceededError' || /quota|存储|空间/i.test(msg)) {
    return '存储空间已满，删几本书再试'
  }
  if (name === 'InvalidStateError' || /private|incognito|隐私/i.test(msg)) {
    return '浏览器不允许写入（可能是隐私模式）'
  }
  return msg || '未知原因'
}

/**
 * 把捕获到的错误翻成能直接给用户看的文案。
 * `StorageWriteError` 已经是「添加高亮失败：存储空间已满」这种成品，原样用；
 * 别的错误（比如解析、网络）走 fallback。
 */
export function writeErrorText(err: unknown, fallbackLabel: string): string {
  if (err instanceof StorageWriteError) return err.message
  return `${fallbackLabel}：${err instanceof Error ? err.message : String(err)}`
}

// ---- 读失败：降级，但必须留下痕迹 ----
//
// 读失败的处置和写失败**不一样**：
//   - 写失败 = 用户操作没生效 → 抛出去，让他知道没存上（见 writeGuard）
//   - 读失败 = 多读一次没读出来 → 不该顺手把整本书判死刑。书签/笔记读不出来
//     降级成空列表，**书照样能读**；但必须留下提示，否则用户会以为笔记真没了。
//
// 所以这里降级的同时发一条故障通知，由 UI 订阅后给回音。
// 注意：**书库（listBooks）与书文件不在此列** —— 那两样读不出来是致命的，
// 必须让调用方拿到错误去显示"书库打不开"，降级成空书库会让人以为书没了。

type StorageFailureListener = (label: string) => void
const failureListeners = new Set<StorageFailureListener>()

/** 订阅"读失败"故障。返回取消订阅的函数。 */
export function onStorageFailure(cb: StorageFailureListener): () => void {
  failureListeners.add(cb)
  return () => {
    failureListeners.delete(cb)
  }
}

export async function readGuard<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.error(`[阅读器] ${label}失败（已降级）：`, err)
    for (const cb of failureListeners) cb(label)
    return fallback
  }
}

/** 写操作统一走这里：抛错的口径一致、控制台一定留痕。
 * label 用中文的「动作名」，直接进用户看到的提示文案（如「添加高亮失败：……」）。
 */
export async function writeGuard<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const wrapped = new StorageWriteError(label, err)
    console.error('[阅读器] 写入失败：', wrapped.message, err)
    throw wrapped
  }
}
