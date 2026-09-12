# AGENTS.md

## 1. 你的角色

你是本项目的 AI Coding Agent。

项目目标：

> 将 Storage Hub 改造成一个安全、可靠、移动端友好、支持多用户认证的 GitHub Repository Web File Manager。

开始前必须：

1. 阅读 `docs/PROJECT_SPEC.md`（架构规格）
2. 阅读 `docs/状态总览-20260912.md`（**唯一状态来源**：已完成 / 待规划）
3. 阅读当前仓库结构
4. 阅读相关源码
5. 理解现有 Storage Hub 实现
6. 找出旧逻辑与目标架构差异
7. 再开始修改

不要未经分析直接大规模重写。

## 2. 第一原则

本项目最重要的是：

```text
数据正确性
一致性
并发安全
权限安全
Git History 正确
```

如果 UI 与数据正确性发生冲突：

> 永远优先数据正确性。

## 3. 严禁架构倒退

### Token

禁止：

```text
localStorage
sessionStorage
IndexedDB
window.token
DOM attribute
```

保存 GitHub access token。

推荐：

```text
HttpOnly
Secure
SameSite
Cookie
```

### Move

禁止：

```text
download
↓
upload
↓
delete
```

必须使用 Git Tree path rewrite，并复用原 Blob SHA。

### Rename

必须：

```text
old path → null
new path → old blob SHA
```

### Copy

必须复用 Blob SHA。

禁止：

```text
download → upload
```

> 跨 GitHub 仓库的复制无法由 Git 提供原子单 commit，此时允许
> 「只读收集 → 目标仓库一次批量写入」：目标侧仍是**一个 Tree + 一个 Commit**，
> 且 Blob 内容只在目标仓库产生一次。见 `workers/operations.js` 与
> `js/githubdisk.js` 的 `collectGithubItems` / `createBatchFromCollected`。

### Batch

一组逻辑操作应尽可能产生：

```text
一个 Tree
一个 Commit
```

禁止 100 个文件产生 100 个 Commit。

### CAS

所有写操作必须带：

```text
expectedHead
```

服务端必须重新获取远端 HEAD。

如果：

```text
currentHead !== expectedHead
```

必须：

```text
409 Conflict
```

绝不能静默覆盖。

## 4. 不要删除 Conflict Center

冲突是正常的多设备场景。

状态至少：

```text
Clean
Dirty
Committing
Conflict
Error
Offline
```

冲突必须进入 Conflict Center。

## 5. Git Data Engine

核心 Git 操作围绕：

```text
Reference
Tree
Blob
Commit
```

**引擎在 Worker 侧，不在浏览器。** 当前模块划分（`workers/`）：

```text
workers/entry.js       唯一 HTTP 入口：路由分派、CORS、错误兜底
workers/http.js        ApiError / json / assertSameOrigin / 路由解析
workers/session.js     Cookie session、仓库 ACL（含 TTL 重校验）、过期清理
workers/repos.js       仓库读取、列表、创建、文件下载入口
workers/operations.js   Git Data 变更管线（CAS + 批量单 commit）
workers/github.js      GitHub API 客户端（含流式下载）
workers/schema.sql     D1 表结构（幂等，可重复执行）

workers/github-oauth-token.js
                       上游遗留的独立 OAuth 代理**安全替代件**：它故意拒绝所有请求，
                       以防旧部署把它当作 token 出口而把 access token 泄露给浏览器。
                       不要删除，也不要在其中实现功能。
```

新增 GitHub API 调用必须放进 `workers/github.js`，变更语义放进
`workers/operations.js`；不要把 API 逻辑堆进 `entry.js`。

> ⚠️ `js/github/*.js`（约 1200 行）是**上游时代的浏览器端 Git 引擎**，
> 既没有被任何页面加载，也被 `scripts/build-config.mjs` 排除出发布产物，
> 仅被 `tests/github-engine.test.mjs` 使用。**不要在其中新增功能**；
> 它属于待清理项（见 `docs/状态总览-20260912.md` P-03）。

## 6. Mutation Pipeline

标准写操作：

```text
Request
↓
Authenticate
↓
Authorize
↓
Read current HEAD
↓
Compare expectedHead
↓
Read Tree
↓
Apply operations in memory
↓
Create required Blobs
↓
Create Tree
↓
Create Commit
↓
Update Branch Reference
↓
Return new HEAD
```

