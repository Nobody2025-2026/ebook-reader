// 「页边距改了但用户觉得没用」的第三层审计：量**文字行的像素宽度**，而不是盒子宽度。
//
// 用法：先起开发服务器（node node_modules/vite/bin/vite.js），再
//   node scripts/margin-text-audit.mjs [书路径] [视口宽]
//
// 为什么又单独一个脚本：
//   layout-theme-audit.mjs 量的是 `.chapter` 的**内容盒宽度**（盒子级）；
//   margin-drag-audit.mjs  验的是**控件能不能被真实鼠标拖到**（交互级）；
//   两者都测不出 2026-09-14 用户报的那个现象：
//     「拖页边距时文字整体横移、宽度没有任何变化」
//   根因是几何而非代码 —— `.chapter` 是 `max-width + margin:0 auto`，盒子**居中**，
//   页边距只是把**内容盒**往里收（`padding: 32px var(--pm)`）。于是：
//     · 占满栏宽的段落 → 行盒跟着内容盒收窄（留白 0 → 1172px，留白 120 → 520px）✓
//     · 短行（目录条目 / 短段 / 标题）→ 左边缘被推着右移，**自身宽度不变** ⚠️
//
//   栏宽上限自 2026-09-14 起随留白变化（settings.ts 的 contentWidthFactor）：
//   留白 ≥ 20px 时固定 760px，往 0 拖线性放宽，0 = 铺满可用宽度。所以本脚本
//   额外守一条 —— 留白 0 时最长段落行宽必须 ≈ 可用宽（旧版这里恒为 760px，
//   1512 视口两侧各空 206px，用户报的"页边距设 0 两边还空那么多"就是它）。
//   短行一多，整屏看起来就只剩"横移"，像是页边距没生效。
//
// 判据：同一屏里既有满行又有短行时，满行必须收窄、短行必须只位移；
//       若**满行**也不收窄，那才是真 bug。
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'

const url = 'http://localhost:5173/ebook-reader/'
const bookPath = process.argv[2] ?? '/Users/shaun_1/WorkBuddy/自制阅读器/books/策略思维.epub'
const vw = Number(process.argv[3] ?? 1280)

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const context = await browser.newContext({ viewport: { width: vw, height: 860 } })
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
        req.onerror = () => resolve(false)
      }
      req.onerror = () => resolve(false)
    }),
)
await page.reload({ waitUntil: 'networkidle' })

const chooser = page.waitForEvent('filechooser')
await page.getByRole('button', { name: '导入书籍' }).click()
;(await chooser).setFiles(bookPath)
await page.locator('.book-card').first().waitFor({ timeout: 180_000 })
await page.getByRole('button', { name: /^打开《/ }).first().click()
await page.locator('.reader-scroll').waitFor({ timeout: 120_000 })
await page.waitForTimeout(2500)

// 滚到底几次，把正文按需加载出来（pump / needMore）
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => {
    const s = document.querySelector('.reader-scroll')
    s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(900)
}
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '排版' }).click()
await page.waitForTimeout(400)

