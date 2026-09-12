# GitFiles UI V2 重构任务单

> ## 📌 实施状态（2026-09-12 更新）
>
> **本文是设计要求，不是进度表。进度以 [`状态总览-20260912.md`](状态总览-20260912.md) 的 P-04 为准。**
>
> 已完成（3 项结构性问题 + 首页）：
>
> | 章节 | 状态 | 说明 |
> |---|---|---|
> | §四十四 CSS 重构要求 | ✅ | 层叠顺序根因已修（`ui-v2.css` 曾被 `style.css` 压制），重复 `.ribbon` 块已清理 |
> | §二十四/§二十五/§二十六 Mobile | ⚠️ 部分 | 已改为两行独立布局、触达 ≥44px；**未**实施 §二十七 Mobile Bottom Navigation |
> | §十八 Empty State | ✅ | 空态统一渲染 + 带动作 |
> | §二十一 首页产品化 | ✅ | 首页已改造为工作区入口（已挂载分组 + 最近访问 + 零状态主按钮） |
> | §三十二 图标 | ⚠️ 部分 | 面板层已统一为内联 SVG（`panelIcon()`）；文件类型图标仍为 emoji |
>
> **尚未实施**：§二十 Repository Picker V2、§十二 Branch Selector、
> §三十八 Settings、§二十七 Mobile Bottom Navigation、§二十九 Design System 完整化、
> §三十六 Operation Feedback、§三十七 Conflict Center UI（依赖 P-01）。
>
> ⚠️ **执行前必读**：新增样式一律写进 `css/ui-v2.css`（它必须最后层叠），
> 不要新增同名块叠加覆盖；改完必须跑 `node scripts/check-ui.mjs`。

> 项目：MbAIGC/GitFiles  
> 目标：将当前“传统文件管理器 + GitHub 风格配色”的 UI，真正重构为以 GitHub Repository 为核心的信息架构和现代 Web/PWA 界面。  
> 执行者：Codex / DSH  
> 基准分支：当前 `main`  
> 重要：本任务不是继续在旧 UI 上缝缝补补，而是一次完整的 UI 表现层重构。

---

# 一、任务目标

当前 GitFiles 的问题不是颜色不够像 GitHub，而是：

- 页面整体仍然继承传统 Windows/文件管理器的信息架构
- Sidebar 仍然是文件管理器思路
- Repository、Storage、目录、文件之间的层级关系不够清晰
- Toolbar 操作过多且缺乏上下文
- 文件列表更像 NAS/Explorer，而不是 Git Repository
- Desktop 和 Mobile 基本是同一套布局缩放
- GitHub Repository 的身份没有成为页面核心
- UI 组件缺少统一 Design System
- 当前 CSS 存在大量历史样式和局部覆盖，继续修改容易形成更多补丁
- 登录、Repository 添加、文件浏览、文件操作等页面之间视觉体系不统一

因此本任务要求：

> **重新设计 GitFiles 的 UI 信息架构和表现层，而不是继续给现有页面增加 CSS 补丁。**

最终目标：

```text
GitFiles
    ↓
不是“一个可以操作 GitHub 的文件管理器”
    ↓
而是“一个以 GitHub Repository 为核心的 Web 文件工作区”
```

---

# 二、严格边界

## 2.1 必须保留

以下内容原则上不得重写或破坏：

- GitHub OAuth / PKCE
- Worker Session
- HttpOnly Cookie
- D1
- Repository ACL
- GitHub API
- Git Data API
- Blob / Tree / Commit / Ref
- CAS
- Conflict Center
- 文件上传
- 文件下载
- 创建
- 删除
- 重命名
- 移动
- 复制
- GitHub Repository 挂载逻辑
- Google Drive / Local Storage 现有业务能力
- PWA 基础能力

UI 重构不得通过修改后端业务逻辑来“绕过问题”。

---

## 2.2 可以重构

允许大范围重构：

- HTML DOM 结构
- 页面布局
- Sidebar
- Header
- Toolbar
- Repository 页面
- File List
- Breadcrumb
- Dialog
- Context Menu
- Empty State
- Login 页面
- Repository Picker
- Settings 页面视觉结构
- Mobile UI
- CSS
- UI component organization
- UI state rendering
- UI event binding

---

# 三、执行前必须做的事情

