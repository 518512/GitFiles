#!/usr/bin/env node
/**
 * 从高分辨率位图生成 GitFiles 应用图标（SVG 不解，走高质量重采样）。
 *
 * 背景：图标源图是外部设计稿（1254x1254 PNG），**没有 alpha 通道**，
 * 白底合成，圆角外只有约 3px 抗锯齿过渡。直接用浏览器/工具链缩放会得到
 * 边缘发毛或发虚的结果。因此这里做三件事：
 *
 *   1. **恢复 alpha**：源图的不透明区是圆角方块。对角连通域做泛洪，判定背景；
 *      再用「蓝通道偏离白」估计每个边缘像素的覆盖率 alpha（红通道偏离太小，
 *      不可用）。圆角处越靠外，覆盖率越低，从而还原出原始抗锯齿。
 *   2. **正确的缩放**：全流程在**预乘 alpha + 线性光**空间做 Lanczos-3
 *      重采样。若直接在 sRGB 空间平均、或对未预乘的颜色平均，边缘会出现
 *      深色描边与灰边——这是「边缘不丝滑」的两个常见根因。
 *   3. **按尺寸分档**：小尺寸下细线（同步箭头、窗口圆点）会糊成噪点，
 *      因此 16/32px 使用裁剪放大版（只保留文件夹 + GitHub 猫 + 圆环），
 *      与 `scripts/build-logo.mjs`（矢量版）的分档策略一致。
 *
 * 使用：
 *   node scripts/build-logo-from-image.mjs <源图.png>
 *   node scripts/build-logo-from-image.mjs <源图.png> --check
 *
 * 说明：本脚本与 scripts/build-logo.mjs（自绘矢量版）二选一，都产出
 * assets/ 下同一组文件名，因此调用方（HTML/manifest/SW）无需改动。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');

// 圆角方块在源图中的内缩（由分析得出，四边一致）
const INSET = 46;
// 源图设计稿的圆角半径约 0.216 * 边长（按观感标定）
const CORNER_RATIO = 0.216;

// ---------------------------------------------------------------------------
// PNG 读写（无依赖）
// ---------------------------------------------------------------------------

function readPng(file) {
  const d = fs.readFileSync(file);
  let pos = 8;
  const idat = [];
  let w = 0; let h = 0; let bitd = 8; let colort = 6; let plte = null; let trns = null;
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const typ = d.toString('ascii', pos + 4, pos + 8);
    const data = d.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (typ === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitd = data[8]; colort = data[9];
    } else if (typ === 'IDAT') idat.push(data);
    else if (typ === 'PLTE') plte = data;
    else if (typ === 'tRNS') trns = data;
    else if (typ === 'IEND') break;
  }
  if (bitd !== 8) throw new Error(`只支持 8bit 图，当前 ${bitd}bit`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colort];
  if (!ch) throw new Error(`不支持的色彩类型 ${colort}`);
  const bpp = ch;
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const f = raw[p]; p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    if (f === 1) for (let i = bpp; i < stride; i += 1) line[i] = (line[i] + line[i - bpp]) & 255;
    else if (f === 2) for (let i = 0; i < stride; i += 1) line[i] = (line[i] + prev[i]) & 255;
    else if (f === 3) for (let i = 0; i < stride; i += 1) { const a = i >= bpp ? line[i - bpp] : 0; line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255; }
    else if (f === 4) for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
      const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      line[i] = (line[i] + pr) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  // 展开调色板 / 灰度 / 灰度+A
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    let r; let g; let b; let a = 255;
    if (colort === 3) {
      const idx = out[i];
      r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colort === 0) { r = g = b = out[i]; }
    else if (colort === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else { r = out[i * ch]; g = out[i * ch + 1]; b = out[i * ch + 2]; if (ch === 4) a = out[i * ch + 3]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, rgba };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 1) 从白底位图恢复 alpha
// ---------------------------------------------------------------------------

/**
 * 源图是圆角方块 + 白底。恢复 alpha 的做法：
 *   - 白色（三通道都接近 255）判为背景；
 *   - 但仅按「是否接近白」逐像素判定是不够的：抗锯齿像素既不是纯白也不是
 *     纯色，会被误判为前景而留下白边。
 *   - 因此用蓝通道估计覆盖率：不透明区蓝通道约 250，白底为 254~255，
 *     偏离量越大越不透明；再对连通背景做泛洪，只处理真正位于边界上的像素。
 *
 * 红通道不可用于估计（不透明区红 ~30，白底 254，但抗锯齿中间态的取值
 * 受下方颜色影响更大，线性度差）；蓝通道偏离小但单调，配合 0..1 归一更稳。
 */