任何一步失败：

> 不允许 UI 报告成功。

## 7. Operation Model

至少支持：

```text
create
update
delete
rename
move
copy
mkdir
upload
```

前端请求中的安全字段不能直接作为可信来源。

服务端必须根据 Session 和路由上下文确定用户、Repository 和权限。

## 8. Directory Operations

Git 不保存真正的空目录。

使用：

```text
folder/.keep
```

UI 默认隐藏 `.keep`。

目录 Move：

```text
TreeIndex
↓
找到 descendants
↓
修改 path prefix
↓
复用 Blob SHA
↓
一次 Commit
```

## 9. Cloudflare

目标：

```text
Cloudflare Workers
+
Worker（内置 API：workers/entry.js）
+
Static Assets
+
D1（sessions / repository_access，部署时绑定 DB）
```

> 注（2026-09-08）：原目标「Cloudflare Pages + Pages Functions + D1」已迁移为
> **Workers + Static Assets**。同源 session、仓库 ACL、OAuth 和 Git Data API 均由
> `workers/entry.js` 及其模块承担；D1 binding 名称为 `DB`。本文不再使用 Pages Function 作为实现名称。

原生 JS 优先。

除非有明确技术理由，不要自动引入：

```text
React
Vue
Next
大型状态管理库
```

## 10. Authentication

目标（**尚未实现**，当前使用 OAuth user token + `repo` scope）：

```text
GitHub App + installation token
细粒度仓库授权（替代全量 repo scope）
session 轮换与主动吊销
```

现状流程：

```text
Browser
↓
GitHub Login
↓
GitHub App Authorization
↓
Worker API (workers/entry.js)
↓
D1 Session
↓
HttpOnly Cookie
```

## 11. Authorization

所有写操作必须：

```text
Authentication
+
Authorization
```

前端隐藏按钮只是 UX，不是安全机制。

真正的权限检查必须在 Worker API（`workers/entry.js` 及其模块）。

## 12. API

当前实现（与 `workers/entry.js` / `workers/repos.js` 保持一致）：

```text
POST /api/github/oauth/token
POST /api/logout
GET  /api/me                                    → { login, avatar }
GET  /api/repos[?refresh=1]                     → 仓库 ACL 列表
POST /api/repos                                 创建私有仓库（需用户明确确认）
GET  /api/repos/:owner/:repo
GET  /api/repos/:owner/:repo/branches
GET  /api/repos/:owner/:repo/tree?branch=main
GET  /api/repos/:owner/:repo/file?branch=main&path=docs/a.md
GET  /api/repos/:owner/:repo/history?branch=main
POST /api/repos/:owner/:repo/operations        批量变更（CAS）
```

说明：

- `branch` / `path` 是**查询参数**，不是路径段。
- 提交由 `operations` 一并完成（一个 Tree + 一个 Commit），**没有独立的 commit 路由**。
- 也没有独立的 download 路由：文件字节流走 `file`，支持 `Range` 与 `206`。

> 新增路由时必须同步本节与 `docs/PROJECT_SPEC.md` §4。

API 必须：

- 输入验证
- 权限检查
- 统一错误格式
- 合理日志
- 不泄露 token

## 13. Error Handling

至少区分：

```text
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Validation Error
429 Rate Limited
500 Internal Error
```

尤其 `409` 必须被 UI 识别为 Conflict。

实现中另有：

```text
413 Payload Too Large    文件超过下载上限
502 Bad Gateway          GitHub 上游不可用
503 Service Unavailable  D1 或必需配置缺失（如未绑定 DB、无 GITHUB_CLIENT_SECRET）
```

缺少 D1 或 secret 时**必须返回 503，不得回退到浏览器 token / PAT 模式**。

## 14. UI 原则

仿照 GitHub Web：

```text
专业
简洁
高密度
全屏
低圆角
低装饰
```

避免：

```text
大面积渐变
巨大卡片
过多阴影
花哨动画
```

## 15. Mobile First

Android 是重要目标。

不能只通过：

```css
@media (...) {
  width: 100%;
}
```

完成移动端。

必须设计：

```text
Top Navigation
Breadcrumb
File List
Bottom Sheet
Long Press
Multi-select
Touch targets
```

触摸目标尽量 ≥ 44px。

