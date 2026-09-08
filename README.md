<div align="center">

# GitFiles

**把 GitHub 仓库当作云端文件系统的 Web 文件管理器（PWA）**

[![Live Demo](https://img.shields.io/badge/在线体验-GitHub%20Pages-0969da?logo=github)](https://mbaigc.github.io/GitFiles/)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MbAIGC/GitFiles)
[![Tests](https://img.shields.io/badge/测试-32%20通过-2da44e)](tests/github-engine.test.mjs)
[![Upstream](https://img.shields.io/badge/上游-fi3ik--mme%2Fstorage--hub-8b949e)](https://github.com/fi3ik-mme/storage-hub)

*基于 [Storage Hub](https://github.com/fi3ik-mme/storage-hub) 深度改造 · 本 fork 仅推送到 origin，禁止向上游提 PR*

[English](README_EN.md) · 简体中文

</div>

---

## 项目简介

GitFiles 是一个纯前端的多云盘文件管理器（PWA）。它把 **GitHub 仓库当作可靠的云端文件系统**：浏览目录、上传下载、新建/重命名/移动/复制/删除、批量操作，全部直接落在 Git 上 —— **一次逻辑操作 = 一个 Commit**，Git History 干净可审计。

本项目 fork 自 `fi3ik-mme/storage-hub`，并按 [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) 完成了 GitHub 写入引擎的整体重构：弃用 Contents API 逐文件读写，改为围绕 **Blob / Tree / Commit / Ref** 的 Git Data API 引擎，并引入 CAS 并发控制。

## ✨ 功能特性

### 三种存储后端
| 后端 | 说明 |
|------|------|
| **GitHub 仓库** | 登录 GitHub 后自动创建/挂载私有 `Drive-N` 仓库作为文件存储，走 Git Data API |
| **Google Drive** | Google 多账号登录，浏览/新建/编辑/删除/复制 |
| **本地存储** | 浏览器内 IndexedDB 卷，支持回收站 |

### 文件管理
- Windows 风格资源管理器：目录树、面包屑、网格/列表视图、右键菜单
- 跨盘剪切/复制/粘贴、回收站（本地存储）、内置记事本（`.txt` / `.json`）
- 路径式 URL 深链（如 `/GitFiles/Drive-1/My%20Drive/notes.txt`）
- 移动端布局（抽屉导航）、PWA 离线外壳缓存（Service Worker）

### Git Data 引擎（本 fork 核心）
- **Move / Rename**：Tree path 重写，**复用原 Blob SHA** —— 不再“下载→上传→删除”
- **Copy**：Tree 条目直接复用 Blob SHA，目录复制**一个 Commit**，零重复上传
- **Delete**：文件或整个目录子树 = **1 Tree + 1 Commit**（不再逐文件调用 Contents DELETE）
- **批量操作**：同盘多选移动/复制合并为**单个 Commit**（`GithubDisk.executeBatch`）
- **CAS 并发控制**：分支引用以非 force 方式更新，提交间隙远端 HEAD 变化 → `ConflictError`（409 语义），UI 弹出冲突对话框，**绝不静默覆盖**
- **TreeIndex 缓存**：键为 `owner/repo/branch/head`，HEAD 变化自动失效
- **Service Worker 不缓存 `/api/*`**，离线不会假装提交成功

## 🚀 快速开始

```bash
git clone https://github.com/MbAIGC/GitFiles.git
cd GitFiles
python3 serve.py          # 内置 OAuth token 代理 + SPA 回退
# 打开 http://localhost:8080
```

> 侧边栏 **Add storage → GitHub repo** 即可连接 GitHub 存储；Google Drive / 本地存储开箱即用。

### GitHub 登录配置

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. 填写回调地址（必须与实际部署地址**完全一致**）：

| 环境 | Authorization callback URL |
|------|----------------------------|
| 本地开发 | `http://localhost:8080/github-oauth-callback.html` |
| GitHub Pages | `https://mbaigc.github.io/GitFiles/github-oauth-callback.html` |
| Cloudflare Pages | `https://<你的项目名>.pages.dev/github-oauth-callback.html` |

3. 将 **Client ID** 填入 `js/config.js` → `GITHUB_CLIENT_ID`

<details>
<summary>遇到 <code>redirect_uri is not associated with this application</code>？</summary>

在应用页面浏览器控制台执行 `GithubDisk.getOAuthRedirectUri()`，把输出的 URL **逐字符**复制到 GitHub OAuth App 的回调地址中再重试。
</details>

<details>
<summary>使用个人令牌（PAT）登录</summary>

应用支持 **PAT 模式**（OAuth 代理不可用时的兜底）：经典令牌 `ghp_…` + `repo` 权限。IDE 内置预览（端口 63342）无法运行代理，会自动引导使用 PAT。
</details>

## ☁️ 部署

### 方式一：一键部署到 Cloudflare Pages（推荐）

点击上方 **Deploy to Cloudflare** 按钮，按向导完成即可。仓库已内置：

- `wrangler.jsonc` —— Pages 配置（纯静态、无构建、`404.html` 兜底）
- `functions/api/github/oauth/token.js` —— OAuth token 交换 Pages Function（`/api/github/oauth/token`）

部署后在 Pages 项目设置中添加 secret，即可启用网页版 GitHub 登录：

```bash
npx wrangler pages secret put GITHUB_CLIENT_SECRET   # GitHub OAuth App 的 client secret
```

前端无需改代码：同源 Pages Function 自动生效（也可在 `js/config.js` 中用 `GITHUB_TOKEN_EXCHANGE_URL` 指向任意代理）。

### 方式二：GitHub Pages

推送 `main` 分支后，仓库内置的 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 会自动发布。SPA 所需文件已就绪：`404.html`（回退）、`.nojekyll`、`sw.js`、`js/base-path.js`（自动识别 `/仓库名` 前缀）。

> GitHub Pages 是纯静态托管，没有服务端代理。需按下一节部署 token 代理，或使用 PAT 登录。

### OAuth token 代理（三种方式）

GitHub 的 token 端点禁止浏览器直连（CORS），交换授权码需要服务端代理：

| 方式 | 适用场景 | 配置 |
|------|----------|------|
| **Pages Function**（本仓库内置） | Cloudflare Pages | 部署即用，配置 `GITHUB_CLIENT_SECRET` 即可 |
| **独立 Worker**（`workers/github-oauth-token.js`） | GitHub Pages 等静态托管 | 手动创建 Worker，`GITHUB_TOKEN_EXCHANGE_URL` 指向它 |
| **serve.py 内置代理** | 本地开发 | 零配置，密钥放 `.github_secret` 文件（勿提交） |

## 🧪 测试

```bash
node tests/github-engine.test.mjs
# 32 passed, 0 failed
```

覆盖 PROJECT_SPEC §24 核心要求：

- 文件：create / update / delete / rename / move / copy
- 目录：mkdir / 删除 / 移动 / 复制 / 多层嵌套
- 批量：10 文件、100 文件、混合操作（含批内顺序语义与 Blob 去重共享）
- Git 正确性：**Move 复用 Blob SHA、Copy 零上传、一批一 Commit**
- 并发：非 force 更新远端 HEAD 变化 → `ConflictError`（409），绝不静默覆盖

## 🏗️ 架构

```text
┌────────────────────────────────────────────┐
│      浏览器 / Android PWA（原生 JS）        │
│  资源管理器 · 记事本 · 冲突对话框 · SW 缓存 │
└───────────────────┬────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  Google Drive API        js/github/（Git Data 引擎）
  localdisk（IndexedDB）        │
                     Blob → Tree → Commit → Ref
                              │
                              ▼
                       GitHub Git Data API
```

`js/github/` 模块职责：

| 模块 | 职责 |
|------|------|
| `client.js` | 请求层：认证 / 限流重试 / 错误标准化 / 409 分类 |
| `repository.js` | 仓库、分支状态、用户读取 |
| `reference.js` | 分支 HEAD 读取 + CAS 引用更新（`ConflictError`） |
| `tree.js` | 递归 Tree 读取，TreeIndex 按 `owner/repo/branch/head` 缓存 |
| `blob.js` | Blob 创建 / 复用（空 Blob 复用知名 SHA） |
| `commit.js` | Tree + Commit 创建 |
| `operations.js` | 严格顺序语义的操作规划器 + Mutation Pipeline + 互斥队列 |

## 📁 目录结构

```text
├── index.html                  # 主资源管理器
├── notepad.html                # 独立记事本
├── github-oauth-callback.html  # GitHub OAuth 弹窗回调
├── 404.html                    # SPA 回退（GitHub Pages）
├── sw.js                       # Service Worker（不缓存 /api/*）
├── manifest.webmanifest        # PWA manifest
├── css/style.css
├── js/
│   ├── github/                 # ★ Git Data 引擎（本 fork 新增）
│   │   ├── client.js
│   │   ├── repository.js
│   │   ├── reference.js
│   │   ├── tree.js
│   │   ├── blob.js
│   │   ├── commit.js
│   │   └── operations.js
│   ├── githubdisk.js           # GitHub 存储后端（已接入引擎）
│   ├── auth.js / drive.js      # Google 登录与 Drive API
│   ├── localdisk.js            # 本地存储后端
│   ├── app.js / contextmenu.js / router.js / notepad.js
│   └── config.js / site-config.js / base-path.js
├── functions/api/github/oauth/token.js   # ★ Pages Function（token 代理）
├── workers/github-oauth-token.js         # 独立 Worker 版 token 代理
├── wrangler.jsonc                        # ★ Cloudflare Pages 配置
├── tests/github-engine.test.mjs          # ★ 引擎测试套件
├── docs/                                 # 项目规格 + 改造记录（中文）
├── serve.py                              # 本地开发服务器（含 token 代理）
└── .github/workflows/pages.yml           # GitHub Pages 自动部署
```

## 📊 与上游的主要差异

| 方面 | 上游 storage-hub | 本 fork |
|------|------------------|---------|
| GitHub 写操作 | Contents API 逐文件 PUT/DELETE | Git Data API（Blob/Tree/Commit/Ref） |
| Move/Rename | 下载→上传→删除 | Tree path 重写，复用 Blob SHA |
| Copy | 重新上传内容 | 复用 Blob SHA，零上传 |
| 目录删除 | 每个文件一次 API 调用 + N 个 Commit | 1 Tree + 1 Commit |
| 批量操作 | 逐项循环，每项一个 Commit | 同盘批量合并为 1 Commit |
| 并发控制 | 无（可静默覆盖远端） | CAS：非 force 更新，冲突弹窗，409 语义 |
| 目录列表缓存 | 按磁盘缓存（易过期） | 按 `owner/repo/branch/head` 缓存 |
| token 代理 | 需手动部署 Worker | Pages Function 内置 + 一键部署 |

## 📝 文档

- [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) —— 改造目标规格（架构、CAS、API、测试要求）
- [`docs/改造记录-*.md`](docs/) —— 每次代码改动的中文记录（命名：`改造记录-YYYYMMDD-主题.md`）
- [`AGENTS.md`](AGENTS.md) —— AI 协作规范（含文档与提交规范）

## ⚠️ 已知限制

- GitHub 单文件上限 **100 MB**；目录列表单层 **1000** 项（Contents API 限制）
- GitHub 访问令牌仍由旧 PAT/OAuth 流程保存在浏览器 `localStorage` —— 目标架构（GitHub App + Pages Functions + D1 会话 + HttpOnly Cookie）尚未实现，见 PROJECT_SPEC
- Conflict Center 目前为对话框级（应用最新远端状态 / 取消），暂无 diff/merge 视图
- GitHub 与 Google/本地存储之间的跨盘复制尚不完整（同盘内完整支持）

## 🙏 致谢

基于 [Mykhailo Mikus](https://github.com/fi3ik-mme) 的 [Storage Hub](https://github.com/fi3ik-mme/storage-hub) 改造而成。应用与 Google LLC、GitHub 无隶属关系；OAuth 描述文案见 [`README_EN.md`](README_EN.md)。
