/**
 * 已废弃的独立 OAuth 代理 —— **安全替代件，不是死代码。**
 *
 * 历史：上游（storage-hub）把 GitHub token 交换放在这个独立端点里，
 * 交换结果直接返回给浏览器，token 由此进入前端存储。
 *
 * 现在：OAuth 统一由 `workers/entry.js` 处理，token 只写入 D1，
 * 浏览器只拿到 HttpOnly session cookie，从不接触 access token。
 *
 * 本文件为什么还要存在（三个理由，缺一不可）：
 *
 *   1. **防止旧部署泄露 token**：如果某处仍把这个文件当作入口部署，
 *      它必须明确拒绝服务，而不是把 access token 返回给浏览器。
 *   2. **让路由由唯一入口接管**：`/api/github/oauth/token` 现在由
 *      `entry.js` 提供真正的交换实现；本文件返回 410，语义是
 *      "这个端点已永久迁移"，而不是 404"不存在"。
 *   3. **留下可追溯的迁移痕迹**：后来者看到 410 与这段注释，
 *      能立刻明白端点去了哪里，不会再"顺手实现"一个返回 token 的版本。
 *
 * 约束：
 *
 *   ❌ 不要删除本文件（删掉后旧部署会以 404 静默失败，反而更难排查）
 *   ❌ 不要在此实现任何 token 交换
 *   ❌ 不要把 access_token 放进响应体（AGENTS.md §3 Token）
 *
 * 相关规则：`AGENTS.md` §3（Token 不得进入浏览器）、§5（模块划分）、
 * `docs/PROJECT_SPEC.md` §3.1（OAuth 流程）。
 */
const TOKEN_PATH = '/api/github/oauth/token';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== TOKEN_PATH) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify({
      error: 'deprecated_endpoint',
      message: 'Use the GitFiles Worker OAuth endpoint with D1 session storage.',
    }), {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
