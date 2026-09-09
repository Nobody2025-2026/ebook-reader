// 自定义字体：用户上传 ttf/otf/woff/woff2，用 FontFace API 注册，
// 不依赖操作系统预装，跨平台一致（也绕开 Safari 的字体指纹收敛）。
//
// 存储分层：
// - 元数据（id / family / filename）随 settings 一起存（见 settings.ts 的 customFonts）。
// - 字体二进制存在独立的 IDB key 下，避免大文件污染 settings 对象
//   （settings 每次都会被整个读出来）。
// 应用启动时由 registerCustomFonts() 把二进制重新注册进 document.fonts。
import { del, get, set } from 'idb-keyval'
import type { CustomFont } from './settings'

const KEY_INDEX = 'customFonts:index' // CustomFont[] 元数据索引
const blobKey = (id: string) => `customFont:blob:${id}`

interface StoredFont {
  family: string
  filename: string
  buf: ArrayBuffer
}

export async function listCustomFonts(): Promise<CustomFont[]> {
  return (await get<CustomFont[]>(KEY_INDEX)) ?? []
}

/** 生成唯一 id：不用 crypto.randomUUID（jsdom / 部分 WebView 没有）。 */
function newFontId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 读取字体二进制并落盘，返回元数据。family 是 FontFace 注册用的唯一 CSS 名。 */
export async function addCustomFont(file: File): Promise<CustomFont> {
  const id = newFontId()
  const family = `CustomFont-${id.slice(0, 8)}`
  const buf = await file.arrayBuffer()
  const meta: CustomFont = { id, family, filename: file.name }
  await set(blobKey(id), { family, filename: file.name, buf } satisfies StoredFont)
  const list = await listCustomFonts()
  list.push(meta)
  await set(KEY_INDEX, list)
  return meta
}

/** 删除字体二进制与索引项。调用方负责同步从 settings.customFonts 移除并更新。 */
export async function removeCustomFont(id: string): Promise<void> {
  await del(blobKey(id))
  const list = (await listCustomFonts()).filter((f) => f.id !== id)
  await set(KEY_INDEX, list)
}

/**
 * 把已存的自定义字体注册进 document.fonts。应用启动 / 新增字体后调用。
 * 单本注册失败不影响其它字体（记录警告后继续）。
 */
export async function registerCustomFonts(list: CustomFont[]): Promise<void> {
  for (const f of list) {
    try {
      const data = await get<StoredFont>(blobKey(f.id))
      if (!data) continue
      const font = new FontFace(f.family, data.buf)
      await font.load()
      document.fonts.add(font)
    } catch (e) {
      console.warn('[customFont] 注册失败：', f.family, e)
    }
  }
}
