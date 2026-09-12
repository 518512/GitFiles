#!/usr/bin/env node
/**
 * 生成 GitFiles 应用图标（SVG 源 + 各尺寸 PNG）。
 *
 * 为什么自己写：本仓库没有前端构建链，也没有第三方依赖（AGENTS.md §29）。
 * 常见的做法（rsvg-convert / sharp / canvas）都会引入新的工具链或二进制依赖，
 * 因此这里用「一份几何定义 → 同时产出 SVG 与 PNG」的方式：
 *
 *   1. GEOMETRY 是唯一的几何/配色来源，SVG 与 PNG 都由它派生，不会各自漂移；
 *   2. SVG 直接拼字符串输出（矢量、可缩放、体积小）；
 *   3. PNG 用自带的扫描线光栅化 + zlib 手写编码（Node 内置 zlib，无外部依赖）。
 *
 * 设计延续原方案的识别特征（蓝色文件夹 + 白色菱形 + Git 分支图腾），
 * 但改为自绘矢量几何，以解决位图源在小尺寸（16/32px）下糊成一团的问题。
 *
 * ⚠️ 本脚本是**备选**来源（自绘矢量）。当前生效的图标来自 `docs/图标源图-20260912.png`，
 * 由 `scripts/build-logo-from-image.mjs` 生成。两者产出同一组文件名，**会互相覆盖**，
 * 因此本脚本默认拒绝执行，必须显式加 `--force` 才会写入：
 *
 *   node scripts/build-logo-from-image.mjs "docs/图标源图-20260912.png"   # 当前采用
 *   node scripts/build-logo.mjs --force                                   # 切回矢量版
 *   node scripts/build-logo.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');

// ---------------------------------------------------------------------------
// 设计定义（512x512 设计坐标）
// ---------------------------------------------------------------------------

const DESIGN = 512;

const COLOR = {
  tileTop: '#2684fc',
  tileBottom: '#0a4fd8',
  backTop: '#8fd0ff',
  backBottom: '#3fa4f5',
  frontTop: '#2b95ff',
  frontBottom: '#0a52e6',
  accent: '#7ac5fd',
  white: '#ffffff',
  ink: '#0a52e6',
};

/** 一个圆角矩形的路径（既可画，也可用于 SVG） */
function roundRectPath(x, y, w, h, r) {
  return [
    `M${x + r},${y}`,
    `H${x + w - r}`,
    `A${r},${r} 0 0 1 ${x + w},${y + r}`,
    `V${y + h - r}`,
    `A${r},${r} 0 0 1 ${x + w - r},${y + h}`,
    `H${x + r}`,
    `A${r},${r} 0 0 1 ${x},${y + h - r}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    'Z',
  ].join(' ');
}

/**
 * 文件夹主体轮廓：左上角起一段较窄的 tab 台阶，其余为圆角矩形。
 *
 * 注意 tabH 刻意大于圆角半径 r，所以左边是「先直落再圆角」，不能像矩形那样
 * 先画圆弧 —— 早期版本在 tabH > r 时生成了退化的 A 指令（起终点重合），
 * 视觉上靠光栅化掩盖了，但导出的 SVG 路径是错的。
 */
function folderPath(x, y, w, h, r, tabW, tabH, tabR) {
  return [
    // 左边：从 tab 顶部直落到底部圆角
    `M${x},${y + tabH}`,
    `V${y + h - r}`,
    `A${r},${r} 0 0 1 ${x + r},${y + h}`,
    // 底边
    `H${x + w - r}`,
    `A${r},${r} 0 0 1 ${x + w},${y + h - r}`,
    // 右边
    `V${y + tabH + r}`,
    `A${r},${r} 0 0 1 ${x + w - r},${y + tabH}`,
    // 主体上边 → 回到 tab 右侧
    `H${x + tabW}`,
    // tab 右侧圆角收口 + 顶边
    `V${y + tabR}`,
    `A${tabR},${tabR} 0 0 1 ${x + tabW - tabR},${y}`,
    `H${x + tabR}`,
    `A${tabR},${tabR} 0 0 1 ${x},${y + tabR}`,
    'Z',
  ].join(' ');
}

const GEOMETRY = {
  tile: { x: 0, y: 0, w: 512, h: 512, r: 116 },
  // 背面两张「垫在后面」的卡片：只在右上角露出窄边，暗示「多个存储」。
  // 刻意做得小且浅，避免与主文件夹争夺视觉重心。
  back: { x: 250, y: 108, w: 124, h: 148, r: 18 },
  back2: { x: 216, y: 84, w: 96, h: 112, r: 16 },
  // 前面主文件夹（视觉重心）：tabH 明显大于 tabR，tab 才能读出「文件夹」轮廓。
  // 宽度收窄到 296，让 tab 台阶在整体构图中可辨。
  front: { x: 58, y: 178, w: 288, h: 288, r: 36, tabW: 204, tabH: 56, tabR: 22 },
  // 白色菱形（Git 图腾底板）：居中于前面文件夹，四周留出蓝色边距
  diamond: { cx: 204, cy: 334, half: 74, r: 12 },
  // Git 分支图腾（菱形内，深蓝）
  git: {
    stroke: 13,
    nodes: [
      { x: 174, y: 300, r: 14 },  // 分支起点
      { x: 174, y: 370, r: 14 },  // 主干末端
      { x: 238, y: 334, r: 14 },  // 分支末端
    ],
    trunk: { x1: 174, y1: 300, x2: 174, y2: 370 },
    branch: { x1: 174, y1: 300, x2: 226, y2: 334 },
  },
};

/**
 * 菱形路径（四角圆角）。
 *
 * 用二次贝塞尔让圆角恰好「顶到」原始顶点：控制点取该顶点本身，曲线中点
 * 因此正好落在顶点上 —— 这样 SVG 的几何与光栅化里的 |dx|+|dy| <= half
 * 判定完全一致，两个产出不会互相漂移。
 */
function diamondPath({ cx, cy, half, r }) {
  const t = { x: cx, y: cy - half };
  const right = { x: cx + half, y: cy };
  const b = { x: cx, y: cy + half };
  const left = { x: cx - half, y: cy };
  const lerp = (a, p, k) => ({ x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k });
  const k = Math.min(0.9, r / Math.max(half, 1)); // 圆角比例（相对半对角）
  const tA = lerp(t, right, k), rA = lerp(right, t, k);
  const rB = lerp(right, b, k), bB = lerp(b, right, k);
  const bC = lerp(b, left, k), lC = lerp(left, b, k);
  const lD = lerp(left, t, k), tD = lerp(t, left, k);
  return [
    `M${tA.x},${tA.y}`,
    `Q${right.x},${right.y} ${rA.x},${rA.y}`,
    `Q${b.x},${b.y} ${bB.x},${bB.y}`,
    `Q${left.x},${left.y} ${lC.x},${lC.y}`,
    `Q${t.x},${t.y} ${tD.x},${tD.y}`,
    'Z',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// SVG 输出
// ---------------------------------------------------------------------------

function buildSvg() {
  const g = GEOMETRY;
  const body = [];
  body.push('<defs>');
  body.push(`<linearGradient id="tile" x1="0" y1="0" x2="0" y2="${DESIGN}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.tileTop}"/><stop offset="1" stop-color="${COLOR.tileBottom}"/></linearGradient>`);
  body.push(`<linearGradient id="back" x1="0" y1="${g.back.y}" x2="0" y2="${g.back.y + g.back.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.backTop}"/><stop offset="1" stop-color="${COLOR.backBottom}"/></linearGradient>`);
  body.push(`<linearGradient id="front" x1="0" y1="${g.front.y}" x2="0" y2="${g.front.y + g.front.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.frontTop}"/><stop offset="1" stop-color="${COLOR.frontBottom}"/></linearGradient>`);
  body.push('</defs>');
  body.push(`<rect width="${DESIGN}" height="${DESIGN}" rx="${g.tile.r}" fill="url(#tile)"/>`);
  body.push(`<rect x="${g.back2.x}" y="${g.back2.y}" width="${g.back2.w}" height="${g.back2.h}" rx="${g.back2.r}" fill="${COLOR.backTop}" opacity="0.75"/>`);
  body.push(`<rect x="${g.back.x}" y="${g.back.y}" width="${g.back.w}" height="${g.back.h}" rx="${g.back.r}" fill="url(#back)"/>`);
  body.push(`<path d="${folderPath(g.front.x, g.front.y, g.front.w, g.front.h, g.front.r, g.front.tabW, g.front.tabH, g.front.tabR)}" fill="url(#front)"/>`);
  body.push(`<path d="${diamondPath(g.diamond)}" fill="${COLOR.white}"/>`);
  body.push(`<g stroke="${COLOR.ink}" stroke-width="${g.git.stroke}" stroke-linecap="round" fill="none">`);
  body.push(`<line x1="${g.git.trunk.x1}" y1="${g.git.trunk.y1}" x2="${g.git.trunk.x2}" y2="${g.git.trunk.y2}"/>`);
  body.push(`<line x1="${g.git.branch.x1}" y1="${g.git.branch.y1}" x2="${g.git.branch.x2}" y2="${g.git.branch.y2}"/>`);
  body.push('</g>');
  for (const n of g.git.nodes) {
    body.push(`<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${COLOR.ink}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN} ${DESIGN}" role="img" aria-label="GitFiles"><title>GitFiles</title>\n${body.join('\n')}\n</svg>\n`;
}

