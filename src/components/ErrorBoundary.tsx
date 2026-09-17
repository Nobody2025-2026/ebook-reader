import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染期异常的最后一道兜底。
 *
 * 没有它，组件树里任何一处抛错就是**整页白屏** —— 对一个「本地优先、零后端」
 * 的阅读器来说，这是最坏的一种失败：书、进度、笔记全都好好躺在 IndexedDB 里，
 * 但界面上一个字都看不见，用户第一反应是「我的数据没了」。
 *
 * 能力边界（写在明面上，别把它当万能药）：
 * - **能兜**：渲染期、生命周期、构造函数里抛的错
 * - **兜不住**：事件处理器里的错、`setTimeout` / Promise 等异步里的错 ——
 *   那些必须在各自的位置 `try/catch`（存储、解析这类异步路径尤其要自己兜）
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 降级界面只给用户看结论，真要排查还得靠这里
    console.error('[阅读器] 渲染出错：', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="state-page" role="alert">
        <h1 className="state-hint state-error">阅读器出了点问题</h1>
        {/* 本地优先的应用，出错时最要紧的一句是「数据没丢」—— 白屏已经很吓人了 */}
        <p className="state-sub">
          你的书、进度和笔记都还在这台设备上，<strong>没有丢失</strong>。
        </p>

        <details className="state-details">
          <summary>错误详情</summary>
          <pre className="state-detail">{error.message || String(error)}</pre>
        </details>

        <div className="state-actions">
          <button className="btn" onClick={() => window.location.reload()}>
            重新加载
          </button>
          <button
            className="btn"
            onClick={() => {
              // 顺序不能反：先把 hash 改回书库，再复位边界。
              // 否则复位后 App 重新挂载、读到的还是刚刚出错的那个路由，原地再崩一次。
              window.location.hash = '/'
              this.setState({ error: null })
            }}
          >
            回书库
          </button>
        </div>
      </div>
    )
  }
}
