// 真机验收：用 Playwright 打开真实浏览器，导入《涛动周期论》，
// 检查渲染、滚动懒加载、刷新后进度恢复。这条路径单元测试覆盖不到。
// 用法：先起 dev server（vite --port 5180），再 node scripts/browser-check.mjs
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bookPath = resolve(__dirname, '../books/涛动周期论.epub')
const shotDir = resolve(__dirname, '../.screenshots')
const url = process.env.READER_URL ?? 'http://127.0.0.1:5180'

if (!existsSync(bookPath)) {
  console.error('缺少真实样本：', bookPath)
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const errors = []
// 本机 Playwright 版本要的 chromium 版本号和缓存里的对不上，直接指到已装的 Chrome
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(String(err)))

const step = (name, ok, extra = '') =>
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)

console.log('=== 1. 打开应用 ===')
await page.goto(url, { waitUntil: 'networkidle' })
step('页面加载', (await page.locator('h1').textContent()) === '自制阅读器')

console.log('\n=== 2. 导入 70MB 真书 ===')
const t0 = Date.now()
const chooserPromise = page.waitForEvent('filechooser')
await page.getByRole('button', { name: '导入书籍' }).click()
const chooser = await chooserPromise
await chooser.setFiles(bookPath)

// 先探 10 秒：导入卡住时至少有提示文本和控制台报错可看
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000)
  const hint = await page.locator('.library-hint').textContent().catch(() => '')
  const cards = await page.locator('.book-card').count()
  console.log(`   ${i + 1}s: 书架 ${cards} 本 | 提示「${hint ?? ''}」`)
  if (cards > 0 || (hint && hint.includes('失败'))) break
}
if (errors.length) console.log('   控制台报错：', errors.slice(0, 5))
await page.screenshot({ path: `${shotDir}/0-importing.png` })

await page.locator('.book-card').first().waitFor({ timeout: 120_000 })
step('书出现在书架', true, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('   书名:', await page.locator('.book-title').first().textContent())
console.log('   封面:', (await page.locator('.book-cover img').count()) > 0 ? '有' : '无（用占位首字）')
await page.screenshot({ path: `${shotDir}/1-library.png` })

console.log('\n=== 3. 打开阅读 ===')
await page.locator('.book-open').first().click()
await page.locator('.chapter').first().waitFor({ timeout: 60_000 })
// 判断"正文渲染"：首章可能是封面页（只有图和几行版权信息），不能只看第一章。
// 改为在整个阅读区内找「有实际文字内容」的块级元素，能抓到即可判定渲染成功。
const hasBody = await page.evaluate(() => {
  const container = document.querySelector('.reader-scroll')
  if (!container) return { ok: false, sample: '' }
  const blocks = [...container.querySelectorAll('.chapter p, .chapter h1, .chapter h2, .chapter h3, .chapter h4, .chapter h5, .chapter h6, .chapter li, .chapter blockquote')]
    .map((el) => el.textContent.replace(/\s+/g, ''))
    .filter((t) => t.length > 0)
  return { ok: blocks.length > 0, sample: blocks[0]?.slice(0, 60) || '' }
})
step('正文渲染', hasBody.ok)
console.log('   首章开头:', hasBody.sample || '(封面页无文字)')
await page.screenshot({ path: `${shotDir}/2-reader.png` })

console.log('\n=== 4. 滚动触发下一章 ===')
const before = await page.locator('.chapter').count()
await page.evaluate(() => {
  const el = document.querySelector('.reader-scroll')
  el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(2500)
const after = await page.locator('.chapter').count()
step('滚动后加载了新章节', after > before, `${before} → ${after} 章`)
console.log('   百分比显示:', await page.locator('.reader-percent').textContent())
await page.screenshot({ path: `${shotDir}/3-scrolled.png` })

console.log('\n=== 5. 刷新后是否回到原处 ===')
// 关键：绝对像素在图片懒加载下是飘的（同一段内容刷前后像素位置不同）。
// 我们改用了"段落锚点"模型，所以验收标准也随之更新：
// 判断刷新后视口顶部压着的段落，是不是刷新前压着的那一段。
const anchorInfo = () =>
  page.evaluate(() => {
    const container = document.querySelector('.reader-scroll')
    const ctop = container.getBoundingClientRect().top
    // 收集所有章节内的块级元素，找视口顶压着的那一段
    const blocks = [...container.querySelectorAll('.chapter p, .chapter h1, .chapter h2, .chapter h3, .chapter h4, .chapter h5, .chapter h6, .chapter li, .chapter blockquote')]
      .map((el, i) => ({ el, i, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
      .filter((b) => b.el.textContent.trim().length > 0)
      .sort((a, b) => a.top - b.top)
    if (!blocks.length) return { found: false }
    let anchor = blocks[0]
    for (const b of blocks) {
      if (b.bottom > ctop + 1) {
        anchor = b
        break
      }
    }
    return {
      found: true,
      text: anchor.el.textContent.replace(/\s+/g, '').slice(0, 30),
      chapterIdx: anchor.el.closest('.chapter')?.dataset.chapterIndex ?? '?',
    }
  })
const beforeInfo = await anchorInfo()
await page.reload({ waitUntil: 'networkidle' })
await page.locator('.chapter').first().waitFor({ timeout: 60_000 })
await page.waitForTimeout(2000)
const afterInfo = await anchorInfo()
const matched = beforeInfo.found && afterInfo.found && beforeInfo.text === afterInfo.text
step('进度恢复', matched, `刷新前段落「${beforeInfo.text ?? '（未定位）'}」→ 刷新后「${afterInfo.text ?? '（未定位）'}」`)
await page.screenshot({ path: `${shotDir}/4-restored.png` })

console.log('\n=== 6. 控制台错误 ===')
const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e))
step('无 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

await browser.close()
console.log(`\n截图已存到 ${shotDir}`)