在修改代码之前：

## 3.1 阅读当前代码

至少检查：

```text
index.html
js/app.js
js/githubdisk.js
js/config.js
css/style.css
workers/entry.js
workers/repos.js
workers/operations.js
```

同时检查：

```text
docs/
AGENTS.md
PROJECT_SPEC.md
tests/
```

确认当前实际 UI、状态管理和业务接口。

---

## 3.2 不允许根据旧报告猜测

必须以当前工作区实际代码为准。

先执行：

```bash
git status
git log -1 --oneline
git branch --show-current
```

确认当前 HEAD。

如果工作区存在用户未提交修改：

> 不得覆盖、删除或重置用户修改。

---

# 四、设计原则

## 4.1 不要“模仿 GitHub 配色”

禁止把以下事情当作完成任务：

```text
换成 GitHub 蓝
换成灰色背景
减小圆角
增加 GitHub logo
修改几个按钮
```

这些只能算视觉微调。

真正要求：

```text
GitHub 的信息架构
+
GitHub Repository 的认知模型
+
现代 Web Workspace 的布局
+
移动端独立设计
```

---

# 五、整体信息架构

推荐采用：

```text
┌──────────────────────────────────────────────────────────┐
│ Header                                                   │
├───────────────┬──────────────────────────────────────────┤
│               │                                          │
│ Application   │ Main Workspace                           │
│ Navigation    │                                          │
│               │                                          │
│               │ Repository / Storage Content             │
│               │                                          │
└───────────────┴──────────────────────────────────────────┘
```

---

# 六、Header V2

Header 不再只是工具按钮集合。

建议结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ GitFiles   [ Search files... ]            +    GitHub   ●    │
└──────────────────────────────────────────────────────────────┘
```

包含：

### 左侧

```text
GitFiles
```

点击返回工作区首页。

### 中间

全局搜索：

```text
Search files...
```

先实现 UI 和交互入口即可。

如果现有全局搜索业务能力不足，不得为了 UI 重构强行修改后端。

### 右侧

包括：

- 创建/添加入口
- 当前 Storage / GitHub 状态
- 用户头像
- 用户菜单

用户菜单至少包含：

```text
Account
Settings
Sign out
```

---

# 七、Sidebar V2

## 7.1 不再把 Sidebar 做成 Windows Explorer

当前 Sidebar 的主要问题是：

> 把“应用导航”和“文件目录”混在一起。

V2 必须区分。

建议：

```text
GitFiles

WORKSPACE
  Repositories
  Recent
  Starred

STORAGE
  GitHub
  Google Drive
  Local

ACCOUNT
  Settings
```

---

# 八、Repository 导航

GitHub Repository 是 GitFiles 最重要的数据对象。

Sidebar 不应该直接无限展开 GitHub Repository 内部目录。

建议：

```text
GitHub

  Repositories
    Notes
    Documents
    Photos
```

点击 Repository：

```text
GitHub / Notes
```

进入 Repository Workspace。

进入后再浏览：

```text
/
├── docs
├── images
├── src
└── README.md
```

---

# 九、Repository 页面 V2

Repository 页面必须成为整个项目的核心页面。

建议结构：

```text
Repository Header
────────────────────────────────────

owner / repository

Private
default branch: main

[ Files ] [ History ]

────────────────────────────────────

Breadcrumb
owner / repository / docs

[ main ▼ ]       [ Add file ▼ ] [ ... ]

────────────────────────────────────

File List
```

---

# 十、Repository Header

例如：

```text
owner / repository

Private repository

