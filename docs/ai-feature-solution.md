# AI 功能方案 · ebook-reader（自制阅读器）

> 状态：**方案 v1（设计原型专家团产出）** ｜ 日期 2026-09-16 ｜ 来源：需求发现 + 设计系统选型 + 高保真原型 + 质量审查
> 配套文件：`docs/ai-feature-requirements.md`（需求摘要）、`docs/ai-feature-prototype.html`（可交互原型）

---

## 0. TL;DR（一句话结论）

在「纯前端、零后端、本地优先」的阅读器里加 AI，**守住隐私/离线基因**是最高优先级。MVP 只做**划词翻译/解释/短摘要**这一最高频场景，引擎走 **WebLLM（默认·本地·零费用）+ 在线 API（兜底·自备 key）双线**，分发**双端**（网页版禁 Ollama），形态为**划词浮层 + 右侧对话侧栏/手机底部抽屉**。视觉上 **100% 复用现有令牌**（靛紫 `#534ab7`、暖白底、popover/panel 范式），不引入新色板。本地方案**边际成本为零**，在线方案每月数千次划词仅约 ¥0.4–2。原型已通过质量审查（21/25，Anti-Slop 通过）。

---

## 1. 范围决策（已与主上大人确认）

| # | 决策项 | 结论 | 备选 | 理由 |
|---|---|---|---|---|
| 1 | MVP 范围 | **仅划词翻译/解释/短摘要** | 含术语轻追问/笔记整理 | 最小算力友好，一次性打通「抽象+三引擎+设置页」主干，风险最低 |
| 2 | 首个落地引擎 | **WebLLM + 在线 API 双线** | 仅在线 / 仅 WebLLM | WebLLM 守隐私默认，在线 API 作质量兜底与易联调；Ollama 后置 |
| 3 | 分发目标 | **双端（桌面+网页，网页禁 Ollama）** | 仅桌面端 Tauri | 覆盖最广；网页版因混合内容限制无法桥接本机 Ollama |
| 4 | AI 形态 | **划词浮层 + 对话侧栏/底部抽屉** | 仅侧栏 | 划词是最高频入口，不能只做侧栏 |
| 5 | 成本策略 | **本地优先零费用；在线可选（自备 key）** | 强制纯本地 | 质量兜底 + 易联调，隐私场景给提示 |
| 6 | 隐私默认 | **本地为默认引擎；在线需显式开启 + 首用知情同意** | 在线为默认 | 守住阅读器隐私/离线基因 |

---

## 2. 设计

### 2.1 设计系统选型：复用既有，不引入外部系统
评估了 4 个内置候选，全部否决——套外部系统会抹掉品牌靛紫、破坏一致性：

| 候选 | 冲突点 | 结论 |
|---|---|---|
| Notion | 强调色中性灰/蓝，抹掉品牌靛紫 `#534ab7` | 否决 |
| Warm Editorial | 衬线杂志风，与无衬线内容优先不符 | 否决 |
| Neutral Modern | 纯中性、无暖白无靛紫，等于降级现有语言 | 否决 |
| Apple | 强调色蓝 `#007AFF`、纯白，非靛紫非暖白 | 否决 |

→ **沿用现有 `:root` 令牌 + 三主题切换**，AI 仅新增少量由既有变量 `color-mix` 派生的令牌，零新色板。

### 2.2 设计令牌（全部走既有变量派生）

既有（`:root`，不可改）：`--bg #f6f5f2` / `--surface #fffefb` / `--fg #2c2c2a` / `--muted #6b6a66` / `--line #e2e0d8` / `--accent #534ab7` / `--danger #a32d2d`。

AI 新增派生令牌（仅追加）：
```
--ai-radius-bubble:12px;  --ai-radius-input:8px;  --ai-gap-msg:12px;
--ai-pad-bubble:12px 14px;  --ai-bar-w:3px;
--accent-tint:      color-mix(in srgb, var(--accent) 12%, var(--surface));
--accent-tint-soft: color-mix(in srgb, var(--accent) 8%,  var(--surface));
--accent-ring:      color-mix(in srgb, var(--accent) 22%, transparent);
--danger-tint:      color-mix(in srgb, var(--danger) 12%, var(--surface));
```
> 老浏览器（不支持 color-mix）已补固态回退，双击即可渲染。

