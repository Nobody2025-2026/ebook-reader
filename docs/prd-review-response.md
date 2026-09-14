# 第三方 PRD 评审：逐条核实与采纳结论

> 2026-09-14。对象：一份来自第三方 AI 的 PRD 评审报告（5 条"需要修正" + 1 条"新发现"）。
> 本文的目的不是"评价这份报告好不好"，而是**把每条建议的事实基础核一遍，再对我们现状，最后给出采纳与否和触发条件**。
>
> 核实方法：对每条事实性论断查一手来源（npm/deps.dev 元数据、OpenSSF Scorecard、W3C 规范现状、MDN 基线、foliate-js 仓库 README），并对本仓库代码做实证（文件、行号、真机 Playwright）。
> 结论速览见第一节表格；逐条证据在后面。

---

## 一、结论速览

| # | 评审建议 | 结论 | 一句话理由 |
|---|---|---|---|
| 1 | 修正 epub.js"停更时间" | ✅ 采纳（但评审自己算错了） | `0.3.93` 是 **2022-02**，不是 2023-01；PRD 写的 2023-09 恰是最后一次发布（alpha） |
| 2 | 进度锚点升级为"内容锚 + 引文" | 🟡 部分采纳 | 我们**本来就没用 CFI**（早已是章索引 + 块索引 + 字符偏移）；引文冗余有效，但**现在做是空转**，记触发条件 |
| 3 | 大文件挪 OPFS | ❌ 不采纳 OPFS；✅ 立刻采纳 `persist()` | OPFS 同样受驱逐规则约束、不解决数据安全；而 `persist()` 我们**一次都没调**，真风险，已修并上线 |
| 4 | 高亮以 `TextQuoteSelector` 为主锚 | ❌ 不采纳（方向与规范现状相反） | EPUB Annotations 1.0 里 **text fragment/TextQuote 被标为 AT RISK**，保留的是位置锚；"位置锚为主 + 引文校验"才对 |
| 5 | P1 高亮锚定方案要提前定 | ⚪ 已过时 | 高亮 2026-09-11 已落地并跑通（块锚点 + 字符偏移 + 重叠合并 + 重绘守卫），无需"提前确定" |
| 6 | 看看 foliate-js | 🟡 读思路，不引入依赖 | 思路（SVG 覆盖层）确实能绕开我们踩过的坑，但该库自称 unstable、无发布、建议 submodule 引入 |

**一句话总结**：这份报告**方向感对、事实错三处**。最值钱的是它提醒了我们"存储可能被浏览器清掉"——这条我们确实漏了，已修（见第三节）；其余多为"PRD 早期设想 vs 实际实现"的信息差。

---

## 二、逐条核实

### 1. epub.js 的停更时间：采纳修正，但评审的数字是错的

评审说："最后正式版是 v0.3.93，发布于 2023-01……不是 2023-09，是 2023-01 就死了。"

**核查结果**（npm / deps.dev 元数据）：

| 版本 | 发布日期 | 性质 |
|---|---|---|
| `0.3.93` | **2022-02-17** | **最后一个正式版** |
| `0.5.0-alpha.0` | 2023-01-26 | 预发布 |
| `0.5.0-alpha.3` | **2023-09-27** | **最后一次发布（仍是 alpha）** |

另据 OpenSSF Scorecard（2026-08 抓取）：`Maintained 0/10`，理由 "0 commit(s) and 0 issue activity found in the last 90 days"；open issues 约 484（Snyk）。

结论：**"实质停更"成立，但时间点是 2022-02（最后正式版）/ 2023-09（最后一次发布）**。评审把"2023-01"当成了死亡时间——那其实是 `0.5.0-alpha.0` 的日期；而 PRD 原写的"2023-09"恰好对应最后一次发布，不算错，只是没说明那是 alpha。

已按此改写 `docs/PRD.md` 的选型表。**这条不影响任何技术决策**（我们没用它），价值仅是把文档写准。

### 2. 进度锚点：我们早就不是 CFI 了

