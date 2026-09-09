# GitFiles Workers 架构规格

## 1. 产品与边界

GitFiles 是一个 Android 优先的 PWA 文件管理器：用户通过 GitHub 授权访问自己有权限的 Repository，并以 Git 数据模型安全地浏览、创建、修改、移动、复制和删除文件。

核心原则：

```text
数据正确性 > 一致性 > 并发安全 > 权限安全 > UI 便利性
```

GitHub Repository 是文件系统；Cloudflare Worker 是唯一可信 API 边界；浏览器只显示状态和请求同源 API，绝不持有 GitHub access token。

## 2. 部署架构

```text
Browser / Android PWA
        │ same-origin HTTPS
        ▼
Cloudflare Worker + Static Assets
        │        │
        │        ├── D1: sessions / repository_access
        │        └── GitHub OAuth + GitHub Git Data API
        ▼
Blob / Tree / Commit / Ref
```

- 部署产品为 **Cloudflare Workers + Static Assets**，不使用 Cloudflare Pages 或 Pages Functions。
- `workers/entry.js` 是唯一 HTTP 入口；静态资源由 `env.ASSETS.fetch()` 返回。
- D1 binding 名称固定为 `DB`，schema 位于 `workers/schema.sql`。
- `/api/*` 永不由 Service Worker 缓存。
- GitHub API host 必须固定为 `https://api.github.com`，Worker 不是任意 URL proxy。

## 3. 会话、认证与授权

### 3.1 OAuth

1. 浏览器使用 PKCE 跳转 GitHub OAuth。
2. 回调把 `code` 交给同源 `POST /api/github/oauth/token`。
3. Worker 使用 `GITHUB_CLIENT_SECRET` 交换 code。
4. Worker 获取 GitHub 用户和可访问仓库，写入 D1 session 与 ACL。
5. Worker 返回 HttpOnly Cookie，不返回 access token。

Cookie 必须为：

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

禁止把 GitHub token 写入：

```text
localStorage
sessionStorage
IndexedDB
window
DOM attribute
URL/hash
```

### 3.2 D1 数据

最低表结构：

```text
sessions(id, github_login, access_token, expires_at, created_at)
repository_access(session_id, owner, repo, can_read, can_write)
```

`workers/schema.sql` 是初始化来源。生产部署必须执行 migration；未绑定 D1 时 Worker 返回 `503 service_unavailable`，不得回退到浏览器 token 模式。

### 3.3 授权

每个仓库请求必须按顺序完成：

```text
Cookie session → D1 session → repository_access → GitHub request
```

浏览器请求中的 `owner`、`repo`、`branch`、操作列表不是授权依据。写操作还必须满足 `can_write=1` 和同源 Origin 校验。

## 4. API 契约

所有 API 返回 JSON，除文件字节流外使用统一错误结构：

```json
{
  "error": "conflict",
  "message": "Branch HEAD changed before the operation started",
  "details": {}
}
```

状态码：

| 状态 | 含义 |
|---|---|
| 401 | 缺少或过期 session |
| 403 | 非同源请求或无仓库权限 |
| 404 | 路由、仓库、分支或文件不存在 |
| 409 | CAS 或初始 ref 创建冲突 |
| 422 | 输入或操作校验失败 |
| 429 | GitHub rate limit |
| 500 | Worker 内部错误 |
| 502 | GitHub 上游不可用 |
| 503 | D1 或必需 Worker 配置缺失 |

当前路由：

```text
POST /api/github/oauth/token
POST /api/logout
GET  /api/me
GET  /api/repos
POST /api/repos
GET  /api/repos/:owner/:repo
GET  /api/repos/:owner/:repo/branches
GET  /api/repos/:owner/:repo/tree?branch=main
GET  /api/repos/:owner/:repo/file?branch=main&path=docs/a.md
GET  /api/repos/:owner/:repo/history?branch=main
POST /api/repos/:owner/:repo/operations
```

`POST /api/repos` 仅在用户明确确认后创建私有初始化仓库，并把返回仓库写入当前 session ACL。登录本身绝不创建 `Drive-N` 或其他仓库。

## 5. Git Data Mutation Pipeline

所有写操作必须由 Worker 执行：

```text
Request
↓
Authenticate + authorize
↓
Read remote branch HEAD
↓
Compare expectedHead
↓
Read recursive Tree
↓
Apply operations in memory
↓
Create only required Blobs
↓
Create one Tree
↓
Create one Commit
↓
Non-force ref update
↓
Return new HEAD
```

若远端 `currentHead !== expectedHead`，返回 `409`，禁止静默覆盖。

### 5.1 操作模型

支持：

```text
create, update, upload, mkdir, delete, rename, move, copy
```

- 所有 path 必须拒绝空路径段、`.`、`..`、NUL、绝对路径歧义。
- `mkdir` 生成 `folder/.keep`；UI 默认隐藏 `.keep`。
- delete 删除 path 本身及所有 descendants。
- rename/move：删除旧 path，使用原 blob SHA 写入新 path。
- copy：新 path 复用原 blob SHA；禁止下载再上传。
- 一个逻辑批次尽量只创建一个 Tree、一个 Commit、一次 ref 更新。
- 无变化操作不得创建 Commit。

### 5.2 空仓库