/** 小尺寸专用：16/32px 下细节会糊，所以只保留文件夹 + 菱形 + 一个 Git 节点 */
function buildFaviconSvg() {
  const g = GEOMETRY;
  const scale = 512 / 32;
  const s = (v) => (v / scale).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="GitFiles"><title>GitFiles</title>
<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.tileTop}"/><stop offset="1" stop-color="${COLOR.tileBottom}"/></linearGradient><linearGradient id="f" x1="0" y1="${s(g.front.y)}" x2="0" y2="${s(g.front.y + g.front.h)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.frontTop}"/><stop offset="1" stop-color="${COLOR.frontBottom}"/></linearGradient></defs>
<rect width="32" height="32" rx="7.25" fill="url(#t)"/>
<path d="${folderPath(g.front.x / scale, g.front.y / scale, g.front.w / scale, g.front.h / scale, g.front.r / scale, g.front.tabW / scale, g.front.tabH / scale, g.front.tabR / scale)}" fill="url(#f)"/>
<path d="${diamondPath({ cx: g.diamond.cx / scale, cy: g.diamond.cy / scale, half: g.diamond.half / scale, r: g.diamond.r / scale })}" fill="${COLOR.white}"/>
<g stroke="${COLOR.ink}" stroke-width="1.4" stroke-linecap="round" fill="none"><line x1="${s(g.git.trunk.x1)}" y1="${s(g.git.trunk.y1)}" x2="${s(g.git.trunk.x2)}" y2="${s(g.git.trunk.y2)}"/><line x1="${s(g.git.branch.x1)}" y1="${s(g.git.branch.y1)}" x2="${s(g.git.branch.x2)}" y2="${s(g.git.branch.y2)}"/></g>
<circle cx="${s(g.git.nodes[0].x)}" cy="${s(g.git.nodes[0].y)}" r="1.5" fill="${COLOR.ink}"/>
<circle cx="${s(g.git.nodes[1].x)}" cy="${s(g.git.nodes[1].y)}" r="1.5" fill="${COLOR.ink}"/>
<circle cx="${s(g.git.nodes[2].x)}" cy="${s(g.git.nodes[2].y)}" r="1.5" fill="${COLOR.ink}"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// 光栅化（纯 JS，无依赖）
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 点是否在圆角矩形内 */
function inRoundRect(px, py, r) {
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
  const rx = Math.min(r.r, r.w / 2);
  const ry = Math.min(r.r, r.h / 2);
  const cx = Math.min(Math.max(px, r.x + rx), r.x + r.w - rx);
  const cy = Math.min(Math.max(py, r.y + ry), r.y + r.h - ry);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rx * ry + 0.0001 || (px >= r.x + rx && px <= r.x + r.w - rx) || (py >= r.y + ry && py <= r.y + r.h - ry);
}

