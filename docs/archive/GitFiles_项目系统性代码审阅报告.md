# GitFiles 项目系统性代码审阅报告

> ## ⚠️ 已归档 — 本文档部分已过时
>
> **归档日期**：2026-09-12 · **当前状态请只看 [`../状态总览-20260912.md`](../状态总览-20260912.md)。**
>
> 本文的核心判断（「认证架构重构了一半，Worker 入口与前后端 API 不同步」）
> **当时是对的，现已闭环**：
>
> | 本文建议 | 结论 |
> |---|---|
> | P0 认证/API 架构闭环（`workers/*` 全套） | ✅ 已完成（`docs/改造记录-20260912-代码审阅问题修复.md`） |
> | 第二节 Worker 架构断层 | ✅ 已完成（`entry/session/repos/github/operations` 职责已分离） |
> | §3.2 D1 明文保存 access_token | ⚠️ **仍未解决** → `状态总览-20260912.md` P-02 |
> | §4 OAuth Scope 偏大（`repo`） | ⚠️ **仍未解决** → `状态总览-20260912.md` P-02 |
> | §5 ACL 缺失效机制 | ✅ 已完成（TTL + 写操作强制重校） |
> | §6 Session 增加字段 | ✅ 部分（`checked_at` 已加；轮换待 P-02） |
> | §10 CORS Origin 判断过宽 | ✅ 已完成（同源校验 + cookie） |
> | §11–§16 页面速度 / Tree 请求 / 大仓库 / 上传内存 | ✅ 已完成（惰性 subtree、并发 blob、流式下载） |
> | §18–§26 UI 视觉与首页产品化 | ✅ 已完成（层叠根因修复 + 首页入口化） |
> | §24 移动端默认 List | ⏳ 未实施 → `状态总览-20260912.md` P-04 |
>
> 保留本文因为它的**推理链与证据引用仍有参考价值**（尤其 §4 Scope、§3.2 token 存储）。

> 项目：MbAIGC/GitFiles  
> 定位：Storage Hub — browser file manager for Google Drive, local storage, and GitHub repos  
> 审阅重点：认证/授权、页面速度、GitHub API、UI/移动端、PWA、数据安全、并发/CAS、代码结构、测试及整体产品架构。

---

## 一、总体结论

GitFiles 现在已经不是简单的 Storage Hub fork，`Git Data + CAS + Worker/D1` 这个方向是对的。

但目前最大的问题不是 UI，而是：

> **认证架构已经重构了一半，但 Worker 入口和前端/后端 API 设计存在明显不同步。**

如果现在直接继续堆 UI，容易越改越乱。

### 建议优先级

1. **P0：先把认证/API 架构彻底闭环**
2. **P1：页面与 GitHub API 性能优化**
3. **P1：UI/移动端统一优化**
4. **P2：细节、工程质量和扩展功能**

---

# 二、Worker 架构存在明显断层

这是本次审阅中最值得优先处理的问题。

`AGENTS.md` 已经定义了最终架构：

```text
Browser / Android PWA
        │
        ▼
Cloudflare Workers + Static Assets
        │
        ▼
Worker API
        │
   ┌────┴────┐
   ▼         ▼
  D1       GitHub
Session   GitHub API
```

并且规定：

```text
/api/me
/api/repos
/api/repos/:owner/:repo
/api/repos/:owner/:repo/tree/:branch
/api/repos/:owner/:repo/file
/api/repos/:owner/:repo/history
POST /api/repos/:owner/:repo/operations
POST /api/logout
```

以及：

- Token 不进入 localStorage
- 后端必须做 Authorization
- 所有写操作必须 CAS

这些设计方向都是正确的。

但是现在实际 `workers/entry.js` 里，主要还是：

```text
POST /api/github/oauth/token
OPTIONS /api/github/oauth/token
其他 /api/* → 404
其他 → ASSETS
```

与此同时，`workers/session.js`、`workers/repos.js`、`workers/github.js` 等已经开始实现新的后端 API 架构。

前端也已经开始调用：

```text
/api/me
/api/repos
/api/repos/:owner/:repo
```

因此实际形成了：

```text
前端：
新认证架构
     ↓
/api/me
/api/repos
/api/operations

后端入口：
旧 token proxy
     ↓
/api/github/oauth/token
```

**中间没有完全接起来。**

### 结论

这是当前项目的 **P0**。

