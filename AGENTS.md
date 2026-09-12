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

推荐：

```text
github/
├── client.js
├── repository.js
├── reference.js
├── tree.js
├── blob.js
├── commit.js
└── operations.js
```

不要继续把所有 GitHub API 逻辑堆进一个超大文件。

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

优先：

```text
GitHub App
```

认证流程：

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

推荐：

```text
GET  /api/me
GET  /api/repos
GET  /api/repos/:owner/:repo
GET  /api/repos/:owner/:repo/branches
GET  /api/repos/:owner/:repo/tree/:branch
GET  /api/repos/:owner/:repo/file
GET  /api/repos/:owner/:repo/download
GET  /api/repos/:owner/:repo/history

POST /api/repos/:owner/:repo/operations
POST /api/repos/:owner/:repo/commit
POST /api/logout
```

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

缓存：

```text
HTML
CSS
JS
icons
manifest
```

GitHub API：

```text
Network First
```

不要缓存：

```text
/api/*
```

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

缓存键：

```text
owner/repo/branch/head
```

不要只缓存：

```text
owner/repo/branch
```

HEAD 改变：

```text
invalidate TreeIndex
```

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
```

它检查重复 id、JS 引用但已不存在的 id、三个页面的样式表层叠顺序，以及 CSS 类选择器的使用情况。
`notepad.js` 中失效的对话框判断就是由它发现的。

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

## 23. SY-GSP 专项测试

重点测试：

```text
Siyuan
↓
SY-GSP
↓
Markdown
↓
GitHub
```

尤其：

```text
删除 Siyuan 笔记
```

如果已有：

```text
old.md
```

删除笔记后必须：

```text
old.md
↓
Git Tree deletion
↓
GitHub commit
```

不能留下 `old.md`。

还必须测试：

```text
新建
修改
删除
重命名
移动
批量删除
Android ↔ NAS
NAS ↔ GitHub
GitHub ↔ Android
两台设备同时修改
一端删除、一端修改
一端移动、一端修改
```

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

Commit message 应清晰，例如：

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
docs/改造记录-YYYYMMDD-主题.md     每次代码改动的记录
docs/状态总览-YYYYMMDD.md          项目状态（唯一状态来源）
docs/<主题>-YYYYMMDD.md            其他分析 / 方案 / 报告
docs/archive/<原名>                已归档的历史文档（保留原名以便追溯）
```

- 文件名主体必须使用中文，日期用 8 位 `YYYYMMDD`
- 内容至少包含：修改了什么 / 为什么改 / 涉及文件 / 测试情况 / 遗留问题
- 一次改动一份记录，不追加到旧文件

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
已于 2026-09-12 通过 GitHub「Leave fork network」**脱离 fork 网络**，作为独立仓库维护。

- `upstream` remote 保留为**只读参考**；禁止向上游提交 PR 或 Push，所有提交只推 `origin`。
- **必须保留对原作者的署名**：`README.md` / `README_EN.md` 顶部的「致谢与致敬」一节不得删除。
- 上游未声明 LICENSE，默认保留全部权利；**取得授权前不得再分发本项目**。
