// 「书从哪来」的抽象层——PRD 第九章桌面化预留的第三条硬约束。
// 现在只有 Web 实现（<input type=file> / 拖拽），将来套 Tauri 时
// 再加一个读本地文件系统的实现，解析层和组件都不用改。
export interface BookSource {
  /** 打开文件选择框，返回用户选中的文件；取消则返回 null */
  pickFile(): Promise<File | null>
  /** 从拖拽事件里取出第一个可解析的文件 */
  fromDrop(dataTransfer: DataTransfer | null): File | null
}

export const EPUB_ACCEPT = '.epub,application/epub+zip,.txt,text/plain'

export const webBookSource: BookSource = {
  pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = EPUB_ACCEPT
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', () => {
        resolve(input.files?.[0] ?? null)
        input.remove()
      })
      input.click()
    })
  },

  fromDrop(dataTransfer) {
    const file = dataTransfer?.files?.[0]
    if (!file) return null
    return /\.(epub|txt)$/i.test(file.name) ? file : null
  },
}
