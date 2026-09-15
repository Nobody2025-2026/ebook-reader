# AI 功能开发规划（阅读器）

> 状态：**规划文档**，功能实现待主上大人开发指令。最后更新 2026-09-15。

## 1. 背景与目标

阅读器当前是**零后端、本地优先**架构（IndexedDB 存储 + 离线可用、数据不出本机）。后续拟加入 AI 能力，按两条互补路线设计：

- **在线 API**：调用云端大模型，算力最强、零本机负担，但需联网且涉及内容出本机。
- **本地部署**：数据不出本机、离线可用、零费用，与阅读器既有的隐私/离线基因天然契合。

目标：让用户按场景在「在线 / 本地」间自由切换，业务代码通过统一接口调用，无需感知背后引擎。

## 2. 总体架构：统一 `AIEngine` 抽象

定义统一的 `AIEngine` 接口（建议落地于 `src/lib/ai/engine.ts`）：

- `chat(messages, opts): Promise<string>`（或 streaming 变体）
- `listModels(): Promise<ModelInfo[]>`
- 元信息：`id`、`label`、`kind: 'online' | 'ollama' | 'webllm'`

三个实现：

| 引擎 | 实现 | 适用 |
|---|---|---|
| `OnlineAPIEngine` | OpenAI 兼容 `/v1/chat/completions`（可配 `baseURL`，兼容各家） | 最强模型、零本机算力 |
| `OllamaEngine` | 直连 `http://localhost:11434/api/chat` | 复用本机已部署 Qwen/Gemma，效果好 |
| `WebLLMEngine` | `@mlc-ai/web-llm`（WebGPU，浏览器内） | 纯前端、零外部依赖、真离线 |

**设置页（Settings）**让用户选择默认引擎，并填在线 key / 选定本地模型。key 存于本地设置（IndexedDB 或 localStorage），明文存储但标注隐私风险。

## 3. 功能优先级排序（按「本地小算力模型友好度」）

> 本地小算力指 WebLLM 1.5–3B、Ollama 3–7B 量级。排序由高到低：小模型擅长短输入短输出，长 context / 重推理 / 需 embedding 的往后放。

| # | 功能 | 小算力友好度 | 说明（小模型视角） | 三引擎适配 |
|---|---|---|---|---|
| 1 | **划词翻译 / 解释 / 短摘要** | ★★★★★ | 输入=单句到一段、输出短，1.5–3B 即胜任 | 在线 / Ollama / WebLLM 全兼容 |
| 2 | **术语解释 / 划词轻追问** | ★★★★★ | 单轮短 context，同上 | 三引擎全兼容 |
| 3 | **智能笔记整理**（分批喂） | ★★★★ | 数条高亮/笔记一批批喂小模型能归纳；量超大时自动降级大模型 | 在线 / Ollama 优先，WebLLM 限短批 |
| 4 | **单章级 RAG 问答**（「这章讲了啥」） | ★★★ | 单章几千字拼 context，3–7B + 4–8k 窗口勉强答章内问题；跨章易丢信息 | Ollama 7B+ / 在线；WebLLM 吃力 |
| 5 | **跨章 / 全书摘要 · 长文归纳** | ★★ | 需 chunk + 多轮归纳，小模型易失全局且慢 | 在线 / Ollama 大模型 |
| 6 | **语义全文检索**（embedding） | ★ | 需本地 embedding 模型 + 向量索引（IndexedDB），工程最重、小模型精度有限 | 在线 API embedding / Ollama embedding |

**MVP 建议 = #1 划词翻译 / 解释**：三引擎全兼容，能一次性打通 `AIEngine` 抽象 + 三引擎切换 + 设置页主干，且对最小算力的 WebLLM 也友好——正合「先看小算力友好度」的诉求。

## 4. 三引擎落地要点

### 4.1 在线 API
- 协议：OpenAI 兼容（`chat/completions`，stream 可选）。
- key 存本地设置；首次调用前校验非空并提示。
- 风险：阅读内容可能含用户私密文本，须明确告知「将发送至第三方」并获知情同意。

### 4.2 本地 Ollama 桥接
- 端点：`http://localhost:11434/api/chat`（或 `/api/generate`）。
- 复用本机已部署的 Qwen / Gemma 等模型，模型任选、效果最好。
- **Tauri 需放开 localhost 网络权限**：在 `src-tauri` 的 capabilities 增加 `http://localhost`、`http://127.0.0.1`（当前 `csp: null` 已宽松，但仍需 capability 授权）。
- 混合内容限制：纯 HTTPS 网页版 `fetch http://localhost` 会被浏览器当作混合内容拦截。**建议仅在桌面端（Tauri，加载 `tauri://` 或本地文件）启用 Ollama 桥接**；纯网页版只开放在线 / WebLLM。
- 需探测 Ollama 是否在跑（`/api/tags`），未运行则提示用户启动。

### 4.3 浏览器内 WebLLM
- 库：`@mlc-ai/web-llm`，依赖 WebGPU。
- 模型：预量化小模型（如 Qwen2.5-1.5B/3B-Instruct 的 web 格式），首次需下载数百 MB ~ 1GB，须有进度提示。
- 内存占用较高，低端设备需降级提示。
- 完全离线、零外部依赖，最契合隐私定位。

## 5. 与现有架构的集成点

- **设置页**：新增「AI」分节（引擎选择、在线 key、本地模型选择）。
- **存储**：key / 配置走现有 settings store（`idb-keyval`）。
- **划词交互**：复用现有选中文本机制（高亮 / 选词链路），新增「AI 解释 / 翻译」入口（弹层或侧栏）。
- **阅读内容获取**：现有块锚点（`chapterIndex` + `blockIndex`）可直接取章内文本喂模型，无需新增解析。
- **Tauri 权限**：仅桌面端补 capabilities 允许 localhost。

## 6. 风险与备注

- 在线 API 隐私：私密书籍内容经第三方，须用户知情同意。
- WebLLM 模型体积与内存：低端机可能不可用，需优雅降级。
- Ollama 依赖本机服务：分发出去的安装包用户需自备，或后续评估随包携带。
- 混合内容限制：纯 HTTPS 网页版无法桥接本机 Ollama，仅桌面端启用。

## 7. 待办（等待主上大人开发指令）

- [ ] 确认 MVP 范围（默认 #1 划词翻译 / 解释）
- [ ] 起 `AIEngine` 抽象 + 三引擎适配骨架
- [ ] 设置页 AI 分节
- [ ] 划词 AI 入口 UI
- [ ] 各引擎连通验证（优先 Ollama 桥接）
- [ ] 测试与 CHANGELOG / README 同步

---

*本文档仅规划，不实现代码。具体落地以主上大人的开发指令为准。*
