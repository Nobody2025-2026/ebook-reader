# P1 功能规划（v0.1.2 之后）

> 本文是「规划」文档，不含实现代码。目标：把 P1 真正待做的三块功能（高亮与笔记、全文搜索、阅读时长统计）的需求、数据模型、与现有架构的集成点、关键技术风险和测试策略讲清楚，并给出建议实现顺序。

---

## 0. 一句话结论

PRD 里 P1 四项 = **高亮与笔记 · 书签 · 全文搜索 · 阅读时长统计**。
经代码核查，**「书签」其实已经完整实现**（模型 + 存储 + UI + 跳转 + TOC 集成都在），所以 P1 真实增量只剩三块：

| 功能 | 状态 | 证据 |
|------|------|------|
| 书签 | ✅ 已完成 | `src/lib/bookmark.ts`（模型/去重/排序/摘录）+ `src/lib/storage.ts`（`listBookmarks`/`addBookmark`/`removeBookmark`/`deleteBook` 级联删）+ `Reader.tsx`（书签面板 865–912 行、添加 477 行起、跳转 `goToBookmark`、`jumpTo` 394 行、TOC 集成 928 行） |
| 高亮与笔记 | ❌ 未开始 | 全仓 grep `highlight/note` 无匹配 |
| 全文搜索 | ❌ 未开始 | 全仓无 search 代码；`OpenedBook` 只有 `loadChapter(id)→{html,css}`，**没有拿纯文本的接口** |
| 阅读时长统计 | ❌ 未开始 | 全仓无 stats 代码 |

⚠️ **与历史记忆不符处（已核实）**：记忆里写「状态管理用 zustand」，但全仓无 store 文件，状态全是 `App.tsx` / `Reader.tsx` 里的本地 `useState` / `useRef`。本规划按**现状（不引入 zustand）**设计；若主上大人要求改架构，请先明示，否则保持本地 state 不动。

---

## 1. 共同地基（已具备，直接复用，不要重造）

1. **锚点体系 `(chapterIndex, blockIndex)`**：进度、书签都已用它精确定位一个"块"。`block` = `BLOCK_SELECTOR`（`p/h1~h6/li/blockquote/pre`）命中的块级元素。`Reader.tsx` 里 `getCurrentAnchor()`（455 行）、`getBlockExcerpt(ch,block)`（466 行）都基于它。高亮、搜索、统计的定位全部复用这套锚点。
2. **存储 key 约定**：`meta:` / `file:` / `progress:` / `bookmarks:`（见 `storage.ts` 20–23 行）。新增功能沿用同范式：
   - `annotations:` —— 每书一个数组（仿 `bookmarks:`）
   - `stats:` —— 每书一条（或数组）
3. **事件委托范式**：`Reader` 已在 `.reader-scroll` 容器上用 `onClick` 委托处理正文内 `<a>`（`handleContentClick` 426 行），并 `preventDefault` 防 HashRouter 被踢回书库。高亮选区捕获、搜索结果跳转可复用同一容器委托。
4. **文本抽取能力**：`src/lib/weights.ts` 的 `findEntry()` + `textLength()`（33 行）已经用 `unzipSync` 直读 zip、去标签数纯文字。把 `textLength` 抽成 `stripTags()` 工具后，**搜索、统计可直接从 zip 拿纯文本**，完全绕开 `loadChapter`（也就避开 epub-parser 那个全局 `imageRecord` / blob URL 互踩的已知坑）。

5. **数据持久化与 origin 隔离（关键认知）**：所有数据（书二进制、进度、书签，以及规划中的 `annotations:` / `stats:`）都存浏览器 **IndexedDB**，按 **origin（协议 + 主机 + 端口）** 隔离，**与 dev server 进程无关**。关电脑 / 杀 server / 重启后再打开，只要同一浏览器、同一 origin，数据都在（因为躺在硬盘上，不活在进程内存里）。
   - **端口漂移会"看起来丢库"**：vite 默认 `5173`，被占用会悄悄退到 `5181`；而 `localhost:5173` 与 `localhost:5181` 是**两个不同 origin**，各自独立 IndexedDB → 在 5173 导入的书在 5181 访问时"全没了"（数据没删，只是访问到了空库）。已在 `vite.config.ts` 用 `server: { port: 5173, strictPort: true }` 固化，端口被占直接报错退出，杜绝漂移。
   - **真实用户不受此坑影响**：网页版走固定 `https://<user>.github.io/ebook-reader/` 网址、桌面版 Tauri 用固定 `tauri://localhost` origin，都无端口漂移概念。
   - **真正会丢数据的边界（本地存储固有限制）**：换浏览器（Chrome↔Safari）/ 清站点缓存 / 无痕模式 / 换设备（Mac→Windows）。换浏览器或清缓存后，原 origin 下的库不可达，也无法用脚本跨 origin 合并。