main ▼
```

视觉层级必须明确：

```text
Owner / Repository
```

比：

```text
当前目录名称
```

优先级更高。

用户必须一眼知道：

> 我现在浏览的是哪个 GitHub Repository。

---

# 十一、Breadcrumb

不要继续使用传统文件管理器式 Breadcrumb。

推荐：

```text
owner / repository / docs / images
```

每一级可点击。

移动端空间不足时：

```text
… / docs / images
```

但必须保留当前目录。

---

# 十二、Branch Selector

Branch 是 GitFiles 的核心概念之一。

不要把 Branch 隐藏到 Settings。

应该在 Repository 文件区上方明确显示：

```text
[ main ▼ ]
```

打开后：

```text
main
develop
feature/xxx
```

如果当前 Repository 默认分支不是 `main`：

> 必须使用 Repository 实际 default branch。

不要在 UI 层硬编码 `main`。

---

# 十三、File List V2

文件列表不要再设计成纯 Windows Explorer。

推荐：

```text
Name                         Last commit
────────────────────────────────────────────
📁 docs/                     Update docs
📁 images/                   Add images
📁 src/                      Refactor
📄 README.md                 Update README
📄 config.json               Fix configuration
```

核心字段：

```text
Name
Git information
```

文件大小等次要信息可以在需要时显示。

---

# 十四、文件列表交互

## 默认状态

保持干净：

```text
Name
Last commit
```

## Hover

显示：

```text
Rename
Move
Copy
Delete
More
```

## 选中

顶部出现 Context Toolbar：

```text
2 selected

[ Move ] [ Copy ] [ Delete ] [ ... ]
```

不要始终显示所有操作。

---

# 十五、Toolbar V2

禁止长期保留：

```text
New
Upload
Copy
Move
Rename
Delete
Refresh
More
```

全部平铺。

推荐：

```text
[ Add file ▼ ]                 [ ... ]
```

Add file：

```text
Create new file
Upload files
```

选中文件后：

```text
[ Move ] [ Copy ] [ Delete ] [ ... ]
```

这样默认页面保持干净。

---

# 十六、Context Menu

右键 Desktop：

```text
New file
Upload
Paste
Refresh
```

文件：

```text
Open
Rename
Move
Copy
Download
Delete
```

目录：

```text
Open
Rename
Move
Copy
Delete
```

移动端不得依赖右键。

---

# 十七、Dialog V2

所有 Dialog 必须统一设计。

统一：

```text
标题
说明
内容
操作区
```

例如删除：

```text
Delete README.md?

This action will create a new commit
that removes this file from the repository.

Cancel                 Delete
```

危险操作按钮必须明确。

---

# 十八、Empty State

不要显示传统：

```text
此文件夹为空
```

应该根据上下文设计。

Repository 空：

```text
This repository is empty

Create your first file or upload files
to get started.

[ Create file ] [ Upload files ]
```

没有 Repository：

```text
No repositories mounted

Connect a repository to start working.

[ Add repository ]
```

---

# 十九、登录页面 V2

登录页不要继续使用传统管理后台式布局。

建议：

```text
                 GitFiles

        Your files, your repositories.

             [ Continue with GitHub ]

             Secure OAuth authentication
```

视觉重点：

```text
品牌
一句话说明
GitHub 登录
```

不要出现大量技术说明。

---

# 二十、Repository Picker V2

登录后如果需要选择 Repository：

```text
GitHub repositories

[ Search repositories... ]

Private
  Notes
  Documents

Public
  ...

                         [ Connect ]
```

必须区分：

```text
已连接
未连接
```

不要让用户误以为：

> GitHub 登录 = 自动创建 Repository。

---

# 二十一、跨设备同步后的 UI

当前最新代码已经支持登录后发现 GitHub Repository。

UI 必须适应这个逻辑。

建议：

```text
GitHub

CONNECTED
  Notes
  Documents

AVAILABLE REPOSITORIES
  Project A
  Project B
```

或者：

```text
Repositories

Connected
  Notes
  Documents

All repositories
  Project A
  Project B
```

不能因为自动发现 Repository，就把用户全部 GitHub Repository 无差别塞进主要导航。

---

# 二十二、Storage 抽象

GitHub、Google Drive、Local Storage 应该有统一 Storage 模型。

例如：

```text
STORAGE

GitHub
  Notes
  Documents

Google Drive
  My Drive

Local
  Local files