必须先把 `workers/entry.js` 与：

- `session.js`
- `repos.js`
- `github.js`
- `operations.js`

完整接通。

---

# 三、认证逻辑审阅

## 3.1 Token 不落 localStorage —— 正确

这是当前认证设计中非常值得保留的一点。

推荐的架构：

```text
GitHub OAuth
      ↓
Worker
      ↓
D1
      ↓
HttpOnly Cookie
```

而不是：

```text
GitHub OAuth
      ↓
access_token
      ↓
localStorage
```

当前前端已经朝这个方向设计：

- GitHub token 不直接暴露给浏览器
- Worker Session 使用 HttpOnly Cookie
- 浏览器只持有 Session Cookie

这是比原始 Storage Hub 更安全的方向。

---

## 3.2 D1 明文保存 GitHub access_token —— 需要加强

当前 `sessions` 表类似：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  github_login TEXT,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

问题是：

```text
D1 被攻击
   ↓
sessions
   ↓
GitHub access_token
   ↓
用户 GitHub 权限
```

### 建议

不要长期以明文形式保存 GitHub Token。

可以改为：

```text
GitHub Token
     ↓
AES-GCM 加密
     ↓
Worker Secret 派生密钥
     ↓
D1 encrypted_token
```

使用时：

```text
D1
 ↓
decrypt
 ↓
Worker memory
 ↓
GitHub API
```

核心原则：

> **Token 永远不返回浏览器。**

---

# 四、GitHub OAuth Scope 偏大

当前：

```text
GITHUB_SCOPES=repo
```

`repo` 对 GitHub OAuth App 来说权限较大。

GitFiles 确实需要对私有仓库进行读写，所以不能简单改成 read-only。

但是从长期产品架构看，更推荐最终迁移到：

## GitHub App

架构：

```text
用户授权
    ↓
GitHub App
    ↓
用户选择允许访问的 Repository
    ↓
GitHub App Installation
    ↓
Installation Token
    ↓
Cloudflare Worker
```

优点：

```text
OAuth App：
用户所有 repo 权限

GitHub App：
用户明确授权的 repo 权限
```

对于 GitFiles 这种文件管理器，GitHub App 是长期更合理的权限模型。

---

# 五、Repository ACL 设计是对的，但缓存需要失效机制

目前思路：

```text
session
 ↓
repository_access
 ↓
owner/repo
 ↓
can_read
can_write
```

首次访问：

```text
D1 没 ACL
 ↓
GitHub API 查询 repo
 ↓
判断 permissions
 ↓
写入 D1
```

这个设计是合理的。

但存在权限缓存过期问题。

例如：

```text
今天：
用户 A = write

明天：
仓库管理员取消 A 权限

D1：
仍然 = write
```

### 建议增加

```text
validated_at
```

例如：

```text
repository_access
├── can_read
├── can_write
└── validated_at
```

策略：

```text
首次访问 → GitHub 验证
超过 5~15 分钟 → 重新验证
写操作 → 必要时实时验证
GitHub 返回 401/403 → 立即刷新 ACL
```

---

# 六、Session 建议增加字段

当前 Session 基本结构：

```text
sessions
├── id
├── github_login
├── access_token
├── expires_at
└── created_at
```

建议增加：

```text
github_user_id
last_seen_at
revoked_at
token_expires_at
```

特别是：

> 不应该只依赖 `github_login` 作为用户唯一身份。

GitHub Login 名称存在变化的可能性，因此更适合使用稳定的 GitHub User ID。

---

# 七、Logout 逻辑方向正确

当前思路不是单纯清 Cookie，而是：

```text
DELETE repository_access
DELETE sessions
```

这是正确的。

完整 Logout 应该做到：

```text
POST /api/logout
        ↓
删除 D1 Session
        ↓
删除/清理 ACL
        ↓
Set-Cookie Max-Age=0
```

最终必须保证：

> Cookie 被清掉以后，服务端 Session 也已经失效。

---

# 八、OAuth State / PKCE

这一部分总体评价较高。

当前采用：

```text
state
code_verifier
code_challenge
S256
```

这是正确方向。

尤其：

```text
code_challenge_method=S256
```

应该保留。

---

# 九、OAuth callback 通信机制略复杂

目前同时使用了：

```text
postMessage
BroadcastChannel
localStorage
```

这种设计容易造成：