/** 点是否在文件夹轮廓内（tab 台阶 + 圆角底） */
function inFolder(px, py, f) {
  if (px < f.x || px > f.x + f.w || py < f.y || py > f.y + f.h) return false;
  const rx = f.r;
  // tab 区域：左上角一块矩形凸起
  if (py <= f.y + f.tabH) return px <= f.x + f.tabW;
  // 主体圆角矩形
  const bodyY = f.y + f.tabH;
  const cx = Math.min(Math.max(px, f.x + rx), f.x + f.w - rx);
  const cy = Math.min(Math.max(py, bodyY - rx), f.y + f.h - rx);
  const dx = px - cx;
  const dy = py - cy;
  if (dx * dx + dy * dy <= rx * rx + 0.0001) return true;
  return (px >= f.x + rx && px <= f.x + f.w - rx) || (py >= bodyY && py <= f.y + f.h - rx && px >= f.x && px <= f.x + f.w);
}

/** 点到线段距离（用于 Git 连线） */
function distToSegment(px, py, s) {
  const vx = s.x2 - s.x1;
  const vy = s.y2 - s.y1;
  const wx = px - s.x1;
  const wy = py - s.y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = px - (s.x1 + t * vx);
  const dy = py - (s.y1 + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** 菱形：|dx|/half + |dy|/half <= 1 */
function inDiamond(px, py, d) {
  return (Math.abs(px - d.cx) + Math.abs(py - d.cy)) <= d.half;
}

function inTriangle(px, py, pts) {
  const [a, b, c] = pts;
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign({ x: px, y: py }, a, b);
  const d2 = sign({ x: px, y: py }, b, c);
  const d3 = sign({ x: px, y: py }, c, a);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/** 在超采样网格上计算某点(设计坐标)的颜色，返回 [r,g,b,a]，a 为 0/1 */
function samplePoint(px, py, simple = false, tiny = false) {
  const g = GEOMETRY;
  // 小尺寸（16/32px）下背层卡片会糊成噪点、git 图腾会看不清，
  // 因此小尺寸使用简化几何：只保留文件夹 + 放大的菱形与图腾。
  const diamond = simple ? { cx: 214, cy: 318, half: 104, r: 12 } : g.diamond;
  const git = simple
    ? {
      stroke: 26,
      nodes: [{ x: 172, y: 266, r: 26 }, { x: 172, y: 372, r: 26 }, { x: 256, y: 320, r: 26 }],
      trunk: { x1: 172, y1: 266, x2: 172, y2: 372 },
      branch: { x1: 172, y1: 266, x2: 240, y2: 320 },
    }
    : g.git;

  if (!inRoundRect(px, py, g.tile)) return null;
  const tile = [COLOR.tileTop, COLOR.tileBottom];
  // 从下往上依次覆盖，取最上层命中
  if (inDiamond(px, py, diamond)) {
    if (tiny) return hexToRgb(COLOR.white);
    for (const n of git.nodes) {
      const dx = px - n.x, dy = py - n.y;
      if (dx * dx + dy * dy <= n.r * n.r) return hexToRgb(COLOR.ink);
    }
    if (distToSegment(px, py, git.trunk) <= git.stroke / 2) return hexToRgb(COLOR.ink);
    if (distToSegment(px, py, git.branch) <= git.stroke / 2) return hexToRgb(COLOR.ink);
    return hexToRgb(COLOR.white);
  }
  if (inFolder(px, py, g.front)) {
    const t = (py - g.front.y) / g.front.h;
    return mix(hexToRgb(COLOR.frontTop), hexToRgb(COLOR.frontBottom), t);
  }
  if (!simple && inRoundRect(px, py, g.back)) {
    const t = (py - g.back.y) / g.back.h;
    return mix(hexToRgb(COLOR.backTop), hexToRgb(COLOR.backBottom), t);
  }
  if (!simple && inRoundRect(px, py, g.back2)) {
    const t = (py - g.back2.y) / g.back2.h;
    return mix(hexToRgb(COLOR.backTop), hexToRgb(COLOR.backBottom), t);
  }
  if (false) {
    const t = (py - g.back.y) / g.back.h;
    return mix(hexToRgb(COLOR.backTop), hexToRgb(COLOR.backBottom), t);
  }
  const t = py / DESIGN;
  return mix(hexToRgb(tile[0]), hexToRgb(tile[1]), t);
}

function mix(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const SS = 4; // 每个输出像素 4x4 超采样

/** 渲染 size x size 的 RGBA，返回 Buffer（PNG 原始扫描线数据） */
function renderRgba(size, { maskOnly = false, simple = false, tiny = false } = {}) {
  const scale = DESIGN / size;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) * scale;
          const py = (y + (sy + 0.5) / SS) * scale;
          const c = samplePoint(px, py, simple, tiny);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits += 1; }
        }
      }
      const total = SS * SS;
      const o = x * 4;
      if (maskOnly) {
        // 单色遮罩（用白色），alpha 为覆盖率
        row[o] = 255; row[o + 1] = 255; row[o + 2] = 255;
        row[o + 3] = Math.round((hits / total) * 255);
      } else if (hits === 0) {
        row[o] = 0; row[o + 1] = 0; row[o + 2] = 0; row[o + 3] = 0;
      } else {
        row[o] = Math.round(r / hits);
        row[o + 1] = Math.round(g / hits);
        row[o + 2] = Math.round(b / hits);
        row[o + 3] = Math.round((hits / total) * 255);
      }
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前置 filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const LOGO_SIZES = [48, 72, 128, 180, 192, 512];
const FAVICON_SIZES = [16, 32];

function buildAll() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const written = [];

  // SVG 源
  const svgPath = path.join(ASSETS, 'logo.svg');
  fs.writeFileSync(svgPath, buildSvg());
  written.push(['logo.svg', fs.statSync(svgPath).size]);

  const favSvgPath = path.join(ASSETS, 'favicon.svg');
  fs.writeFileSync(favSvgPath, buildFaviconSvg());
  written.push(['favicon.svg', fs.statSync(favSvgPath).size]);

  // PNG：每个尺寸独立渲染（16/32 用简化几何的小尺寸 SVG 风格渲染）
  for (const size of LOGO_SIZES) {
    const png = encodePng(size, renderRgba(size));
    const file = path.join(ASSETS, `logo-${size}.png`);
    fs.writeFileSync(file, png);
    written.push([`logo-${size}.png`, png.length]);
  }
  for (const size of FAVICON_SIZES) {
    // 16px 连简化图腾都糊，只保留文件夹 + 菱形
    const png = encodePng(size, renderRgba(size, { simple: true, tiny: size <= 16 }));
    const file = path.join(ASSETS, `favicon-${size}.png`);
    fs.writeFileSync(file, png);
    written.push([`favicon-${size}.png`, png.length]);
  }

  return written;
}

