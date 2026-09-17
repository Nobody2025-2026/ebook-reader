// 错误边界的单测：渲染期抛错时要降级成一张"能救"的页，而不是白屏。
// 这是「本地优先」应用最要紧的兜底 —— 数据都还在，界面不能先崩成一张白纸。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
// React 19 起 JSX 命名空间从全局挪进了 react 模块，要用得显式导入
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../src/components/ErrorBoundary'

/** 由外部变量控制是否抛错：复位后要能"改好了再渲染一次"，否则测不出复位逻辑 */
let shouldThrow = true

function Boom(): JSX.Element {
  if (shouldThrow) throw new Error('测试用的炸点')
  return <div>正常内容</div>
}

function Harness() {
  return (
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>
  )
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  shouldThrow = true
  window.location.hash = ''
  // React 捕获渲染错误后会往控制台吐一大段（含组件栈），测试里全是噪音，静音掉
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('错误边界', () => {
  it('子树渲染抛错时降级成一张能救的页，而不是白屏', () => {
    render(<Harness />)

    expect(screen.getByText('阅读器出了点问题')).toBeInTheDocument()
    // 本地优先的应用，出错时最要紧的一句是「数据没丢」
    expect(screen.getByText(/没有丢失/)).toBeInTheDocument()
    // 两个出口都要在：重试 + 退出到安全的地方
    expect(screen.getByText('重新加载')).toBeInTheDocument()
    expect(screen.getByText('回书库')).toBeInTheDocument()
    expect(screen.queryByText('正常内容')).toBeNull()
  })

  it('错误详情里带着出错原因（排查靠它）', () => {
    render(<Harness />)
    expect(screen.getByText('错误详情')).toBeInTheDocument()
    expect(screen.getByText('测试用的炸点')).toBeInTheDocument()
  })

  it('出错时把堆栈留在控制台（降级页只给用户看结论）', () => {
    render(<Harness />)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('点「回书库」：先把 hash 改回书库，再复位边界（顺序反了会原地再崩一次）', async () => {
    window.location.hash = '#/read/b1'
    render(<Harness />)

    // 根因解除：复位后重渲染时不再抛错
    shouldThrow = false
    fireEvent.click(screen.getByText('回书库'))

    await waitFor(() => expect(screen.getByText('正常内容')).toBeInTheDocument())
    expect(window.location.hash).toBe('#/')
  })

  it('没出错时原样渲染子树（不能因为加了边界就改变正常路径）', () => {
    shouldThrow = false
    render(<Harness />)
    expect(screen.getByText('正常内容')).toBeInTheDocument()
    expect(screen.queryByText('阅读器出了点问题')).toBeNull()
  })
})