- 多标签页状态复杂
- callback 残留
- 临时 localStorage 数据积累
- 调试困难

### 建议

优先收敛成：

```text
OAuth popup
      ↓
callback
      ↓
window.opener.postMessage()
      ↓
主窗口
```

然后依靠：

```text
state
```

进行严格校验。

如果确实需要兼容特殊移动端场景，再保留 BroadcastChannel。

不建议继续扩大三套通信机制。

---

# 十、CORS Origin 判断过宽

当前类似：

```text
^https:\/\/[^/]*\.workers\.dev$
```

这类规则允许范围过大。

例如可能匹配：

```text
https://gitfiles.xxx.workers.dev
https://abc.xxx.workers.dev
https://evil.xxx.workers.dev
```

### 建议

改成明确的：

```text
ALLOWED_ORIGINS
```

例如：

```text
https://gitfiles.xxx.workers.dev
https://your-domain.com
http://localhost:8080
```

然后：

```text
Origin 必须精确匹配
```

不要直接允许：

```text
*.workers.dev
```

---

# 十一、页面速度：真正的大问题是 GitHub API 请求数量

当前仓库树加载流程类似：

```text
GET branch
    ↓
GET recursive tree
    ↓
GET commit
```

因此一次进入仓库可能产生多次 GitHub API 请求。

这比单纯优化 CSS/JS 更值得关注。

---

# 十二、减少 GitHub Tree 请求次数

目前类似：

```text
branchState()
   ↓
branches/:branch

然后：
git/trees/:sha?recursive=1

然后：
git/commits/:sha
```

建议减少到：

```text
GET branch
+
GET recursive tree
```

最多两次请求。

commit 的相关信息尽量从已有数据复用。

---

# 十三、TreeIndex 的方向正确

当前设计考虑了：

```text
owner/repo/branch/head
```

作为缓存关键因素。

这是正确的。

不能只缓存：

```text
owner/repo/branch
```

因为远端 HEAD 改变后，旧 Tree 已经失效。

推荐：

```text
owner/repo/branch/head
```

作为缓存核心。

---

# 十四、`force: true` 使用过多

当前部分流程会：

```text
getFileContentMeta()
    ↓
getRepoTreeState(..., { force: true })
```

以及：

```text
getFileProperties()
    ↓
getFileContentMeta()
    ↓
getRepoTreeState(force)
```

问题是：

> 用户只是查看一个文件属性，也可能触发完整 Tree 重新请求。

这会浪费 GitHub API 请求。

### 建议

建立：

```text
Memory Cache
     ↓
TreeIndex
     ↓
HEAD
     ↓
TTL
```

减少不必要的：

```text
force: true
```

只有明确需要刷新时才强制刷新。

---

# 十五、大仓库不要首次加载完整 recursive Tree

目前：

```text
进入 Repository
      ↓
recursive tree
      ↓
整个仓库全部下载
```

小仓库没有问题。

但如果：

```text
10,000 文件
100,000 文件
```

就会明显变慢。

而 GitHub recursive tree 还有返回过大的问题。

目前遇到：

```text
payload.truncated
```

就直接报错。

### 更好的方案

首次进入：

```text
进入 Repository
      ↓
只加载根目录
```

点击目录：

```text
点击 folder
      ↓
加载该 folder children
```

也就是最终支持：

> 按目录懒加载，而不是整个 Repository 一次性加载。

这会是后续最重要的性能优化之一。

---

# 十六、上传逻辑存在内存压力

目前上传类似：

```text
Blob
 ↓
arrayBuffer()
 ↓
Uint8Array
 ↓
operations
```

例如上传：

```text
80 MB
```

可能产生：

```text
80MB Blob
+
80MB ArrayBuffer
+
Uint8Array
+
后续编码/请求开销
```

在 Android 上尤其需要注意。

### 建议

后续优化：

- 避免不必要的完整内存复制
- 大文件采用更合理的上传流程
- 控制并发上传数量
- 移动端限制同时上传任务数

---

# 十七、不要把产品限制描述成 GitHub 平台限制

当前有类似：

```text
GitHub 存储支持的单文件大小上限为 100 MB
```

这种提示不够严谨。

应该区分：

```text
GitFiles 当前上传限制
```

与：

```text
GitHub 普通 Git 文件限制
Git LFS 限制
GitHub API 限制
```