```

不同 Storage 使用统一视觉组件。

---

# 二十三、Desktop 设计要求

Desktop 最小目标：

```text
≥ 1024px
```

推荐：

```text
Header
Sidebar 240~280px
Main Workspace
```

Sidebar 支持：

```text
展开
折叠
```

折叠后只保留图标。

Main Workspace 不应该被固定宽度限制得过窄。

---

# 二十四、Mobile 必须独立设计

这是本次重构的重点。

禁止：

> Desktop 页面缩小后作为 Mobile UI。

Mobile 必须重新设计布局。

推荐：

```text
┌──────────────────────┐
│ ☰  GitFiles       ⋮ │
├──────────────────────┤
│ GitHub / Notes       │
│ main ▼               │
├──────────────────────┤
│ 📁 documents         │
│ 📁 images            │
│ 📄 README.md         │
│ 📄 config.json       │
└──────────────────────┘
```

---

# 二十五、Mobile Navigation

Sidebar 在 Mobile 上改为：

```text
Drawer
```

通过：

```text
☰
```

打开。

不得强行把 Desktop Sidebar 压缩成几十像素。

---

# 二十六、Mobile File List

Mobile 默认：

> **List，而不是 Grid。**

不要继续使用：

```css
minmax(76px, 1fr)
minmax(88px, 1fr)
```

来塞大量文件图标。

推荐：

```text
📁 documents
────────────────
📁 images
────────────────
📄 README.md
────────────────
📄 config.json
```

每一行：

```text
min-height ≥ 44px
```

重要操作按钮：

```text
≥44 × 44px
```

---

# 二十七、Mobile Bottom Navigation

如果经过实际测试发现 Sidebar Drawer 对高频操作不够方便，可以使用：

```text
Repositories
Recent
Settings
```

底部导航。

但不要为了“像 App”而强行增加没有实际意义的 Tab。

---

# 二十八、Responsive Breakpoints

不要只写：

```css
@media (max-width: xxx)
```

然后不断覆盖旧 CSS。

应该重新建立：

```text
Desktop
Tablet
Mobile
```

三个明确布局状态。

---

# 二十九、Design System

必须建立统一 CSS Variables。

至少包括：

```css
--color-bg
--color-surface
--color-border
--color-text
--color-muted
--color-accent
--color-danger
--color-success

--space-1
--space-2
--space-3
--space-4
--space-5
--space-6

--radius-sm
--radius-md

--font-size-sm
--font-size-md
--font-size-lg

--header-height
--sidebar-width
```

禁止继续大量使用历史变量：

```text
--win-*
```

如果这些变量已经没有实际语义：

> 删除并统一迁移。

---

# 三十、不要大量使用圆角卡片

GitHub 风格不是：

```text
┌──────────────┐
│   Card       │
└──────────────┘
```

页面不应该到处都是：

```text
border-radius: 12px
box-shadow
```

推荐：

- 轻边框
- 少量圆角
- 大量留白
- 明确层级
- 高信息密度
- 不滥用阴影

---

# 三十一、颜色

不要追求：

> 整个页面都是 GitHub 蓝。

推荐：

```text
背景：中性灰/白
文字：深灰
边框：浅灰
Accent：GitHub Blue
Danger：红色
Success：绿色
```

Accent 只用于：

- Link
- Primary Button
- Active state
- Focus
- Selected state

---

# 三十二、图标

统一使用项目现有图标系统。

不要为了 UI 重构：

> 随意引入多个图标库。

如果现有图标系统可以满足要求：

> 优先复用。

如果当前某些图标名称和实际图形不一致：

> 可以统一重命名，但不得破坏业务引用。

---

# 三十三、动画

不要增加大量动画。

允许：

```text
Drawer
Dialog
Dropdown
Toast
Loading
```

使用短、克制的 transition。

禁止：

```text
页面大量飞入
文件卡片弹跳
过度缩放
持续动画
```

---

# 三十四、Loading 状态

不要全部使用：

```text
Loading...
```

推荐：

```text
Skeleton
```

Repository：

```text
Repository Header skeleton
File list skeleton
```

这样首次打开页面不会产生明显闪烁。

---

# 三十五、Error 状态

错误不能只写 Console。

统一：

```text
Inline Error
Toast
Dialog
```

根据严重程度决定。

例如：

```text
Failed to load repository

Try again

[ Retry ]
```

---

# 三十六、Success / Operation Feedback

文件操作必须给用户明确反馈：

```text
Uploaded 3 files
```

```text
File renamed
```

```text
Changes committed
```

```text
Conflict detected
```

不要只写：

```text
console.log()
```

---

# 三十七、Conflict Center UI

Conflict Center 需要保持独立的视觉层级。

推荐：

```text
Conflict detected

Repository:
owner / repo

Local base:
abc123

Remote HEAD:
def456

Remote repository changed
before your operation was committed.

