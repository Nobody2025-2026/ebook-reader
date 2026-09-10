# 更新日志

记录每个版本对外可见的改动。**发版（打 tag 触发 Release）前，务必把本次改动补进这里。**

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.2] — 待发布

### 修复

- **排版设置被 EPUB 自带样式压过**（样本：《涛动周期论》）

  该书每个段落都焊死了 `style="font-size:16px;font-family:'PingFang SC'"`。内联样式的优先级高于阅读器的 `.chapter` 规则，导致调字号没反应、切字体无变化、行距怎么调都不对劲。

  现在清洗阶段会摘掉内联的排版声明（`font-size` / `font-family` / `line-height` / `letter-spacing` / `color`），并用 CSS `!important` 兜住 EPUB 外部样式表里的同类规则；标题改用 `em` 相对值，层级保留且跟随字号设置一起缩放。语义样式（粗体、斜体、对齐）不受影响。

- **夜间模式下正文可能变成黑底黑字**

  同一根因：EPUB 内联的 `color:rgb(0,0,0)` 会盖过主题配色。现在文字颜色统一交给阅读器接管（链接保留强调色）。

- **部分书读不到封面 / 封面是错的**（样本：《博弈与社会》）

  这类书没有 cover 命名的封面页（页面全叫 `part0000.xhtml`），封面改由 OPF 的 `<meta name="cover">` 声明，且那张图不被任何页面引用——解析库只把章节引用到的资源转成地址，孤立资源拿不到，旧兜底链便直接放弃了。

  第一版修复用"书名页抠图"顶上，结果二次打脸：书名页里那张图是白底题名图（一行作者名），并不是真封面。

  现在按**访达/Quick Look 同款规则**取封面：优先认 OPF 的权威声明（`<meta name="cover">` 或 `properties="cover-image"`），直接从 EPUB 内部解出那张图（data URL 存储，刷新不失效）；封面页抠图降为第二顺位，书名页抠图最后保底。两本真实样本都验证了取到的图与 OPF 声明图**逐字节一致**，不再是"每来一本新书补一条规则"。

  顺带加了**封面版本号**：封面算法以后再修正，老书的封面会自动重取，不需要手动删书重导。

- **正文图片全部不显示**（样本：《涛动周期论》46 张图）

  根因在解析库 `@lingo-reader/epub-parser` 0.4.6：它用**模块级全局** `imageRecord` 缓存图片字节、`browserUrlCache` 缓存 blob URL，而 `destroy()` 会 `unlink` 全部条目 + `revokeBlobUrls()` 清空全局。本项目 `openEpub` 会被多次调用（导入 / 进阅读页 / 后台补封面），任一次 `destroy` 都清空全局状态，已渲染的 `<img src="blob:…">` 当场变成 0 字节空 blob（真浏览器实测 `naturalWidth=0`、fetch 回来 `byteLength=0`）。Node 测试走真实文件系统，这类"全局状态被跨实例互踩"的问题永远测不出。

  改为**自建资源层**（`src/lib/resources.ts`）：直接解 EPUB 的 zip 字节，把章节里的 `<img src>`、SVG `<image href>`、外链 CSS 的 `url()` 换成我们自己控制的地址（浏览器用 blob、Node 退化成 data URL）。地址生命周期归每本书自己管，只有这本书 `destroy` 时才 `revoke`，跨实例互不干扰；与封面那条路同源。

- **部分 EPUB 无法导入**（样本：《巴菲特致股东的信（原书第4版）》）

  解析库 `parseGuide()` 见到 `<guide>` 里没有 `<reference>` 子元素会**直接抛错**，整本书打不开。但空的 `<guide></guide>` 是**完全合法的 EPUB 2 结构**（calibre 转换产物常见）。新增 `fixEpubBytes`：导入前解 zip 检测并剔除空 `<guide>`，重新打包成新字节（level 0 不重压），绝大多数书零开销返回 `undefined` 用原文件。

- **翻页滚到底卡死、只能上翻**（样本：《笔记的方法》卡在 5.6%）

  旧实现两个缺陷叠加：① `loadChapter` 守卫 `|| loadingRef.current` 把忙时的并发请求**直接丢弃**（是丢弃不是排队）；② `IntersectionObserver` 只在交叉状态"变化"时回调，effect 依赖 `[loaded]` 每加载一章就 `disconnect` 再 `observe`，若哨兵仍在视口内（状态没变）浏览器不再补发回调。于是"请求被丢 + 之后再无回调" → 加载链永久断开，滚到底顶住；只有把哨兵滚出视口再滚回才有概率恢复。

  新方案：滚动位置是**连续可查量**，不依赖事件是否补发。`loadChapter` 改用 `inFlightRef`（按章节 index 记的集合）替代全局布尔量——同章只发一次请求，但不同章可排队；新增 `pump()` 从已加载末尾往后补相邻未加载章，每次加载完由 `[loaded]` effect 复查，天然自愈；`handleScroll` 触发 `pump`，移除 `IntersectionObserver` 与哨兵 div。

