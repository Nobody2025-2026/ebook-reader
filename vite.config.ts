import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // 两条都是被本机环境逼出来的配置，改之前先看 tests/ 里的说明：
    // 1. pool 用 threads：默认的 forks 池在本环境 fork 子进程起不来 worker
    // 2. fileParallelism 关掉：并行起多个 worker 时，总有一个卡在
    //    "Timeout waiting for worker to respond" 起不来（实测必现）
    // 代价是单跑一次全量要 100 秒左右（大半耗在 worker 启动），换来的是全绿。
    pool: 'threads',
    fileParallelism: false,
  },
})
