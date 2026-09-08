# GitHub File Hub / Storage Hub Fork → Cloudflare 多用户 GitHub 文件管理器

## 1. 项目目标

Fork `fi3ik-mme/storage-hub`，将其改造成一个安全、可靠、移动端友好、支持多用户认证的 GitHub Repository Web File Manager。

核心体验：

> 把 GitHub Repository 当成一个云端文件夹/文件系统来操作。

用户可以在网页/PWA中：
- 浏览 Repository
- 浏览目录
- 打开/预览文件
- 新建文件
- 新建文件夹
- 上传文件
- 重命名
- 移动
- 复制
- 删除
- 批量操作
- 提交变更
- 查看 Git History
- 发生并发修改时进入 Conflict Center

目标平台：
- Cloudflare Pages
- Cloudflare Pages Functions
- GitHub
- GitHub App
- Cloudflare D1
- PWA
- Android 优先兼容

原则：

> 正确性、一致性、安全性优先于“快速能跑”。

## 2. 当前 Storage Hub 必须修复的问题

当前项目已经具备较完整的 GitHub 文件管理 UI 和基础能力，但 GitHub 后端实现存在明显问题。

### Move / Rename

禁止：

```text
下载旧文件
↓
上传到新路径
↓
删除旧路径
```

必须改为 Git Data API：

```text
读取当前 Tree
↓
修改 Tree path
↓
创建新的 Tree
↓
创建 Commit
↓
更新 Branch
```

文件内容 Blob SHA 可以直接复用。

Rename：

```text
old/path.md → null
new/path.md → old_blob_sha
```

### Copy

Copy 不应该重新上传文件内容。

```text
old/path.md → blob SHA
new/path.md → 同一个 blob SHA
```

目录 Copy 也应复用已有 Blob SHA。

### Delete

删除文件：

```text
path → null
```

删除目录时批量删除所有 descendants，一次 Tree、一次 Commit。

禁止逐文件 Contents API DELETE。

### Batch Operations

支持：
- 批量删除
- 批量移动
- 批量复制
- 批量重命名
- 批量上传

原则：

> 一组逻辑操作 = 一个 Git Commit。

## 3. Git Data API 架构

核心写入引擎不要继续依赖 GitHub Contents API。

围绕：

```text
Reference
Tree
Blob
Commit
```

设计。

推荐：

```text
github/
├── client.js
├── repository.js
├── tree.js
├── blob.js
├── commit.js
├── reference.js
└── operations.js
```

职责：

- `client.js`：GitHub API 请求、认证、限流、重试、错误标准化
- `reference.js`：Branch HEAD、CAS
- `tree.js`：Repository Tree、TreeIndex
- `blob.js`：Blob 创建/下载/复用
- `commit.js`：Commit 创建
- `operations.js`：create/update/delete/rename/move/copy/mkdir/upload

## 4. CAS / 并发控制

客户端读取：

```text
HEAD = A
```

其他设备提交：

```text
A → B
```

当前设备提交时携带：

```text
expectedHead = A
```

服务端重新检查：

```text
currentHead === expectedHead
```

如果不相等：

```text
409 Conflict
```

禁止静默覆盖。

## 5. Conflict Center

冲突必须明确告诉用户：

```text
发生远端修改

本地基准：A
当前远端：B
你的操作：Rename / Delete / Move / Update
```

可提供：

```text
查看差异
重新加载
尝试合并
覆盖远端
取消
```

默认不允许静默覆盖。

## 6. TreeIndex / Cache

缓存键必须包含：

```text
Repository + Branch + HEAD
```

例如：

```text
owner/repo
branch=main
head=abc123
```

HEAD 改变后旧 TreeIndex 失效。

## 7. GitHub Authentication

生产版不要让用户直接在浏览器保存 PAT。

推荐：

```text
GitHub App
↓
GitHub Login
↓
Authorization
↓
Cloudflare Pages Function
↓
Session
↓
HttpOnly Secure SameSite Cookie
```

禁止：

```text
localStorage
sessionStorage
IndexedDB
window.token
```

保存 GitHub access token。

## 8. Session / D1

推荐使用 Cloudflare D1：

```text
users
sessions
github_accounts
github_installations
repositories
```

Cookie：

```text
HttpOnly
Secure
SameSite=Lax
```