- **进度被存到末尾的目录页，再次打开"只有目录、翻不动"**（样本：《The Art of Focus》）

  这本转换版 EPUB 把**全书正文塞进单个 spine 项**，另外挂一个只有千把字的 `nav.xhtml` 目录页，且它排在 spine **最后**。旧逻辑把这类"边缘轻量章"当普通正文处理：滚到末尾时 `pump()` 会把目录页也加载进来当正文渲染（一长串链接），进度条随之顶到 100%，`progress.chapterIndex` 也被存成那个目录页的下标——下次打开就正好停在目录页上，而它是最后一项，于是"翻不动"。

  新增 `detectContentRange()`（`src/lib/progress.ts`）：按字数从 spine 两端各刮掉明显低于平均值（< 5%）的边缘章，得到真正的**正文区间**。三处据此收敛：① `pump()` 不再自动加载正文区间**之后**的章节（目录页不再被当正文渲染）；② 百分比只在正文区间内折算，落在区间之前算 0%、之后算 100%；③ 记进度与恢复进度都把章节下标夹回正文区间——即使读者滚过目录页，落盘的仍是最近的正文位置。首次打开仍从封面开始，不会一上来就跳过封面。

- **目录页整页是 `<div>` 时，滚动推不动加载链，后面几章永远加载不出来**（样本：《策略思维》）

  这本书的 `Contents` 页由 calibre 生成，147 个 `<div>` + 146 个 `<a>`，**一个块级元素（`p`/`h*`/`li`…）都没有**。而 `handleScroll` 原先把"补加载下一章"放在了 `if (blocks.length === 0) return` **之后**——于是当已加载的章都是这种无块级元素的前置页时，滚动事件进来先被提前返回挡掉，`pump()` 永远不被调用，加载链彻底停住：只显示封面 + 目录页，怎么滚都出不来正文（"打开只有目录页、无法再往下翻"）。

  修复：把 `pump()` 提到 `blocks` 判断**之前**——补加载与"能不能记进度"是两件事，前者不该依赖后者。进度计算仍需要块级元素，这条判断保留。

  真浏览器（Playwright）实测修复前后：《策略思维》修复前滚到底仍停在 `scrollHeight=5983` 的封面+目录；修复后同一操作加载出整本，`scrollHeight=333203`、正文可见。

- **点击正文里的脚注 / 目录链接不跳转，反而被弹回书库**（样本：《博弈与社会》等带书内锚点的书）

  正文是 `dangerouslySetInnerHTML` 渲染的，里面的 `<a href="part0004.xhtml#a005">` 走的是浏览器**默认跳转**；而本项目路由用的是 **HashRouter**——hash 就是路由本身。默认跳转把 `location.hash` 从 `#/read/xxx` 改成 `#a005`，`parseHash` 认不出阅读路由，`App` 当场渲染书库：读者点一下脚注就被弹出去了。

  两处修复：

  ① `Reader` 在内容容器上做事件委托（`handleContentClick`），拦下所有 `<a>` 点击——书内链接交给 `OpenedBook.resolveHrefToChapter()` 解析成「章序号 + 章内锚点」后跳转（跨章会先加载目标章），外链新标签页打开；**任何情况下都 `preventDefault`**，绝不让浏览器碰 hash。

  ② 新增 `resolveHrefToChapter()`（`src/lib/epub.ts`）：正文链接是"相对**当前章文件**"的相对路径（`part0004.xhtml`），而 spine 记的是"相对 OPF"的路径（`Text/part0004.xhtml`），解析库的 `resolveHref` 对这类链接**一律返回 `undefined`**（连它文档里的 `epub:` 前缀写法也不认，实测），所以自己归一化匹配——按当前章目录拼路径、解析 `.` / `..`、并收 basename 与全小写兜底键。

  真浏览器（Playwright）实测：导入《博弈与社会》，点击目录页里的 `<a href="part0004.xhtml#a005">`，hash 保持 `#/read/…` 不变、仍停在阅读页且滚动到了目标位置（修复前会被踢回书库）。

### 新增

- **自定义字体上传**

  排版面板的字体区新增「＋自定义」按钮：选一个 `.ttf / .otf / .woff / .woff2`，阅读器用 FontFace API 把它注册进页面并立即生效，跨平台一致（也绕开各浏览器对系统字体的指纹收敛）。字体二进制存在独立的 IndexedDB key，不污染设置对象；应用启动时会自动把已上传的字体重新注册。已上传的字体在面板里可一键删除（删掉当前选中的会自动回落到宋体）。