---

## 2. 高亮与笔记（Annotation）

### 2.1 需求与验收
- 用户在阅读时**选中一段文字** → 选区上方浮出操作条 → 可选颜色高亮，或写笔记。
- 高亮后的文字在阅读视图中以底色标出；**滚走再回来、刷新页面再进、从书库重新打开，高亮仍在**。
- 笔记可编辑、可删除；有「标注/笔记」列表面板，点条目跳回原文对应位置。
- 验收清单：选中→高亮→滚离再回→`<mark>` 仍在；刷新→仍在；删除→消失；笔记编辑后内容持久。

### 2.2 数据模型（建议高亮与笔记合一为 Annotation）
```ts
interface Annotation {
  id: string
  bookId: string
  chapterIndex: number
  blockIndex: number
  startOffset: number   // 块内字符偏移（相对 block.textContent）
  endOffset: number
  color?: 'yellow' | 'green' | 'blue'   // 纯高亮用；笔记可无
  note?: string         // 笔记正文，空 = 纯高亮
  createdAt: number
  updatedAt: number
}
```
复用 `(chapterIndex, blockIndex)` 锚点，偏移相对块的 `textContent`——与 `getBlockExcerpt` 的口径一致。

### 2.3 存储
- 新增 `annotations:` 前缀，每书一个数组：`listAnnotations(bookId)` / `upsertAnnotation(bm)` / `removeAnnotation(id)`。
- `deleteBook()` 级联删 `annotations:`（仿 `bookmarks:` 的 133 行）。

### 2.4 与现有架构集成点
- **选区捕获**：在 `.reader-scroll` 加 `onMouseUp` / `selectionchange` → `window.getSelection()` → 用 `anchorNode`/`focusNode` 的祖先 `article[data-chapter-index]` 取 `chapterIndex`，再向上找最近的 `BLOCK_SELECTOR` 取 `blockIndex`，块内偏移 = 该块 `textContent` 上的字符位置。
- **重绘高亮（核心难点，见 2.5）**：章节 HTML 由 `dangerouslySetInnerHTML` 注入（691 行），受 React 控制，**一次性 DOM 包裹会被任何重渲染冲掉** → 必须在章节加载后由 effect 重绘。
- **操作条 UI**：选中后绝对定位浮在选区上方（复用现有 floating-hint 样式思路）。
- **列表面板**：仿 `bookmarks-panel`（865–912 行）新增「标注」面板，列出全部 annotation，点条目 → `jumpTo(chapterIndex)` + 定位到 `block`。

### 2.5 关键技术风险与对策
| 风险 | 对策 |
|------|------|
| React 重渲染冲掉 `<mark>` | 章节 `loaded` 变化后由 effect 调 `applyHighlight(blockEl, start, end)` 重绘；`innerHTML` 重置时 effect 会重跑 |
| 块内有嵌套标签（`<em>`/`<a>`），字符偏移跨多个 text node | 用 `TreeWalker` 累加 text node 偏移；跨节点包裹用 `range.extractContents()` + `insertNode(mark)`（勿用 `surroundContents`，跨节点会抛错）。封装为 `wrapRange(blockEl, start, end)` |
| 选区分跨多个 block | **MVP 限定单次选择只在单 block 内**；跨 block 选择提示"请缩小到一段"或拆成多条（建议先不做） |
| 块 `textContent` 在重排/换字体后变化 | 仅文本流稳定，排版不影响字符序列；章节重新加载后文本一致，偏移可复现 |

### 2.6 测试
- `wrapRange` / 偏移计算：jsdom 单测，构造带嵌套标签的 block，验证高亮后 `textContent` 不变、`<mark>` 数量与位置正确。
- 集成：选中→DOM 出现 `<mark>`；模拟"重新加载章节"→ effect 重绘仍出现 `<mark>`（jsdom 无布局但 `textContent` 可用）。

---

## 3. 全文搜索（Search）

### 3.1 需求与验收
- 阅读页提供搜索框，输入关键词 → 列出全书所有命中（章节 + 上下文片段）→ 点命中跳到该处并临时高亮关键词。
- 中文按子串匹配（大小写不敏感），**不做分词**（MVP 够用）。
- 验收：搜书中确有的词 → 结果数 > 0 且能跳到正确章节；跳过去后关键词在视口内并高亮。

### 3.2 数据 / 索引
- **复用 `weights.ts` 的 zip 直读**：新增 `extractAllChapterText(bytes, spineHrefs): string[]`（镜像 `computeChapterTextLengths` 93 行，但返回纯文本而非长度）。`openEpub` 内部已持有 `bytes` 和 `spineHrefs`（算 `chapterWeights` 必经），在打开流程里一并生成 `chapterTexts`，挂到 `OpenedBook` 或 `Reader` state。
- **内存**：25 万字 ≈ 1MB 字符串，可接受；70MB 图多的书纯文本仍小。
- **索引**：书规模小，直接遍历 `chapterTexts` 用 `indexOf` 收集 `{chapterIndex, charIndex, context}`，**不建倒排**。