[ Reload remote ] [ Review conflict ]
```

按钮名称必须让普通用户看懂。

不要使用：

```text
应用到最新远端状态
```

这种容易产生歧义的描述。

如果实际行为是重新读取远端并重新应用操作：

> 使用：

```text
重新应用当前操作
```

或类似明确文案。

---

# 三十八、Settings

Settings 不应该继续像传统管理后台。

推荐：

```text
Settings

General
Appearance
Storage
GitHub
Sync
About
```

左侧导航 + 右侧设置内容。

Mobile 改成：

```text
Settings
────────────
General >
Appearance >
Storage >
GitHub >
Sync >
About >
```

---

# 三十九、性能要求

本次 UI 重构不得以牺牲性能换视觉效果。

必须避免：

```text
大量 innerHTML 重建整个页面
大量重复 render
每次鼠标移动触发完整 render
大量 DOM 节点
不必要的 API 请求
```

---

# 四十、Tree 数据与 UI 解耦

UI 重构时：

> 不允许让 File List 直接绑定 GitHub API。

应该保持：

```text
GitHub API
    ↓
GithubDisk / Repository State
    ↓
UI View Model
    ↓
FileList
```

这样以后实现 Tree Cache 时不需要重新写 UI。

---

# 四十一、Tree Cache 兼容要求

当前代码存在：

```js
force
```

参数，但实际 Tree Cache 并没有真正实现。

本次 UI 重构：

> 不要求直接实现完整 Tree Cache。

但必须保证：

```text
FileList
Repository State
Tree loading
```

结构上允许以后加入：

```text
owner/repo/branch/head
```

缓存。

不得继续增加依赖：

```text
每打开目录 → 强制重新拉完整 Tree
```

---

# 四十二、避免重复 /api/me

UI 初始化过程中不要重复请求：

```text
/api/me
```

如果当前 UI 重构需要调整登录初始化：

应尽可能形成：

```text
Session
 ↓
Profile
 ↓
Repository discovery
```

避免：

```text
/me
/repos
/me
```

这种重复请求。

如果发现该问题属于现有业务代码而不是 UI：

> 可以单独提交 P1 优化，但不要为了 UI 重构大范围改业务。

---

# 四十三、Repository Discovery

当前 `/api/repos` 已经用于跨设备同步。

UI 必须兼容：

```text
default_branch
html_url
private
can_read
can_write
```

如果当前 API 返回字段不足：

> 不得在前端假造字段。

应该报告为独立 API 修复任务。

特别注意：

> 不得默认假定所有 Repository 的 default branch 都是 `main`。

---

# 四十四、CSS 重构要求

这是本任务最重要的技术要求之一。

## 禁止

继续：

```text
旧 CSS
 ↓
追加 CSS
 ↓
追加 @media
 ↓
!important
 ↓
覆盖旧规则
```

## 要求

对现有 CSS：

1. 找出历史布局规则
2. 删除已经废弃的 UI 规则
3. 建立新的 Design System
4. 重新建立 Layout
5. 重新建立 Components
6. 最后建立 Responsive rules

最终 CSS 应该能够回答：

```text
Layout 在哪里？
Component 在哪里？
Mobile 在哪里？
Theme 在哪里？
State 在哪里？
```

而不是依靠搜索大量：

```text
!important
```

才能理解。

---

# 四十五、HTML 重构要求

如果当前 `index.html` 的 DOM 结构明显服务于旧 UI：

> 可以整体重新组织。

推荐：

```html
<header>
</header>

<div class="app-shell">

  <aside class="sidebar">
  </aside>

  <main class="workspace">
  </main>

</div>
```

而不是继续在旧 DOM 上增加大量 wrapper。

---

# 四十六、JavaScript UI 层

如果当前：

```text
app.js
```

同时承担：

```text
API
State
DOM
Event
Rendering
Toast
Dialog
Navigation
```

可以在不改变业务 API 的情况下进行合理拆分。

推荐最终方向：

```text
js/
  app.js
  githubdisk.js

  ui/
    layout.js
    sidebar.js
    header.js
    repository.js
    file-list.js
    dialogs.js
    menus.js
    toast.js
