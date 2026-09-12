# GitFiles Workers 架构规格

## 1. 产品与边界

GitFiles 是一个 Android 优先的 PWA 文件管理器：用户通过 GitHub 授权访问自己有权限的 Repository，并以 Git 数据模型安全地浏览、上传、创建目录、创建、修改、重命名、移动、复制和删除文件。

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

> **当前实现使用 OAuth user token，scope 为 `repo`。**
> 目标（尚未实现）是 GitHub App + installation token，
> 以获得细粒度仓库授权并替代全量 `repo` scope。见状态总览 P-02。

1. 浏览器在**弹窗**中跳转 GitHub OAuth（PKCE：`code_challenge` / `code_verifier`，
   verifier 只存在于内存，不落盘）。
2. GitHub 回调到同源 `/github-oauth-callback.html`，该页把 `code` 交给
   同源 `POST /api/github/oauth/token`。
3. Worker 使用 `GITHUB_CLIENT_SECRET` 交换 code（前端传入的
   `client_secret` 会被显式剥离，服务端只用自己的）。
4. Worker 只获取 **GitHub 用户资料**并写入 D1 session。
   **仓库 ACL 是懒加载的**：登录本身不枚举仓库，直到需要时才按仓库校验并落库。
5. Worker 返回 HttpOnly Cookie，不返回 access token。

Cookie：

```text
HttpOnly; SameSite=Lax; Path=/;  Secure（仅 HTTPS）; Max-Age=7 天
```

> `Secure` 在本地 http 开发时不加（`cookieAttributes()` 按协议判断），
> 生产 HTTPS 下必然存在。