上传必须兼容 Android 文件选择器。

## 16. PWA

必须保持：

```text
manifest
service worker
icons
standalone
```

缓存（`sw.js` 的 SHELL_ASSETS）：

```text
HTML（index / notepad / 404 / 隐私 / 条款 / OAuth 回调）
CSS
JS
icons
manifest
```

策略：

```text
HTML / CSS / JS / manifest → Network First（失败回落缓存）
icons 等静态资源         → Cache First
/api/*                   → 永不拦截、永不缓存
```

`CACHE_NAME` 由 `js/app-version.js` 的 `APP_VERSION` 组成；
改动前端资源后运行 `node scripts/bump-cache.js` 让旧缓存失效。

离线时不能假装已经 Commit。

## 17. XSS

特别注意：

```text
Markdown
HTML
SVG
文件名
文件内容
GitHub API 返回内容
```

不要直接把不可信内容写入 `innerHTML`。

Markdown Preview 必须防：

```text
<script>
javascript:
onerror
onload
iframe
svg script
```

## 18. SSRF

Worker API 不应该成为任意 URL Proxy。

不要允许用户任意传 URL，然后服务端 fetch。

GitHub API endpoint 应由服务端固定生成。

## 19. Tree Cache

浏览器端的仓库树缓存（`js/githubdisk.js`）按当前 HEAD 作键：

```text
owner/repo/branch/head
```

不要只按 `owner/repo/branch` 缓存——HEAD 变了必须能拿到新树。

HEAD 改变时（提交成功、刷新、跨设备同步）：

```text
invalidate TreeIndex
```

> 注意：写操作的最终权威在 Worker。客户端的树缓存只是加速读取；
> 服务端每次写入都会重新读取远端 HEAD 并做 CAS，不依赖客户端缓存是否新鲜。

## 20. 不要盲目重构

现有代码已经正确的部分尽量复用。

只重构：

```text
明确 bug
安全风险
架构冲突
性能问题
可维护性问题
```

不要为了“代码更漂亮”一次改完整个项目。

## 21. 修改流程

### Step 1

阅读：

```text
docs/PROJECT_SPEC.md
AGENTS.md
```

### Step 2

检查：

```text
git status
```

### Step 3

定位相关代码。

### Step 4

分析当前行为。

### Step 5

写出修改计划。

### Step 6

实现。

### Step 7

运行测试。

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs tests/markdown-lite.test.mjs
node tests/github-engine.test.mjs
```

改动图标资源后还要运行：

```bash
node scripts/build-logo-from-image.mjs --check
```

改动 UI（HTML / CSS / DOM id / 事件绑定）时还必须运行：

```bash
node scripts/check-ui.mjs
node scripts/audit-css.mjs --strict
```

`audit-css.mjs --strict` 是**必须通过**的闸门：存在未处理的样式泄漏时返回非 0。
若确认某条历史属性在新布局下依然正确，应把它登记进脚本里的 `ALLOWED_LEGACY`
并写明理由，而不是让闸门失败。

`check-ui.mjs` 检查重复 id、JS 引用但已不存在的 id、样式表层叠顺序、CSS 选择器使用情况。
`audit-css.mjs` 审计**两层样式表的冲突**：列出给定类在 `style.css`（历史层）与
`ui-v2.css`（V2 层）里的全部规则，并标出「历史层设置、V2 层未显式复位」的属性——
这些就是"多余横线""割裂色块"这类问题的来源，必须逐条确认。
不带 `--strict` 时只做报告；「有意保留」的属性登记在 `ALLOWED_LEGACY` 中并附理由。
`notepad.js` 中失效的对话框判断就是由 `check-ui.mjs` 发现的。

### Step 8

检查：

```text
git diff
git status
```

### Step 9

检查是否违反：

```text
CAS
Security
Git Data API
Mobile
PWA
```

### Step 10

最后报告：

```text
修改了什么
修改了哪些文件
测试了什么
测试结果
剩余问题
```

## 22. 测试要求

必须测试：

### 文件

```text
create
update
delete
rename
move
copy
```

### 目录

```text
mkdir
delete directory
move directory
copy directory
nested directory
```

### Batch

```text
10 files
100 files
mixed operations
```

### Git

验证：

```text
Move 不重新创建 Blob
Copy 不重新创建 Blob
Batch = one logical commit
```

### Concurrency

场景：

```text
Device A reads HEAD=A

