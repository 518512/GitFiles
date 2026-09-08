// 部署配置模板（GitFiles fork）
//
// ⚠️ 直接 fork 本仓库的用户【无需修改本文件】。三种配置方式（优先级从低到高）：
//
//   1. 直接改本文件          —— 可用，但会与上游更新冲突，不推荐
//   2. js/config.local.js    —— 本地开发用（已在 .gitignore，不会提交）
//                               模板见 js/config.local.example.js
//   3. 部署平台构建环境变量   —— Cloudflare Workers 推荐，零代码修改：
//                               Worker → Settings → Build variables and secrets
//                               → 添加 CONFIG_GOOGLE_CLIENT_ID / CONFIG_GITHUB_CLIENT_ID
//                               → 重新部署（scripts/build-config.mjs 构建时自动生成覆盖）
//
// Client ID 是公开标识符，可安全放前端；Client Secret 必须只配置在
// Worker Secret（GITHUB_CLIENT_SECRET）中。
const DEFAULT_CONFIG = {
  // GitHub Pages 使用 /GitFiles；Workers + Static Assets 从根路径提供资源。
  BASE_PATH: typeof location !== 'undefined' && /(^|\.)github\.io$/i.test(location.hostname) ? '/GitFiles' : '/',
  // Google Cloud OAuth 2.0 Web Client ID（Google Drive 登录用，见 README「配置」）
  CLIENT_ID: '',
  // GitHub OAuth App Client ID（公开值；回调地址必须与应用设置一致，见 README）
  GITHUB_CLIENT_ID: '',
  GITHUB_SCOPES: 'repo',
  SCOPES: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/drive',
  ].join(' '),
  DISCOVERY_DOC: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
};

// 可选覆盖键（示例）：
//   GITHUB_REDIRECT_URI: 'http://localhost:8080/github-oauth-callback.html'
//   GITHUB_TOKEN_EXCHANGE_URL: 'https://your-worker.workers.dev/api/github/oauth/token'
//   GITHUB_USE_PAT: true
const CONFIG = {
  ...DEFAULT_CONFIG,
  ...(typeof window !== 'undefined' && window.CONFIG_OVERRIDES ? window.CONFIG_OVERRIDES : {}),
};
