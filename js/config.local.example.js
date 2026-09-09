// 本地配置覆盖模板。复制为 js/config.local.js 后填写（该文件已被 .gitignore，不会提交）。
// 仅用于本地开发；Cloudflare Pages 部署请改用构建环境变量（见 js/config.js 顶部说明）。
window.CONFIG_OVERRIDES = {
  // GitHub OAuth App Client ID（公开值，回调地址须与应用设置一致）
  GITHUB_CLIENT_ID: 'YOUR_GITHUB_CLIENT_ID',
  // 可选：自定义 GitHub 回调 / token 代理 / 强制 PAT 模式
  // GITHUB_REDIRECT_URI: 'http://localhost:8080/github-oauth-callback.html',
  // GITHUB_TOKEN_EXCHANGE_URL: 'http://localhost:8080/api/github/oauth/token',
  // GITHUB_USE_PAT: true,
};