const setMargin = async (v) => {
  await page.evaluate((val) => {
    const el = document.querySelector('input[aria-label="页边距"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, String(val))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, v)
  await page.waitForTimeout(400)
}

const measure = () =>
  page.evaluate(() => {
    const lineBox = (e) => {
      const rg = document.createRange()
      rg.selectNodeContents(e)
      const b = rg.getBoundingClientRect()
      return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }
    }
    // 找第一个含 >=2 个 p 的章（真正文），再找含 >=2 个 a 的章（目录）
    const pick = (sel) => {
      for (const ch of document.querySelectorAll('.chapter')) {
        const items = [...ch.querySelectorAll(sel)]
        if (items.length < 2) continue
        const cs = getComputedStyle(ch)
        const cr = ch.getBoundingClientRect()
        return {
          index: ch.dataset.chapterIndex,
          box: [Math.round(cr.left), Math.round(cr.right)],
          content: [
            Math.round(cr.left + parseFloat(cs.paddingLeft)),
            Math.round(cr.right - parseFloat(cs.paddingRight)),
          ],
          items: items.slice(0, 4).map((e) => ({
            tag: e.tagName,
            line: lineBox(e),
            text: (e.textContent || '').trim().slice(0, 18),
          })),
        }
      }
      return null
    }
    return { slider: document.querySelector('input[aria-label="页边距"]')?.value, prose: pick('p'), links: pick('a') }
  })

console.log(`视口宽=${vw}  书=${bookPath.split('/').pop()}`)
const seen = {}
for (const v of [0, 60, 120]) {
  await setMargin(v)
  const m = await measure()
  console.log(`\n═══════ 页边距 ${v}px（滑块=${m.slider}）═══════`)
  for (const [name, g] of [
    ['正文 <p>', m.prose],
    ['目录 <a>', m.links],
  ]) {
    if (!g) {
      console.log(`【${name}】未找到`)
      continue
    }
    console.log(`【${name}】第${g.index}章  栏盒[${g.box}]  内容盒[${g.content}]`)
    for (const it of g.items) {
      console.log(`   <${it.tag}> 文字行盒[${it.line.l}→${it.line.r}] w=${it.line.w}  "${it.text}"`)
      const k = `${name}|${it.text}`
      ;(seen[k] ??= []).push(it.line.w)
    }
  }
}

console.log('\n───── 判定 ─────')
let ok = true
for (const [k, widths] of Object.entries(seen)) {
  if (widths.length < 3) continue
  const changed = widths[0] !== widths[2]
  console.log(`${changed ? '✓ 收窄' : '· 只位移'}  ${k}  ${widths.join(' → ')}`)
}
const longLines = Object.entries(seen).filter(([, w]) => w[0] === w[1] && w[1] === w[2] && w[0] > 700)
if (longLines.length) {
  ok = false
  console.log(`✗ 有「满行」段落没跟着收窄（可能是真 bug）：${longLines.map(([k]) => k).join(' | ')}`)
} else {
  console.log('✓ 凡是占满栏宽的段落都跟着收窄了（符合几何预期：短行只位移、满行才收窄）')
}
// ── 回归守卫：留白 0 必须"铺满" ──────────────────────────────────────────
// 旧版 .chapter 的 max-width 恒为 760px、与滑块无关，宽窗口下留白拖到 0
// 两侧仍各空 (可用宽 − 760)/2。这里用「可用宽 vs 最长段落行宽」直接卡住。
await setMargin(0)
const full = await page.evaluate(() => {
  const sc = document.querySelector('.reader-scroll')
  const cs = getComputedStyle(sc)
  const r = sc.getBoundingClientRect()
  const avail = Math.round(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
  let widest = 0
  for (const ch of document.querySelectorAll('.chapter')) {
    for (const p of ch.querySelectorAll('p')) {
      if ((p.textContent || '').trim().length < 60) continue
      const rg = document.createRange()
      rg.selectNodeContents(p)
      widest = Math.max(widest, Math.round(rg.getBoundingClientRect().width))
    }
  }
  const ch = document.querySelector('.chapter')
  return { avail, widest, maxWidth: ch ? getComputedStyle(ch).maxWidth : '?' }
})
const flush = full.widest >= full.avail - 2
console.log(`\n── 留白 0 是否铺满 ──`)
console.log(
  `可用宽=${full.avail}  最长段落行宽=${full.widest}  max-width=${full.maxWidth}  ${
    flush ? '✓ 铺满' : `✗ 两侧仍留白（各 ${Math.round((full.avail - full.widest) / 2)}px）`
  }`,
)
if (!flush) ok = false

console.log(`${errs.length === 0 ? '✓' : '✗'} 无 JS 报错${errs.length ? '：' + errs.join(' | ') : ''}`)
await browser.close()
process.exit(ok ? 0 : 1)