function extractAlpha(src) {
  const { w, h, rgba } = src;
  const out = new Uint8ClampedArray(w * h * 4);
  out.set(rgba);

  // 背景判定：三通道均 >= 250 视为白（含抗锯齿外侧）
  const isBg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const r = rgba[i * 4]; const g = rgba[i * 4 + 1]; const b = rgba[i * 4 + 2];
    if (r >= 250 && g >= 250 && b >= 250) isBg[i] = 1;
  }

  // 从四边泛洪，得到「与画布边缘连通」的背景（避免把手绘白色区域误当背景）
  const reach = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const i = y * w + x; if (isBg[i] && !reach[i]) { reach[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x += 1) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 1) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w; const y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  // 对「连通背景像素」按到不透明区的距离给 alpha：
  // 用蓝通道偏离白底的程度估计覆盖率，并做平滑过渡以消除硬阶梯。
  const solidB = 250; // 不透明区蓝通道典型值
  for (let i = 0; i < w * h; i += 1) {
    if (!reach[i]) continue; // 内部不透明像素，保持原样
    const b = rgba[i * 4 + 2];
    // alpha 覆盖率：b 越接近 solidB 越不透明；越接近 255 越透明
    let cov = (255 - b) / (255 - solidB);
    cov = Math.min(1, Math.max(0, cov));
    // 线性映射即可：再做 S 形压缩会把过渡拉宽，小尺寸下表现为一圈白晕。
    out[i * 4 + 3] = Math.round(cov * 255);
  }

  // 收紧 alpha 两端：低覆盖率归零（消除外围淡白光晕），高覆盖率补满
  // （消除圆角内侧的浅色缺口）。这两步对 16/32px 的清晰度影响最大。
  for (let i = 0; i < w * h; i += 1) {
    const a = out[i * 4 + 3];
    if (a <= 26) out[i * 4 + 3] = 0;
    else if (a >= 236) out[i * 4 + 3] = 255;
  }
  return out;
}