空分支写入的 `expectedHead` 必须是 `null`：

```text
Create Blob(s) → Create Tree → Create Commit(parents=[]) → POST refs
```

并发初始 ref 创建返回 `409 Conflict`。不能在创建 ref 后再次 PATCH 同一 ref。

### 5.3 网络不确定性

提交请求网络中断不等于提交失败。客户端必须刷新 branch/tree 后确认真实 HEAD，再显示结果；不得假成功或假失败。

## 6. 冲突中心

冲突是正常状态，不是普通 toast。状态至少为：

```text
Clean, Dirty, Committing, Conflict, Error, Offline
```

Conflict Center 必须保存并展示：

```text
repository
branch
expectedHead
remoteHead
operation summary
affected paths
timestamp
```

当前 UI 支持冲突记录和“重新加载远端状态”。后续必须增加逐文件 diff、文本三方合并、显式覆盖和可恢复跨仓库转移状态；默认禁止覆盖远端。

## 7. 前端与 UI

- 前端只调用同源 `GithubApi`，不得向 GitHub API 发送 `Authorization` header。
- 浏览器只保留 `github-paths.js` 的纯路径工具；GitHub API/token/Git Data engine 必须只在 Worker。
- 登录只建立 Worker session；“Add Repository”先列出可写 ACL 仓库，用户选择后挂载。
- 新建仓库是独立确认动作。
- 顶栏显示 Worker session：checking / active / sign-in required / unavailable。
- CAS 冲突在顶栏显示 Conflict Center 入口。
- UI 使用高密度、低圆角、低阴影的文件管理器风格，不做营销落地页。

### 7.1 Android / 移动端

必须提供：

```text
Top navigation
Scrollable breadcrumb
Sidebar drawer
44px+ touch targets
Long press / item menu
Multi-select
Bottom-sheet dialogs
Android file picker
```

移动端不能仅以 `width: 100%` 缩放桌面布局。长 session 标签可隐藏，但会话异常与冲突必须保留可操作入口。

## 8. PWA、安全与内容

PWA 保留 manifest、icons、standalone display 与 service worker。缓存 HTML/CSS/JS/icons/manifest；`/api/*` 不缓存。离线时写操作必须显示 Offline/Error，不能报告已提交。

禁止将文件名、文件内容、GitHub API 返回、Markdown 或 SVG 直接写入不可信 `innerHTML`。Markdown 预览需过滤 script、event handler、`javascript:`、iframe 与 SVG script。

## 9. 跨仓库语义

同仓库操作可原子化为一个 Git commit。跨 GitHub repository 无法由 Git 提供一个原子 commit：

```text
Copy: destination commit
Move: destination commit → recorded transfer state → source delete commit
```

跨仓库 Move 必须可恢复，失败时不能报告成功；需要提供 retry、cleanup 或 compensation UI。不得宣称它是单事务原子操作。

## 10. 部署要求

1. 创建 Worker，使用根目录 `wrangler.jsonc`。
2. 构建命令：`node scripts/build-config.mjs`。
3. 创建 D1 数据库，将 database id 作为 `DB` binding 配到 Worker。
4. 执行 `workers/schema.sql`。
5. 配置 runtime secret `GITHUB_CLIENT_SECRET`。
6. 配置 build text variable `CONFIG_GITHUB_CLIENT_ID`，可选 `CONFIG_BASE_PATH`。
7. 在 GitHub OAuth App 注册 Worker 的 `/github-oauth-callback.html`。
8. 用 HTTPS Worker 域名验证 Cookie 与 `/api/me`。

GitHub Pages、独立 token proxy、PAT 浏览器 fallback 不属于受支持的安全部署模式。

## 11. PWA 验收要求

- HTTPS 或 localhost 环境下可安装为独立应用。
- 首次联网打开后，断网仍可加载应用壳并使用本地存储。
- Service Worker 更新后自动清理旧缓存并刷新页面。
- `/api/*`、GitHub OAuth 和文件请求不进入缓存；离线时不得显示虚假的 GitHub 操作成功。
- Android Chrome 的添加到主屏幕流程、图标、主题色和安全区域适配应可用。

## 12. 测试要求

必须覆盖：

- 文件 create/update/delete/rename/move/copy。
- 目录 mkdir/delete/move/copy/nested。
- batch: 10、100、混合、顺序语义。
- Move/Copy 的 blob SHA 复用；batch 单 commit。
- 正常 CAS、stale expectedHead、non-fast-forward、空仓库首次 ref、并发首次 ref。
- 未配置 D1、无 cookie、无 ACL、跨站 mutation、OAuth token 不泄漏。
- Worker API 的 401/403/404/409/422/429 分类。
- PWA `/api/*` 不缓存，以及移动端关键触达流程。

当前 Node 测试：

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs
```

## 12. 当前状态与后续

已实现：Workers static assets、D1 session/ACL 基础、HttpOnly session cookie、同源 repo API、Worker Git Data mutation、CAS、空仓库首次写入、前端同源 API、session 状态条、基础 Conflict Center。

待完成：GitHub App installation token 替代 OAuth user token、session 轮换与清理任务、文本三方合并、跨仓库转移恢复、完整内容预览安全审计、真实 D1/Worker 端到端部署测试。