每次访问 Repository 都由服务端验证当前用户、GitHub Account/Installation、Repository 和权限。

## 9. GitHub App 权限

遵循最小权限原则。

初始建议：

```text
Contents: Read and write
Metadata: Read-only
```

不要申请不必要的 Administration 等权限。

## 10. API

建议：

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

核心写操作：

```http
POST /api/repos/:owner/:repo/operations
```

请求示例：

```json
{
  "branch": "main",
  "expectedHead": "abc123",
  "operations": [
    {
      "type": "rename",
      "from": "a.md",
      "to": "b.md"
    }
  ]
}
```

服务端流程：

```text
读取 HEAD
↓
CAS 检查
↓
读取 Tree
↓
生成新的 Tree
↓
必要时创建 Blob
↓
创建 Commit
↓
更新 Branch
↓
返回 newHead
```

## 11. Operation 类型

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

目录 Move 必须修改所有 descendant path，并复用原 Blob SHA。

## 12. 空目录

Git 不保存真正的空目录。

使用：

```text
folder/.keep
```

UI 隐藏 `.keep` 并把它作为目录占位。

## 13. UI

整体仿照 GitHub Web：

```text
简洁
高密度
专业
全屏
低圆角
少阴影
无大面积渐变
```

桌面布局：

```text
┌───────────────────────────────────────┐
│ GitHub File Hub       user    menu   │
├───────────┬───────────────────────────┤
│ Repos     │ owner / repo              │
│ Files     │ branch: main              │
│ History   ├───────────────────────────┤
│ Settings  │ breadcrumb                │
│           ├───────────────────────────┤
│           │ file list                 │
└───────────┴───────────────────────────┘
```

文件菜单：

```text
Open
Preview
Download
Rename
Move
Copy
Delete
Copy path
Open on GitHub
```

## 14. Mobile

Android 不能只是缩小桌面 UI。

需要独立交互：

```text
Top Navigation
Breadcrumb
File List
Bottom Sheet
Long Press
Multi-select
```

Touch target 尽量 ≥ 44px。

上传兼容 Android File Picker。

## 15. PWA

必须支持：

```text
manifest.webmanifest
service worker
icons
theme-color
display: standalone
```

缓存：

```text
HTML
CSS
JS
icons
manifest
```

GitHub 数据：

```text
Network First
```

禁止缓存：

```text
/api/*
```

离线时不允许假装 Commit 成功。

## 16. Preview

至少支持：

```text
Markdown
TXT
JSON
YAML
YML
JS
TS
CSS
HTML
XML
CSV
```

图片支持：

```text
PNG
JPG
JPEG
GIF
WEBP
SVG
```

Markdown 提供：

```text
Preview
Edit
Raw
```

必须防 XSS，特别处理 Markdown、HTML、SVG、iframe 和 script。

## 17. Git History

显示：

```text
Commit
Author
Date
Message
```

## 18. 状态系统

建议：

```text
CLEAN
DIRTY
COMMITTING
CONFLICT
ERROR
OFFLINE
```

UI 必须来自真实状态机。

不能出现：

```text
实际失败
↓
UI 显示成功
```

## 19. Pending Operations

前端可以维护：

```js
[
  {
    type: "rename",
    from: "a.md",
    to: "b.md"
  },
  {
    type: "delete",
    path: "old.md"
  }
]
```

用户点击 Commit 后统一提交。

## 20. Cloudflare Pages

推荐：

```text
Cloudflare Pages
├── Static Frontend
└── Pages Functions
      └── /api/*
```

如果使用 Pages Functions：

```text
workers/github-oauth-token.js
```

可迁移为：

```text
functions/api/github/oauth/token.js
```

## 21. Security

重点处理：

### XSS
不信任文件名、Markdown、SVG、HTML、GitHub API 内容。

### CSRF
修改请求验证 Session、Origin、SameSite；必要时增加 CSRF token。

### SSRF
后端不能成为任意 URL Proxy。GitHub API endpoint 应固定。

### Authorization
前端隐藏按钮不等于权限控制。所有写操作必须在后端再次验证。

## 22. 推荐目录

