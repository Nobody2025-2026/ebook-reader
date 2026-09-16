# AI 功能需求摘要（ebook-reader）

> 角色：需求发现分析师（许明需）。本摘要为**设计系统专家 / 原型构建师**的输入，覆盖设计、落地、开销、可行性、UX 五个维度，并给出需用户拍板的范围决策。
> 依据：现有 `docs/ai-feature-plan.md`（规划）、实际代码（`src/lib/settings.ts`、`src/lib/highlight.ts`、`src/components/Reader.tsx`、`src/index.css`）。
> 标注「需核实」的数字：价格/体积随厂商变动，落地前务必二次核对官方页。

---

## 1. 设计（Design）—— AI 在阅读器里的视觉/交互落点

现有界面资产：书库页、阅读视图（连续滚动 + 目录侧栏 + 选中文本机制）、设置页、高亮笔记。建议 AI 落点如下：

| 界面 | AI 形态 | 复用现有语言 | 决策要点 |
|---|---|---|---|
| **阅读视图·划词** | 划词浮层（扩展现有 `.ann-popover`） | `highlight.ts#selectionToAnchor` → 浮层；accent 细边 + 选中原文摘录 | MVP 核心入口。选中后浮层增加「AI 解释 / 翻译 / 短摘要」动作（单入口+模式切换亦可）。**不可破坏现有"框选→确认"两步入库约定**。 |
| **阅读视图·追问/笔记整理** | 右侧 AI 对话侧栏（桌面）/ 底部抽屉（移动） | 复用 `.search-panel`/`.toc-panel` 骨架（280–320px、header+body、`togglePanel` 单面板互斥、手机 bottom-sheet + `.panel-backdrop`） | 承载多轮对话，将 AI 回复沉淀为笔记。 |
| **设置页** | 新增「AI」分节 | 复用 `.settings-group` / `.settings-label` / `.settings-pill` / `.settings-details` | 引擎选择、在线 key 输入、本地模型选择、隐私说明。 |
| **书库页** | 暂不入（MVP） | — | 全书级功能（跨章摘要）放后期。 |
| **高亮笔记面板** | AI 结果可存为高亮/笔记 | 复用 `Annotation` 结构、`buildAnnotationMarkdown` 导出 | 翻译/解释沉淀为笔记，导出 Markdown。 |

**视觉一致性约束（给设计系统专家）：** 全部走既有 CSS 变量（`:root` 与 `.reader` 三主题 day/sepia/night 自动跟随）——主色 `--accent:#534ab7`、卡片 `--surface`、描边 `--line`、次要文字 `--muted`、危险 `--danger`。AI 回复气泡用 surface 底 + accent 左边线（与 `.ann-popover__excerpt` 一致）。**不引入新色板、新圆角规范**（现有按钮 8px、浮层 12px、卡片阴影 `0 8px 28px`）。

**建议新增组件命名（供原型构建师）：** `.ai-popover`（划词动作）、`.ai-panel`（对话侧栏）、`.ai-msg`（气泡），样式 100% 继承现有 token。

---

## 2. 落地（Implementation）—— 从现有架构切的路径

**MVP 模块拆分（建议落点）：**
- `src/lib/ai/engine.ts` — `AIEngine` 抽象：`chat(messages, opts)`（建议 streaming 变体）、`listModels()`、`kind: 'online'|'ollama'|'webllm'`、`getStatus()`。
- `src/lib/ai/online.ts` — OpenAI 兼容 `/v1/chat/completions`（可配 `baseURL`）。
- `src/lib/ai/ollama.ts` — `fetch http://localhost:11434/api/chat`（或 `/api/generate`）。
- `src/lib/ai/webllm.ts` — `@mlc-ai/web-llm`，**必须 `CreateWebWorkerMLCEngine` 跑在 Worker**（防主线程卡死）。
- 设置页 + settings store — 扩展 `ReaderSettings` 或新增 `ai` 字段（仍走 `idb-keyval` 同 store）；key 明文存，标注风险。
- 划词 UI — 扩展 `Reader.tsx#openSelectionPopover`，复用 `selectionToAnchor`；AI 侧栏接入 `togglePanel` 单面板互斥。
- 内容获取 — 选中文本用 `highlight.ts#selectionToAnchor/blockText`；章内文本用 `progress.ts#BLOCK_SELECTOR` 块锚点；单章 RAG 用 `search.ts#extractBookTexts(book)`（每书抽一次缓存）。