避免把 GitFiles 自己的产品限制误说成 GitHub 的统一平台限制。

---

# 十八、UI：当前视觉语言存在冲突

CSS 中存在大量：

```text
--win-blue
--win-bg
--win-border
--win-hover
--win-selected
--title-bar-bg
--sidebar-bg
```

说明目前明显还保留 Windows Explorer 风格。

但是 `AGENTS.md` 又要求：

```text
仿 GitHub Web
专业
简洁
高密度
全屏
低圆角
低装饰
```

因此当前存在：

> **设计语言没有完全统一。**

---

# 十九、建议不要继续强化“Windows Explorer 仿真”

GitFiles 最终更适合：

```text
GitHub Web
+
现代文件管理器
+
PWA
```

而不是：

```text
Windows Explorer Clone
```

当前如果继续增加：

- Ribbon
- Windows Title Bar
- 传统地址栏
- 大量 Windows 式按钮

会越来越像：

> “网页套了一层 Windows 文件管理器皮肤”。

---

# 二十、建议重新设计顶部结构

推荐类似：

```text
┌──────────────────────────────────────────────┐
│ GitFiles   [仓库 ▼] [搜索]       GitHub 👤 │
├────────────┬─────────────────────────────────┤
│            │                                 │
│ Repository │  Home / Documents / Notes       │
│            │                                 │
│ 📁 repo-A  │  📁 Documents                  │
│ 📁 repo-B  │  📁 Images                     │
│ 📁 repo-C  │  📄 README.md                   │
│            │  📄 config.json                 │
│            │                                 │
└────────────┴─────────────────────────────────┘
```

重点：

- 顶栏更轻
- Repository 切换更明显
- 搜索作为核心能力
- GitHub 用户菜单放右侧
- 减少 Windows 标题栏感

---

# 二十一、首页应该更加产品化

当前登录后没有仓库时，核心逻辑已经改成：

```text
登录
 ↓
Explorer
 ↓
添加 Repository
```

这个方向比以前“登录后自动创建 Repo”合理很多。

`AGENTS.md` 以及当前代码都应该坚持：

> 登录只负责 Authentication，不创建仓库。

### 更推荐的空状态

```text
GitFiles

你的 GitHub 文件空间

┌─────────────────────────────┐
│                             │
│     还没有连接仓库           │
│                             │
│   [ 添加 GitHub 仓库 ]       │
│                             │
│   连接已有仓库 / 创建私有仓库 │
│                             │
└─────────────────────────────┘
```

而不是登录后直接进入一个空 Explorer。

---

# 二十二、添加 Repository 流程已经合理

推荐保持：

```text
Add Repository
       ↓
┌─────────────────┐
│ 挂载已有仓库     │
│ 创建私有仓库     │
│ 取消             │
└─────────────────┘
```

特别要保证：

```text
登录
≠
创建 Repository
```

以及：

```text
登录 callback
≠
自动创建 Repository
```

这解决了之前产品逻辑中最容易造成误解的问题。

---

# 二十三、移动端已经有不错基础

目前已经考虑：

- safe-area
- 100dvh
- sidebar drawer
- touch target
- bottom selection bar
- mobile navigation

这些方向都是正确的。

但 `AGENTS.md` 要求：

```text
触摸目标尽量 ≥ 44px
```

而实际部分：

```text
min-height: 40px
```

因此建议统一成：

```text
44px
```

重点检查：

- 三点菜单
- 返回
- 添加仓库
- 文件选择
- Checkbox
- Toolbar
- Breadcrumb

---

# 二十四、移动端建议默认 List，而不是 Grid

当前：

```text
grid-template-columns:
repeat(auto-fill, minmax(88px, 1fr));
```

在 Android 手机上容易造成文件名拥挤。

建议：

### Desktop

```text
Grid / List
```

### Mobile

```text
List 默认
```

例如：

```text
📁 Documents          >
📁 Images             >
📄 README.md      12 KB
📄 config.json     2 KB
```

移动端更适合：

- 单列
- 文件名完整显示
- 文件大小/修改时间辅助信息
- 点击区域更大

---

# 二十五、搜索目前主要是前端过滤

当前：

```text
state.files.filter(...)
```

对于当前目录搜索没问题。

但未来如果支持：

> 全仓库搜索

不能继续：

```text
整个 Git Tree
 ↓
浏览器
 ↓
JS filter
```