Device B commits:
A → B

Device A commits with:
expectedHead=A
```

必须：

```text
409 Conflict
```

## 23. 集成与删除语义

### 23.1 删除语义（最容易被漏掉的一类 bug）

**删除必须真正落到 Git Tree 上，不能在仓库里留下残留文件。**

重点验证：

```text
仓库中已存在 old.md
↓
通过应用删除它
↓
Git Tree 中 old.md 必须消失
↓
产生一个对应的 Commit
```

判据：操作完成后重新拉取远端树，**不能仍能读到 `old.md`**。
这一类问题的典型成因是提交时误用了 `base_tree`（GitHub 会把它当 patch，
被省略的路径得以保留），见 §3 Batch 与 `workers/operations.js` 的注释。

### 23.2 第三方工具 / 编辑器集成

本应用常被其他工具当作 GitHub 仓库的后端使用（笔记软件导出 Markdown、
同步工具、脚本等）。这类集成必须覆盖：

```text
外部工具写入 → 应用内可见
应用内修改   → 外部工具拉取后一致
外部工具删除 → 应用内不再显示
应用内删除   → 远端文件消失（见 23.1）
```

### 23.3 平台间往返

```text
Android ↔ 服务端 / NAS
NAS ↔ GitHub
GitHub ↔ Android
```

必须验证往返之后：

```text
文件内容一致
文件名（含中文、空格、特殊字符）一致
目录结构一致
没有重复文件
```

> 文件名一致性尤其要注意 Unicode 规范化：路径入库前统一 NFC，
> 同时兼容仓库中历史遗留的 NFD 名称（见 `workers/operations.js` 的 `pathOf`）。

## 24. 重点场景

任何同步/文件操作都必须考虑：

```text
单设备
双设备
多设备
同时编辑
一端删除、一端修改
一端移动、一端修改
一端重命名、一端删除
网络中断
GitHub API 超时
GitHub Rate Limit
Commit 成功但前端断网
Branch HEAD 已改变
```

## 25. 禁止“假成功”

例如：

```text
Commit 请求超时
```

不能直接判断失败。

服务器可能已经成功。

必须重新获取：

```text
Branch HEAD
```

判断真实状态。

## 26. Commit

> 注意区分两种「commit message」：本节指的是**写入 GitHub 仓库的 Git commit message**
> （默认 `Batch file operations`，由 `workers/operations.js` 生成）；
> 而**本仓库自身的 git commit** 必须用中文，规则见 §33。

写入仓库的 commit message 应清晰，例如：

```text
Create docs/a.md
Update README.md
Delete docs/old.md
Rename docs/a.md → docs/b.md
Move docs/a.md → archive/a.md
Copy docs/a.md → backup/a.md
```

Batch 可以使用：

```text
Batch file operations
```

## 27. Rate Limit

避免：

- 循环大量 Contents API
- 每个文件一个 Commit
- Move 重新上传
- Copy 重新上传
- 无意义刷新

优先：

```text
一次 Tree
复用 Blob SHA
TreeIndex Cache
批量 Commit
```

## 28. Code Style

保持：

```text
简单
可读
模块化
明确
```

优先：

```text
小函数
明确命名
统一错误处理
```

避免：

```text
巨型函数
隐式全局状态
魔法字符串
重复 API 逻辑
```

## 29. Dependencies

新增依赖前必须考虑：

```text
是否真的需要？
Cloudflare Workers 是否支持？
是否增加 bundle？
是否增加维护成本？
是否有原生 JS 方案？
```

能用原生 Web API：

> 优先原生 Web API。

## 30. 完成标准

一个功能只有同时满足：

```text
功能正确
+
Git History 正确
+
并发安全
+
权限安全
+
移动端可用
+
PWA 可用
+
错误可见
+
测试通过
```

才算完成。

## 31. 最重要的 12 条规则

1. **Token 不进入 localStorage**
2. **Move 不允许 download/upload/delete**
3. **Rename 必须复用 Blob SHA**
4. **Copy 必须复用 Blob SHA**
5. **Batch 尽可能一个 Commit**
6. **所有写操作必须 CAS**
7. **远端 HEAD 改变必须进入 Conflict**
8. **不能静默覆盖远端**
9. **后端必须做 Authorization**
10. **Mobile 不能只是缩小桌面**
11. **PWA 必须保留**
12. **数据正确性优先于 UI 和开发速度**

## 32. 最终架构

```text
Browser / Android PWA
          │
          ▼
