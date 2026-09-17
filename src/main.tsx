import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// 错误边界兜住整棵树：App 之下任何一处渲染期抛错，都降级成一张「出了点问题 +
// 数据没丢 + 重新加载 / 回书库」的页面，而不是白屏。
// 注意它兜不住异步里的错（事件处理器、Promise），那些要在各自位置 try/catch。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
