#!/usr/bin/env node
/**
 * UI 结构校验（无浏览器环境下的静态检查）。
 *
 * 这个项目没有前端测试框架，UI 改动此前只能靠人工看页面，容易漏掉
 * 「改了 HTML 但 JS 仍在查旧 id」「删了样式但 CSS 还在选择器里」这类问题。
 * 本脚本做四件事，全部是确定性检查，可在 CI/本地快速运行：
 *
 *   1. HTML 中是否存在重复 id
 *   2. js/ 里 $('#x') / getElementById('x') 引用的 id 是否存在于某个 HTML
 *   3. index.html / notepad.html / 404.html 是否都存在样式表且顺序为
 *      style.css → ui-v2.css（层叠顺序约定，见 css/ui-v2.css 顶部注释）
 *   4. css/ui-v2.css 与 css/style.css 中的类选择器是否至少被 HTML/JS 使用
 *      （仅告警，不失败：历史样式允许存在未使用选择器）
 *
 * 用法：node scripts/check-ui.mjs
 * 退出码：0 = 通过；1 = 有 error
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const HTML_FILES = ['index.html', 'notepad.html', '404.html', 'github-oauth-callback.html', 'privacy.html', 'terms.html'];
const errors = [];
const warnings = [];

// --- 1. 重复 id -------------------------------------------------------------
const idsByFile = new Map();
for (const rel of HTML_FILES) {
  if (!fs.existsSync(path.join(root, rel))) continue;
  const html = read(rel);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  idsByFile.set(rel, seen);
  for (const id of dupes) errors.push(`${rel}: 重复的 id="${id}"`);
}

// --- 2. JS 引用的 id 必须存在 ----------------------------------------------
const allIds = new Set();
for (const ids of idsByFile.values()) for (const id of ids) allIds.add(id);

const jsFiles = fs.readdirSync(path.join(root, 'js'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `js/${name}`);
// js/github/ 是仅测试用的历史引擎，不参与生产 UI，跳过。
const jsSources = jsFiles.concat(['js/github']);

// id 也可以由 JS 动态创建（例如 Dialog 惰性插入 #app-dialog），这类 id 不在
// HTML 里出现是正常的，不能报错。
const createdIds = new Set();
for (const rel of jsFiles) {
  const code = read(rel);
  for (const m of code.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) createdIds.add(m[1]);
  for (const m of code.matchAll(/id="([A-Za-z0-9_-]+)"/g)) createdIds.add(m[1]);
}

const referenced = new Map();
for (const rel of jsSources) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  let code = '';
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) continue;
    code = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  for (const m of code.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) referenced.set(m[1], rel);
  for (const m of code.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.set(m[1], rel);
}
const dynamicPrefixes = ['overview-', 'notepad-'];
for (const [id, rel] of referenced) {
  if (allIds.has(id)) continue;
  if (createdIds.has(id)) continue;
  if (dynamicPrefixes.some((prefix) => id.startsWith(prefix))) continue;
  errors.push(`${rel}: 引用了不存在的 id="${id}"`);
}

// --- 3. 样式表顺序 ----------------------------------------------------------
for (const rel of ['index.html', 'notepad.html', '404.html']) {
  const html = read(rel);
  const baseIndex = html.indexOf('data-storage-hub-css ');
  const v2Index = html.indexOf('data-storage-hub-css-v2');
  if (baseIndex === -1) errors.push(`${rel}: 缺少 data-storage-hub-css（style.css）`);
  if (v2Index === -1) errors.push(`${rel}: 缺少 data-storage-hub-css-v2（ui-v2.css）`);
  if (baseIndex !== -1 && v2Index !== -1 && v2Index < baseIndex) {
    errors.push(`${rel}: ui-v2.css 出现在 style.css 之前，层叠顺序被反转`);
  }
}

// --- 4. CSS 类选择器使用情况（告警）----------------------------------------
const htmlAndJs = HTML_FILES
  .filter((rel) => fs.existsSync(path.join(root, rel)))
  .map(read)
  .join('\n')
  .concat(jsSources
    .filter((rel) => fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile())
    .map((rel) => read(rel))
    .join('\n'));

for (const cssRel of ['css/ui-v2.css', 'css/style.css']) {
  const css = read(cssRel).replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unused = [...classes].filter((name) => !htmlAndJs.includes(name));
  if (unused.length) {
    warnings.push(`${cssRel}: ${unused.length} 个类选择器未被 HTML/JS 引用 → ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ' …' : ''}`);
  }
}

// --- 输出 -------------------------------------------------------------------
for (const message of warnings) console.warn(`warn  ${message}`);
for (const message of errors) console.error(`error ${message}`);
console.log(`\ncheck-ui: ${idsByFile.size} 个 HTML、${referenced.size} 个 id 引用、${errors.length} 个 error、${warnings.length} 个 warning`);
process.exit(errors.length ? 1 : 0);
