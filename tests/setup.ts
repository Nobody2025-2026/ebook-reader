import '@testing-library/jest-dom/vitest'
// jsdom 不自带 IndexedDB，存储层测试需要它
import 'fake-indexeddb/auto'

// jsdom 没实现 scrollIntoView / requestAnimationFrame 等真实浏览器 API，
// 组件里用到的都在这里补个 no-op / 简单实现，避免测试炸在环境差异上。
// 注意：本 setup 对 node 环境（解析层测试）也会跑，node 里没有 Element/window，
// 所以要先判断是否存在再补。
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
if (typeof window !== 'undefined' && typeof window.requestAnimationFrame !== 'function') {
  // jsdom 的 rAF 类型签名为 (cb) => number，setTimeout 返回 Timeout，这里显式转一下
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0) as unknown as number
}
