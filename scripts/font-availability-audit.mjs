// 手机端「字体面板」真机审计（Playwright + 本机 Chrome，390×844 触屏视口）
//
// 用法：先起开发服务器（node node_modules/vite/bin/vite.js），再
//   node scripts/font-availability-audit.mjs
//
// 背景（2026-09-12 主上大人安卓夸克实测）：
//   ① 5 种内置字体全部被标灰 + 每个都挂「不可用」角标 + 一大段写死 iPhone 的说明
//      → 手机屏被文字占满，信息还是错的（安卓机器上看到 iPhone 说明）。
//   ② 需要分清两种"全灰"：
//      - 安卓确实没有宋体/楷体这套桌面字体 → 如实标灰是对的；
//      - 某些浏览器把 canvas 字体度量抹平 → 会把"本可用"的也标灰，这是误判。
//
// 三个场景：
//   A. 真实 Chrome（macOS 字体齐全）→ 一个都不该被禁用、不该出现折叠说明
//   B. 模拟度量被抹平的浏览器（夸克类）→ 探针不可信 → 一个都不该被禁用
//   C. 模拟安卓字体环境（只有 Noto Sans CJK SC）→ 只该禁用真的没有的那几种，
//      且「系统默认」始终可选、说明收进折叠、文案里不出现平台名
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const url = 'http://localhost:5173/ebook-reader/'
const bookPath = '/Users/shaun_1/WorkBuddy/自制阅读器/books/策略思维.epub'

const { chromium } = await import(
  '/Users/shaun_1/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs'
)

const step = (n, ok, extra = '') => console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`)

/** 造一个假的 2D context：按字体表决定宽度，模拟"某平台装了什么字体" */
const fakeCanvas = (fonts, fallback) => `
(() => {
  const FONTS = ${JSON.stringify(fonts)};
  const FB = ${fallback};
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type !== '2d') return orig.call(this, type, ...rest);
    const ctx = { _font: '16px sans-serif' };
    Object.defineProperty(ctx, 'font', {
      get() { return this._font; },
      set(v) { this._font = v; },
    });
    ctx.measureText = (text) => {
      const fam = ctx._font.replace(/^[\\d.]+px\\s*/, '');
      const quoted = [...fam.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const bare = fam.replace(/"[^"]+"/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      const hit = [...quoted, ...bare].find((c) => c in FONTS);
      const w = hit ? FONTS[hit] : FB;
      return { width: w * (text.length / 20) };
    };
    return ctx;
  };
})();
`

// 真实 macOS / Windows 都有的字体（宽度的绝对值不重要，只要彼此不同）
const DESKTOP_FONTS = {
  'Songti SC': 1.0,
  'PingFang SC': 0.95,
  'Kaiti SC': 1.05,
  STFangsong: 1.02,
  'Yuanti SC': 0.98,
  monospace: 1.2,
  serif: 1.1,
  'sans-serif': 1.0,
  'system-ui': 0.97,
}

// 安卓：只有系统默认的无衬线中文字体
const ANDROID_FONTS = {
  'Noto Sans CJK SC': 0.95,
  monospace: 1.2,
  serif: 1.1,
  'sans-serif': 1.0,
  'system-ui': 0.97,
}

const scenarios = [
  {
    name: 'A 真实 Chrome（macOS 字体齐全）',
    initScript: null,
    expectDisabled: [],
  },
  {
    name: 'B 度量被抹平的浏览器（夸克类）',
    // 所有字体量出来一样宽 → 探针不可信
    initScript: fakeCanvas({}, 1),
    expectDisabled: [],
  },
  {
    name: 'C 安卓字体环境（只有 Noto Sans CJK SC）',
    initScript: fakeCanvas(ANDROID_FONTS, 1.0),
    expectDisabled: ['宋体', '楷体', '圆体', '仿宋'],
  },
]

const browser = await chromium.launch({ executablePath: chromePath })

for (const sc of scenarios) {
  console.log(`\n========== ${sc.name} ==========`)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  if (sc.initScript) await page.addInitScript(sc.initScript)

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

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入书籍' }).click()
  ;(await chooser).setFiles(bookPath)
  await page.locator('.book-card').first().waitFor({ timeout: 120_000 })
  await page.getByRole('button', { name: /^打开《/ }).first().click()
  await page.locator('.reader-scroll').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(2000)

  await page.getByRole('button', { name: '排版' }).click()
  await page.waitForTimeout(700)

  const report = await page.evaluate(() => {
    const pills = [...document.querySelectorAll('.settings-row .settings-pill')]
    const fonts = pills
      .filter((p) => !p.classList.contains('settings-pill--add') && !p.classList.contains('settings-pill--custom'))
      .map((p) => ({
        label: (p.textContent || '').trim(),
        disabled: p.disabled === true,
      }))
    const details = document.querySelector('.settings-details')
    const summary = details?.querySelector('summary')
    // 面板里可见的文字总量（看看还会不会"被文字占满"）
    const panel = document.querySelector('.settings-panel')
    const textLen = (panel?.innerText || '').replace(/\s+/g, '').length
    const panelRect = panel?.getBoundingClientRect()
    return {
      fonts,
      hasDetails: !!details,
      detailsOpen: details?.hasAttribute('open') ?? null,
      detailsClosedHeight: details ? Math.round(details.getBoundingClientRect().height) : 0,
      summaryText: (summary?.textContent || '').trim(),
      mentionsPlatform: /Safari|iPhone|iOS|Chrome/.test(panel?.innerText || ''),
      warnText: (document.querySelector('.settings-hint--warn')?.textContent || '').trim(),
      textLen,
      panelHeight: panelRect ? Math.round(panelRect.height) : 0,
      activeFont: (document.querySelector('.settings-pill--font.active')?.textContent || '').trim(),
    }
  })

  console.log(`   字体按钮：${report.fonts.map((f) => `${f.label}${f.disabled ? '(禁用)' : ''}`).join(' ')}`)
  console.log(`   当前选中：${report.activeFont} ｜ 面板高 ${report.panelHeight}px ｜ 面板文字 ${report.textLen} 字`)

  const disabledLabels = report.fonts.filter((f) => f.disabled).map((f) => f.label)
  step(
    '被禁用的字体与预期一致',
    JSON.stringify(disabledLabels) === JSON.stringify(sc.expectDisabled),
    `实际 [${disabledLabels.join(',')}] 预期 [${sc.expectDisabled.join(',')}]`,
  )
  step('「系统默认」永远可选', report.fonts.find((f) => f.label === '系统默认')?.disabled === false)
  step('默认选中「系统默认」', report.activeFont === '系统默认', report.activeFont)
  step(
    '折叠说明：有不可用字体才出现，且默认收起',
    sc.expectDisabled.length > 0
      ? report.hasDetails && report.detailsOpen === false
      : !report.hasDetails,
    report.hasDetails ? `摘要「${report.summaryText}」收起高度 ${report.detailsClosedHeight}px` : '无',
  )
  step('面板文案不写死平台名（安卓上看不到 iPhone/Safari）', !report.mentionsPlatform)
  step('选中字体可用时不出现红字警告', sc.expectDisabled.length === 0 ? !report.warnText : true, report.warnText)
  step('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  await page.screenshot({
    path: `/tmp/font-panel-${sc.name.slice(0, 1)}.png`,
    fullPage: false,
  })
  await context.close()
}

await browser.close()
console.log('\n截图：/tmp/font-panel-A.png  /tmp/font-panel-B.png  /tmp/font-panel-C.png')
