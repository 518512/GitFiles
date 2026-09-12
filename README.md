<div align="center">

# GitFiles

**基于 Cloudflare Workers 的 GitHub Repository 文件管理器（PWA）**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MbAIGC/GitFiles)
[![Tests](https://img.shields.io/badge/tests-77%20passing-2da44e)](tests/)

[English](README_EN.md) · 简体中文

</div>

## 项目简介

GitFiles 将 GitHub Repository 作为可靠的云端文件系统。浏览器只调用同源 Worker API；GitHub access token 仅保存在 Worker 的 D1 session 中，并通过 HttpOnly Cookie 使用。文件写入由 Worker 的 Git Data pipeline 执行，保持 Tree、Commit 与 branch ref 的正确历史。

## 核心能力

- GitHub OAuth 登录只建立 Worker session，不自动创建或挂载仓库。
- 从 Worker ACL 列表挂载有写权限的仓库；创建私有仓库必须由用户明确确认。
- 同仓库 create/update/delete/rename/move/copy/mkdir/upload。
- Move、Rename、Copy 复用 Blob SHA；批量逻辑操作合并为一个 Tree、Commit 和非 force ref 更新。
- CAS：客户端提交 `expectedHead`，Worker 重读远端 HEAD；不一致返回 `409 Conflict`。
- Worker session 状态条、基础 Conflict Center、移动端侧栏与大触达区域。
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

1. Fork 本仓库，或使用上方 Deploy to Cloudflare 按钮。
2. 在 Cloudflare Workers 项目中设置 Build command：

   ```bash
   node scripts/build-config.mjs
   ```

3. 为每个部署设置 D1 配置变量（变量值只存在于你的 Cloudflare 部署配置，不提交到公共仓库）：

   ```text
   D1_DATABASE_NAME=你的D1数据库名称
   D1_DATABASE_ID=你的D1数据库ID
   ```

   在 Cloudflare Workers Builds 中，将它们添加为 Build variables；如果使用 Dashboard 部署，则在构建/部署环境变量中配置。`wrangler.jsonc` 会使用这两个变量创建固定名称为 `DB` 的 D1 binding。然后执行 schema：

   ```bash
   npx wrangler d1 execute <database-name> --file=workers/schema.sql
   ```

4. 设置 Worker runtime secret：

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

5. 设置 Build text variables：

   | 变量 | 用途 |
   |---|---|
   | `CONFIG_GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
   | `CONFIG_BASE_PATH` | 可选站点路径覆盖 |

6. 在 GitHub OAuth App 中登记：

   ```text
   https://<worker-domain>/github-oauth-callback.html
   ```

7. 部署后访问 `/api/me` 验证 session；没有 D1 binding 或 secret 时 API 会返回 `503`，不会退回到浏览器 token/PAT 模式。

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

详细规范见 [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md)。每次改动的中文记录见 `docs/改造记录-*.md`。