### 2.3 三个 AI 界面（复用现有范式）
| 界面 | 形态 | 复用现有 | 要点 |
|---|---|---|---|
| 划词浮层 | 扩展 `.ann-popover`（300px、圆角12px、阴影 `0 8px 28px/.18`） | `highlight.ts#selectionToAnchor` | 加「解释(.btn)/翻译/摘要(.btn-ghost)」动作，不破坏既有「框选→确认」两步入库 |
| AI 对话侧栏 | 桌面右栏 300px / 手机底部抽屉(`<640px` + `.panel-backdrop`，max-height 78%) | `.search-panel`/`.toc-panel` 骨架、`togglePanel` 单面板互斥 | 承载多轮、可沉淀为笔记 |
| 设置页 AI 分节 | 引擎选择 / 在线 key / 模型选择 / 隐私说明 | `.settings-group/.settings-pill/.settings-details` | 复用既有分组样式 |

### 2.4 三主题与响应式
- 所有 AI 元素**不写死颜色**，随 `.reader` 切换日间/护眼/夜间自动跟随（夜间 `--accent` 提亮为 `#a49cf8`）。
- 夜间对比度要点：错误长文用 `--fg` 而非 `--danger`（`#e88b8b` 仅作图标/边线）；浮层/面板靠 `1px --line` 边线分隔而非依赖阴影。
- 触控目标 ≥36–40px；`focus-visible` 焦点环统一 `0 0 0 3px var(--accent-ring)`；`@media (prefers-reduced-motion: reduce)` 关闭光标/脉冲动画。

---

## 3. 高保真原型（可交互，已审查定稿）

**文件**：`docs/ai-feature-prototype.html`（单文件、零外部依赖、双击即可在浏览器打开）

覆盖 7 个场景：① 划词浮层（解释/翻译/摘要）② AI 对话侧栏（流式光标/思考中/错误态）③ 设置页 AI 分节 ④ 隐私同意弹窗 ⑤ 三主题切换（日间/护眼/夜间）⑥ 响应式（手机底部抽屉）⑦ WebLLM+在线双引擎指示（实心=本地 / 空心=在线）。

**怎么看**：直接浏览器打开文件 → 顶栏切三主题验证配色跟随 → 正文选中文字唤出浮层点「解释」→ 看默认对话/流式/思考中 → 设置里点「在线 API」触发隐私同意 → 窄屏下侧栏变底部抽屉。

---

## 4. 落地架构（从现有代码切，非另起炉灶）

### 4.1 统一 `AIEngine` 抽象（`src/lib/ai/engine.ts`）
```
interface AIEngine {
  readonly kind: 'online' | 'ollama' | 'webllm';
  chat(messages, opts): Promise<string> | AsyncIterable<string>; // 支持流式
  listModels(): Promise<ModelInfo[]>;
  getStatus(): EngineStatus;
}
```
三个实现：`OnlineAPIEngine`（OpenAI 兼容 `/v1/chat/completions`，可配 `baseURL`）、`OllamaEngine`（仅 MVP 后置，`http://localhost:11434/api/chat`）、`WebLLMEngine`（`@mlc-ai/web-llm`，**必须 `CreateWebWorkerMLCEngine` 跑在 Worker 防主线程卡死**）。

### 4.2 模块拆分与集成点
| 能力 | 复用对象 | 备注 |
|---|---|---|
| 选中文本 | `highlight.ts#selectionToAnchor` → `{chapterIndex,blockIndex,startOffset,endOffset,text}` | 划词入口已验证，直接接 |
| 章内/全书文本 | `progress.ts#BLOCK_SELECTOR`、`search.ts#extractBookTexts` | 无需新增解析 |
| 设置持久化 | `settings.ts#loadSettings/saveSettings`（idb-keyval） | AI 字段并入或新增 key；key 明文存、标注风险 |
| 划词链路 | `Reader.tsx` `onMouseUp→openSelectionPopover` | 加 AI 动作，不改选中语义 |
| 侧栏互斥 | `Reader.tsx#togglePanel/closeAllPanels` | AI 面板须遵守「一次只开一个」 |
| 桌面端权限 | `src-tauri` capabilities 放开 `localhost`/`127.0.0.1` | 仅 Ollama 需要 |

### 4.3 桌面端 vs 网页端（关键约束）
| 能力 | 网页版(HTTPS) | 桌面端(Tauri) |
|---|---|---|
| 在线 API | ✅ | ✅ |
| WebLLM | ✅（需 WebGPU） | ✅ |
| Ollama | ❌ 混合内容拦截（`fetch http://localhost` 被当混合内容） | ✅（capability 放开） |

抽象层三引擎都写，但**运行时按环境屏蔽**：网页版禁用 Ollama 选项并给说明，桌面端全开。

---

## 5. 开销（分两类量化；价格标「需核实」）

**表 A：在线 API（划词翻译/解释场景，短输入短输出）**
假设单次输入≈150 tokens、输出≈120 tokens；汇率 1 USD≈7.2 RMB（需核实）。价格取自各厂商公开定价页（2025–2026，需核实）：

