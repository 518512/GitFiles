#!/usr/bin/env node
/**
 * 构建时生成 js/config.runtime.js（部署环境变量 → 前端配置覆盖）。
 *
 * Cloudflare Pages 会在构建期间注入项目环境变量，因此 fork 用户无需修改
 * 任何被 git 跟踪的文件即可完成部署配置：
 *
 *   Pages 项目 → Settings → Variables and Secrets → 添加（Production 与 Preview 都要）：
 *     CONFIG_GOOGLE_CLIENT_ID   Google OAuth Web Client ID（可选，Google Drive 登录用）
 *     CONFIG_GITHUB_CLIENT_ID   GitHub OAuth App Client ID（可选，GitHub 登录用）
 *     CONFIG_BASE_PATH          基础路径（可选，默认 '/GitFiles'；根域名部署用 '/'）
 *
 * 环境变量命名避开 GITHUB_ 前缀（GitHub Actions 保留前缀），本脚本平台无关。
 * 幂等：变量缺失时生成空覆盖，构建永不因此失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const body = [
  '// 由 scripts/build-config.mjs 在构建时生成（勿手改；部署环境变量见 js/config.js 顶部说明）。',
  'window.CONFIG_OVERRIDES = Object.assign(window.CONFIG_OVERRIDES || {},',
  `${JSON.stringify(overrides, null, 2)});`,
  '',
].join('\n');

fs.writeFileSync(path.join(root, 'js', 'config.runtime.js'), body);

const keys = Object.keys(overrides);
console.log(keys.length
  ? `build-config: generated js/config.runtime.js with overrides: ${keys.join(', ')}`
  : 'build-config: generated js/config.runtime.js (no override env vars set)');
