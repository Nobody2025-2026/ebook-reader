// 自定义字体：二进制落盘 / 增删查 / FontFace 注册。
// fake-indexeddb（tests/setup.ts）已提供 IndexedDB，无需额外依赖。
// jsdom 没有 FontFace / document.fonts，这里在 beforeEach 里打桩。
import { describe, expect, it, beforeEach } from 'vitest'

class FakeFontFace {
  family: string
  buf: unknown
  constructor(family: string, buf: unknown) {
    this.family = family
    this.buf = buf
  }
  async load() {}
}

const addedFonts: FakeFontFace[] = []

beforeEach(() => {
  addedFonts.length = 0
  ;(globalThis as unknown as { FontFace: unknown }).FontFace = FakeFontFace
  ;(globalThis.document as unknown as { fonts: { add: (f: FakeFontFace) => void } }).fonts = {
    add: (f: FakeFontFace) => addedFonts.push(f),
  }
})

import {
  addCustomFont,
  listCustomFonts,
  registerCustomFonts,
  removeCustomFont,
} from '../src/lib/customFont'
import type { CustomFont } from '../src/lib/settings'

describe('customFont 生命周期', () => {
  it('add 后 list 能取到，且 family 是唯一 CSS 名', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'My Font.ttf', { type: 'font/ttf' })
    const meta = await addCustomFont(file)
    expect(meta.id).toBeTruthy()
    expect(meta.family).toMatch(/^CustomFont-/)
    expect(meta.filename).toBe('My Font.ttf')

    const list = await listCustomFonts()
    expect(list.some((f) => f.id === meta.id)).toBe(true)
  })

  it('remove 后 list 不再包含', async () => {
    const file = new File([new Uint8Array([9, 9])], 'Del.ttf')
    const meta = await addCustomFont(file)
    await removeCustomFont(meta.id)
    const list = await listCustomFonts()
    expect(list.find((f) => f.id === meta.id)).toBeUndefined()
  })
})

describe('registerCustomFonts', () => {
  it('把已存字体注册进 document.fonts', async () => {
    const file = new File([new Uint8Array([5, 6, 7, 8])], 'Reg.ttf')
    const meta = await addCustomFont(file)
    await registerCustomFonts([meta])
    expect(addedFonts).toHaveLength(1)
    expect(addedFonts[0].family).toBe(meta.family)
  })

  it('单本注册抛错不向上传播，其余继续', async () => {
    ;(globalThis as unknown as { FontFace: unknown }).FontFace = class {
      constructor() {
        throw new Error('boom')
      }
    }
    const file = new File([new Uint8Array([1])], 'Boom.ttf')
    const meta = await addCustomFont(file)
    // 不抛错即过关
    await expect(registerCustomFonts([meta])).resolves.toBeUndefined()
  })

  it('缺二进制（从未 add）时安全跳过', async () => {
    const ghost: CustomFont = { id: 'nope', family: 'Ghost', filename: 'g.ttf' }
    await expect(registerCustomFonts([ghost])).resolves.toBeUndefined()
    expect(addedFonts).toHaveLength(0)
  })
})