Cloudflare Workers + Static Assets
          │
          ▼
Worker API (`workers/entry.js`)
          │
     ┌────┴────┐
     ▼         ▼
    D1       GitHub
  Session    GitHub App
     │         │
     │         ▼
     │     Git Data API
     │         │
     │    Blob / Tree
     │    Commit / Ref
     │
     └── Authentication
```

最终产品定位：

> 一个类似 GitHub Web 文件管理器的 PWA，将 GitHub Repository 作为可靠的云端文件系统，并通过 Cloudflare 实现多用户认证、权限和安全 API 层。

## 33. 文档与提交规范（本项目强制）

### 文档命名

`docs/` 下的**所有文档**（含分析、方案、状态、索引等，不只改造记录）统一使用
中文名 + 日期：

```text
docs/改造记录-YYYYMMDD-主题.md     阶段性完成记录（见下方粒度说明）
docs/状态总览-YYYYMMDD.md          项目状态（唯一状态来源）
docs/<主题>-YYYYMMDD.md            其他分析 / 方案 / 报告
docs/archive/<原名>                已归档的历史文档（保留原名以便追溯）
```

- 文件名主体必须使用中文，日期用 8 位 `YYYYMMDD`
- 内容至少包含：修改了什么 / 为什么改 / 涉及文件 / 测试情况 / 遗留问题

### 记录粒度：阶段性，不是每次改动

**不要每改一处就写一份记录。** 按**阶段**写：把一个完整目标（一个功能、
一次问题排查、一轮重构）做完并验证后，写**一份**阶段记录。

```text
✅ 一个阶段 = 一份记录
   例：完成「批量删除」功能 → 一份改造记录

❌ 同一阶段内每修一个小点就写一份
   例：调整按钮间距 → 一份
       修正文案       → 一份
       修复换行       → 一份        （这三条应合并为一份阶段记录）
```

判断标准：**如果几次改动是在完成同一件事、且未必需要单独回溯，就合并成一份。**

- 阶段记录建议在**收尾时**写，而不是边做边写——过程中细节还在变，早写要反复改。
- 同阶段的多次提交在记录里用「补充修正」小节汇总，而不是新开文件。
- 只有**独立**的阶段（互不相关的新目标）才另起一份。

> 说明：`docs/` 下 2026-09-12 之前存在较细的逐次记录，是早期规则遗留。
> 新规则不追溯改写旧文件；由 `docs/README.md` 的索引统一组织。

**例外**（保持原名，属于约定俗成的固定名称）：

```text
docs/PROJECT_SPEC.md   规范正文，被 AGENTS.md 与多处引用
AGENTS.md              本文件
README.md / README_EN.md   双语主文档
docs/README.md         docs 目录级索引（GitHub 会自动渲染，故不加日期）
```

### Commit

Commit message 一律使用中文，格式：

```text
类型: 摘要
```

例如：`新增: Git Data 引擎与 CAS 并发控制`、`修复: 批量操作逐文件提交`、`文档: README 中文化`。

### README 双语同步

`README.md`（中文，主文档）与 `README_EN.md`（英文）内容必须保持同步，任何一处变更都要同时更新两个文件。

### 上游与致谢

本项目源自 [storage-hub](https://github.com/fi3ik-mme/storage-hub)（作者 Mykhailo Mikus），
按独立项目维护。

> 状态核实：`https://api.github.com/repos/MbAIGC/GitFiles` 目前仍返回
> `"fork": true` 且带 `parent`，说明**尚未真正脱离 fork 网络**。
> 脱离需要在 GitHub 网页操作：Settings → General → Danger Zone → Leave fork network（不可逆）。
> 未完成前，文档中不应宣称"已脱离"。

- `upstream` remote 保留为**只读参考**；禁止向上游提交 PR 或 Push，所有提交只推 `origin`。
- **必须保留对原作者的署名**：`README.md` / `README_EN.md` 顶部的「致谢与致敬」一节不得删除。
- 上游未声明 LICENSE，默认保留全部权利；**取得授权前不得再分发本项目**。
