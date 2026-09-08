#!/usr/bin/env node
/**
 * 构建脚本（wrangler.jsonc 的 build.command，CLI 与 Workers Builds 共用）：
 *
 *   1. 汇集前端文件到 public/ —— Workers Static Assets 的 assets.directory，
 *      即官方推荐的构建产物目录结构（仓库根为唯一来源，本项目无打包器）
 *   2. 从部署环境变量生成 public/js/config.runtime.js（前端配置覆盖）
 *
 * 幂等：每次构建重建 public/；无环境变量时生成空覆盖，构建永不因此失败。
 * 环境变量命名避开 GitHub Actions 保留的 GITHUB_ 前缀，平台无关。
 *
 * 必须配置（Cloudflare Dashboard → 项目 → Settings → Build → Build command）：
 *   node scripts/build-config.mjs
 * 若留空，Workers Builds 不会生成 public/，assets 上传将失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public');
const wranglerPath = path.join(root, 'wrangler.jsonc');
const d1Name = (process.env.D1_DATABASE_NAME || '').trim();
const d1Id = (process.env.D1_DATABASE_ID || '').trim();

if ((d1Name && !d1Id) || (!d1Name && d1Id)) {
  throw new Error('D1_DATABASE_NAME and D1_DATABASE_ID must be configured together');
}
if (d1Id && !/^[0-9a-f-]{36}$/i.test(d1Id)) {
  throw new Error('D1_DATABASE_ID must be a valid D1 UUID');
}

const d1Binding = d1Name && d1Id
  ? `    "d1_databases": [{ "binding": "DB", "database_name": ${JSON.stringify(d1Name)}, "database_id": ${JSON.stringify(d1Id)} }]`
  : '    // "d1_databases": [{ "binding": "DB", "database_name": "<D1_DATABASE_NAME>", "database_id": "<D1_DATABASE_ID>" }]';
const wranglerTemplate = fs.readFileSync(wranglerPath, 'utf8');
const startMarker = '  // D1_BINDING_START';
const endMarker = '  // D1_BINDING_END';
const start = wranglerTemplate.indexOf(startMarker);
const end = wranglerTemplate.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) {
  throw new Error('wrangler.jsonc is missing the D1 binding markers');
}
const before = wranglerTemplate.slice(0, start);
const after = wranglerTemplate.slice(end + endMarker.length);
fs.writeFileSync(wranglerPath, `${before}${startMarker}\n${d1Binding}\n${endMarker}${after}`);

/** 进入 public/ 的前端文件与目录（与部署相关的一切，不含仓库/开发文件）。 */
const FILES = [
  '404.html',
  'github-oauth-callback.html',
  'index.html',
  'notepad.html',
  'privacy.html',
  'terms.html',
  'manifest.webmanifest',
  'robots.txt',
  'sitemap.xml',
  'sw.js',
];
const DIRS = ['css', 'js', 'assets'];

/**
 * Test-only legacy Git engine remains in source for regression coverage but
 * must never be published to Worker static assets: production browser code
 * uses same-origin Worker APIs plus github-paths.js only.
 */
const EXCLUDED = [/config\.local\.example\.js$/, /[\\/]js[\\/]github(?:[\\/]|$)/];

// 1) 重建 public/
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
for (const file of FILES) {
  fs.copyFileSync(path.join(root, file), path.join(outDir, file));
}
for (const dir of DIRS) {
  fs.cpSync(path.join(root, dir), path.join(outDir, dir), {
    recursive: true,
    filter: (src) => !EXCLUDED.some((re) => re.test(src)),
  });
}

// js/config.local.js：本地开发时随仓库发布；部署产物中不存在时生成占位注释，
// 避免 SPA 回退（single-page-application）把 index.html 当 JS 返回导致控制台
// 报 "Unexpected token '<'"。
const localConfigOut = path.join(outDir, 'js', 'config.local.js');
if (!fs.existsSync(localConfigOut)) {
  fs.writeFileSync(
    localConfigOut,
    '// js/config.local.js is not present in this deployment (see js/config.local.example.js).\n'
  );
}

// 2) 生成配置覆盖（构建环境变量 → 前端 CONFIG）
const ENV_MAP = {
  CONFIG_GOOGLE_CLIENT_ID: 'CLIENT_ID',
  CONFIG_GITHUB_CLIENT_ID: 'GITHUB_CLIENT_ID',
  CONFIG_BASE_PATH: 'BASE_PATH',
  CONFIG_GITHUB_SCOPES: 'GITHUB_SCOPES',
};

const overrides = {};
for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
  const value = (process.env[envKey] || '').trim();
  if (value) {
    overrides[configKey] = value;
  }
}

const runtimeBody = [
  '// 由 scripts/build-config.mjs 在构建时生成（勿手改；部署环境变量见 js/config.js 顶部说明）。',
  'window.CONFIG_OVERRIDES = Object.assign(window.CONFIG_OVERRIDES || {},',
  `${JSON.stringify(overrides, null, 2)});`,
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'js', 'config.runtime.js'), runtimeBody);

const keys = Object.keys(overrides);
console.log(keys.length
  ? `build-config: public/ ready (overrides: ${keys.join(', ')})`
  : 'build-config: public/ ready (no override env vars set)');
