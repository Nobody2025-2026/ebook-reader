// 书库页：读不出来时给用户什么（UI 层）。
//
// 这条是上一轮"读失败兜底"的核心：**空书架 ≠ 读不出来**。
// 数据库打不开时如果照常渲染一个空书架，用户看到的是"我的书全没了"。
// 所以这里断言：读失败必须显示明确的错误态，并且**不能**出现"书架是空的"。
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ctl = vi.hoisted(() => ({ failReads: false }))

vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>()
  const maybeFail = async () => {
    if (ctl.failReads) throw new DOMException('db broken', 'InvalidStateError')
  }
  return {
    ...actual,
    get: async (...args: Parameters<typeof actual.get>) => {
      await maybeFail()
      return actual.get(...args)
    },
    keys: async (...args: Parameters<typeof actual.keys>) => {
      await maybeFail()
      return actual.keys(...args)
    },
  }
})

import { clear } from 'idb-keyval'
import App from '../src/App'

beforeEach(async () => {
  ctl.failReads = false
  await clear()
  window.location.hash = ''
})

describe('书库读不出来时', () => {
  it('显示"书库打不开"，绝不显示空书架', async () => {
    ctl.failReads = true
    render(<App />)

    await waitFor(() => expect(screen.getByText('书库打不开')).toBeTruthy())
    // 这条是重点：不能降级成一个空书架，否则用户以为书没了
    expect(screen.queryByText('书架是空的')).toBeNull()
    expect(screen.getByText(/你的书还在这台设备上/)).toBeTruthy()
  })

  it('恢复正常后重试就能回到书架（说明不是把功能改坏了）', async () => {
    ctl.failReads = true
    render(<App />)
    await waitFor(() => expect(screen.getByText('书库打不开')).toBeTruthy())

    ctl.failReads = false
    screen.getByText('重试').click()
    await waitFor(() => expect(screen.getByText('书架是空的')).toBeTruthy())
    expect(screen.queryByText('书库打不开')).toBeNull()
  })
})