**与现有模块的具体集成点：**
| 能力 | 复用对象 | 备注 |
|---|---|---|
| 选中文本 | `highlight.ts#selectionToAnchor(article, sel)` → `{chapterIndex, blockIndex, startOffset, endOffset, text}` | 划词入口已验证，直接接 |
| 章内/全书文本 | `progress.ts#BLOCK_SELECTOR`、`search.ts#extractBookTexts` | 无需新增解析 |
| 设置持久化 | `settings.ts#loadSettings/saveSettings`（idb-keyval, key=`settings:reader`） | AI 字段并入或新增 key |
| 划词链路 | `Reader.tsx` `onMouseUp→openSelectionPopover`；触屏 `handleTouchEnd` 已排除选区 | 加 AI 动作，不改选中语义 |
| 侧栏互斥 | `Reader.tsx#togglePanel/closeAllPanels` | AI 面板须遵守"一次只开一个" |
| 桌面端权限 | `src-tauri` capabilities 放开 `http://localhost`/`http://127.0.0.1` | 仅 Ollama 需要 |

**桌面端 vs 网页端差异（关键约束）：**
| 能力 | 网页版（HTTPS） | 桌面端（Tauri） |
|---|---|---|
| 在线 API | ✅ | ✅ |
| WebLLM | ✅（需 WebGPU） | ✅ |
| Ollama | ❌ 混合内容拦截（`fetch http://localhost` 被浏览器当混合内容） | ✅（capability 放开） |

建议：抽象层三引擎都写，但**运行时按环境屏蔽**——网页版禁用 Ollama 选项并给出说明，桌面端全开。

---

## 3. 开销（Cost）—— 量化两类成本

### 表 A：在线 API（划词翻译/解释场景，短输入短输出）
**假设单次：输入均值 ≈150 tokens（一句到一段）、输出均值 ≈120 tokens。** 价格取 2025–2026 公开价，均标「需核实」。

| 模型 | 输入 $/1M | 输出 $/1M | 缓存命中输入 | 每 1000 次调用成本(≈$) | 折合 ¥/1000 次* |
|---|---|---|---|---|---|
| GPT-4o-mini | 0.15（需核实） | 0.60（需核实） | 0.075 | ~0.095 | ~0.68 |
| Claude Haiku 3.5 | 0.80（需核实） | 4.00（需核实） | 0.08 | ~0.60 | ~4.3 |
| DeepSeek-V3 | ¥2(未命中)/¥0.5(命中)（需核实） | ¥8（需核实） | — | ~¥1.26(未命中) | ¥1.26 |
| 通义 Qwen-Plus | ¥0.8（需核实） | ¥2（需核实） | — | ~¥0.36 | ¥0.36 |
| 通义 Qwen-Turbo | ¥0.3（需核实） | ¥0.6（需核实） | — | ~¥0.12 | ¥0.12 |

\*汇率按 1 USD ≈ 7.2 RMB（需核实）。**结论：对单人读者成本极低**——即便每月 3000 次划词，GPT-4o-mini ≈ ¥2/月、Qwen-Turbo ≈ ¥0.36/月。瓶颈是**隐私与密钥管理**，不是单价。若上「全本摘要/RAG」，输入可至数千 token/次，成本线性放大但仍可控。

### 表 B：本地方案（一次性 + 持续）
| 引擎 | 一次性开销 | 持续开销 | 体积/资源 | 备注（需核实） |
|---|---|---|---|---|
| **WebLLM** | 模型下载（首启） | 无费用；本地 GPU 算力+内存 | Qwen2.5-0.5B ~400MB / ~0.9GB VRAM；1.5B ~940MB–1GB / ~1–2GB VRAM；3B ~2GB / ~3GB VRAM | 缓存按浏览器源隔离（同模型跨站重复下载）；**不随包携带**，运行时从 MLC CDN 拉；WebGPU 必需 |
| **Ollama** | 用户自装 Ollama + 拉模型（qwen2.5:1.5b ~0.9GB、3b ~1.9GB、7b ~4.5GB） | 无费用；本机算力 | 模型存本机磁盘，跨应用共享 | 仅桌面端；分发包不默认捆绑（否则安装包增重数 GB）；用户需自备 |

**结论：** 本地方案边际成本 = 0（无 API 账单），代价是首下体积 + 设备算力。WebLLM 最契合"零后端零费用"，但小模型(≤1.5B)翻译/解释质量有限；Ollama 质量最佳但强依赖用户环境。

---

## 4. 可行性（Feasibility）—— 逐引擎评估

| 引擎 | 技术可行性 | 主要坑点 | 降级方案 |
|---|---|---|---|
| **在线 API** | 高（OpenAI 兼容最成熟） | 私密内容出本机→隐私/合规；key 明文存储；需用户自备 key | 无 key 时灰显；首用显式知情同意 |
| **WebLLM** | 中（WebGPU + Worker 化） | WebGPU 兼容性（Safari/iOS 弱）；低端机 VRAM 不足；首下体积；主线程卡顿 | 探测不支持→提示在线/关闭；按设备选 0.5B/1.5B；`CreateWebWorkerMLCEngine` 防卡 |
| **Ollama** | 中（桌面端） | 纯 HTTPS 网页混合内容拦截；需 Tauri 放 localhost capability；用户未必装/拉模型 | 仅桌面端开放；探测 `/api/tags`，未运行提示启动；网页端直接隐藏选项 |

