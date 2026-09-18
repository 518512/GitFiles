#!/usr/bin/env node
/**
 * CSS 层叠审计（无浏览器环境下的静态检查）。
 *
 * 背景：自 2026-09-18 起本项目只有一份样式表 `css/style.css`，但文件内部
 * 仍分两层——
 *   历史基础层   文件头部（上游时代遗留，含历史 !important）
 *   V2 覆盖层    文末 `V2_LAYER_START` 标记之后（原 css/ui-v2.css 并入）
 *
 * 本脚本以 `V2_LAYER_START` 标记把单文件切回两层做静态比对：
 *   对给定的类名，列出两层里所有命中它的规则（含来源行号、是否在 @media 内、
 *   是否 !important），并**标记出哪些属性只被历史层设置、V2 层没有显式复位**
 *   ——这些就是"可能泄漏"的候选。
 *
 * 用法：
 *   node scripts/audit-css.mjs                       # 审计 UI 已知的迁移元素
 *   node scripts/audit-css.mjs ribbon file-tools …   # 审计指定类名
 *
 * 退出码：0（本脚本只做报告，不阻断构建）；--strict 时未处理泄漏返回 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'css/style.css';
/** 单文件内两层切分标记（见 css/style.css 文末 V2_LAYER_START 小节）。 */
const V2_MARKER = 'V2_LAYER_START';

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

/** 该规则是否位于 @media 内（向前找最近的未闭合 '{'） */

/** 解析 CSS 为声明列表 */
/**
 * 去掉注释但保留换行数，避免破坏行号。
 *
 * 必须先去掉注释：规则体里的 /* ... *\/ 会被下面的 `([^{}]*)\}`
 * 一起吞掉，导致该花括号无法闭合，于是**后续整段规则全部解析错位**——
 * 早先版本因此把「已经复位过的属性」误报为泄漏（例如 .ribbon .file-tools
 * 已经 background: transparent，却仍报告历史层的 background: #fff 在胜出）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * 解析一段 CSS 文本为声明列表。
 * @param {string} relPath   展示用的文件路径（行号归一到该文件）
 * @param {string} layer     层名（'历史' 或 'V2'），用于区分层叠来源
 * @param {string} source    CSS 源码（可能只是单文件的一部分）
 * @param {number} lineOffset 该段在真实文件中的起始行（0 基偏移），用于行号还原
 */
function parseCss(relPath, layer, source, lineOffset = 0) {
  const src = stripComments(source);
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
    const line = lineOffset + lineOf(src, m.index + rawSel.length);
    for (const decl of body.split(';')) {
      const d = decl.trim();
      const c = d.indexOf(':');
      if (c <= 0) continue;
      const prop = d.slice(0, c).trim();
      const value = d.slice(c + 1).trim();
      for (const one of sel.split(',')) {
        const s = one.trim();
        if (s) out.push({ file: relPath, layer, line, media, sel: s, prop, value, important: /!important/.test(value) });
      }
    }
  }
  return out;
}

/**
 * 已确认「历史层的值就是 V2 期望值」的属性白名单。
 *
 * 这些属性在层叠中由历史层胜出，但**核对后认为在新布局下依然正确**，
 * 因此不写覆盖规则（写了反而制造重复）。列入白名单等于显式登记这个判断，
 * 而不是把它藏在"没人注意到"里。
 *
 * 新增条目必须在注释里写明理由；发现理由不成立时应改为真正复位。
 */
