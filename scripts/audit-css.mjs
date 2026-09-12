#!/usr/bin/env node
/**
 * CSS 层叠审计（无浏览器环境下的静态检查）。
 *
 * 背景：本项目有两层样式表——
 *   css/style.css   历史基础层（约 3400 行，含历史 !important，上游时代遗留）
 *   css/ui-v2.css   设计令牌与 V2 覆盖层，必须最后加载
 *
 * `style.css` 里的规则是在**旧布局**下写的。当某个元素被搬进新的结构
 * （例如 `.file-tools` 从独立工具栏并入 `.ribbon`）后，它的定位/装饰属性
 * （白底、border-bottom、padding、min-height…）往往不再成立，却仍然生效，
 * 表现为「多出一条横线」「间距莫名变大」这类问题。
 *
 * 这类问题靠肉眼逐个页面看很难查全，因此用本脚本静态比对：
 *   对给定的类名，列出两层样式表里所有命中它的规则（含来源文件、行号、
 *   是否在 @media 内、是否 !important），并**标记出哪些属性只被历史层设置、
 *   V2 层没有显式复位** —— 这些就是"可能泄漏"的候选。
 *
 * 用法：
 *   node scripts/audit-css.mjs                       # 审计 UI 已知的迁移元素
 *   node scripts/audit-css.mjs ribbon file-tools …   # 审计指定类名
 *
 * 退出码：0（本脚本只做报告，不阻断构建）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'css/style.css';
const V2 = 'css/ui-v2.css';

/** 被搬进新结构、需要重点核对的历史元素 */
const DEFAULT_TARGETS = [
  'ribbon', 'app-brand', 'app-header-actions', 'header-action', 'header-repo-state',
  'nav-buttons', 'address-bar', 'breadcrumbs', 'breadcrumb-item',
  'file-tools', 'view-toggle', 'tool-btn', 'search-box', 'sort-select',
  'sidebar', 'sidebar-nav', 'sidebar-nav-item', 'sidebar-tree', 'tree-row',
  'list-header', 'list-row', 'file-grid', 'empty-state', 'status-bar',
  'repository-header', 'repository-tab', 'overview-panel', 'overview-storage-item',
  'user-menu', 'user-menu-panel', 'user-menu-item',
];

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** 解析 CSS 为声明列表 */
function parseCss(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const rawSel = m[1];
    const body = m[2];
    // 判断是否位于 @media 内：向前扫描，找到最近的未闭合 '{'
    let media = false;
    let depth = 0;
    for (let i = m.index - 1; i >= 0; i -= 1) {
      const ch = src[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          media = /@media/.test(src.slice(Math.max(0, i - 120), i));
          break;
        }
        depth -= 1;
      }
    }
    const sel = rawSel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!sel || sel.startsWith('@')) continue;
    const line = lineOf(src, m.index + rawSel.length);
    for (const decl of body.split(';')) {
      const d = decl.trim();
      const c = d.indexOf(':');
      if (c <= 0) continue;
      const prop = d.slice(0, c).trim();
      const value = d.slice(c + 1).trim();
      for (const one of sel.split(',')) {
        const s = one.trim();
        if (s) out.push({ file: relPath, line, media, sel: s, prop, value, important: /!important/.test(value) });
      }
    }
  }
  return out;
}

const baseRules = parseCss(BASE);
const v2Rules = parseCss(V2);
const allRules = [...baseRules, ...v2Rules];

/** 命中某个类的规则（选择器里出现 .cls） */
function hitsFor(cls) {
  const rx = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  return allRules.filter((r) => rx.test(r.sel));
}

/** 简易特异性：id*100 + class/attr/pseudo-class*10 + 元素*1 */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length
    + (sel.match(/\[[^\]]+\]/g) || []).length
    + (sel.match(/:(?!:)[\w-]+/g) || []).length;
  const tags = (sel.match(/^[a-zA-Z][\w-]*|[\s>+~][a-zA-Z][\w-]*/g) || []).length;
  return ids * 100 + classes * 10 + tags;
}

function audit(cls, { verbose = true } = {}) {
  const hits = hitsFor(cls);
  if (!hits.length) return null;
  const exact = hits.filter((h) => h.sel === `.${cls}`);
  const scoped = hits.filter((h) => h.sel !== `.${cls}`);

  // 找出「历史层设置了、但 V2 层没有为同类选择器显式复位」的属性
  const baseProps = new Map();
  for (const h of exact.filter((r) => r.file === BASE)) baseProps.set(h.prop, h);
  const leaks = [];
  for (const [prop, decl] of baseProps) {
    const v2SameScope = exact.some((r) => r.file === V2 && r.prop === prop);
    // V2 里任何以该元素结尾的规则覆盖了同名属性，也算已处理
    const v2Any = allRules.some((r) => r.file === V2 && r.prop === prop
      && new RegExp(`\\.${cls}(?![\\w-])\\s*$`).test(r.sel));
    if (!v2SameScope && !v2Any) leaks.push(decl);
  }

  if (verbose) {
    console.log(`\n### .${cls} —— 命中 ${hits.length} 条`);
    for (const h of exact) {
      const tag = h.file === BASE ? '历史' : ' V2 ';
      console.log(`  [${tag}] ${h.file}:${h.line}${h.media ? ' [media]' : ''}  ${h.prop}: ${h.value}${h.important ? '  !important' : ''}`);
    }
    if (scoped.length) {
      console.log(`  -- 带前缀/后代选择器 ${scoped.length} 条 --`);
      for (const h of scoped) {
        const tag = h.file === BASE ? '历史' : ' V2 ';
        console.log(`  [${tag}] ${h.file}:${h.line}${h.media ? ' [media]' : ''}  ${h.sel} { ${h.prop}: ${h.value}${h.important ? ' !important' : ''} }`);
      }
    }
  }
  return { cls, leaks, exact, scoped };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = args.length ? args : DEFAULT_TARGETS;

console.log(`审计 ${targets.length} 个类；已解析 ${baseRules.length} 条(style.css) + ${v2Rules.length} 条(ui-v2.css)\n`);

let leakCount = 0;
const results = [];
for (const cls of targets) {
  const r = audit(cls, { verbose: true });
  if (!r) continue;
  results.push(r);
  if (r.leaks.length) leakCount += r.leaks.length;
}

console.log('\n' + '='.repeat(72));
console.log('可能泄漏的历史属性（历史层设置了、V2 层未显式复位）：');
let shown = 0;
for (const r of results) {
  if (!r.leaks.length) continue;
  shown += 1;
  console.log(`\n  .${r.cls}`);
  for (const l of r.leaks) {
    console.log(`    ${BASE}:${l.line}  ${l.prop}: ${l.value}${l.important ? '  !important' : ''}`);
  }
}
if (!shown) console.log('  （无）');
console.log(`\n合计 ${leakCount} 条候选。请逐条确认这些属性在新布局下是否仍然成立。`);
console.log('注意：本脚本是静态提示，不是错误——有些属性在新布局下依然正确。');