回调页交付 `code` 时必须校验投递目标：只允许本页 origin 与 `CONFIG` 中
显式配置的 origin，**不信任 `state` 中携带的任意 origin**。

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
sessions(id, github_login, github_avatar, access_token, expires_at, created_at)
repository_access(session_id, owner, repo, can_read, can_write, checked_at)
```

- `github_avatar` 供顶栏账户菜单显示真实头像；旧行可为 NULL，
  `/api/me` 会退回按 login 推导的头像 URL。
- `checked_at` 是 ACL 最近一次回源 GitHub 校验的时间。
  读操作 TTL 5 分钟；**写操作 TTL=0（每次强制重校）**，因此撤权能立即生效。
  `NULL` 视为过期。

`workers/schema.sql` 是初始化来源，且**幂等**（DROP + CREATE，可重复执行）。
重建表会清空 session，用户需重新登录一次。

> 已有生产库只想补列时，不要跑整个 schema（会清空 session），
> 改用单条 `ALTER TABLE repository_access ADD COLUMN checked_at INTEGER;`。
> 执行方式见 README「部署」章节（wrangler CLI 必须带 `--remote`，或用 Dashboard 控制台）。

未绑定 D1 时 Worker 返回 `503 service_unavailable`，不得回退到浏览器 token 模式。

### 3.3 授权

每个仓库请求必须按顺序完成：

```text
Cookie session → D1 session → repository_access → GitHub request
```

浏览器请求中的 `owner`、`repo`、`branch`、操作列表不是授权依据。写操作还必须满足 `can_write=1` 和同源 Origin 校验。

ACL 未命中或已过期时，Worker 用 session 的 token 回源 GitHub 校验该仓库并落库。
若该仓库对当前 session **不可见**（GitHub 返回 404），必须映射为 **403**，
而不是 404——不得借此确认某个私有仓库是否存在。

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
| 403 | 非同源请求、无仓库权限，或该仓库对当前 session 不可见 |
| 404 | 路由、仓库、分支或文件不存在 |
| 409 | CAS 或初始 ref 创建冲突 |
| 413 | 文件超过下载上限（当前 95 MB，Worker 内存保护） |
| 422 | 输入或操作校验失败 |
| 429 | GitHub rate limit（响应 `details` 保留 `Retry-After`） |
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
Read Tree（递归；被 GitHub 截断时改为按子树惰性遍历，见 §5.4）
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

- 所有 path 必须**统一规范化为 NFC** 后再入库，并拒绝空路径段、`.`、`..`、NUL、
  绝对路径歧义。NFC 是为了让 macOS/NAS 的 NFD 文件名不会在 Git 中产生重复文件；
  同时要兼容仓库中**历史遗留的 NFD 路径**（查找时按 NFC 形式匹配）。
- 文本内容含未配对 UTF-16 代理项时必须返回 `422`，不得静默替换为 U+FFFD。
- `mkdir` 生成 `folder/.keep`；UI 默认隐藏 `.keep`。
- delete 删除 path 本身及所有 descendants。
- rename/move：删除旧 path，使用原 blob SHA 写入新 path。
- copy：**同仓库**时新 path 复用原 blob SHA；禁止下载再上传。
  跨 GitHub 仓库无法复用 Blob SHA（对象库不同），见 §9。
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

### 5.4 大仓库与 blob 写入

GitHub 的递归 tree 接口在约 10 万条目 / 7 MB 处会**截断**并置 `truncated: true`。
此时不得直接拒绝写入，而应**按子树逐目录惰性遍历**还原完整索引
（有目录数量上限保护）。否则超大仓库会完全无法写入。

批量创建 Blob 时使用**有界并发**，避免串行往返撞上 Worker 墙钟或 GitHub 二级限流。

### 5.5 下载

`GET .../file` 必须**流式透传**上游字节流，不得把整个文件读进 Worker 内存；
转发客户端的 `Range` 并透传 `206` / `416`；超过上限返回 `413`。

## 6. 冲突中心

冲突是正常状态，不是普通 toast。

> **状态机尚未实现。** 下面列出的 `Clean / Dirty / Committing / Conflict / Error / Offline`
> 是目标取值；当前前端只用 `state.conflicts` 记录冲突事件（`checking` / `connected` /
> `expired` / `unavailable` 是会话状态，与本状态机无关）。
> 实现状态机列入状态总览 P-01。

目标状态：

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

  > 现状与目标的差距必须如实记录：`js/github/*.js` 是上游遗留的浏览器端 Git 引擎，
  > 未被任何页面加载且被构建排除，仅测试使用；`js/drive.js` / `js/auth.js` 是
  > Google Drive 的兼容壳（已移除该能力）。二者都是待清理项，**不得**作为
  > "浏览器可以持有 Git 引擎"的先例。
- 登录只建立 Worker session；“Add Repository”先列出可写 ACL 仓库，用户选择后挂载。
- 新建仓库是独立确认动作。
- 顶栏显示 Worker session，状态取值为
  `checking` / `connected` / `expired` / `unavailable`（与 `js/app.js` 一致）。
  账户菜单提供退出登录入口——**退出必须是一个显式、可见的操作**，
  不能只藏在状态栏。
- CAS 冲突在顶栏显示 Conflict Center 入口。
- UI 使用高密度、低圆角、低阴影的文件管理器风格，不做营销落地页。
- 首页是工作区入口：展示已挂载 storage 与本地记录的「最近访问」，并在零状态直接给出添加存储的主行动按钮。首页不得为展示附加信息而逐仓库请求 API。
- 仓库页签为 文件 / README / 历史。README 使用内置 `js/markdown-lite.js` 渲染；该渲染器必须先整体转义再做白名单替换，绝不输出原始 HTML，且链接与图片只允许 http、https、mailto 与相对路径。
- 样式表层叠顺序固定为 `css/style.css`（历史基础层）→ `css/ui-v2.css`（设计令牌与 V2 覆盖层）。`js/base-path.js` 保证 V2 最后层叠；新增样式一律写进 `ui-v2.css`，不要叠加同名块。
- UI 结构变更后必须通过：

  ```bash
  node scripts/check-ui.mjs          # 重复 id、JS 引用的 id 是否存在、样式表顺序、选择器使用
  node scripts/audit-css.mjs --strict # 两层样式表的冲突（必须 0 未处理）
  ```

  图标资源变更后：`node scripts/build-logo-from-image.mjs --check`。

### 7.1 Android / 移动端

必须提供：

```text
Top navigation
Sidebar drawer
Long press / item menu
Multi-select
Android file picker
```

并且：

- **移动端独立布局，不是桌面缩放。** 顶栏为两行紧凑结构
  （第一行：导航 / 品牌 / 刷新 / 添加 / 账户；第二行：搜索 / 视图切换）。
- **面包屑在移动端隐藏**：仓库名与当前目录由仓库头、列表内容与「返回上一级」行表达，
  挤在顶栏只会压缩可用空间。
- **子目录导航必须提供「返回上一级」入口**，位置在列表 / 网格的**最上方**
  （`..` 行），而不是顶栏按钮——这是文件管理器的通用约定。
- **触达尺寸**：侧栏项、列表行、对话框按钮等主要操作 ≥ 44px；
  顶栏紧凑工具按钮为 36px，属于有意的密度取舍。
- 长 session 标签可隐藏，但**会话异常与冲突必须保留可操作入口**。

## 8. PWA、安全与内容

PWA 保留 manifest、icons、standalone display 与 service worker。

- HTML / CSS / JS / manifest → **Network First**（失败回落缓存）
- icons 等静态资源 → **Cache First**
- `/api/*` → **永不拦截、永不缓存**
- 缓存名由 `js/app-version.js` 的 `APP_VERSION` 组成；前端资源变更后运行
  `node scripts/bump-cache.js` 使旧缓存失效

离线时写操作必须显示 Offline/Error，不能报告已提交。

禁止将文件名、文件内容、GitHub API 返回、Markdown 或 SVG 直接写入不可信 `innerHTML`。Markdown 预览需过滤 script、event handler、`javascript:`、iframe 与 SVG script。

`js/markdown-lite.js` 的实现方式是「先整体转义、再做白名单替换」：原始 HTML 在第一步就变成纯文本，因此结构上不可能被注入；`sanitizeUrl()` 额外拦截 `javascript:`、`vbscript:`、`data:text/html`，并先剥离控制字符以防 `java\tscript:` 绕过。安全测试见 `tests/markdown-lite.test.mjs`。

## 9. 跨仓库语义

同仓库操作可原子化为一个 Git commit。跨 GitHub repository 无法由 Git 提供一个原子 commit：

```text
Copy: destination commit
Move: destination commit → recorded transfer state → source delete commit
```

跨仓库 Move 必须可恢复，失败时不能报告成功；不得宣称它是单事务原子操作。

现状（与目标有差距，如实记录）：

- Copy：已实现「只读收集 → 目标仓库一次批量写入」，目标侧是**一个 Tree + 一个 Commit**；
  Blob 内容只在目标仓库产生一次（无法跨仓库复用 SHA，因为对象库不同）。
- Move：先写目标，再删源；**尚无 retry / cleanup / compensation 的恢复 UI**（见状态总览 P-01）。

## 10. 部署要求

1. 创建 Worker，使用根目录 `wrangler.jsonc`。
2. 构建命令：`node scripts/build-config.mjs`。
3. 创建 D1 数据库，配置 `D1_DATABASE_NAME` / `D1_DATABASE_ID` 构建变量——
   `build-config.mjs` 会把 `DB` binding 注入 `wrangler.jsonc`（binding 本身不入库）。
4. 初始化 `workers/schema.sql`。三种方式任选：
   - Dashboard → D1 → Console，粘贴 schema 全文执行
   - `npx wrangler d1 execute <数据库名> --remote --file=workers/schema.sql`

     ⚠️ **必须带 `--remote`**：不带时 wrangler 操作的是本地 `.wrangler/state/` 副本，
     与线上库无关，会出现"执行成功但线上没变"。参数用**数据库名**而非 binding 名。
   - 已有生产库只补列：`ALTER TABLE repository_access ADD COLUMN checked_at INTEGER;`
     （不要跑整个 schema，`DROP TABLE` 会清空 session）
5. 配置 runtime secret `GITHUB_CLIENT_SECRET`。
6. 配置 build text variable `CONFIG_GITHUB_CLIENT_ID`，可选 `CONFIG_BASE_PATH`。
7. 在 GitHub OAuth App 注册 Worker 的 `/github-oauth-callback.html`。
8. 用 HTTPS Worker 域名验证 Cookie 与 `/api/me`。

GitHub Pages、独立 token proxy、PAT 浏览器 fallback 不属于受支持的安全部署模式。
`workers/github-oauth-token.js` 是上游遗留 token 代理的安全替代件（故意拒绝请求），
不要部署它，也不要删除它。

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

当前 Node 测试与静态校验：

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs tests/markdown-lite.test.mjs
node tests/github-engine.test.mjs        # 自带 harness，退出码非 0 表示失败
node scripts/check-ui.mjs                # UI 结构
node scripts/audit-css.mjs --strict      # 两层样式表冲突，必须 0 未处理
node scripts/build-logo-from-image.mjs --check   # 图标资源
```

## 13. 当前状态与后续

> **进度以 [`状态总览-20260912.md`](状态总览-20260912.md) 为唯一权威来源**，本节只做摘要，不再逐一维护。

已实现：Workers static assets、D1 session/ACL（含 TTL 重校验与写操作强制重校）、HttpOnly session cookie、同源 repo API、Worker Git Data mutation、CAS、空仓库首次写入、前端同源 API、session 状态条、基础 Conflict Center、OAuth 投递 origin 白名单、流式文件下载（Range）、批量 blob 并发、大仓库惰性子树遍历、NFC 路径规范化、首页工作区入口化、README 安全渲染（`js/markdown-lite.js`）。

待完成（详见状态总览第 3 节）：Conflict Center 状态机与三方合并（P-01/P-06）、GitHub App installation token 与 session 轮换（P-02）、真实 D1/Worker 端到端部署验证（P-07）、UI V2 剩余信息架构（P-04）、死代码清理（P-03）。