const ALLOWED_LEGACY = new Map(Object.entries({
  ribbon: { 'flex-shrink': '工具栏在纵向不收缩' },
  'nav-buttons': { 'flex-shrink': '按钮组不被压扁' },
  'view-toggle': { 'flex-shrink': '同上' },
  'tool-btn': {
    display: '按钮需 flex 居中', 'align-items': '同上', 'justify-content': '同上',
    cursor: '可点击指针', background: '透明底（V2 亦为透明）',
    border: '透明占位边框，便于 hover 变色',
  },
  'address-bar': { 'border-color': 'border 已为 0，颜色无实际影响' },
  breadcrumbs: {
    overflow: '横向滚动容器需要裁剪',
    'font-size': '13px，与 V2 正文一致',
    '-webkit-overflow-scrolling': '移动端惯性滚动',
  },
  'file-tools': { 'flex-wrap': '仅窄屏媒体查询内，与 V2 的 wrap 一致' },
  sidebar: {
    display: '侧栏需竖向 flex', 'flex-direction': '同上', 'flex-shrink': '不参与收缩',
    position: '移动端抽屉定位', top: '同上', left: '同上', bottom: '同上',
    'z-index': '抽屉层级', 'max-width': '抽屉最大宽度', transform: '收起时移出视口',
    'box-shadow': '抽屉投影', 'padding-top': '安全区适配', 'padding-bottom': '安全区适配',
  },
  'sidebar-tree': { 'list-style': '列表需去点' },
  'tree-row': { 'display': '行内 flex', 'align-items': '同上', 'min-width': '允许压缩', 'padding-right': '与图标对齐的微调' },
  'list-header': {
    position: '表头吸顶', top: '同上', 'z-index': '吸顶层级',
    'background': '表头底色', padding: '表头内边距', 'font-size': '紧凑字号',
    'font-weight': '表头加粗', 'border-bottom-color': '仅改颜色，边框本身由 V2 提供',
  },
  'list-row': {
    cursor: '可点击指针', 'align-items': '行内对齐', border: '透明占位边框',
    '-webkit-touch-callout': '移动端长按行为', gap: '紧凑间距', 'font-size': '紧凑字号',
  },
  'file-grid': { display: '网格容器', 'grid-template-columns': '自适应列宽', gap: '紧凑间距', padding: '容器内边距' },
  'empty-state': {
    display: '居中布局', 'flex-direction': '纵向', 'align-items': '居中',
    'justify-content': '居中', gap: '元素间距', color: '次要文字色',
    height: '占满可用高度', background: '与表面色一致',
  },
  'status-bar': {
    display: '横向 flex', 'align-items': '垂直居中', gap: '元素间距',
    padding: '内边距', 'font-size': '紧凑字号', color: '次要文字色',
    'flex-shrink': '不参与收缩', 'min-height': '最小高度',
    'border-top-color': '仅改颜色，边框本身由 V2 提供',
    'padding-bottom': '安全区适配', 'padding-left': '与主区域内边距对齐',
    'padding-right': '同上',
  },
  'overview-panel': {}, 'overview-storage-item': {}, 'user-menu': {},
  'repository-header': {}, 'repository-tab': {}, 'sidebar-nav': {}, 'sidebar-nav-item': {},
}));

// 单文件按 V2_LAYER_START 标记切回两层；行号归一到真实文件。
const fullCss = fs.readFileSync(path.join(ROOT, BASE), 'utf8');
const markerIdx = fullCss.indexOf(V2_MARKER);
if (markerIdx === -1) {
  throw new Error(`未找到 V2_LAYER_START 标记（${BASE} 应包含原 ui-v2.css 的 V2 覆盖层小节）`);
}
const baseSource = fullCss.slice(0, markerIdx);
const v2Source = fullCss.slice(markerIdx);
const v2LineOffset = baseSource.split('\n').length - 1; // 0 基：V2 段第一行的前一行号
const baseRules = parseCss(BASE, '历史', baseSource, 0);
const v2Rules = parseCss(BASE, 'V2', v2Source, v2LineOffset);
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

  // 判定「泄漏」：对每个属性，找出真正在层叠中胜出的声明。
  //
  // 不能用「V2 是否出现过同名属性」来判断——早先的实现就是这么写的，
  // 会把 display / flex 这类"历史层与 V2 层都设、且 V2 用更高特异性胜出"的
  // 属性误报为泄漏（100 条候选里大部分是这种误报）。
  //
  // 正确做法：候选规则只取「以该类结尾的选择器」（即整条规则就是为这个元素设的），
  // 按 (特异性, 层叠顺序) 取最大值；若胜出者来自历史层，才算真正泄漏。
  const rxEnd = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])\\s*$`);
  const byProp = new Map();
  // allRules 的顺序 = 历史层全部规则，再 V2 覆盖层全部规则，
  // 正好等价于浏览器里「历史层先、V2 层后」的层叠顺序。
  allRules.forEach((r, index) => {
    if (!rxEnd.test(r.sel)) return;
    const spec = specificity(r.sel);
    const prev = byProp.get(r.prop);
    const better = !prev
      || spec > prev.spec
      || (spec === prev.spec && index > prev.index)
      || (r.important && !prev.important);
    if (better) byProp.set(r.prop, { ...r, spec, index });
  });
  const leaks = [];
  const handled = [];
  for (const [prop, winner] of byProp) {
    const baseDecl = exact.find((r) => r.layer === '历史' && r.prop === prop);
    if (!baseDecl) continue; // 历史层没设过这个属性，无需关心
    if (winner.layer === '历史') {
      // 历史层胜出：检查 V2 是否"根本没管"这个属性（真正的泄漏）
      leaks.push(winner);
    } else {
      handled.push({ base: baseDecl, winner });
    }
  }

  if (verbose) {
    console.log(`\n### .${cls} —— 命中 ${hits.length} 条`);
    for (const h of exact) {
      const tag = h.layer === '历史' ? '历史' : ' V2 ';
      console.log(`  [${tag}] ${h.file}:${h.line}${h.media ? ' [media]' : ''}  ${h.prop}: ${h.value}${h.important ? '  !important' : ''}`);
    }
    if (scoped.length) {
      console.log(`  -- 带前缀/后代选择器 ${scoped.length} 条 --`);
      for (const h of scoped) {
        const tag = h.layer === '历史' ? '历史' : ' V2 ';
        console.log(`  [${tag}] ${h.file}:${h.line}${h.media ? ' [media]' : ''}  ${h.sel} { ${h.prop}: ${h.value}${h.important ? ' !important' : ''} }`);
      }
    }
  }
  return { cls, leaks, handled, exact, scoped };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = args.length ? args : DEFAULT_TARGETS;

