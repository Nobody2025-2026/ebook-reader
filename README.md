# 自制阅读器（ebook-reader）

一个让人能舒服地读完一本 EPUB 的本地阅读器。**纯前端、零后端、数据全存你浏览器里**，拖进去就能读，不需要注册、不需要联网。

> 网页版：打开链接即用，无需安装。桌面版：已打包成独立 macOS App，去 [Releases](https://github.com/Nobody2025-2026/ebook-reader/releases) 下载。

## 📦 下载：网页版 or 桌面版

本项目提供两种使用方式，按你喜好任选，**两者数据互不相通、各自独立**：

| 方式 | 适合谁 | 怎么用 |
|---|---|---|
| **网页版** | 不想安装、随手就读 | 直接打开 GitHub Pages 链接：[https://nobody2025-2026.github.io/ebook-reader/](https://nobody2025-2026.github.io/ebook-reader/) |
| **桌面版** | 想要独立 App、离线常驻 | 去 [Releases](https://github.com/Nobody2025-2026/ebook-reader/releases) 下载 `.dmg`，拖进「应用程序」文件夹即可 |

> ⚠️ 网页版与桌面版是两个独立的本地书库（浏览器的 IndexedDB 与 App 的 WebView 存储各自隔离），在其中一边导入的书不会自动出现在另一边。

### 桌面版关于「未签名」的说明

桌面版目前**未做 Apple 开发者签名与公证**（个人项目，避免年费与复杂流程）。首次打开时 macOS 会弹出「无法验证开发者」的 Gatekeeper 提示，这属于正常现象，按以下方式打开即可：

1. 在「访达」中**右键（或 Control + 点击）**该 App → 选择「打开」；
2. 在弹出的确认框中再次点击「打开」；
3. 之后即可正常启动。

也可在「系统设置 → 隐私与安全性」中，看到被拦截提示后点「仍要打开」。

如果以上两种方式都找不到「仍要打开」按钮，可在终端执行（需 App 已拖入「应用程序」文件夹）：

```bash
xattr -cr /Applications/ebook-reader.app
```

> 与网页版一样：书、进度、封面全部存在你本机，不上传任何服务器。

## ✨ 功能

- **导入书籍**：拖拽或文件选择，支持 EPUB（TXT 顺带）
- **书库页**：封面网格、书名作者、阅读进度百分比、自动补封面
- **阅读视图**：正文渲染、图片内联、连续滚动
- **目录导航**：侧边目录树，点击跳转章节（含章内锚点跳转）
- **排版调节**：字号、行距、页边距、7 种中文字体、三套主题（日间 / 护眼 / 夜间）
- **进度记忆**：按字数加权计算的阅读百分比，自动保存，重开回到原处
- **键盘操作**：`←`/`→` 滚动、`空格` 翻屏、`Home` 回开头

## 🚀 快速开始

### 环境要求

- Node.js 18+（推荐 22）

### 本地运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

然后打开终端提示的地址（默认 `http://localhost:5173/`）。

> ⚠️ 数据按「域名 + 端口」隔离存储。换端口 = 换了一个空书库。固定用同一个端口，书和进度才一直在。

### 构建

```bash
npm run build      # 类型检查 + 产出 dist/
npm run preview    # 本地预览构建产物
```

### 测试

```bash
npm test           # 跑完整测试套件
npm run test:watch # 监听模式
```

## 🧱 技术栈

| 项 | 选择 |
|---|---|
| 框架 | Vite + React 19 + TypeScript |
| EPUB 解析 | `@lingo-reader/epub-parser` |
| 存储 | IndexedDB（`idb-keyval`），存书文件 + 进度 |
| 状态管理 | zustand |
| 测试 | Vitest + Testing Library |
| 解压 | fflate（字数加权进度用）|

## 📁 项目结构

```
src/
├── components/   # Library（书库）、Reader（阅读视图）
├── lib/          # epub 解析、封面提取、进度、排版、存储、路由等
├── App.tsx       # 顶层路由 + 书库/阅读切换
└── main.tsx      # 入口
docs/             # PRD 等文档
tests/            # 测试
```

## 🤝 使用与授权

- 本项目采用 [MIT 许可证](LICENSE)，可自由使用、修改、分发。
- 数据（书、进度、封面）全部存在你的浏览器本地 IndexedDB，不上传任何服务器。

## 🗺️ 路线图

- [x] P0 MVP：导入 / 书库 / 阅读 / 目录 / 排版 / 进度 / 键盘
- [x] 网页版部署（GitHub Pages）
- [x] 桌面版（Tauri 打包，macOS）
- [ ] P1：高亮与笔记、书签、全文搜索、阅读时长统计