function checkAll() {
  const expected = [
    ...LOGO_SIZES.map((s) => [`logo-${s}.png`, s]),
    ...FAVICON_SIZES.map((s) => [`favicon-${s}.png`, s]),
  ];
  const problems = [];
  for (const [name, size] of expected) {
    const file = path.join(ASSETS, name);
    if (!fs.existsSync(file)) { problems.push(`${name}: 缺失`); continue; }
    const buf = fs.readFileSync(file);
    if (buf.readUInt32BE(0) !== 0x89504e47) { problems.push(`${name}: 不是 PNG`); continue; }
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== size || h !== size) problems.push(`${name}: 尺寸 ${w}x${h}，期望 ${size}x${size}`);
    if (buf[25] !== 6) problems.push(`${name}: 色彩类型 ${buf[25]}，期望 6(RGBA)`);
  }
  for (const name of ['logo.svg', 'favicon.svg']) {
    const file = path.join(ASSETS, name);
    if (!fs.existsSync(file)) problems.push(`${name}: 缺失`);
    else if (!fs.readFileSync(file, 'utf8').includes('<svg')) problems.push(`${name}: 不是 SVG`);
  }
  return problems;
}

const check = process.argv.includes('--check');
const force = process.argv.includes('--force');
if (!check && !force) {
  console.error('build-logo: 这是备选（矢量）来源，会覆盖 image 版图标。');
  console.error('  当前采用：node scripts/build-logo-from-image.mjs "docs/图标源图-20260912.png"');
  console.error('  确实要切回矢量版请加 --force');
  process.exit(2);
}
if (check) {
  const problems = checkAll();
  if (problems.length) {
    problems.forEach((p) => console.error(`error ${p}`));
    process.exit(1);
  }
  console.log('build-logo: 全部图标存在且尺寸正确');
} else {
  const written = buildAll();
  for (const [name, bytes] of written) console.log(`  ${name.padEnd(20)} ${String(bytes).padStart(7)} B`);
  console.log(`build-logo: 已生成 ${written.length} 个图标文件`);
}
