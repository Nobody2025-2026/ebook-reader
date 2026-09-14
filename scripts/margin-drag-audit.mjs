// 「页边距改了但用户觉得没用」的补充审计：真实鼠标拖拽 + 重开是否保留
//
// 用法：先起开发服务器（node node_modules/vite/bin/vite.js），再
//   node scripts/margin-drag-audit.mjs
//
// 为什么单独一个脚本、而不是并进 layout-theme-audit.mjs：
//   那个脚本用 `HTMLInputElement.prototype` 的 value setter + 派发 input/change
//   来改滑块 —— 这验证的是"React 的 onChange 接线对不对"，**验证不了用户手指/鼠标
//   能不能真的碰到那个控件**（被浮层遮住、pointer-events:none、滚出可视区都测不出）。
//   2026-09-14 排查"页边距失效"时靠这个区别排除了一大类怀疑，所以固化下来。
//
// 它还顺带验"持久化"：拖完 reload，变量应仍是拖动后的值（量正文、不必再开面板）。
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'

const url = 'http://localhost:5173/ebook-reader/'
const bookPath = '/Users/shaun_1/WorkBuddy/自制阅读器/books/策略思维.epub'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
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
await page.getByRole('button', { name: '排版' }).click()
await page.waitForTimeout(500)

const measure = () =>
  page.evaluate(() => {
    const ch = document.querySelector('.chapter')
    const r = ch.getBoundingClientRect()
    const cs = getComputedStyle(ch)
    const slider = document.querySelector('input[aria-label="页边距"]')
    const sc = document.querySelector('.reader-scroll')
    return {
      textW: Math.round(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      sliderVal: slider ? slider.value : null,
      varPM: sc.style.getPropertyValue('--reader-page-margin'),
    }
  })

const before = await measure()
console.log(`初始：滑块=${before.sliderVal}  变量=${before.varPM}  可排字宽=${before.textW}`)

// ---- 真实鼠标拖拽（从当前位置拖到约 90% 处）----
const box = await page.locator('input[aria-label="页边距"]').boundingBox()
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(400)

const after = await measure()
const dragged = after.sliderVal !== before.sliderVal
console.log(`鼠标拖动后：滑块=${after.sliderVal}  变量=${after.varPM}  可排字宽=${after.textW}`)
console.log(`${dragged ? '✓' : '✗'} 滑块可被真实鼠标拖动（JS 赋值测不出这一点）`)
console.log(`${after.textW !== before.textW ? '✓' : '✗'} 拖动改变了正文可排字宽`)

// ---- reload 后是否保留 ----
if (dragged) {
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.reader-scroll').waitFor({ timeout: 120_000 })
  await page.waitForTimeout(2500)
  const persisted = await measure()
  console.log(`reload 后：变量=${persisted.varPM}  可排字宽=${persisted.textW}`)
  console.log(`${persisted.varPM === after.varPM ? '✓' : '✗'} 页边距被持久化保留`)
}

console.log(`${errs.length === 0 ? '✓' : '✗'} 无 JS 报错${errs.length ? '：' + errs.join(' | ') : ''}`)
await browser.close()