| 模型 | 输入 $/1M | 输出 $/1M | 每1000次成本($) | 折合 ¥/1000次 | 月均3000次划词/月 |
|---|---|---|---|---|---|
| GPT-4o-mini | 0.15* | 0.60* | ~0.095 | ~0.68 | ~¥2.0 |
| Claude Haiku 3.5 | 0.80* | 4.00* | ~0.60 | ~4.3 | ~¥12.9 |
| DeepSeek-V3 | ¥2(未命中)/¥0.5(命中)* | ¥8* | ~¥1.26(未命中) | ¥1.26 | ~¥3.8 |
| 通义 Qwen-Plus | ¥0.8* | ¥2* | ~¥0.36 | ¥0.36 | ~¥1.1 |
| 通义 Qwen-Turbo | ¥0.3* | ¥0.6* | ~¥0.12 | ¥0.12 | ~¥0.36 |

> 结论：对单人读者成本极低，瓶颈是**隐私与密钥管理，不是单价**。上全本摘要/RAG 时输入可至数千 token/次，成本线性放大但仍可控。

**表 B：本地方案（一次性 + 持续）**
| 引擎 | 一次性 | 持续 | 体积/资源（需核实） |
|---|---|---|---|
| WebLLM | 模型首启下载 | 无费用；本地 GPU+内存 | Qwen2.5-0.5B~400MB/~0.9GB VRAM；1.5B~940MB–1GB/~1–2GB VRAM；3B~2GB/~3GB VRAM；需 WebGPU；不随包携带，运行时从 MLC CDN 拉 |
| Ollama | 用户自装+拉模型 | 无费用；本机算力 | qwen2.5:1.5b~0.9GB、3b~1.9GB、7b~4.5GB；仅桌面端；分发包不默认捆绑 |

> 结论：本地方案**边际成本=0**（无 API 账单），代价是首下体积 + 设备算力。WebLLM 最契合「零后端零费用」，但小模型(≤1.5B)翻译/解释质量有限；Ollama 质量最佳但强依赖用户环境。

---

## 6. 可行性（逐引擎）

| 引擎 | 技术可行性 | 主要坑点 | 降级方案 |
|---|---|---|---|
| 在线 API | 高（OpenAI 兼容最成熟） | 私密内容出本机→隐私/合规；key 明文；需自备 key | 无 key 时灰显；首用显式知情同意 |
| WebLLM | 中（WebGPU + Worker 化） | WebGPU 兼容性(Safari/iOS 弱)；低端机 VRAM 不足；首下体积；主线程卡顿 | 探测不支持→提示在线/关闭；按设备选 0.5B/1.5B；Worker 防卡 |
| Ollama | 中（桌面端） | 纯 HTTPS 网页混合内容拦截；需 Tauri 放 localhost；用户未必装/拉模型 | 仅桌面开放；探测 `/api/tags` 未运行提示启动；网页直接隐藏 |

**MVP 首接推荐**：WebLLM（隐私默认）+ 在线 API（质量兜底/易联调）双线；Ollama 置 MVP 之后。若只想最快打通「抽象+三引擎切换+设置页」主干，也可先在线 API 一家打通再补 WebLLM/Ollama。

---

## 7. 用户体验（UX）

- **隐私知情同意**：首次切到/用在线引擎，弹一次确认（复用 `.modal-backdrop+.confirm-dialog`），明确「选中文本将发送至 XX」，可勾「本次不再提示」；设置页常驻隐私说明（`.settings-hint--warn` 风格）。
- **首屏引导**：首次进阅读轻提示「选中文字可唤出 AI 解释」（复用 `.restore-hint` 胶囊），不强制。
- **模型下载进度**：WebLLM 首下必须有进度条 + 预估时间 + Wi-Fi 建议（移动端）+ 可取消。
- **低端机降级**：检测 WebGPU/可用 VRAM，不支持时隐藏 WebLLM 引导在线；模型加载失败给明确报错而非白屏。
- **划词顺滑度**：复用 `selectionToAnchor`→浮层，AI 动作内置 `.ann-popover`，不打断选中态；移动端划词与「点中间翻页」手势已隔离，保持。
- **三引擎切换感知成本**：默认引擎在设置选好；运行时当前引擎不可用（在线无 key / WebLLM 不支持）自动回退并 toast 提示，不让用户每次手动选。