/** 按 alpha 反预乘，恢复「未与白底混合」的颜色（消除边缘白边） */
function unpremultiply(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < n; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    if (a <= 0) { out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = 0; continue; }
    out[i * 4] = Math.min(255, Math.round(rgba[i * 4] / a));
    out[i * 4 + 1] = Math.min(255, Math.round(rgba[i * 4 + 1] / a));
    out[i * 4 + 2] = Math.min(255, Math.round(rgba[i * 4 + 2] / a));
    out[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2) 线性光 + 预乘 alpha 的 Lanczos-3 重采样
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

function linearToSrgb(x) {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

function lanczos(x, a = 3) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/**
 * 把已反预乘的 RGBA 图像重采样到 size x size。
 * 关键点：在**线性光**下、对**预乘 alpha** 的通道做加权平均。
 * 这样半透明像素不会把「未预乘的亮色」混进来产生白边/黑边。
 */
function resample(rgba, srcW, srcH, size) {
  // 转为线性 + 预乘
  const lin = new Float32Array(srcW * srcH * 4);
  for (let i = 0; i < srcW * srcH; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    lin[i * 4] = SRGB_TO_LINEAR[rgba[i * 4]] * a;
    lin[i * 4 + 1] = SRGB_TO_LINEAR[rgba[i * 4 + 1]] * a;
    lin[i * 4 + 2] = SRGB_TO_LINEAR[rgba[i * 4 + 2]] * a;
    lin[i * 4 + 3] = a;
  }

  const scaleX = srcW / size;
  const scaleY = srcH / size;
  const supportX = Math.max(3, 3 * scaleX);
  const supportY = Math.max(3, 3 * scaleY);

  // 预计算权重表
  const buildTaps = (dstCount, srcCount, support) => {
    const taps = [];
    const scale = srcCount / dstCount;
    for (let d = 0; d < dstCount; d += 1) {
      const center = (d + 0.5) * scale - 0.5;
      const lo = Math.ceil(center - support);
      const hi = Math.floor(center + support);
      const list = [];
      let sum = 0;
      for (let s = lo; s <= hi; s += 1) {
        const w = lanczos((s - center) / Math.max(1, scale));
        if (w === 0) continue;
        list.push([s, w]);
        sum += w;
      }
      if (sum !== 0) for (const t of list) t[1] /= sum;
      taps.push(list);
    }
    return taps;
  };

  const tapsX = buildTaps(size, srcW, supportX);
  const tapsY = buildTaps(size, srcH, supportY);

  // 水平 pass -> 临时 buffer（srcH x size）
  const tmp = new Float32Array(srcH * size * 4);
  const clampX = (x) => (x < 0 ? 0 : (x >= srcW ? srcW - 1 : x));
  for (let y = 0; y < srcH; y += 1) {
    for (let d = 0; d < size; d += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (const [s, w] of tapsX[d]) {
        const o = (y * srcW + clampX(s)) * 4;
        r += lin[o] * w; g += lin[o + 1] * w; b += lin[o + 2] * w; a += lin[o + 3] * w;
      }
      const o = (y * size + d) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  // 垂直 pass -> 输出
  const outLin = new Float32Array(size * size * 4);
  const clampY = (y) => (y < 0 ? 0 : (y >= srcH ? srcH - 1 : y));
  for (let dy = 0; dy < size; dy += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (const [s, w] of tapsY[dy]) {
        const o = (clampY(s) * size + x) * 4;
        r += tmp[o] * w; g += tmp[o + 1] * w; b += tmp[o + 2] * w; a += tmp[o + 3] * w;
      }
      const o = (dy * size + x) * 4;
      outLin[o] = r; outLin[o + 1] = g; outLin[o + 2] = b; outLin[o + 3] = a;
    }
  }

  // 反预乘 + 回 sRGB
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = Math.min(1, Math.max(0, outLin[i * 4 + 3]));
    if (a <= 0.0001) { out[i * 4 + 3] = 0; continue; }
    out[i * 4] = linearToSrgb(outLin[i * 4] / a);
    out[i * 4 + 1] = linearToSrgb(outLin[i * 4 + 1] / a);
    out[i * 4 + 2] = linearToSrgb(outLin[i * 4 + 2] / a);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** 正方形裁剪（源图内容四周有等量留白，裁掉留白再缩放，避免图标偏小） */
function cropSquare(rgba, w, h, inset) {
  const size = Math.min(w, h) - inset * 2;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const src = ((y + inset) * w + inset) * 4;
    out.set(rgba.subarray(src, src + size * 4), y * size * 4);
  }
  return { rgba: out, size };
}

// ---------------------------------------------------------------------------
// 3) 小尺寸分档裁剪（16/32px 保留核心元素）
// ---------------------------------------------------------------------------

/**
 * 16/32px 下同步箭头与窗口圆点会糊成噪点。这里只保留右下角的
 * 「文件夹 + GitHub 猫 + 圆环」区域并放大，保证小图标可辨。
 * 区域按源图（裁掉留白后的方形）归一化坐标标定。
 */
function cropZoom(rgba, size, box) {
  const x0 = Math.round(box.x * size); const y0 = Math.round(box.y * size);
  const w = Math.round(box.w * size); const h = Math.round(box.h * size);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const src = ((y + y0) * size + x0) * 4;
    out.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return { rgba: out, w, h };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const LOGO_SIZES = [48, 72, 128, 180, 192, 512];
const FAVICON_SIZES = [16, 32];

function build(sourcePath) {
  const src = readPng(sourcePath);
  const alpha = extractAlpha(src);
  const unpre = unpremultiply(alpha);
  const cropped = cropSquare(unpre, src.w, src.h, INSET);

  const results = [];
  for (const size of LOGO_SIZES) {
    const png = encodePng(size, resample(cropped.rgba, cropped.size, cropped.size, size));
    const file = path.join(ASSETS, `logo-${size}.png`);
    fs.writeFileSync(file, png);
    results.push([`logo-${size}.png`, png.length]);
  }
  for (const size of FAVICON_SIZES) {
    // 32px：整图缩放即可（浏览器标签页能读出整体轮廓）。
    // 16px：整图必然糊成一团，裁出右下角的「GitHub 猫 + 同步环」并放大。
    let src = cropped.rgba; let sw = cropped.size; let sh = cropped.size;
    if (size <= 16) {
      const z = cropZoom(cropped.rgba, cropped.size, { x: 0.47, y: 0.44, w: 0.52, h: 0.52 });
      src = z.rgba; sw = z.w; sh = z.h;
    }
    const png = encodePng(size, resample(src, sw, sh, size));
    const file = path.join(ASSETS, `favicon-${size}.png`);
    fs.writeFileSync(file, png);
    results.push([`favicon-${size}.png`, png.length]);
  }

  // SVG：嵌入 512px PNG（源是位图，不做矢量化，避免伪矢量带来的失真）
  const b64 = fs.readFileSync(path.join(ASSETS, 'logo-512.png')).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="GitFiles"><title>GitFiles</title>\n<image width="512" height="512" href="data:image/png;base64,${b64}"/>\n</svg>\n`;
  fs.writeFileSync(path.join(ASSETS, 'logo.svg'), svg);
  results.push(['logo.svg', svg.length]);

  const favB64 = fs.readFileSync(path.join(ASSETS, 'favicon-32.png')).toString('base64');
  const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="GitFiles"><title>GitFiles</title>\n<image width="32" height="32" href="data:image/png;base64,${favB64}"/>\n</svg>\n`;
  fs.writeFileSync(path.join(ASSETS, 'favicon.svg'), favSvg);
  results.push(['favicon.svg', favSvg.length]);

  return results;
}

function check() {
  const problems = [];
  const expect = [
    ...LOGO_SIZES.map((s) => [`logo-${s}.png`, s]),
    ...FAVICON_SIZES.map((s) => [`favicon-${s}.png`, s]),
  ];
  for (const [name, size] of expect) {
    const file = path.join(ASSETS, name);
    if (!fs.existsSync(file)) { problems.push(`${name}: 缺失`); continue; }
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) !== 0x89504e47) { problems.push(`${name}: 不是 PNG`); continue; }
    const w = b.readUInt32BE(16); const h = b.readUInt32BE(20);
    if (w !== size || h !== size) problems.push(`${name}: ${w}x${h}，期望 ${size}x${size}`);
    if (b[25] !== 6) problems.push(`${name}: 色彩类型 ${b[25]}，期望 6(RGBA)`);
  }
  return problems;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--check')) {
  const problems = check();
  if (problems.length) { problems.forEach((p) => console.error(`error ${p}`)); process.exit(1); }
  console.log('build-logo-from-image: 全部图标存在且尺寸正确');
} else {
  if (!args[0]) { console.error('用法: node scripts/build-logo-from-image.mjs <源图.png>'); process.exit(1); }
  const results = build(args[0]);
  for (const [name, bytes] of results) console.log(`  ${name.padEnd(20)} ${String(bytes).padStart(8)} B`);
  console.log(`build-logo-from-image: 已生成 ${results.length} 个图标文件`);
}