应该最终改成：

```text
Worker
 ↓
TreeIndex
 ↓
Search
```

这样大型 Repository 也可以快速搜索。

---

# 二十六、Git Data API 重构是目前项目最正确的一步

这一部分评价很高。

目前已经朝：

```text
Move
 ↓
Tree path rewrite
 ↓
Blob SHA 不变
```

Copy：

```text
复用 Blob SHA
```

Delete：

```text
Tree
 ↓
Commit
```

Batch：

```text
多个操作
 ↓
一个 Commit
```

CAS：

```text
expectedHead
 ↓
远端 HEAD 变化
 ↓
409 Conflict
```

这个方向比简单使用 GitHub Contents API 更合理。

---

# 二十七、Conflict UX 需要优化

当前冲突提示类似：

```text
Conflict detected

Your base: ...
Remote HEAD: ...

Apply to latest remote state
Cancel
```

普通用户容易理解成：

> 覆盖远端。

实际上真正含义是：

> 重新基于最新 HEAD 执行当前操作。

建议改成：

```text
远端已发生变化

GitFiles 检测到仓库在操作期间被其他设备修改。

本次操作尚未写入。

[重新应用当前操作]
[取消]
```

重点是：

> **不要让“重新应用操作”和“覆盖远端”产生歧义。**

---

# 二十八、需要处理“Commit 已成功但客户端超时”

这是文件管理器非常重要的异常场景。

不能：

```text
Commit 请求
 ↓
客户端超时
 ↓
直接显示失败
```

因为实际上可能是：

```text
Commit 已经成功
只是响应没有返回
```

推荐状态机：

```text
pending
 ↓
request timeout
 ↓
unknown
 ↓
重新查询 Branch HEAD
 ↓
判断 commit 是否已经发生
```

这样可以避免：

> 用户以为上传失败，再次点击上传，结果重复操作。

---

# 二十九、Operation Progress 设计是对的

当前已经有：

```text
Uploading
Saving
Moving
Deleting
Conflict
Pending
```

这种状态反馈很好。

但是需要注意：

```text
notifyListChange()
```

如果批量操作大量触发 render：

```text
100 个文件
 ↓
100 次 state change
 ↓
100 次 render
```

可能造成 UI 卡顿。

### 建议

使用：

```text
requestAnimationFrame batching
```

把：

```text
多次状态变化
```

合并成：

```text
一次 UI render
```

---

# 三十、代码结构开始出现“大文件问题”

目前：

```text
js/app.js
js/githubdisk.js
style.css
```

都已经比较大。

尤其：

```text
app.js
githubdisk.js
```

已经开始影响：

- 首屏 JS 解析
- Debug
- Codex 修改成本
- 回归风险
- 后续维护
- AI 修改 token 消耗

---

# 三十一、不要做一次性“大重构”

不建议让 Codex 直接：

```text
把整个项目重写成 React
```

或者：

```text
全部改 TypeScript
```

这种大手术。

更适合渐进式拆分。

例如：

```text
app.js
 ├── app-state.js
 ├── app-navigation.js
 ├── app-render.js
 ├── app-events.js
 ├── app-auth.js
 └── app.js
```

以及：

```text
githubdisk.js
 ├── github-auth.js
 ├── github-tree.js
 ├── github-files.js
 ├── github-transfer.js
 ├── github-conflict.js
 └── githubdisk.js
```

原则：

> **保持原生 JS，不要为了模块化引入大型前端框架。**

---

# 三十二、PWA 方向正确

目前已经有：

```text
manifest
service worker
offline shell
```

并且应该继续保持：

```text
/api/*
```

不进入离线缓存。

这非常重要。

### 原则

```text
HTML
CSS
JS
icons
manifest
    ↓
Cache First

/api/*
    ↓
Network Only
```

不能把 GitHub 用户数据错误地缓存进离线 Cache。

---

# 三十三、GitHub 动态数据可以采用 Network First

推荐：

```text
静态资源：
Cache First

GitHub / Worker 动态数据：
Network First

/api/*：
Network Only
```

尤其：

> 离线状态不能假装 Commit 成功。

---

# 三十四、XSS 需要继续重点审计

GitFiles 的特殊之处在于：

> GitHub Repository 中的数据最终会直接成为网页 UI。

因此这些都是不可信输入：

