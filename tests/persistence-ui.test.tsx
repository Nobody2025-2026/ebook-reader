import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clear } from 'idb-keyval'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 把申请结果做成可控的：真机里 Chrome 拒绝、Safari 有时同意，
// 这两条分支的表现必须都能在单测里钉住。
const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  dismiss: vi.fn(),
  isDismissed: vi.fn(),
}))

vi.mock('../src/lib/persistence', () => ({
  ensurePersistentStorage: mocks.ensure,
  dismissStorageHint: mocks.dismiss,
  isStorageHintDismissed: mocks.isDismissed,
}))

// 补封面会在后台解书；这里给个必然失败的解析器，验证"解析失败不影响书库渲染"
vi.mock('../src/lib/epub', () => ({ openEpub: vi.fn().mockRejectedValue(new Error('stub')) }))

import App from '../src/App'
import { saveBook, type BookMeta } from '../src/lib/storage'

const meta: BookMeta = {
  id: 'b1',
  title: '测试书',
  author: '主上大人',
  fileName: 'book.epub',
  chapterCount: 3,
  addedAt: 1_000,
}

beforeEach(async () => {
  await clear()
  window.location.hash = ''
  mocks.ensure.mockReset()
  mocks.dismiss.mockReset()
  mocks.isDismissed.mockReset().mockReturnValue(false)
})

describe('App：持久化存储申请与备份提示', () => {
  it('被拒且书架有书时才提示，点「不再提示」会永久记住', async () => {
    mocks.ensure.mockResolvedValue('denied')
    await saveBook(meta, new File(['epub'], 'book.epub'))

    render(<App />)
    await waitFor(() => expect(screen.getByText(/可能连书架一起清掉/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '不再提示' }))
    expect(mocks.dismiss).toHaveBeenCalled()
    expect(screen.queryByText(/可能连书架一起清掉/)).toBeNull()
  })

  it('拿到保护时不提示', async () => {
    mocks.ensure.mockResolvedValue('granted')
    await saveBook(meta, new File(['epub'], 'book.epub'))

    render(<App />)
    await waitFor(() => expect(screen.getByText('测试书')).toBeInTheDocument())
    expect(screen.queryByText(/可能连书架一起清掉/)).toBeNull()
  })

  it('用户说过「不再提示」就不再申请（省掉一次无意义的权限请求）', async () => {
    mocks.isDismissed.mockReturnValue(true)
    await saveBook(meta, new File(['epub'], 'book.epub'))

    render(<App />)
    await waitFor(() => expect(screen.getByText('测试书')).toBeInTheDocument())
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(screen.queryByText(/可能连书架一起清掉/)).toBeNull()
  })
})