评审把 PRD 里的 `Progress { cfi: string }` 当成了现状。实际现状（`src/lib/storage.ts` / `src/lib/progress.ts`）：

```ts
ReadingProgress { bookId, chapterIndex, blockIndex, percent, updatedAt }
// 高亮另加：块内字符偏移 { startOffset, endOffset }
```

- **不用 CFI**：CFI 依赖 DOM 结构路径，而我们的章节是 `dangerouslySetInnerHTML` 灌进来的、单章最多几十张懒加载图片会把内容往下顶——像素与结构路径都不可靠，所以选了**块锚点**（`BLOCK_SELECTOR = p,h1-h6,li,blockquote,pre` 的下标）+ 块内字符偏移。
- `percent` 我们也持久化，但它**只是派生展示值**（书库卡片进度条用），定位不读它——与评审说的"百分比只在当次会话用"实质一致。

**所以"需要升级"这半句对我们无效。** 有效的是它的**冗余**主张（W3C 规范第 6.2 节 "Using multiple selectors" 确实推荐多 selector）。我们采纳其精神，**但不采纳"以引文为主锚"**（理由见第 4 条），方案定为：

> **位置锚为主锚，引文为校验**——给锚点加可选 `quote: { exact, prefix, suffix }`；取位置前先用偏移定位，定位结果显示的文本与 `exact` 不符时，再在章内做一次引文匹配纠偏。

**触发条件（现在不做）**：`BLOCK_SELECTOR` 或章节渲染方式发生变更导致旧锚点漂移时，或要做"标注跨设备/跨应用导入"时。当前锚点稳定，加了也是死代码。

### 3. 存储：OPFS 不解决它想解决的问题，但评审戳中了一个真窟窿

评审建议：大 EPUB 放 OPFS，元数据/进度/标注放 IndexedDB，"无论选哪个都要调 `navigator.storage.persist()`"。

**核查**：

- OPFS 跨浏览器可用始于 **2023-03**（MDN），与评审一致 ✓。
- 但 MDN 同页明确：**OPFS 同样受浏览器存储配额与驱逐规则约束**，"clearing storage data for the site deletes the OPFS"。也就是说**迁移到 OPFS 并不能让数据更安全**——真正决定"会不会被自动清掉"的是 `persist()`。评审把两件事混在一句话里，结论容易误导。
- 我们存的是 `ArrayBuffer` 而非 Blob（`storage.ts` 有注释说明原因：Blob 在结构化克隆下的可移植性不够确定）。评审那句"存 70MB Blob"不准确，不过 structured clone 的开销判断本身没错。
- **真正的窟窿**：全仓搜 `navigator.storage` / `persist(` → **零命中**。也就是说：用户的书、进度、书签、高亮笔记、阅读统计全部躺在浏览器认为"随时可丢"的 best-effort 存储里，**我们从来没申请过保护，也从没告诉过用户**。这与刚修好的"删书无二次确认"是同一级别的问题（都是"用户没做错任何事，数据却会消失"）。

**采纳区分对待**：

| | 判断 | 理由 |
|---|---|---|
| `navigator.storage.persist()` | ✅ **已实现**（本次） | 基线 2021-12，两行代码，直接降低数据被清的风险 |
| 迁到 OPFS | ❌ 不做 | ① 解析库要整本书（zip 解压走 Blob/ArrayBuffer），OPFS 的分片读优势发挥不出来；② 不解决驱逐，收益为 0；③ Tauri 桌面版根本不吃浏览器配额；④ 最大样本 70MB，没到"整库超内存"的量级 |

**OPFS 的触发条件**：单书 > 300MB，或用户反馈"导入/打开卡顿"且采样证实内存峰值来自 ArrayBuffer 拼接。

### 4. `TextQuoteSelector` 为主锚：方向与 W3C 现状相反

评审说："W3C 已发布 EPUB Annotations 1.0 正式规范，推荐 TextQuoteSelector（exact + prefix + suffix）为主锚。"

**核查结果（两处都需要纠正）**：