console.log(`审计 ${targets.length} 个类；已解析 ${baseRules.length} 条(历史层) + ${v2Rules.length} 条(V2 覆盖层)\n`);

const STRICT = process.argv.includes('--strict');
let leakCount = 0;
let handledCount = 0;
let allowedCount = 0;
const results = [];
for (const cls of targets) {
  const r = audit(cls, { verbose: true });
  if (!r) continue;
  const allowedProps = ALLOWED_LEGACY.get(cls) || {};
  const kept = r.leaks.filter((l) => allowedProps[l.prop]);
  const real = r.leaks.filter((l) => !allowedProps[l.prop]);
  r.allowed = kept;
  r.real = real;
  allowedCount += kept.length;
  leakCount += real.length;
  handledCount += r.handled.length;
  results.push(r);
}

console.log('\n' + '='.repeat(72));
console.log('未处理：历史层在层叠中胜出，且未登记为「有意保留」');
let shown = 0;
for (const r of results) {
  if (!r.real.length) continue;
  shown += 1;
  console.log(`\n  .${r.cls}`);
  for (const l of r.real) {
    console.log(`    ${l.file}:${l.line} (spec ${l.spec})  ${l.prop}: ${l.value}${l.important ? '  !important' : ''}`);
  }
}
if (!shown) console.log('  （无）');

console.log('\n已登记为有意保留（历史值即 V2 期望值，见 ALLOWED_LEGACY 注释）：');
let shownAllowed = 0;
for (const r of results) {
  if (!r.allowed?.length) continue;
  shownAllowed += 1;
  console.log(`  .${r.cls}: ${r.allowed.map((l) => l.prop).join(', ')}`);
}
if (!shownAllowed) console.log('  （无）');

// ---------------------------------------------------------------------------
// 层内重复：同一选择器在同**一**层里被定义多次（与跨层覆盖无关）。
// 这是历史层多代样式叠加留下的痕迹，跨层审计看不到，因此单独报告。
// 仅作提示、不参与 --strict 判定：历史遗留量较大，清理需要专门排期。
// ---------------------------------------------------------------------------
for (const [layerName, rules] of [['历史层', baseRules], ['V2 覆盖层', v2Rules]]) {
  const linesBySel = new Map();
  for (const rule of rules) {
    if (rule.media) continue; // 媒体查询里的重设通常是有意的断点覆盖
    if (!linesBySel.has(rule.sel)) linesBySel.set(rule.sel, new Set());
    linesBySel.get(rule.sel).add(rule.line);
  }
  const duplicates = [...linesBySel.entries()].filter(([, lines]) => lines.size > 1);
  console.log(`\n层内重复（${layerName}）：${duplicates.length} 个选择器在同一层被定义多次`);
  for (const [sel, lines] of duplicates.slice(0, 15)) {
    const nums = [...lines];
    console.log(`  ${nums.length}x ${sel} @ ${nums.join(', ')}`);
  }
  if (duplicates.length > 15) console.log(`  … 其余 ${duplicates.length - 15} 个`);
}

console.log(`\n未处理 ${leakCount} 条；已登记 ${allowedCount} 条；已被 V2 层接管 ${handledCount} 条。`);
if (STRICT && leakCount) {
  console.error('\n--strict: 存在未处理的样式泄漏，视为失败。');
  process.exit(1);
}