```

但：

> **不要为了“模块化”而进行无意义的大规模重构。**

如果当前代码结构已经可以稳定工作，可以先完成 UI V2，再逐步拆分。

---

# 四十七、可访问性

至少保证：

- Keyboard navigation
- Focus state
- `aria-label`
- Dialog focus
- Escape 关闭 Dialog/Menu
- Enter/Space 操作按钮
- 文件列表键盘操作
- 颜色不能成为唯一状态提示

---

# 四十八、触控要求

所有主要交互：

```text
≥44 × 44px
```

包括：

- Menu button
- Back
- More
- Add
- Checkbox
- File action
- Dialog action

不要为了视觉紧凑把实际点击区域做成：

```text
24px
32px
36px
40px
```

---

# 四十九、PWA

必须保持：

- Mobile viewport 正常
- Safe area
- Standalone 模式正常
- Drawer 正常
- Dialog 不被屏幕底部遮挡
- 操作按钮不会被浏览器 UI 覆盖

---

# 五十、视觉验收页面

完成后至少检查以下状态：

## 1. 未登录

```text
Login
```

## 2. 登录后无 Repository

```text
Empty workspace
```

## 3. 登录后有多个 Repository

```text
Repository navigation
```

## 4. Repository 根目录

```text
/
```

## 5. Repository 深层目录

```text
owner / repo / docs / images
```

## 6. 空目录

```text
Empty directory
```

## 7. 文件选中

```text
Context toolbar
```

## 8. 多文件选中

```text
Multi-selection
```

## 9. 上传

```text
Upload progress
```

## 10. 删除

```text
Delete dialog
```

## 11. Rename

```text
Rename dialog
```

## 12. Move

```text
Move dialog
```

## 13. Conflict

```text
Conflict Center
```

## 14. Markdown Preview

```text
Preview
```

## 15. Mobile

至少：

```text
360px
390px
430px
```

## 16. Desktop

至少：

```text
1280px
1440px
1920px
```

---

# 五十一、必须特别检查 Markdown / SVG Preview

当前项目已经具备文件预览能力。

UI V2 不得因为重构而降低安全性。

必须确认：

```text
Markdown
HTML
SVG
```

预览不会因为：

```text
<script>
javascript:
onclick=
onerror=
iframe
```

等内容造成 XSS。

如果发现当前 Preview 本身存在安全问题：

> 单独记录为 P1 安全问题并修复。

---

# 五十二、禁止事项

Codex 执行时禁止：

### 禁止 1

仅修改：

```text
颜色
圆角
阴影
字体
```

然后宣称完成。

---

### 禁止 2

在旧 CSS 后面继续增加大量：

```css
@media
!important
```

---

### 禁止 3

删除现有业务功能。

---

### 禁止 4

修改 OAuth / Session / Git Data API 来配合 UI。

---

### 禁止 5

为了 UI 重构引入大型 UI Framework。

除非当前项目已经使用，否则不要突然引入：

```text
React
Vue
Ant Design
MUI
Bootstrap
```

等。

---

### 禁止 6

把 Desktop UI 简单缩小成 Mobile。

---

### 禁止 7

把所有 GitHub Repository 自动变成用户“已挂载”的 Repository。

UI 必须能够区分：

```text
Connected
Available
```

---

### 禁止 8

默认假定：

```text
default_branch = main
```

---

# 五十三、实施阶段

## Phase 1：UI 现状审计

先不要修改代码。

输出：

```text
当前页面
当前 DOM
当前 CSS
当前 UI State
当前组件
当前问题
```

并列出：

```text
可以保留
必须重写
可以删除
```

---

# Phase 2：建立 Design System

先建立：

```text
颜色
字体
间距
边框
圆角
按钮
Input
Menu
Dialog
Toast
```

---

# Phase 3：重构 App Shell

实现：

```text
Header
Sidebar
Main Workspace
```

先不要处理复杂文件操作。

---

# Phase 4：重构 Repository Workspace

实现：

```text
Repository Header
Branch Selector
Breadcrumb
Toolbar
File List
```

---

# Phase 5：重构交互

实现：

```text
Selection
Context Menu
Dialog
Toast
Loading
Error
Empty State
```

---

# Phase 6：Mobile V2

单独设计：

```text
Header
Drawer
Repository Header
File List
Action Menu
Dialog
```

不要复制 Desktop DOM 后单纯缩放。

---

# Phase 7：Preview / Conflict / Settings

统一这些页面的视觉体系。

---

# Phase 8：清理旧 UI

最后删除：

- 无用 CSS
- 旧变量
- 重复 Media Query
- 废弃 DOM
- 无效 UI State
- 无用 Event Handler

---

# 五十四、Git Commit 要求

建议分阶段提交：

```text
ui: add GitFiles V2 design system

