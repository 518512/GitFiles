/**
 * Worker 入口：静态站点 + 同源 OAuth token 代理。
 *
 * 路由：
 *   POST /api/github/oauth/token  → GitHub OAuth token 交换代理（下述逻辑）
 *   OPTIONS /api/github/oauth/token → CORS 预检
 *   其余                          → env.ASSETS.fetch（静态资源；404.html 兜底）
 *
 * token 代理语义与 serve.py / workers/github-oauth-token.js 保持一致：
 *   1. client_id === 'reachability-check' → 直接返回 JSON（前端可达性探测，不消耗凭据）
 *   2. 请求体已带 client_secret → 原样转发
 *   3. 其余注入 secret（env.GITHUB_CLIENT_SECRET，可选 env.GITHUB_CLIENT_ID 覆盖），
 *      缺失返回 misconfigured_proxy
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TOKEN_PATH = '/api/github/oauth/token';

/** 允许调用的来源（部署域名 + 本地开发任意端口）。 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https:\/\/[^/]*\.workers\.dev$/.test(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

async function handleTokenExchange(request, env) {
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ error: 'invalid_request', error_description: 'Body must be JSON' }, 400, request);
  }

  if (payload.client_id === 'reachability-check') {
    return jsonResponse({ ok: true, proxy: 'worker' }, 200, request);
  }

  let body = payload;
  if (!payload.client_secret) {
    const secret = env && env.GITHUB_CLIENT_SECRET;
    if (!secret) {
      return jsonResponse({
        error: 'misconfigured_proxy',
        error_description: 'Missing GitHub OAuth client secret. Add the GITHUB_CLIENT_SECRET secret to the Worker.',
      }, 500, request);
    }
    body = { ...payload, client_secret: secret };
    if (env.GITHUB_CLIENT_ID) {
      body.client_id = env.GITHUB_CLIENT_ID;
    }
  }

  try {
    const upstream = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'GitFiles-TokenProxy',
      },
      body: JSON.stringify(body),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  } catch (err) {
    return jsonResponse({ error: 'proxy_error', error_description: String(err) }, 502, request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === TOKEN_PATH) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders(request) });
      }
      return handleTokenExchange(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'not_found' }, 404, request);
    }

    // 其余路径交给静态资源（not_found_handling=404-page 时，未匹配路径回退 404.html）
    return env.ASSETS.fetch(request);
  },
};
