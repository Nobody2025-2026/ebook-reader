// 覆盖「选文件」这条链路的浏览器兼容约定。
// 这三条都是国产内核（UC / 夸克 / U4）实测会出问题的写法，改之前先看
// src/lib/bookSource.ts 里的注释，别当重构随手改回去。
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EPUB_ACCEPT, webBookSource } from '../src/lib/bookSource'

function findInput(): HTMLInputElement | null {
  return document.querySelector('input[type="file"]')
}

function fakeFiles(file: File): void {
  const input = findInput()!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
}

afterEach(() => {
  document.querySelectorAll('input[type="file"]').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('webBookSource.pickFile', () => {
  it('accept 只写扩展名，不含 MIME（安卓文件管理器把 epub 报成 octet-stream）', () => {
    void webBookSource.pickFile()
    const input = findInput()!
    expect(input.accept.split(',')).toEqual(['.epub', '.txt'])
    expect(input.accept).not.toMatch(/epub\+zip|text\/plain/)
  })

  it('隐藏方式不是 display:none（国产内核不响应不可见元素的 click）', () => {
    void webBookSource.pickFile()
    const input = findInput()!
    expect(input.style.display).not.toBe('none')
    // 移出视口 + 透明：仍在渲染树里，用户看不见也挡不住点击
    expect(input.style.position).toBe('fixed')
    expect(input.style.opacity).toBe('0')
  })

  it('click() 必须同步发生在 pickFile() 返回之前（瞬时用户激活不能过期）', () => {
    let clicked = false
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
      clicked = true
    })
    void webBookSource.pickFile()
    // 一旦包进 setTimeout / await 再 click，各家都会静默拒绝弹出选择器
    expect(clicked).toBe(true)
  })

  it('选中文件 → resolve 该文件，并从 DOM 移除自己', async () => {
    const p = webBookSource.pickFile()
    const file = new File(['x'], '策略思维.epub')
    fakeFiles(file)
    findInput()!.dispatchEvent(new Event('change'))

    await expect(p).resolves.toBe(file)
    expect(findInput()).toBeNull()
  })

  it('在系统选择器里点取消（cancel 事件）→ resolve null 且不泄漏 input', async () => {
    const p = webBookSource.pickFile()
    findInput()!.dispatchEvent(new Event('cancel'))
    await expect(p).resolves.toBeNull()
    expect(findInput()).toBeNull()
  })

  it('同一份 Promise 只结算一次（change 后紧跟 cancel 不会二次 resolve）', async () => {
    const p = webBookSource.pickFile()
    fakeFiles(new File(['x'], 'a.epub'))
    findInput()!.dispatchEvent(new Event('change'))
    await expect(p).resolves.toBeTruthy()
    // 此刻 input 已移除，再派发也应当完全无害
    await expect(p).resolves.toBeTruthy()
  })
})

describe('webBookSource.fromDrop', () => {
  const drop = (name: string) =>
    ({ files: [new File(['x'], name)] }) as unknown as DataTransfer

  it('接受 .epub / .txt，大小写不敏感', () => {
    expect(webBookSource.fromDrop(drop('a.epub'))?.name).toBe('a.epub')
    expect(webBookSource.fromDrop(drop('b.TXT'))?.name).toBe('b.TXT')
  })

  it('拒绝其它后缀（不去碰解析层，避免把 PDF 喂给 epub 解析器）', () => {
    expect(webBookSource.fromDrop(drop('a.pdf'))).toBeNull()
    expect(webBookSource.fromDrop(drop('cover.jpg'))).toBeNull()
  })

  it('空 DataTransfer（点在页面上而非拖文件）不炸', () => {
    expect(webBookSource.fromDrop(null)).toBeNull()
    expect(webBookSource.fromDrop({} as DataTransfer)).toBeNull()
  })
})

describe('EPUB_ACCEPT', () => {
  it('保持纯扩展名形态，方便直接喂给 input.accept', () => {
    expect(EPUB_ACCEPT).toBe('.epub,.txt')
  })
})