```text
Markdown
HTML
SVG
文件名
文件内容
Repository 名称
Owner
Commit message
GitHub API 返回字段
```

建议重点扫描：

```text
innerHTML
insertAdjacentHTML
outerHTML
document.write
```

然后逐个判断：

```text
可信 HTML？
还是 GitHub 用户可控数据？
```

文件名例如：

```text
<img src=x onerror=alert(1)>.txt
```

如果直接：

```js
element.innerHTML = file.name
```

就存在 XSS 风险。

因此：

> 文件名、仓库名、Commit message 等优先使用 `textContent`。

---

# 三十五、SSRF 防护方向正确

Worker GitHub API 应保持：

```text
固定 endpoint
```

而不是：

```text
用户传 URL
 ↓
Worker fetch(url)
```

应该：

```text
Worker
 ↓
固定 https://api.github.com
```

只允许代码构造合法 GitHub API path。

不要为了“灵活”而允许用户传任意 URL。

---

# 三十六、Repository 创建权限必须继续严格分离

最终应该保证：

```text
GET /api/repos
```

只负责查询。

```text
POST /api/repos
```

明确执行创建。

绝不能出现：

```text
GET /api/repos
 ↓
顺便 create
```

或者：

```text
OAuth callback
 ↓
自动 create
```

当前前端已经朝正确方向修改，这一点应该保持。

---

# 三十七、Repository 发现逻辑还可以优化

目前如果一次加载大量 Repository，可能产生：

```text
/user/repos?page=1
/user/repos?page=2
...
```

如果用户有：

```text
500 个 Repository
```

首次进入就做大量请求没有必要。

### 推荐

登录：

```text
GitHub 登录
 ↓
获取基本用户信息
 ↓
进入 GitFiles
```

用户点击：

```text
添加仓库
```

之后再：

```text
加载 Repository Selector
```

这样可以明显改善首屏速度。

---

# 三十八、Authentication 与 Repository Discovery 应彻底解耦

最终建议：

```text
GitHub 登录
      ↓
建立 Session
      ↓
进入 GitFiles
      ↓
显示已有挂载
      ↓
用户点击「添加仓库」
      ↓
加载 GitHub Repository 列表
```

而不是：

```text
GitHub 登录
 ↓
获取用户
 ↓
获取所有 repo
 ↓
建立所有 disk
 ↓
加载所有 tree
 ↓
渲染 Explorer
```

---

# 三十九、当前项目评分

| 项目 | 当前评价 |
|---|---:|
| Git Data API 架构 | ⭐⭐⭐⭐⭐ |
| CAS / 并发控制 | ⭐⭐⭐⭐½ |
| Token 不落地浏览器 | ⭐⭐⭐⭐½ |
| OAuth PKCE | ⭐⭐⭐⭐ |
| Session 架构 | ⭐⭐⭐½ |
| ACL | ⭐⭐⭐½ |
| API 架构完整度 | ⭐⭐ |
| 首屏性能 | ⭐⭐⭐ |
| 大仓库性能 | ⭐⭐½ |
| UI 视觉统一 | ⭐⭐⭐ |
| Desktop UX | ⭐⭐⭐½ |
| Mobile UX | ⭐⭐⭐½ |
| PWA | ⭐⭐⭐⭐ |
| XSS 防护意识 | ⭐⭐⭐⭐ |
| 工程可维护性 | ⭐⭐½ |
| 测试覆盖 | ⭐⭐ |
| 产品化程度 | ⭐⭐⭐½ |

### 综合评价

**约 7/10。**

不是因为功能差，而是：

> **核心引擎已经不错，但认证/API 这一层正在“换发动机”，目前还没有完全装好。**

---

# 四十、推荐的 P0 修复任务

## P0-1：Worker API 闭环

重点修改：

```text
workers/entry.js
workers/session.js
workers/repos.js
workers/github.js
workers/operations.js
```

最终确保：

```text
/api/me
/api/repos
/api/repos/:owner/:repo
/api/repos/:owner/:repo/tree/:branch
/api/repos/:owner/:repo/file
/api/repos/:owner/:repo/history
POST /api/repos/:owner/:repo/operations
POST /api/logout
```

全部真正可用。

---

## P0-2：认证安全

增加：

```text
session expiration
revocation
last_seen
github_user_id
ACL TTL
```

---

## P0-3：Token 加密

```text
D1
 ↓
encrypted access_token
```