**最容易翻车的 6 个 UX 雷区**：
1. WebLLM 首屏无进度/无降级 → 用户以为卡死。
2. 在线引擎静默把私密书内容发第三方 → 隐私翻车（最严重）。
3. 划词浮层与现有选中/高亮逻辑冲突 → 破坏已验证的高亮体验。
4. 三面板（目录/排版/AI）互斥未遵守 → 手机挤爆。
5. key 明文存储无提示 → 安全认知缺口。
6. Ollama 在网页版误开放 → 必然失败且无说明。

---

## 8. 实施路线图（分阶段，MVP 聚焦）

| 阶段 | 目标 | 关键产出 / 文件 | 测试点 |
|---|---|---|---|
| **M1 抽象+设置** | 打通 AIEngine 骨架与设置分节 | `src/lib/ai/engine.ts`、online/ollama/webllm 三实现、设置页 AI 分节、`settings.ts` 扩展 | 抽象层接口单测；设置持久化 |
| **M2 划词+WebLLM** | 划词入口 + 对话侧栏 + 默认 WebLLM | 扩展 `Reader.tsx#openSelectionPopover`、`.ai-panel`/`.ai-popover`、WebLLM Worker 接入 | 划词→解释链路；流式输出；三主题 |
| **M3 在线+同意** | 在线 API 兜底 + 隐私同意 | `OnlineAPIEngine`、密钥存储、同意弹窗、自动回退 | 无 key 灰显；同意流（点在线 pill 即弹框）；回退 toast |
| **M4 打磨** | 降级/可访问性/响应式收尾 | 低端机降级、键盘焦点、动效降级、移动端底抽屉 | 全量测试 + CHANGELOG/README 同步 |
| **后续（非 MVP）** | 扩能力 | Ollama 桥接(桌面)、术语轻追问、智能笔记整理、单章 RAG、跨章/全书摘要、语义检索 | 按小算力友好度递进 |

> 每次改动一个约定式 commit + 配套测试全绿；对外可见改动写 CHANGELOG（用标准小节标题）。

---

## 9. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 在线引擎静默外泄私密书内容 | 高 | 默认本地引擎；在线需显式开启 + 首用知情同意（已接入） |
| 纯 HTTPS 网页混合内容拦截 Ollama | 高 | 网页版隐藏 Ollama；仅桌面端开放 |
| WebGPU 兼容性/低端机 VRAM 不足 | 中 | 探测不支持→提示/引导在线；按设备选 0.5B/1.5B |
| key 明文存储 | 中 | 设置页标注风险；可只在本机使用 |
| WebLLM 首下体积大、主线程卡顿 | 中 | Worker 化；进度条+可取消；不随包携带 |
| 划词与现有高亮/选中逻辑冲突 | 中 | 复用 `selectionToAnchor`，AI 动作不破坏两步入库 |

---

## 10. 质量审查结论（严过审）

| 维度 | 分数 | 一句话 |
|---|---|---|
| 设计哲学 Philosophy | 4/5 | 本地优先/隐私/离线内核贯穿全局 |
| 视觉层次 Hierarchy | 4/5 | 正文主体、AI 侧栏次级、浮层情境态、弹窗顶层，权重合理 |
| 执行质量 Execution | 4/5 | 令牌严格对齐规范，响应式可用，无破窗 |
| 特异性 Specificity | 4/5 | 明确是「阅读器内的 AI」而非通用聊天 UI |
| 克制 Restraint | 5/5 | 单色+单一 accent，零渐变/玻璃拟态/emoji |
| **总分** | **21/25** | **PASS，可进入导出** |

- **Anti-Slop 门控**：✅ 通过（无平铺、无渐变/玻璃拟态、无风格割裂、无过度设计、移动端可用）。
- **P1 修复**：隐私复选框假控件、部分控件缺 `focus-visible`、缺动效降级、弹窗阴影不一致、color-mix 回退——已全数修复并复检 6 项断言 PASS。
- **复检回归**：点「在线 API」pill 时 `currentEngine` 仍滞 `'local'` 导致同意框推迟——已修（`ensureConsent(cb, targetEngine)` + pill 传 `'api'`），选在线即弹同意框。

---

## 11. 下一步 / 待主上大人提供

1. **是否直接进入开发**：本方案与 `ai-feature-plan.md` 已对齐，待主上大人给开发指令即可按 M1→M4 落地。
2. **在线 API key**（可选）：若想体验在线兜底，准备一个 OpenAI 兼容 key（settings 页填，明文存本机）。
3. **WebLLM 模型加载带宽**：首启需下载约 0.4–1GB（1.5B 量级），确认用户对首次下载体积可接受。
4. **Ollama 优先级**：当前置 MVP 之后；若主上大人本机已部署 Qwen/Gemma 且主要在桌面端用，可提前到 M3 并入。