- **内置字体精简为 5 种跨平台字体**

  去掉了 macOS 独占的冬青黑体、思源黑体（Windows / Linux 上点它们只会回落到系统默认，造成"切了没反应"的错觉）。保留的宋体 / 黑体 / 楷体 / 圆体 / 仿宋在 macOS 与 Windows 上都有对应字体，切换结果一致。想用冬青黑体 / 思源黑体的用户，走上面的"自定义字体"上传即可。

### 测试

- 新增 `tests/sanitize.test.ts`（内联排版剥离，11 例）。
- 新增第二本真实样本《博弈与社会》进入回归测试，专门守住"封面走 OPF meta 声明"这条路。
- 新增 `tests/settings.test.ts`（字体栈解析 + 归一化迁移，10 例）、`tests/customFont.test.ts`（字体增删查 + FontFace 注册，5 例）。
- 新增 `tests/resources.test.ts`（自建资源层：zip 解包、相对路径解析、魔数兜底 MIME、图片/SVG/CSS 内联替换，覆盖 Node 退化 data URL 路径）。
- 新增 `tests/guide.test.ts`（空 `<guide></guide>` 与自闭合 `<guide/>` 被 `fixEpubBytes` 剥离、带内容的 guide 与无 guide 返回 `undefined`）。
- `tests/epub.test.ts`、`tests/real-book.test.ts` 图片断言改为校验 `blob:` / `data:` 前缀（不再误判为 `EPUB/` 开头）。
- `tests/app-ui.test.tsx` 阅读器用例里 `findByText('c1 的正文')` 等改为 `waitFor(() => expect(screen.getByText(...)).toBeInTheDocument())`。原因：`findByText` 底层 `getBy` 在 jsdom 下首检拿不到元素时直接返回 `null` 而不重试，openEpub 异步渲染与查询首检偶发竞态会导致整批测试不稳定；`expect(...).toBeInTheDocument()` 找不到时会抛错，交给 `waitFor` 重试即可稳过。
- 新增 `detectContentRange` 与"带正文区间"的 `computeWeightedPercent` 单测（`tests/logic.test.ts`），断言用两本真书的实际权重分布，锁定"目录页划出正文区间"的切分规则。
- `tests/app-ui.test.tsx` 增加"脏书"回归用例：进度落在末尾 nav 上时，打开的是正文而不是目录；正文区间之后的 nav 页不会被自动加载；另有"首章整页只有 `<div>/<a>` 时滚动仍能推动加载下一章"（用 `Element.prototype` 临时给滚动容器真实尺寸，否则 jsdom 下 `scrollHeight` 恒为 0，测不出这条路）。
- 新增第三、四本真实样本《The Art of Focus》《策略思维》进入 `tests/real-book.test.ts`，守住"轻量目录页划出正文区间"这条路（与既有样本一样，缺书自动跳过）。
- `tests/app-ui.test.tsx` 新增"脚注书"回归用例：点书内锚点链接时 `fireEvent.click` 必须返回 `false`（即 `preventDefault` 被调用）且 hash 不被改；点跨章锚点时目标章会被加载（用 `Element.prototype` 临时给滚动容器真实尺寸，避免 jsdom 下 `scrollHeight=0` 让 `pump` 提前把目标章加载完，从而测不出"点击才触发"）。
  - ⚠️ 踩坑记录：**别用 `findByText` 拿元素再点击** —— 它在 React 异步重渲染的间隙会返回**已脱离文档**的 stale 引用（实测 `document.body.contains(el) === false`），游离元素的事件冒泡不到 React root，`onClick` 根本不触发，会得出"功能没实现"的假结论。用 `container.querySelector(...)` 取当前 DOM 里的元素。
- `tests/real-book.test.ts` 的《博弈与社会》组新增"书内跨章链接能解析成「章序号 + 锚点」"用例，用真实脏书的 href 写法（相对当前章、带 `../`、纯 `#` 锚点、解析不到的目标）守住解析规则。

### 文档

- 新增 `docs/字体验证清单.md`：自定义字体功能的跨平台 / 多格式验证矩阵（Mac + Windows × ttf/otf/woff/woff2），已验证项打勾、未验证留空，供主上大人有条件时逐步回填；含通用通过标准与各形态（Mac Web / Mac 桌面 / Windows Web / Windows 桌面）的验证步骤。

## [0.1.1]

- 重新设计并替换 macOS 应用图标。
- 修复打包文件名版本号不跟随 git tag 的问题（改为 CI 用 tag 覆盖 `conf.version`）。
- README 补充未签名 App 的 `xattr` 兜底放行说明。

## [0.1.0]

- 首个可用版本：导入 EPUB/TXT、书库与进度、阅读视图与目录跳转、排版面板（字号/行距/页边距/字体/三主题）、进度记忆与继续阅读、键鼠翻页。
- macOS 桌面版（Tauri，未签名）与网页版（GitHub Pages）双通道。