```text
/
├── index.html
├── manifest.webmanifest
├── sw.js
├── css/
│   ├── app.css
│   ├── github.css
│   └── mobile.css
├── js/
│   ├── app.js
│   ├── router.js
│   ├── github/
│   │   ├── client.js
│   │   ├── repository.js
│   │   ├── reference.js
│   │   ├── tree.js
│   │   ├── blob.js
│   │   ├── commit.js
│   │   └── operations.js
│   ├── ui/
│   │   ├── sidebar.js
│   │   ├── file-list.js
│   │   ├── context-menu.js
│   │   ├── bottom-sheet.js
│   │   ├── dialogs.js
│   │   └── conflict-center.js
│   └── pwa/
│       └── install.js
└── functions/
    └── api/
        ├── me.js
        ├── repos.js
        ├── logout.js
        ├── github/
        │   └── oauth/
        │       └── token.js
        └── repos/
            └── [owner]/
                └── [repo]/
                    ├── tree.js
                    ├── file.js
                    ├── download.js
                    ├── history.js
                    └── operations.js
```

## 23. MVP

第一阶段必须完成：

- GitHub Login
- Session
- Repo List
- Branch List
- Repository Tree
- Directory Navigation
- File Preview
- Upload
- Create File
- Create Folder
- Rename
- Move
- Copy
- Delete
- Batch Operations
- Commit
- CAS
- Conflict Center
- Git History
- PWA
- Mobile UI
- Cloudflare Pages
- Cloudflare Functions

## 24. 测试

必须测试：

### 文件
- 创建
- 修改
- 删除
- 重命名
- 移动
- 复制

### 目录
- 创建
- 删除
- 移动
- 复制
- 多层目录

### 批量
- 10 文件
- 100 文件
- 多目录
- 混合操作

### Git
验证：

```text
一个逻辑操作 = 一个 Commit
Move 不产生新的 Blob
Copy 不产生新的 Blob
```

### 并发

设备 A：

```text
读取 HEAD=A
```

设备 B：

```text
A → B
```

设备 A：

```text
expectedHead=A
```

结果必须：

```text
409 Conflict
```

## 25. SY-GSP 专项测试

必须针对 `MbAIGC/SY-GSP` 设计测试。

关键场景：

```text
设备 A 删除 Siyuan 笔记
↓
已存在对应 .md
↓
GitHub Repo
↓
设备 B 同步
```

必须保证：

```text
笔记删除
↓
对应 .md 删除
```

不能出现：

```text
.sy 已删除
.md 仍然存在
```

还需要测试：

- 新建笔记
- 修改笔记
- 删除笔记
- 重命名
- 移动
- 批量删除
- Android ↔ NAS
- NAS ↔ GitHub
- GitHub ↔ Android
- 两台设备同时修改
- 一端删除、一端修改
- 一端移动、一端修改

## 26. 重点场景

实现任何文件/同步功能，都必须考虑：

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

## 27. 禁止“假成功”

例如 Commit 请求超时：

不能简单认为：

```text
Commit 失败
```

因为服务器可能已经成功。

应重新获取：

```text
Branch HEAD
```

判断真实状态。

## 28. 性能

优先优化：

```text
API request count
Blob upload count
Tree generation
Commit count
Repository Tree caching
```

避免：

- 每个文件一个 Commit
- Move 重新上传
- Copy 重新上传
- 无意义刷新
- 大量 Contents API 请求

## 29. 最终架构

```text
┌──────────────────────────────┐
│ Android / Desktop Browser    │
│ GitHub-style File Manager    │
│ PWA                          │
└──────────────┬───────────────┘
               │ HTTPS
               ▼
┌──────────────────────────────┐
│ Cloudflare Pages             │
│ Static Frontend              │
│ Pages Functions /api/*       │
└──────────────┬───────────────┘
               │
               ├───────────────┐
               ▼               ▼
        ┌────────────┐   ┌────────────┐
        │ Cloudflare │   │ GitHub     │
        │ D1         │   │ API        │
        │ users      │   │ App        │
        │ sessions   │   │ Repo       │
        │ accounts   │   │ Git Data   │
        └────────────┘   └─────┬──────┘
                               │
                               ▼
                       ┌──────────────┐
                       │ Git Data     │
                       │ Blob         │
                       │ Tree         │
                       │ Commit       │
                       │ Reference    │
                       └──────────────┘
```

最终定位：

> GitHub Repository = 云端文件系统  
> Cloudflare = 多用户认证与 API 层  
> Git Data API = 正确的文件操作引擎  
> PWA = Android/Desktop 使用入口