避免明文长期保存。

---

## P0-4：CORS 精确白名单

删除：

```text
*.workers.dev
```

改成：

```text
ALLOWED_ORIGINS
```

精确匹配。

---

## P0-5：Authentication / Mutation 完全分离

保证：

```text
登录
≠
创建仓库
≠
挂载仓库
≠
执行文件操作
```

---

# 四十一、P1 性能任务

## P1-1

减少：

```text
branch
tree
commit
```

三次 GitHub 请求。

## P1-2

减少：

```text
force: true
```

## P1-3

Tree Cache 使用：

```text
owner/repo/branch/head
```

## P1-4

大仓库不要首次加载完整 recursive tree。

## P1-5

批量 UI 更新使用：

```text
requestAnimationFrame
```

## P1-6

登录时不要加载所有 Repository。

---

# 四十二、P1 UI 任务

重新定义 GitFiles UI：

```text
GitHub Web 风格
+
现代文件管理器
+
高密度
+
低圆角
+
低阴影
+
蓝色强调
+
全屏
```

不要继续增强：

```text
Windows Explorer 仿真
```

---

# 四十三、P1 Android / Mobile 任务

默认：

```text
List View
```

而不是 Grid。

统一：

```text
Touch Target ≥ 44px
```

底部操作栏：

```text
选择文件
 ↓
Bottom Action Sheet
```

减少桌面端式右键/小按钮交互。

---

# 四十四、P2 后续功能

后续可以考虑：

```text
全局搜索
收藏
最近文件
回收站
批量下载
拖拽优化
文件预览
Markdown Preview
图片预览
视频预览
大文件优化
Git History UI
Commit Details
```

---

# 四十五、最终推荐架构

```text
                    GitFiles PWA
                         │
              ┌──────────┴──────────┐
              │                     │
          Local Storage         GitHub Login
                                      │
                                      ▼
                              OAuth + PKCE
                                      │
                                      ▼
                           Cloudflare Worker
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
                   D1              Session           GitHub API
                    │                 │                 │
              ACL / Session           │                 │
                    │                 │                 │
                    └──────────────┬──┘                 │
                                   │                    │
                                   ▼                    ▼
                              Authorization       Git Data API
                                                        │
                                           ┌────────────┼───────────┐
                                           │            │           │
                                          Blob         Tree       Commit
                                           │            │           │
                                           └────────────┼───────────┘
                                                        │
                                                       CAS
                                                        │
                                                     GitHub
```

核心原则：

```text
浏览器：
不保存 GitHub Token

Worker：
负责 Authentication + Authorization

D1：
Session + ACL

GitHub：
真正的数据

Git Data：
真正的文件操作

CAS：
保证并发安全

PWA：
负责 UI / 本地缓存

Service Worker：
绝不缓存 API
```

---

# 四十六、最终实施顺序

不要现在直接从 UI 开始大改。

推荐：

```text
① Worker/API/认证闭环
        ↓
② Session/ACL 安全
        ↓
③ GitHub API 请求优化
        ↓
④ 大仓库性能
        ↓
⑤ UI 重新收口
        ↓
⑥ Android/PWA
        ↓
⑦ 测试矩阵
```

尤其目前已经有 `AGENTS.md`，其中实际上已经定义了很多正确原则，但：

> **源码目前还没有完全达到它自己规定的最终架构。**

因此下一步最适合给 Codex/DSH 的不是“继续优化 UI”，而是先做：

> **《GitFiles P0：认证/API 架构闭环 + 安全加固任务单》**

具体覆盖：

- `workers/entry.js`
- `workers/session.js`
- `workers/repos.js`
- `workers/github.js`
- `workers/operations.js`
- `workers/schema.sql`
- `githubdisk.js`
- Authentication 状态机
- Authorization 状态机
- Session 生命周期
- ACL TTL
- CORS
- Token 安全
- CAS
- 回归测试

然后第二阶段再做：

> **《GitFiles P1：页面速度 + GitHub API + UI/Android 优化任务单》**

> 注（2026-09-12 补记）：本文中的「fork」「Sync fork」「上游」等表述反映写作当时的状态。
> 本仓库已于 2026-09-12 脱离 fork 网络，作为独立仓库维护；相关流程说明不再适用。

这样比现在同时修改认证、后端、UI 更稳，也更适合后续让 Codex/DSH 分阶段执行。
