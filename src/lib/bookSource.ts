// 「书从哪来」的抽象层——PRD 第九章桌面化预留的第三条硬约束。
// 现在只有 Web 实现（<input type=file> / 拖拽），将来套 Tauri 时
// 再加一个读本地文件系统的实现，解析层和组件都不用改。
export interface BookSource {
  /** 打开文件选择框，返回用户选中的文件；取消则返回 null */
  pickFile(): Promise<File | null>
  /** 从拖拽事件里取出第一个可解析的文件 */
  fromDrop(dataTransfer: DataTransfer | null): File | null
}

// ⚠️ 只写扩展名，**不要写 MIME**。
// 原先是 '.epub,application/epub+zip,.txt,text/plain'。Android 的文件管理器
// 对 .epub 报的 MIME 常常是 `application/octet-stream`（系统根本没注册 epub），
// 而 UC / 夸克这类国产内核对 accept 的匹配实现与标准不一致：一旦它拿实际 MIME
// 去比对、发现对不上，就会把文件在列表里置灰不可选 —— 表现为「导入弹出了
// 选择器，但死活选不了书」。纯扩展名是各家都认的最小公约数。
export const EPUB_ACCEPT = '.epub,.txt'

export const webBookSource: BookSource = {
  pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = EPUB_ACCEPT
      // ⚠️ 不要用 display:none。部分国产内核（UC / 夸克 / U4）不会响应不可见
      //    元素的 click()，文件选择器压根不弹 —— 表现为「点了导入毫无反应」。
      //    改成「移出视口且透明」：元素仍在渲染树里，但用户看不见、也挡不住点击。
      input.style.position = 'fixed'
      input.style.left = '-9999px'
      input.style.top = '0'
      input.style.width = '1px'
      input.style.height = '1px'
      input.style.opacity = '0'
      document.body.appendChild(input)

      let settled = false
      const settle = (file: File | null) => {
        if (settled) return
        settled = true
        input.remove()
        resolve(file)
      }
      input.addEventListener('change', () => {
        settle(input.files?.[0] ?? null)
      })
      // 用户在系统选择器里点「取消」：现代浏览器（含 iOS 15.4+ / Chrome 113+）
      // 会派发 cancel。老浏览器不会 —— 那时 Promise 就悬着，input 留在 DOM 里，
      // 但下次点「导入」会新建一个，不会互相干扰，所以只是泄漏一个节点，可接受。
      input.addEventListener('cancel', () => settle(null))

      // click() 必须留在用户点击「导入书籍」的同一个调用栈里（这里是同步的），
      // 一旦包进 setTimeout / await，浏览器的「瞬时用户激活」就过期了，
      // 各家都会静默拒绝弹出选择器。
      input.click()
    })
  },

  fromDrop(dataTransfer) {
    const file = dataTransfer?.files?.[0]
    if (!file) return null
    return /\.(epub|txt)$/i.test(file.name) ? file : null
  },
}