1. **它不是"正式规范"**。EPUB Annotations 1.0 目前是 **W3C Working Draft**（First Public WD 2026-02-24，最新 WD 2026-04-25 与 2026-05-21），由 Publishing Maintenance WG 在 Recommendation track 上推进，规范正文自己写着"Publication as a Working Draft does not imply endorsement"。
2. **更关键：TextQuoteSelector 不在保留列表里**。规范保留的 selector 是 **Fragment Selector**（HTML / Media / SVG / **Text fragment**）、**CSS Selector**、**Text Position Selector**。工作组 2026-01 的讨论邮件里，编辑 Laurent Le Meur 明确写道：text fragment "actually replace the separate Text Quote Selector"（同一个东西，只是换了承载形式）。

   而 text fragment 这条路，规范**自己标了 AT RISK**，理由是逐字引用的："the absence of a standard API in web browsers makes mapping a text fragment to a DOM Range difficult. Rebuilding a DOM range from a textual range using tree walking is suboptimal, and the existing polyfills are not well-maintained."（并引用 whatwg#8282）

   翻成人话：**浏览器没有"从引文反推 DOM 位置"的标准 API**，所以"以引文为主锚"在当前 Web 平台上恰恰是最不可靠的一条路——而这正是我们做高亮时踩过的坑的方向。

3. 反过来，被规范**正式保留**的 `TextPositionSelector`（"记录选区在文本流中的起止位置"）在语义上就是我们的"块内字符偏移"。

**所以结论是：位置锚为主 + 引文做校验**，而不是相反。评审这条如果把"主锚"改成"校验层"，就是对的——我们按这个口径采纳（见第 2 条的触发条件）。

另：规范给的是 JSON 序列化格式，若哪天要做"标注导出给别的阅读器用"，可考虑加一个 `EPUB Annotations JSON` 导出选项（现在是 Markdown，面向人读）。

### 5. "P1 高亮锚定方案要提前定"：已经做完了

评审基于 PRD 判断"P1 还没定锚定方案"。实际：字符级高亮与笔记已于 **2026-09-11** 交付（`972d9bc` 及后续三轮实测修复），锚定方案就是我们上面说的块锚点 + 字符偏移，另有两条踩坑换来的机制：

- **重叠区间合并**（不是跳过），合并后 id 全记在 `data-ann-ids`，导出/删除仍按原多条处理；
- **重绘守卫**：章节用 `dangerouslySetInnerHTML` 渲染，重渲染会冲掉手画的 `<mark>`，所以靠"memo 隔离 + 渲染后比对数量补画"扛住任意次重渲染。

结论：无需"提前确定"，已落地并有测试覆盖（当前全量 250+ 用例）。

### 6. foliate-js：思路值得读，依赖不值得引

**核查结果**：

- MIT ✓；模块清单 ✓（`paginator.js` 分页渲染、`overlayer.js` 覆盖层批注、`progress.js`、`search.js`、`text-walker.js`、`tts.js`、`epubcfi.js`……）；已被 Foliate 稳定版使用 ✓。
- `overlayer.js` **不是包 DOM**，而是**绝对定位的 SVG 覆盖层**，`draw()` 可返回任意 SVG 元素（于是天然支持多色、波浪线、手绘感下划线），并配 `hitTest()` 做命中测试。
- 但仓库 README 明确写着：**"This library itself is, however, not stable. Expect it to break."**、"**Since there's no release yet**, it is recommended that you include the library as a git submodule"。即：没有 npm 正式包、接口会变。
- 它的进度表示（`progress.js`）：section index + 节内 fraction + 节的 `.size`（字节数）算全书进度，CFI 只用于 `resolveCFI` 定位——**印证我们自己那套"索引 + 偏移 + 加权百分比"的路线是主流做法**，这条算是对我们现有实现的背书。

**判断**：

