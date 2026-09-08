# 改造记录：Google Client ID 缺失防御与 config.local.js 占位

- 日期：2026-09-08
- 关联：`docs/改造记录-20260908-登录页GitHub按钮.md`

## 问题现象（用户控制台）

1. `config.local.js:1 Uncaught SyntaxError: Unexpected token '<'`
2. `app.js:2764 _.Cd`（Google GSI 压缩库抛出的 Error，经 App.init().catch 打印）

## 根因

1. `not_found_handling: "single-page-application"` 下，不存在的
   `js/config.local.js` 返回 **200 + index.html**，`<script>` 把 HTML 当 JS
   解析报语法错误（GH Pages 时代为 404 状态故无此噪音）
2. 用户未配置 `CONFIG_GOOGLE_CLIENT_ID` → `CONFIG.CLIENT_ID` 为空 →
   `google.accounts.oauth2.initTokenClient({client_id:''})` 被 GSI 压缩库
   抛出内部错误；该异常发生在 App.init 的初始化链中，存在中断后续步骤
   （bindEvents 等）的风险

## 修改了什么

1. `js/auth.js`：`CONFIG.CLIENT_ID` 为空或 `YOUR_*` 占位时**跳过 GSI 初始化**
   并回调 `{initialized:false}`；`signIn()` 在 tokenClient 未就绪时回调
   友好错误（指向 CONFIG_GOOGLE_CLIENT_ID 配置指引）
2. `js/app.js`：Auth.init 回调新增 `initialized === false` 分支（提示但不中断）；
   旧占位检测 `'YOUR_CLIENT_ID.apps...'` 扩展为空值/`YOUR_*` 检测，.login-hint
   提示文案同步更新（并加 null 保护）
3. `scripts/build-config.mjs`：部署产物缺少 `js/config.local.js` 时生成占位
   注释文件（本地开发时仓库根的 config.local.js 照常随产物发布），
   消除 SPA-200 模式下的控制台噪音

## 为什么改

两处报错虽不阻断 GitHub 登录，但污染控制台、误导排查方向（本次用户即被
误导认为配置仍有问题），且 GSI 抛错有中断应用初始化的风险。

## 涉及文件

- `js/auth.js`、`js/app.js`、`scripts/build-config.mjs`、`js/app-version.js`

## 测试情况

- 三个文件语法检查通过；`build-config.mjs` 本地运行验证占位文件生成
- 引擎回归 32/32 通过
- 端到端待用户 Sync fork 重新部署后验证：控制台应无上述两条报错

## 遗留问题

无