ui: rebuild application shell

ui: rebuild repository workspace

ui: rebuild file list and toolbar

ui: rebuild dialogs and context menus

ui: add mobile UI v2

ui: rebuild settings and preview states

ui: remove legacy UI styles
```

不要一次提交一个几千行无法审查的混合 commit。

---

# 五十五、验收标准

完成后必须满足：

## A. 视觉

打开 GitFiles 后：

> 用户第一眼应该感觉这是一个现代 Git Repository Workspace，而不是 Windows 文件管理器。

---

## B. GitHub Repository 认知

用户必须明确看到：

```text
owner
repository
branch
path
```

---

## C. 文件操作

常用操作：

```text
Create
Upload
Rename
Move
Copy
Delete
Download
```

必须容易找到，但不能全部长期占据 Toolbar。

---

## D. Mobile

手机上：

> 不允许出现“缩小版桌面文件管理器”的感觉。

---

## E. Responsive

至少验证：

```text
360
390
430
768
1024
1280
1440
1920
```

---

## F. Touch

主要操作：

```text
≥44px
```

---

## G. Accessibility

键盘、Focus、Dialog、Menu 必须基本可用。

---

## H. Performance

UI 重构后不得出现：

- 明显全页面重复 render
- 滚动卡顿
- 打开目录明显变慢
- 大量无意义 DOM
- API 请求数量明显增加

---

# 五十六、最终报告

完成后不要只告诉我：

> “UI 已经优化完成”。

必须输出：

## 1. 修改文件

```text
file
change
reason
```

## 2. 删除的旧代码

```text
file
removed
reason
```

## 3. 新 UI 架构

```text
Header
Sidebar
Workspace
Repository
FileList
Dialogs
Mobile
```

## 4. 性能影响

说明：

```text
是否增加 API 请求
是否增加 DOM
是否增加 JS bundle
是否增加首屏时间
```

## 5. 移动端测试

报告：

```text
360px
390px
430px
```

## 6. Desktop 测试

报告：

```text
1280px
1440px
1920px
```

## 7. 发现但没有修改的问题

必须单独列出：

```text
P0
P1
P2
```

不能为了宣称完成而隐藏问题。

---

# 五十七、最终完成定义

只有同时满足以下条件，才算 UI V2 完成：

```text
[ ] 不是旧 UI 上继续打补丁
[ ] 新 App Shell
[ ] 新 Header
[ ] 新 Sidebar
[ ] 新 Repository Workspace
[ ] 新 Breadcrumb
[ ] 新 Branch Selector
[ ] 新 File List
[ ] 新 Toolbar
[ ] 新 Context Menu
[ ] 新 Dialog
[ ] 新 Empty State
[ ] 新 Loading/Error
[ ] 新 Login
[ ] 新 Repository Picker
[ ] 新 Settings
[ ] 新 Mobile Layout
[ ] 新 Design System
[ ] 清理旧 CSS
[ ] 清理旧 DOM
[ ] Desktop 测试
[ ] Mobile 测试
[ ] Accessibility 基础测试
[ ] Preview 安全回归
[ ] 不破坏现有 GitHub/Git Data 功能
```

---

# 最重要的一句话

**不要把“GitFiles UI V2”理解成给现有 UI 换一套颜色。**

本任务真正要求的是：

```text
旧：

Windows / Explorer
       ↓
文件管理器
       ↓
GitHub 功能

新：

GitFiles Workspace
       ↓
GitHub Repository
       ↓
Branch / Path / Files
       ↓
Git Operations
```

**业务引擎可以继续使用现有实现，但 UI 信息架构和表现层必须重新设计。**

如果发现当前某个旧组件严重阻碍 V2：

> 可以删除并重新实现，不要为了保留旧 DOM 而继续打补丁。

最终判断标准不是：

> “代码有没有改很多。”

而是：

> **打开 GitFiles 后，是否已经从“文件管理器”变成真正的“GitHub Repository Web Workspace”。**