#!/usr/bin/env node
// 跨设备 / 跨分辨率 / 横竖屏的「页边距适配」审计。
//
// 为什么需要单独一个脚本：`margin-text-audit.mjs` 只在固定视口量「满行收窄 vs
// 短行位移」；`layout-theme-audit.mjs` 只量盒子；两者都假设「一个视口就代表所有
// 屏幕」。但页边距是**绝对 px**（0–120），它在 320px 屏上占 37.5%、在 1440px 屏上
// 只占 8.3% —— 同一个值，语义完全失衡。这个脚本专查三类跨设备问题：
//
//   ① 内容盒过窄：留白 120 时正文是否被压到读不下去（窄屏常见）
//      → 已修：留白按屏宽封顶 min(设置值, 12vw)，见 settings.ts 的 pageMarginCapPx
//   ② 横向溢出：内容盒被压窄后，不可断的长串（数字列举 / URL / 长英文词）
//      顶破容器 → reader-scroll 出现横向滚动；而 touch-action:pan-y 又禁止手指
//      横拖 → 手机上溢出的字「看得见、摸不着」
//      → 已修：.chapter 加 overflow-wrap: break-word
//   ③ 横屏掉布局：断点是 max-width:720px（只认宽度），手机横屏 844px 不命中
//      → 从「底部浮层 + 顶栏横滑」掉回「桌面侧栏」
//      → 已修：断点补上 (max-height:500px) and (max-width:1024px)
//
// 现在这个脚本仍有用，因为三层价值都还在：三类问题各有守卫（把修复删掉会立刻报警）；
// 而且 ① 的"实际生效留白"必须读 computed padding —— 加了封顶后「设为 120」不等于
// 「生效 120」（390px 屏只生效 44），拿设置值当生效值会得出完全错误的结论。
//
// 用法：
//   node scripts/margin-devices-audit.mjs                  # 全部视口
//   node scripts/margin-devices-audit.mjs --quick          # 只跑 3 个关键视口
//   node scripts/margin-devices-audit.mjs --book <epub>    # 换书（默认中文书，断行正常）
//
// 前置：dev server 在 http://localhost:5173/ebook-reader/ 跑着。
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'

const url = 'http://localhost:5173/ebook-reader/'
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const bookArg = argv.indexOf('--book')
const bookPath =
  bookArg >= 0
    ? argv[bookArg + 1]
    : '/Users/shaun_1/WorkBuddy/自制阅读器/books/策略思维.epub'

const ALL = [
  { w: 320, h: 568, name: '极小屏手机竖屏' },
  { w: 390, h: 844, name: '手机竖屏' },
  { w: 844, h: 390, name: '手机横屏' },
  { w: 768, h: 1024, name: '平板竖屏' },
  { w: 1024, h: 768, name: '平板横屏' },
  { w: 1440, h: 900, name: '笔记本' },
  { w: 2560, h: 1440, name: '2K 大屏' },
]
// --quick：窄屏 + 横屏 + 一个桌面基准，足够暴露三类问题
const VIEWPORTS = QUICK
  ? ALL.filter((v) => [320, 390, 844, 1440].includes(v.w))
  : ALL

// 判定阈值：一行少于 ~10 个汉字（180px @18px 字号）就该报警
const MIN_CONTENT_W = 180

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

await page.goto(url, { waitUntil: 'networkidle' })
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('keyval-store')
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite')
        tx.objectStore('keyval').clear()
        tx.oncomplete = () => resolve(true)
      }
      req.onerror = () => resolve(false)
    }),
)
await page.reload({ waitUntil: 'networkidle' })

const chooser = page.waitForEvent('filechooser')
await page.getByRole('button', { name: '导入书籍' }).click()
;(await chooser).setFiles(bookPath)
await page.locator('.book-card').first().waitFor({ timeout: 120_000 })
await page.getByRole('button', { name: /^打开《/ }).first().click()
await page.locator('.reader-scroll').waitFor({ timeout: 90_000 })
await page.waitForTimeout(2500)
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => {
    const s = document.querySelector('.reader-scroll')
    s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(650)
}
await page.waitForTimeout(1000)

