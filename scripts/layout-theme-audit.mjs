// 「排版设置生效 + 三套主题可读性」的真机审计（Playwright + 本机 Chrome，390×844 触屏视口）
//
// 用法：先起开发服务器（node node_modules/vite/bin/vite.js），再
//   node scripts/layout-theme-audit.mjs
//
// 它验两件在 jsdom 里测不出的事：
//   ① 页边距滑块真的改变每行宽度 —— 量「正文块宽 − 左右 padding」，
//      不依赖章节里第一个元素是不是 <p>。曾出过的 Bug：滑块调的是 max-width，
//      手机视口比最小值还窄，三档取值正文宽度完全一样（死控件）。
//   ② 三套主题下排版面板的文字对比度 ≥ WCAG AA 4.5:1 —— 逐元素取
//      computedStyle.color，再向上找第一个不透明祖先背景算对比度。
//      修「夜间模式深色正文配纯白侧栏」时靠的就是它。
//
// 两个易踩的坑：
//   - 改 range 输入框的值必须用 HTMLInputElement.prototype 的 value setter
//     再派发 input/change，直接改 el.value 不会触发 React；而且受控 input
//     会把超范围的值 clamp（设 680 进去会被 max=120 截成 120）。
//   - 对比度计算要向上找**不透明**背景，否则 rgba(0,0,0,0) 会算错。
import { chromium } from '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'

const url = 'http://localhost:5173/ebook-reader/'
const bookPath = '/Users/shaun_1/WorkBuddy/自制阅读器/books/策略思维.epub'

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url, { waitUntil: 'networkidle' })
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('keyval-store')
      req.onsuccess = () => {
        const tx = req.result.transaction('keyval', 'readwrite')
        tx.objectStore('keyval').clear()
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
      }
      req.onerror = () => resolve(false)
    }),
)
await page.reload({ waitUntil: 'networkidle' })

const step = (n, ok, extra = '') => console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`)
const sleep = (ms) => page.waitForTimeout(ms)

console.log('=== 准备 ===')
const chooser = page.waitForEvent('filechooser')
await page.getByRole('button', { name: '导入书籍' }).click()
;(await chooser).setFiles(bookPath)
await page.locator('.book-card').first().waitFor({ timeout: 120_000 })
await page.getByRole('button', { name: /^打开《/ }).first().click()
await page.locator('.reader-scroll').waitFor({ timeout: 60_000 })
await sleep(2500)

// ---------- ① 页边距 ----------
console.log('\n=== ① 页边距滑块（当前实现：.chapter 的 max-width）===')
await page.getByRole('button', { name: '排版' }).click()
await sleep(500)

const slider = page.locator('input[aria-label="页边距"]')
const range = await slider.evaluate((el) => ({ min: el.min, max: el.max, step: el.step, value: el.value }))

// 直接写 IndexedDB 之外的办法：拖滑块。用 evaluate 触发 React onChange 需要原生 setter
async function setRange(label, value) {
  await page.evaluate(
    ({ label, value }) => {
      const el = document.querySelector(`input[aria-label="${label}"]`)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, String(value))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { label, value },
  )
  await sleep(350)
}

const measure = () =>
  page.evaluate(() => {
    const ch = document.querySelector('.chapter')
    const r = ch.getBoundingClientRect()
    const cs = getComputedStyle(ch)
    const padL = parseFloat(cs.paddingLeft)
    const padR = parseFloat(cs.paddingRight)
    // 正文能排字的宽度 = 块宽 − 两侧留白（不依赖章节里第一个元素是不是 <p>）
    return {
      chapterW: Math.round(r.width),
      textW: Math.round(r.width - padL - padR),
      left: Math.round(r.left + padL),
      right: Math.round(window.innerWidth - r.right + padR),
      maxWidth: cs.maxWidth,
      padding: padL,
    }
  })

const samples = []
for (const v of [Number(range.min), 40, Number(range.max)]) {
  await setRange('页边距', v)
  const m = await measure()
  samples.push({ v, ...m })
  console.log(`   值 ${String(v).padStart(3)}px → 正文块宽 ${m.chapterW}  可排字宽 ${m.textW}  留白 ${m.left}/${m.right}  (max-width=${m.maxWidth}, padding=${m.padding})`)
}
const widths = new Set(samples.map((s) => s.textW))
step('页边距滑块能改变正文宽度', widths.size > 1, `三个取值得到的文字宽：${[...widths].join(' / ')}`)
step('滑块最小值也未超出视口（否则永远撑满）', Number(range.min) < 390, `min=${range.min}, 视口=390`)

// ---------- ② 三套主题下面板的可读性 ----------
// 夜间是用户报的问题，日间/护眼是回归项：整套调色板重绑必须在三个主题下都成立，
// 别修好夜间把日间弄坏。
const THEMES = [
  ['日间', 'rgb(255,254,251)'],
  ['护眼', 'rgb(250,243,228)'],
  ['夜间', 'rgb(35,35,40)'],
]
let worstAll = 99
for (const [label, wantPanelBg] of THEMES) {
  console.log(`\n=== ② ${label}主题：排版面板的可读性 ===`)
  await page.evaluate((t) => {
    const btns = [...document.querySelectorAll('.settings-pill')]
    btns.find((b) => b.textContent.trim() === t)?.click()
  }, label)
  await sleep(450)

  const r = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    })
    const rgbStr = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`
    const effBg = (el) => {
      let n = el
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c.a > 0.9) return c
        n = n.parentElement
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }
    const ratio = (el) => {
      const fg = parse(getComputedStyle(el).color)
      const bg = effBg(el)
      const l1 = lum(over(fg, bg))
      const l2 = lum(bg)
      return +( (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) ).toFixed(2)
    }
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      return {
        sel,
        text: (el.textContent || '').trim().slice(0, 10),
        fontSize: getComputedStyle(el).fontSize,
        ratio: ratio(el),
        color: getComputedStyle(el).color,
        on: rgbStr(effBg(el)),
      }
    }
    return {
      panelBg: rgbStr(effBg(document.querySelector('.settings-panel'))),
      readerBg: getComputedStyle(document.querySelector('.reader-scroll')).backgroundColor,
      items: ['.settings-header', '.settings-label', '.settings-value', '.settings-pill', '.settings-hint']
        .map(pick)
        .filter(Boolean),
    }
  })

  console.log(`   面板背景 ${r.panelBg}（期望 ${wantPanelBg}）  正文区背景 ${r.readerBg}`)
  for (const it of r.items) {
    const tag = it.ratio >= 4.5 ? '✓' : it.ratio >= 3 ? '△' : '✗'
    console.log(`   ${tag} ${it.sel.padEnd(18)} 对比度 ${String(it.ratio).padStart(5)}:1  ${it.fontSize.padStart(5)}  ${it.color} on ${it.on}`)
  }
  step(`${label}主题面板底色正确`, r.panelBg === wantPanelBg, r.panelBg)
  const worst = Math.min(...r.items.map((i) => i.ratio))
  step(`${label}主题文字对比度 ≥ 4.5:1`, worst >= 4.5, `最低 ${worst}:1`)
  worstAll = Math.min(worstAll, worst)
}
console.log(`\n三套主题里的最低对比度：${worstAll}:1`)

await page.screenshot({ path: '/tmp/night-settings.png' })
console.log('   截图：/tmp/night-settings.png')

step('无 JS 报错', errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length === 0)
await browser.close()
