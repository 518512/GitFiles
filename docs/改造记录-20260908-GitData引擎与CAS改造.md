# 改造记录：Git Data 引擎与 CAS 并发控制

- 日期：2026-09-08
- 提交：`5ad90b1 Replace GitHub Contents API writes with Git Data engine (Blob/Tree/Commit/Ref)`
- 关联规格：`docs/PROJECT_SPEC.md` §2/§3/§4/§5/§6/§11、`AGENTS.md` §3/§5/§6

## 修改了什么

### 1. 新建 Git Data Engine（`js/github/`，7 模块）

| 模块 | 职责 |
|------|------|
| `client.js` | GitHub API 请求层：认证、429/Retry-After 重试、错误标准化、`isConflict` 分类（422 fast-forward / 409） |
| `repository.js` | 仓库、分支状态（head + treeSha 一次请求）、用户、历史读取 |
| `reference.js` | 分支 HEAD 读取 + **CAS 引用更新**（非 force，失败抛 `ConflictError`，携带 base/remote HEAD） |
| `tree.js` | 递归 Tree 读取；TreeIndex 缓存键 = `owner/repo/branch/head` |
| `blob.js` | Blob 创建；空 Blob 复用知名 SHA `e69de29…` |
| `commit.js` | Tree + Commit 创建 |
| `operations.js` | **严格顺序语义**的纯操作规划器（可注入依赖、可离线单测）+ Mutation Pipeline + 同盘互斥队列 |

### 2. `js/githubdisk.js` 写路径全面切换

- Move/Rename：Tree path 重写，**复用原 Blob SHA**，一个 Commit（原实现为逐文件 下载→上传→删除）
- Copy：Tree 条目复用 Blob SHA；目录复制**单 Commit**、零重复上传（原实现为逐文件递归复制）
- Delete：文件/整棵目录子树 **1 Tree + 1 Commit**（原实现为逐文件 Contents DELETE + 逐文件取 sha）
- Create/Update/Mkdir：单 Commit；空目录用 `folder/.keep`
- 冲突：pending 状态新增 `conflict`，弹对话框「应用到最新远端状态 / 取消」，**禁止静默覆盖**
- 新增公开 API：`executeBatch`、`buildBatchCopyOperations`、`buildBatchMoveOperations`、`isConflictError`

### 3. UI 批量单 Commit

`js/contextmenu.js` 同盘多选移动/复制从「逐项循环、每项一个 Commit」改为一次 `executeBatch` = 1 Commit；跨盘路径保持逐项。

### 4. 缓存与 PWA

- 目录列表缓存从「按磁盘」改为「按 HEAD」：HEAD 不变直接命中，HEAD 变化自动失效
- `sw.js`：预缓存 7 个引擎模块；新增 `/api/*` 永不缓存规则；`js/app-version.js` 版本戳更新

### 5. 脚本挂载

`index.html` / `notepad.html` / `404.html` 按依赖顺序加载引擎（client → repository → blob → reference → tree → commit → operations → githubdisk）。

## 为什么改

原实现把 GitHub 当「网盘 REST」用：Move 是下载→上传→删除、Copy 重新上传、目录删除逐文件 N 次 API + N 个 Commit、并发无保护可静默覆盖远端。既慢（请求数 O(文件数)）又污染 Git History，还可能覆盖其他设备的修改。目标架构（PROJECT_SPEC）要求以 Git Data API 为正确性引擎，CAS 保证多设备安全。

## 涉及文件

- 新增：`js/github/{client,repository,reference,tree,blob,commit,operations}.js`、`tests/github-engine.test.mjs`
- 修改：`js/githubdisk.js`（核心）、`js/contextmenu.js`、`sw.js`、`js/app-version.js`、`index.html`、`notepad.html`、`404.html`、`README.md`

## 测试情况

`node tests/github-engine.test.mjs` — **32 通过 / 0 失败**：

- 文件：create / update / delete / rename / move / copy（含冲突校验）
- 目录：mkdir（`.keep`，含空 Blob SHA 复用）、删除、移动、复制、多层嵌套
- 批量：混合操作、批内顺序语义（rename 后 copy 同源报错）、批内 Blob 去重共享（create+update 仅 1 次上传）、100 文件删除/创建
- Git 正确性：Move/Copy 复用 Blob SHA（`blobsCreated === 0`）、一批 = 1 次 createCommit + 1 次 CAS ref 更新、no-op 跳过提交
- 并发：非 force 更新遇远端 HEAD 变化 → `ConflictError`（409 语义）、`expectedHead` 不匹配提前拒绝
- 冲突分类：422 fast-forward = 冲突；422 普通校验错误 ≠ 冲突；409 = 冲突；404 = not found

## 遗留问题

- GitHub 访问令牌仍存于 `localStorage`（旧 PAT/OAuth 流程）；需 Cloudflare Pages Functions + D1 会话 + GitHub App 方可根治
- Conflict Center 为对话框级（应用最新远端/取消），尚无 diff/merge 视图
- GitHub ↔ Google/本地跨盘复制仍不完整（同盘完整）
