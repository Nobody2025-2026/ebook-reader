// 真机验证「持久化存储申请 + 被拒时的备份提示」
//
// 用法：先起开发服务器（node node_modules/vite/bin/vite.js），再
//   node scripts/storage-persist-audit.mjs
//
// 验四件 jsdom 测不出的事（jsdom 没有 navigator.storage）：
//   ① 真实 Chrome 里确实调了 persist()，且**只调一次**（严格模式下 effect 跑两遍）；
//   ② 空书架时不提示（没东西可丢）；
//   ③ 用 addInitScript 强制 persist() 返回 false（模拟被拒）+ 书架有书 → 必须提示；
//   ④ 点「不再提示」后刷新页面仍然不再提示（标记写在 localStorage）。
//
// 注意：Chrome 对全新访客基本一律拒绝 persist()，所以场景 A 不断言"申请成功"，
// 只断言"申请过、并如实把结果反馈到界面"。拒绝本身是正常现象，不是 bug。
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'

const url = 'http://localhost:5173/ebook-reader/'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WARN = '可能连书架一起清掉'

let failed = 0
const step = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

/** 直接往 IndexedDB 塞一条书元数据，省掉导入 3.5MB 真书的时间 */
const seedBook = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('keyval-store')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('keyval', 'readwrite')
          tx.objectStore('keyval').put(
            { id: 'seed-1', title: '预置书', author: '小喵子', fileName: 'seed.epub', chapterCount: 3, addedAt: 1 },
            'meta:seed-1',
          )
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => resolve(false)
        }
      }),
  )

const readWarn = (page) =>
  page.evaluate((needle) => ({
    visible: document.body.innerText.includes(needle),
    text: (document.querySelector('.library-hint--warn')?.textContent ?? '').trim(),
    books: document.querySelectorAll('.book-card').length,
  }), WARN)

const browser = await chromium.launch({ executablePath: chrome })

// ---------- 场景 A：真实 Chrome ----------
console.log('=== A. 真实 Chrome：申请一次、结果如实反馈、空书架不打扰 ===')
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.addInitScript(() => {
    window.__persistCalls = 0
    const sm = navigator.storage
    if (sm && typeof sm.persist === 'function') {
      const orig = sm.persist.bind(sm)
      sm.persist = (...a) => {
        window.__persistCalls++
        return orig(...a)
      }
    }
  })

  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  const state = await page.evaluate(async () => ({
    calls: window.__persistCalls,
    hasApi: typeof navigator.storage?.persist === 'function',
    persisted: await navigator.storage.persisted(),
    warn: document.body.innerText.includes('可能连书架一起清掉'),
  }))

  step('浏览器提供 persist() API（安全上下文）', state.hasApi)
  step('启动时调用 persist()，且严格模式下只调一次', state.calls === 1, `调用 ${state.calls} 次`)
  step('申请结果如实落在浏览器上（本次 persisted()=' + state.persisted + '）', typeof state.persisted === 'boolean')
  step('空书架时不出提示', state.warn === false)
  step('无 JS 报错', errors.length === 0, errors[0] ?? '')
  if (!state.persisted) console.log('  · 说明：Chrome 对全新访客默认拒绝持久化（按"用户参与度"判定），属正常')
  await ctx.close()
}

// ---------- 场景 B：被拒 + 书架有书 → 提示；关掉后持久生效 ----------
console.log('\n=== B. 模拟被拒 + 书架有书：提示出现、可自救、关掉后刷新不再出现 ===')
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist: async () => false },
    })
  })

  await page.goto(url, { waitUntil: 'networkidle' })
  await seedBook(page)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  const denied = await readWarn(page)
  step('书架上有书（预置 1 本）', denied.books === 1, `${denied.books} 本`)
  step('被拒 + 有书 → 出现备份提示', denied.visible)
  step('提示给了可执行的兜底（导出）', denied.text.includes('导出'))
  step('提示带警示样式', await page.evaluate(() => !!document.querySelector('.library-hint--warn')))

  const dismissed = await page.evaluate(() => {
    document.querySelector('.library-hint__dismiss')?.click()
    return true
  })
  step('点「不再提示」能关掉', dismissed && (await readWarn(page)).visible === false)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const afterReload = await readWarn(page)
  step('刷新后仍不再提示（选择被记住）', afterReload.visible === false)
  step('关掉提示不影响书架内容', afterReload.books === 1)
  step('无 JS 报错', errors.length === 0, errors[0] ?? '')
  await ctx.close()
}

// ---------- 场景 C：环境不支持 ----------
console.log('\n=== C. 环境不支持（老浏览器 / 私密模式）：不打扰用户 ===')
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined })
  })

  await page.goto(url, { waitUntil: 'networkidle' })
  await seedBook(page)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  const unsupported = await readWarn(page)
  step('页面照常渲染且书在架上', unsupported.books === 1)
  step('无 persist API 时不出提示（用户也无能为力，提示只是噪音）', unsupported.visible === false)
  step('无 JS 报错', errors.length === 0, errors[0] ?? '')
  await ctx.close()
}

await browser.close()
console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 全部通过'}`)
process.exitCode = failed ? 1 : 0
