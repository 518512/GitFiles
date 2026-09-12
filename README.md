<div align="center">

# GitFiles

**基于 Cloudflare Workers 的 GitHub Repository 文件管理器（PWA）**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MbAIGC/GitFiles)
[![Tests](https://img.shields.io/badge/tests-77%20passing-2da44e)](tests/)

[English](README_EN.md) · 花了2亿Token重复造的轮子，不如Openlist好用

</div>

---

## 🙏 致谢与致敬

本项目的起点是 **[storage-hub](https://github.com/fi3ik-mme/storage-hub)**，作者 **[Mykhailo Mikus](https://github.com/MishaMikusEleks)**（[@MishaMikusEleks](https://github.com/MishaMikusEleks)）。

storage-hub 是一个纯客户端的多后端文件管理器——它把 Google Drive、浏览器本地存储与 GitHub 仓库
挂在同一个界面里，用一套 Windows 资源管理器风格的 UI 统一操作，并支持跨盘复制粘贴、
内置记事本与可分享的路径深链，全部在浏览器内完成、不需要后端服务器。

> 多存储抽象（`localdisk.js` / `drive.js`）、文件树交互、记事本与 PWA 骨架都源自它。
> 谨向原作者**致以诚挚的感谢与敬意**。

### 引用上游项目时请署名

storage-hub 是本项目的上游灵感与代码来源，请在使用、引用或再分发时一并署名为它做的工作。

> ⚠️ **许可提示**：上游仓库目前**未声明 LICENSE**，因此默认保留全部权利。
> 在获得原作者明确授权之前，请勿再分发本派生版本。详见
> [`docs/架构现状-20260912.md`](docs/架构现状-20260912.md) 第 3.3 节。

---

## 项目简介

GitFiles 将 GitHub Repository 作为可靠的云端文件系统。浏览器只调用同源 Worker API；GitHub access token 仅保存在 Worker 的 D1 session 中，并通过 HttpOnly Cookie 使用。文件写入由 Worker 的 Git Data pipeline 执行，保持 Tree、Commit 与 branch ref 的正确历史。

> **项目状态**：已完成 / 待规划见 [`docs/状态总览-20260912.md`](docs/状态总览-20260912.md)（唯一状态来源）。
> **文档索引**：见 [`docs/README.md`](docs/README.md)。

### 相对上游的改造

上游是**纯客户端**的浏览器文件管理器（以 Google Drive 为主，无后端）；GitFiles 已将重心转向
GitHub Repository，并引入 Cloudflare Worker + D1 后端、Git Data 变更管线与 CAS，
数据模型从 Google Drive 转为 Git 对象模型（Blob / Tree / Commit / Ref）：

| 维度 | storage-hub（上游） | GitFiles |
|---|---|---|
| 后端 | 无（纯客户端 + PAT） | Cloudflare Worker + D1 |
| 认证 | Google OAuth / GitHub PAT | GitHub OAuth + PKCE + HttpOnly Cookie |
| token 存放 | 浏览器内 | 仅 Worker / D1 |
| 数据模型 | Google Drive 为中心 | Git 对象模型 + CAS |
| 部署 | GitHub Pages | Workers + Static Assets |
| 测试 | 无 | 77 项 |

GitFiles 按独立项目维护（注：GitHub 平台层面的 fork 标记尚未解除）。完整差异与实测数据见
[`docs/架构现状-20260912.md`](docs/架构现状-20260912.md) 第 2–3 节。

## 核心能力

- GitHub OAuth 登录只建立 Worker session，不自动创建或挂载仓库。
- 从 Worker ACL 列表挂载有写权限的仓库；创建私有仓库必须由用户明确确认。
- 同仓库 create/update/delete/rename/move/copy/mkdir/upload。
- Move、Rename、Copy 复用 Blob SHA；批量逻辑操作合并为一个 Tree、Commit 和非 force ref 更新。
- CAS：客户端提交 `expectedHead`，Worker 重读远端 HEAD；不一致返回 `409 Conflict`。
- Worker session 状态条、基础 Conflict Center、移动端侧栏与大触达区域。
- 首页作为工作区入口（已挂载存储 + 最近访问），仓库页含 README 安全渲染。
- PWA 外壳缓存；Service Worker 永不缓存 `/api/*`。

## 架构

```text
Browser / Android PWA
        │ same-origin HTTPS + HttpOnly cookie
        ▼
Cloudflare Worker + Static Assets
        ├── D1: sessions / repository_access
        └── GitHub OAuth + Git Data API
                    │
              Blob / Tree / Commit / Ref
```

浏览器不保存 GitHub token，也不直接请求 `api.github.com`。`workers/entry.js` 是 API 与授权边界；`workers/operations.js` 执行 Git Data mutation pipeline。

## 部署

受支持的生产部署方式只有 **Cloudflare Workers + Static Assets**。

1. 克隆本仓库，或使用上方 Deploy to Cloudflare 按钮。
2. 在 Cloudflare Workers 项目中设置 Build command：

   ```bash
   node scripts/build-config.mjs
   ```

3. 创建 D1 数据库，并设置 D1 配置变量（变量值只存在于你的 Cloudflare 部署配置，不提交到公共仓库）：

   ```text
   D1_DATABASE_NAME=你的D1数据库名称
   D1_DATABASE_ID=你的D1数据库ID
   ```

   在 Cloudflare Workers Builds 中，将它们添加为 Build variables；如果使用 Dashboard 部署，则在构建/部署环境变量中配置。`wrangler.jsonc` 会使用这两个变量创建固定名称为 `DB` 的 D1 binding。

4. 初始化数据库 schema（`workers/schema.sql`）。三种方式任选：

   **方式 A — Dashboard SQL 控制台（无需本地环境）**

   Dashboard → Workers & Pages → D1 → 选择数据库 → **Console**，
   粘贴 `workers/schema.sql` 全部内容后执行。

   **方式 B — wrangler CLI**

   ```bash
   npx wrangler d1 execute <database-name> --remote --file=workers/schema.sql
   ```

   > ⚠️ 必须加 `--remote`。不加时 wrangler 操作的是本地 `.wrangler/state/` 副本，
   > 与线上生产库无关。
   >
   > 参数用**数据库名**而不是 binding 名 `DB`：binding 名可能变、数据库名不会。

   **方式 C — 已有部署的增量升级**

   若数据库已在使用，不要执行整个 `schema.sql`（其中的 `DROP TABLE` 会清空 session、
   强制所有人重新登录）。只执行新增列：

   ```sql
   ALTER TABLE repository_access ADD COLUMN checked_at INTEGER;
   ```

   旧行的 `checked_at` 为 `NULL`，会被视为「过期」，首次访问时回源 GitHub 重新校验一次。

5. 设置 Worker runtime secret：

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

6. 设置 Build text variables：

   | 变量 | 用途 |
   |---|---|
   | `CONFIG_GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
   | `CONFIG_BASE_PATH` | 可选站点路径覆盖 |

7. 在 GitHub OAuth App 中登记：

   ```text
   https://<worker-domain>/github-oauth-callback.html
   ```

8. 部署后访问 `/api/me` 验证 session；没有 D1 binding 或 secret 时 API 会返回 `503`，不会退回到浏览器 token/PAT 模式。

本地 `serve.py` 仅用于静态/OAuth 开发排查，不代表受支持的生产安全架构。GitHub Pages、独立 token proxy 与浏览器 PAT fallback 不属于受支持的安全部署模式。

## API

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

写操作必须带 `expectedHead`；空仓库首次写入使用 `expectedHead: null`。Worker 在 ref 被并发创建或远端 HEAD 变化时返回 `409`，前端进入 Conflict Center。

## 开发与测试

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs tests/markdown-lite.test.mjs
node scripts/build-config.mjs
```

当前测试覆盖 Git 操作、Blob SHA 复用、批量单 commit、CAS、空仓库初始 ref、D1/session/ACL 拒绝与陈旧 ACL 重校验、同源写入、OAuth token 不泄漏、OAuth 回调投递域名白名单、路径 NFC 规范化、非法 UTF-16 内容拒绝、429 退避信息透传、文件下载的流式透传与 Range，以及 Markdown 渲染的 XSS 防护。

UI 结构另有静态校验（重复 id、JS 引用的 id 是否存在、样式表层叠顺序、CSS 选择器使用情况）：

```bash
node scripts/check-ui.mjs
```

## 当前限制

- 当前 session 使用 OAuth user token；GitHub App installation token 与 session 轮换尚未完成。过期 session 会在 `/api/me` 上顺带清理，没有 cron 绑定。
- 单文件下载上限为 95 MB（Worker 内存保护）；超过该大小需要 R2 中转才能真正支持。
- Conflict Center 已支持记录与重载远端状态，尚未提供文本三方合并与逐文件 diff。
- 跨仓库 Move 是两阶段可恢复流程，不能是单个原子 Git commit；恢复 UI 尚未完成。
- 仓库访问权限（ACL）读操作有 5 分钟缓存，写操作每次都回源 GitHub 校验。
- README 预览使用内置的 MarkdownLite（安全优先，不支持表格 / 任务列表 / 嵌套列表，也不放行原始 HTML）。
- 本地存储只支持文本内容，二进制文件上传会被明确拒绝。

详细规范见 [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md)；项目状态见 [docs/状态总览-20260912.md](docs/状态总览-20260912.md)；文档与改造记录索引见 [docs/README.md](docs/README.md)。
