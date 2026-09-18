# 改造记录 20260918 CSS 单文件化与 Windows 风格清理

## 背景

上一轮「设计令牌统一」（`docs/改造记录-20260912-设计令牌统一.md`）只把
`--win-*` 改为引用 `--color-*`，但遗留了三件事：

1. **令牌迁移未完成**：ui-v2.css 的 `:root` 令牌块被删除时漏掉了 `--space-*` 系列，
   而 ui-v2.css 内仍有 5 处 `var(--space-1..4)` 引用——这些属性在浏览器里解析失败
   （回退到初始值），顶栏 `gap` / `padding` 会塌成 0，是真实布局 bug。
2. **Windows 风格残留**：进度条渐变仍用 Windows 蓝 `#0078d4`；privacy / terms 的
   `theme-color` 仍是 `#0078d4`，与主应用的 `#1a7ff5` 不一致。
3. **死代码未清**：`--win-*` 别名、`local-drive-icon`、`app-dialog-perms` 等无引用类仍在。

用户要求：删除 Windows 风格、清理无用/未引用代码，并把两个 CSS 整理成一个。

## 做了什么

### 1. 完成令牌迁移（修复 `--space-*` 缺失）

`css/style.css` 的 `:root` 补齐 `--space-1..6`（4/8/12/16/20/24px），
与 ui-v2.css 原定义一致。合并后全文件「使用 vs 定义」校验通过：0 个未定义变量。

### 2. 删除 Windows 风格残留

- `.file-icon-progress__bar` 渐变 `linear-gradient(90deg, #0078d4, #00a2ed)`
  → `linear-gradient(90deg, var(--color-accent), #54aeff)`（GitHub 蓝系）。
- `privacy.html` / `terms.html` 的 `theme-color` `#0078d4` → `#1a7ff5`
  （与 index / notepad / 404 / manifest 一致）。
- `--win-*` 别名在上一轮未删干净的部分已随 CSS 合并清理；全仓库代码中已无 `--win-*`
  引用（docs/ 历史记录除外）。

### 3. 两个 CSS 合并成一个

`css/ui-v2.css`（750 行）整体并入 `css/style.css` 文末，作为「V2 覆盖层」小节，
以机器可识别的 `V2_LAYER_START` 注释标记切分；删除 `css/ui-v2.css`。

合并保持**原层叠语义不变**：V2 覆盖层规则仍排在整个文件最后，等效于此前
「style.css 先、ui-v2.css 后」的加载顺序。`audit-css.mjs --strict` 合并前后
结果完全一致（未处理 0 / 已登记 59 / 已接管 89）。

引用同步更新：

```text
index.html / notepad.html / 404.html   移除 data-storage-hub-css-v2 link 与相关注释
js/base-path.js                         移除 v2 link 补建/重排逻辑，只处理 style.css
sw.js                                   SHELL_ASSETS 移除 ./css/ui-v2.css
scripts/check-ui.mjs                    样式表检查改为「必须有 style.css、禁止残留 v2 link」
scripts/audit-css.mjs                   改为按 V2_LAYER_START 标记在单文件内切分两层
css/style.css                           文件头注释改写为唯一样式表说明
```

### 4. 清理无用 / 未引用代码

- 删除无引用类 `local-drive-icon`（`.local-storage-icon-wrap` 保留）、
  `app-dialog-perms` / `app-dialog-perms li`（`.app-dialog-message code` 保留）。
- 清理删除遗留的 12 处 3+ 连续空行。
- 保留 JS 动态拼接的类：`file-item--pending-${status}` / `file-pending-badge--${status}`
  由 `js/app.js` 模板生成，check-ui 子串匹配会误报，实际在用，不能删。

## 涉及文件

```text
css/style.css        令牌补齐 + V2 覆盖层并入 + Windows 蓝清理 + 死类删除
css/ui-v2.css        已删除（并入 style.css）
index.html           移除 v2 link
notepad.html         移除 v2 link
404.html             移除 v2 link 与 isCss 判断中的 v2 分支
privacy.html         theme-color 统一
terms.html           theme-color 统一
js/base-path.js      移除 v2 link 处理
sw.js                SHELL_ASSETS 移除 ui-v2.css
scripts/check-ui.mjs 样式表检查适配单文件
scripts/audit-css.mjs 单文件内两层切分（V2_LAYER_START 标记）
js/app-version.js    APP_VERSION 提升（缓存失效）
AGENTS.md / docs/PROJECT_SPEC.md / docs/状态总览-20260912.md / docs/架构现状-20260912.md / docs/README.md
                     文档同步
```

## 测试情况

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs tests/markdown-lite.test.mjs
# pass 52 / fail 0
node tests/github-engine.test.mjs        # 35 passed, 0 failed
node scripts/check-ui.mjs                # 0 error（仅 10 个动态拼接类告警，均为在用）
node scripts/audit-css.mjs --strict      # 未处理 0 条（与合并前一致）
node scripts/build-logo-from-image.mjs --check   # 全部图标存在且尺寸正确
node scripts/build-config.mjs            # public/ 重建，css/ 下仅 style.css
```

- CSS 花括号平衡校验通过；合并后「var(--x) 使用 vs 定义」0 缺失。
- `public/` 已重建，产物中无 `css/ui-v2.css`，也无 `data-storage-hub-css-v2` 引用。

## 遗留问题

- **需真机/浏览器确认视觉效果**：合并后样式与合并前应逐像素一致（层叠顺序未变），
  但本环境无法渲染；重点确认顶栏间距（`--space-*` 修复生效）与进度条颜色。
- `js/github/*.js`、`js/auth.js`、`js/drive.js`、`copyGithubItemToGithub`
  仍是上游遗留死代码（P-03），其中 `js/github/*` 被 35 项测试引用，
  删除需先迁移测试，本轮未动。
- style.css 历史基础层仍有 20 处 `!important` 与若干未引用类，
  按 check-ui 告警逐批清理（已登记 `ALLOWED_LEGACY` 的不算）。