- ❌ **不引入为依赖**：不稳定 + 无发布 + 要 submodule，为一个我们已经有可用实现的功能引入"会 break 的库"，风险收益不成比例。
- ✅ **读它的思路**：如果将来要做**非纯色标记**（波浪线、下划线、多色叠加），SVG 覆盖层确实是更好的形态——它能彻底绕开"手改 DOM 被重渲染冲掉"这一整类问题。
- ⚠️ **但要留意它的代价**：覆盖层是几何定位的，**滚动、重排、图片把布局顶动时必须重算**。我们单章最多几十张懒加载图片（还会陆续撑高页面），这正是当初放弃"像素定位"、改用块锚点的原因。真要上覆盖层，得先解决"重算时机"，而不是照抄。

**触发条件**：确定要做多色 + 非纯色标记时，先读 `overlayer.js` 的重算策略，再评估；若只是"同一套 `<mark>` 换颜色"，改 CSS 变量即可，不必动架构。

---

## 三、本次立刻落地的一条

**申请持久化存储（`navigator.storage.persist()`）**，并按"不打扰"的原则设计提示：

- `src/lib/persistence.ts`：申请 + 会话内去重（真机发现 React 严格模式会把 effect 跑两遍 → 并发调用共用一次申请）+ 提示开关的记忆。
- `src/App.tsx`：启动时安静申请一次；**只有明确被拒**才置标记（`unsupported` 不提示——老浏览器/私密模式用户也无能为力，提示只是噪音）。
- `src/components/Library.tsx`：被拒 **且书架上有书** 时才显示提示，文案给出可执行的兜底（阅读页「笔记 → 导出」），并提供「不再提示」永久关闭。

**为什么这么克制**：真机实测——**Chrome 对全新访客默认拒绝** `persist()`（按"用户参与度/是否安装为应用"判定）。若逢人就挂红字，就是"狼来了"，用户会连其他提示一起无视。所以：空书架不提、有书才提、可以永久关掉。

真机复核（`scripts/storage-persist-audit.mjs`，Playwright + 本机 Chrome）：申请只调一次 ✓、空书架不打扰 ✓、强制被拒 + 有书 → 提示出现且可关 ✓、关掉后刷新仍不提示 ✓、无存储 API 时页面照常渲染 ✓。

---

## 四、对这份报告的总评

**做对的**：指出"保持不动的四项"（解析+自渲染、连续滚动、桌面化三约束、实测修正资产）——判断准确，尤其"不要换库"这一句在阅评里很稀缺；把 `persist()` 拎出来说事，也是真戳到了我们的盲区。

**做错的**：三处事实（epub.js 时间、W3C 规范状态、TextQuote 在规范中的地位），共同根因是**引用较旧或二手的信息**——比如"2023-01"看起来来自 alpha 版本列表、"正式规范"来自对规范的误读。这提醒我们一条通用经验：**凡涉及"规范怎么说""库是否停更"的判断，必须回到一手来源核对状态与日期**（本项目的 Release notes、CHANGELOG 也是同理——写出去的东西会被当成事实）。

**方法上的局限**：它只读了 PRD，没读代码。于是第 2、4、5 条实际都在讨论我们早就解决的问题。这也侧面说明 `docs/PRD.md` 该标注"哪部分是历史设想"——本次已加注（见第六章）。

---

## 五、待办与触发条件汇总

| 事项 | 状态 | 触发条件 |
|---|---|---|
| 申请持久化存储 + 备份提示 | ✅ 已实现 | — |
| PRD 过时条目修正（epub.js 时间、退路作废、数据模型标注） | ✅ 已完成 | — |
| 锚点加引文冗余（`exact/prefix/suffix` 校验层） | ⏳ 备选 | `BLOCK_SELECTOR`/渲染方式变更导致锚点漂移，或要做跨设备导入标注 |
| 迁 OPFS | ❌ 不做 | 单书 > 300MB，或卡顿与内存采样指向 ArrayBuffer 拼接 |
| SVG 覆盖层批注（借 foliate-js 思路） | ⏳ 备选 | 要做非纯色标记（波浪线/下划线）或多色叠加时 |
| 导出 EPUB Annotations JSON | ⏳ 备选 | 要与其他阅读器互通标注时（等规范脱离 WD） |