### 3.3 存储
- 搜索是临时运算，**不持久化**，无需新 key。每次打开重建（与 `chapterWeights` 同量级耗时，合并进 loading 阶段）。

### 3.4 与现有架构集成点
- **UI**：阅读页顶栏加「搜索」按钮 → 打开搜索面板（仿 `toc-panel`），输入框 + 结果列表。
- **跳转**：命中项 → `jumpTo(chapterIndex)`（394 行）+ 在目标 block 内定位关键词，用与高亮相同的 `wrapRange` 做**临时**（不持久）高亮。

### 3.5 关键技术风险与对策
| 风险 | 对策 |
|------|------|
| 拿不到 `bytes` | `getBookFile` 返回 `File`，`openEpub` 收 `File`；打开流程里 `await file.arrayBuffer()` 即可，无需改解析库 |
| 大书索引耗时 | 和 `chapterWeights` 同量级（已接受"首次解析几秒"），并入 loading 或首次搜时带 loading 态 |
| HTML 标签/实体残留 | 抽取文本复用同一 `stripTags`（从 `textLength` 抽出），保证去标签 |
| 中文无分词 | MVP 子串匹配，接受"词语边界不处理" |

### 3.6 测试
- `extractAllChapterText`：构造 mini epub bytes（或 mock `files` 对象）→ 校验抽出的纯文本、去标签正确。
- 搜索逻辑：给定 `chapterTexts` + 关键词 → 返回正确命中位置与上下文。

---

## 4. 阅读时长统计（Stats）

### 4.1 需求与验收
- 记录每本书**累计阅读时长、阅读次数（session 数）、首次/最近阅读时间**。
- 书库页每本书显示阅读时长（如「已读 3 小时 12 分」）+ 进度。
- 验收：打开书 30 秒后退出 → 时长 ≥ 30s 且持久；下次打开累加。

### 4.2 数据模型
```ts
interface ReadingStats {
  bookId: string
  totalSeconds: number
  sessions: number
  firstOpenedAt: number
  lastReadAt: number
  finishedAt?: number   // 进度到 100% 时标记（可选）
}
```

### 4.3 存储
- 新增 `stats:` 前缀：`getStats(bookId)` / `addReadingSeconds(bookId, secs)` / `touchOpen(bookId)`。`deleteBook` 级联删。

### 4.4 与现有架构集成点
- **计时**：`Reader` 进入 `ready` 起 `start = Date.now()`；用 `visibilitychange` 暂停（标签页隐藏不计）；`pagehide` / unmount 时 flush；周期性（每 10–30s）累加防丢。
- **展示**：`Library.tsx` 书卡加一行统计（加载时一并读 `stats:`）。

### 4.5 风险与对策
- 后台标签 / 息屏：`visibilitychange` 暂停计时。
- 精度：周期 flush + 退出 flush 双保险。
- 多标签同开一书：极端场景，先不处理。

### 4.6 测试
- 计时逻辑单测：mock 时钟，验证累加 / 暂停 / flush。

---

## 5. 建议实现顺序（由易到难，风险隔离）

1. **阅读时长统计** —— 最简单、零渲染风险、独立存储。先打通「打开计时 → 持久 → 书库展示」，建立信心。
2. **全文搜索** —— 复用 zip 直读，独立于渲染，风险中等。建索引 + 搜索面板 + 跳转。
3. **高亮与笔记** —— 渲染重绘风险最高。先做 MVP：单 block 字符级高亮 + 笔记，再做跨 block / 多色等增强。

---

## 6. 跨功能工程约定

- 每个功能独立 `feat:` commit + 配套测试 + `CHANGELOG.md` 条目（遵循 `AGENTS.md`）。
- 真实书验收 3 本（含《涛动周期论》OCR 脏书）：导入 → 翻页 → 图片 → 进度 → 脚注 → 各新功能全链路。
- 三功能均纯本地、IndexedDB，**不引入云同步 / 导出**（PRD P2 已砍）。

---

## 7. 待主上拍板的决策点

1. **高亮精度**：字符级精确（推荐，体验好但需 `wrapRange` 跨节点封装）vs 整块级 MVP（实现极简、体验差）？
2. **搜索范围**：仅当前打开的书（推荐）vs 书库跨书全局搜？
3. **统计展示**：书库卡片一行（推荐）vs 独立「统计」页 / 周报？
4. **笔记导出 / 跨设备**：PRD 已砍 → 默认纯本地；如要坚持请明示。