const setMargin = async (v) => {
  const open = await page.evaluate(() => {
    const p = document.querySelector('.settings-panel')
    return !!p && getComputedStyle(p).display !== 'none'
  })
  if (!open) {
    await page.getByRole('button', { name: '排版' }).click()
    await page.waitForTimeout(300)
  }
  await page.evaluate((val) => {
    const el = document.querySelector('input[aria-label="页边距"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, String(val))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, v)
  await page.waitForTimeout(380)
}

// 直接读「内容盒」——比 Range 量文字行盒可靠：Range 会被英文长单词的
// min-content 撑大，看不出容器到底被压到多窄（曾因此误判「留白没生效」）。
const probe = () =>
  page.evaluate(() => {
    const sc = document.querySelector('.reader-scroll')
    let contentW = null
    let padL = null
    for (const ch of document.querySelectorAll('.chapter')) {
      if ([...ch.querySelectorAll('p')].filter((p) => (p.textContent || '').trim().length > 40).length < 2) continue
      const cs = getComputedStyle(ch)
      const boxW = ch.getBoundingClientRect().width
      contentW = Math.round(boxW - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
      // 实际生效的留白。必须读 computed，不能拿"设置值"当生效值 ——
      // 现在留白会被屏宽封顶（手机设 120 实际只生效 44），拿设置值看会误判。
      padL = Math.round(parseFloat(cs.paddingLeft))
      break
    }
    return {
      contentW,
      padL,
      overflowX: sc.scrollWidth - sc.clientWidth,
      // 移动布局断点 = 「宽 ≤ 720」或「矮 + 不超平板」（后者是补的手机横屏那条）
      mobile: matchMedia('(max-width: 720px), (max-height: 500px) and (max-width: 1024px)').matches,
      innerH: innerHeight,
    }
  })

const alarms = new Set()
console.log(`\n样本：${bookPath.split('/').pop()}`)
console.log('视口        设备            留白设→实 | 内容盒 | 横向溢出 | 移动布局')
console.log('─'.repeat(76))
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.w, height: vp.h })
  await page.waitForTimeout(500)
  for (const m of [0, 20, 120]) {
    await setMargin(m)
    const r = await probe()
    if (r.contentW == null) {
      console.log(
        `${String(vp.w).padStart(4)}×${String(vp.h).padEnd(5)} ${vp.name.padEnd(14)} ${String(m).padStart(3)}   | （未找到正文章节，跳过）`,
      )
      continue
    }
    const label = `${String(vp.w).padStart(4)}×${String(vp.h).padEnd(5)} ${vp.name.padEnd(14)} ${String(m).padStart(3)}→${String(r.padL).padStart(3)}`
    console.log(
      `${label} | ${String(r.contentW).padStart(5)}  | ${String(r.overflowX).padStart(6)}px  | ${r.mobile ? '命中' : '—'}`,
    )
    if (m === 120 && r.contentW < MIN_CONTENT_W) {
      alarms.add(`内容过窄：${vp.name}(${vp.w}px) 留白 120 → 正文仅 ${r.contentW}px（一行约 ${Math.floor(r.contentW / 18)} 字）`)
    }
    if (r.overflowX > 2) {
      alarms.add(`横向溢出：${vp.name}(${vp.w}px) 留白 ${m} → 溢出 ${r.overflowX}px（touch-action:pan-y 下触屏拖不过去）`)
    }
    // 封顶守卫：生效留白不得超过屏宽的 12%（+1 步长的取整余量）。
    // 这条是防回归 —— 一旦有人把「留白按屏宽封顶」删掉，窄屏会立刻爆出来。
    if (r.padL > vp.w * 0.12 + 4) {
      alarms.add(`封顶失效：${vp.name}(${vp.w}px) 生效留白 ${r.padL}px > 屏宽 12%（${Math.round(vp.w * 0.12)}px）`)
    }
  }
  // 手机横屏的特征是「宽 > 720 且矮」。只看「宽 > 720」会把笔记本/大屏全误报，
  // 必须加高度条件；补的 (max-height:500px) 断点正是为这种视口准备的。
  if (vp.w > 720 && vp.h < 500 && !(await probe()).mobile) {
    alarms.add(`掉桌面布局：${vp.name}(${vp.w}×${vp.h}) 未命中移动布局断点（宽≤720 或 矮+≤1024）—— 面板/顶栏会退回桌面样式`)
  }
}
console.log('─'.repeat(76))

// 主动检查「长串断行」：往正文塞一段 300 字符的无空格串，看容器会不会被顶破。
// 不做被动检测的原因是它不可靠 —— 中文样本里根本没有长串，英文样本要看运气，
// 于是 ② 的修复（.chapter 的 overflow-wrap: break-word）就算被删掉也没人发现。
// 必须在窄视口测：宽屏下 300 个字符本来也可能装得下。
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(400)
const longTokenOverflow = await page.evaluate(() => {
  const sc = document.querySelector('.reader-scroll')
  const p = [...document.querySelectorAll('.chapter p')].find(
    (el) => (el.textContent || '').trim().length > 40,
  )
  if (!p) return null
  const span = document.createElement('span')
  span.textContent = 'A'.repeat(300)
  p.appendChild(span)
  const over = sc.scrollWidth - sc.clientWidth
  span.remove()
  return over
})
if (longTokenOverflow == null) {
  console.log('长串断行：跳过（本页没有可用段落）')
} else if (longTokenOverflow > 2) {
  console.log(`长串断行：✗ 300 字符无空格串溢出 ${longTokenOverflow}px`)
  alarms.add(`长串未断行：390px 屏下 300 字符无空格串溢出 ${longTokenOverflow}px（检查 .chapter 的 overflow-wrap: break-word）`)
} else {
  console.log('长串断行：✓ 300 字符无空格串已断开，未顶破容器')
}

if (alarms.size) {
  const list = [...alarms]
  console.log(`发现 ${list.length} 类适配问题：`)
  list.forEach((a) => console.log('  ⚠️ ' + a))
} else {
  console.log('✓ 各视口 + 留白档均正常')
}
console.log(`${errs.length === 0 ? '✓' : '✗'} JS 报错 ${errs.length ? errs.join(' | ') : '无'}`)
await browser.close()
process.exit(alarms.size ? 1 : 0)
