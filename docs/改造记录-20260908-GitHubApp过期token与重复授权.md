# 改造记录：GitHub App token 过期与重复授权问题

- 日期：2026-09-08
- 关联：`docs/改造记录-20260908-登录页GitHub按钮.md`

## 问题现象（用户报告）

1. 授权完成后 popup 仍反复弹出
2. notepad 打开 `/Drive-2/My Drive/README.md` 后"不知道哪个仓库"（空白草稿）
3. 添加 repo 行为奇怪（每次都要求重新授权）

## 根因（统一解释）

用户配置的 Client ID 是 **GitHub App**（Ov23 前缀），其 user access token
**默认 8 小时过期**，而本项目把 token 存在盘记录（localStorage，遗留架构，
AGENTS §3）且无刷新逻辑。过期后：

- `listFiles` 401 → notepad 静默降级为空白草稿（`openDraftFromPath` 接收
  errorMessage 但从未展示）→"不知道哪个仓库"
- `createDisk()` 每次都调用 `acquireAccessToken()`，**无已有 token 复用检查**
  → 每次添加仓库都弹授权窗，且换到的 token 8 小时后再次失效 → 循环体验

## 修改了什么

1. `js/githubdisk.js` `createDisk()`：先尝试复用现有盘记录中的 token
   （getAuthenticatedUser 验证通过即直接使用），失效才走 `acquireAccessToken`
   弹授权 —— 已登录时添加仓库零弹窗
2. `js/notepad.js`：草稿降级不再静默 —— `app.showError` 透传加载失败原因与
   所在盘（含重新授权提示）

## 为什么改

GitHub App 是用户实际使用的注册形态（Ov23 前缀），token 过期是必然发生的
运行时状态，当前代码对其零处理。

## 涉及文件

- `js/githubdisk.js`、`js/notepad.js`、`js/app-version.js`

## 测试情况

语法检查通过；引擎回归 32/32；端到端待用户部署验证。

## 遗留问题（用户侧一键缓解 + 后续方向）

- **用户侧**：GitHub App → Settings → General → 取消勾选
  **"Expire user authorization tokens"** → token 不再过期（一次性解决失效循环；
  已过期的存量 token 需重新授权一次）
- 后续可选：实现 refresh token 流程（expires_in/refresh_token 已在响应中）