**MVP 先接哪个引擎？推荐：WebLLM（隐私默认）+ 在线 API（质量兜底/最易联调）双线起步；Ollama 置 MVP 之后。**
- 阅读器核心卖点是隐私/离线/零后端，WebLLM 最贴合，且 MVP 划词对小模型(1.5B Qwen)友好。
- 但 WebLLM 质量与兼容性有风险，MVP 若只接它，可能因设备不支持而"首屏即不可用"。故并行接在线 API 作兜底、也最易联调验证抽象层。
- Ollama 放 MVP 后（仅桌面、依赖用户环境）。若团队想用"最快打通三引擎切换+设置页主干"验证抽象，也可先在线 API 一家打通主干再补 WebLLM/Ollama——但规划已默认 #1 划词且强调 WebLLM 友好度，**推荐 WebLLM+在线双线**。

---

## 5. 用户体验（UX）—— 隐私敏感场景与雷区

- **隐私知情同意：** 首次用在线/第三方引擎，弹一次确认（复用 `modal-backdrop`+`confirm-dialog` 风格），明确"选中文本将发送至 XX"，可勾"本次不再提示"；设置页常驻隐私说明（`.settings-hint--warn` 风格）。
- **首屏引导：** 首次进阅读，轻提示"选中文字可唤出 AI 解释"（复用 `.restore-hint` 胶囊），不强制。
- **模型下载进度：** WebLLM 首下必须有进度条 + 预估时间 + Wi-Fi 建议（移动端）+ 可取消；用类似 `.reader-progressbar` 的控件或独立进度层。
- **低端机降级：** 检测 WebGPU/可用 VRAM，不支持时隐藏 WebLLM 并引导在线；模型加载失败给明确报错而非白屏。
- **划词顺滑度：** 复用 `selectionToAnchor`→浮层，AI 动作按钮内置于 `.ann-popover`，不打断选中态；移动端划词与"点中间翻页"手势已隔离（gesture 排除选区），保持。
- **三引擎切换感知成本：** 默认引擎在设置页选好；运行时当前引擎不可用（在线无 key / WebLLM 设备不支持）自动回退并 `toast` 提示（复用 `.export-toast`），不让用户每次手动选。

**最容易翻车的 6 个 UX 雷区：**
1. WebLLM 首屏无进度/无降级 → 用户以为卡死。
2. 在线引擎静默把私密书内容发第三方 → **隐私翻车（最严重）**。
3. 划词浮层与现有选中/高亮逻辑冲突 → 破坏已验证的高亮体验。
4. 三面板（目录/排版/AI）互斥未遵守 → 手机上挤爆。
5. key 明文存储无提示 → 安全认知缺口。
6. Ollama 在网页版误开放 → 必然失败且无说明。

---

## 6. 关键范围决策（需用户拍板，附推荐默认）

| # | 决策项 | 推荐默认（标注「推荐」） | 备选 | 理由 |
|---|---|---|---|---|
| 1 | **MVP 范围** | 仅划词翻译/解释（推荐） | 含术语轻追问/笔记整理 | 最小算力友好、一次性打通"抽象+三引擎+设置页"主干 |
| 2 | **首个落地引擎** | WebLLM（隐私默认）+ 在线 API（质量兜底）双线（推荐） | 仅在线 API 先通主干；或仅 WebLLM | 兼顾隐私卖点与设备兼容性；Ollama 置 MVP 后 |
| 3 | **分发目标** | 双端（桌面 Tauri + 网页版；网页版禁 Ollama）（推荐） | 仅桌面端 Tauri（Ollama 可用、体验最完整） | 双端覆盖广；若资源紧先桌面 |
| 4 | **设计形态** | 划词浮层 + 右侧 AI 对话侧栏/底部抽屉，两者都要（推荐） | 仅侧栏 | 划词是最高频入口，不能只做侧栏 |
| 5 | **成本策略** | 本地优先、在线可选：默认 WebLLM 零费用，允许小额在线 API（用户自备 key）（推荐） | 强制纯本地零费用 | 质量兜底 + 易联调；隐私敏感场景给提示 |
| 6 | **隐私默认** | WebLLM/本地为默认引擎；在线 API 需显式开启 + 每次首用知情同意（推荐） | 在线为默认（体验最佳） | 守住阅读器隐私/离线基因 |

> 请主上就上述 6 项拍板；其中 #2（引擎）与 #3（分发）会直接决定设置页选项与运行时屏蔽逻辑，建议优先确认。
