/**
 * Pages Function：GitHub OAuth token 交换代理（/api/github/oauth/token）。
 *
 * 由 workers/github-oauth-token.js（独立 Worker 版）迁移而来，逻辑与 serve.py
 * 的本地开发代理保持一致（PROJECT_SPEC §20 推荐路径）：
 *   1. 请求体 `client_id === 'reachability-check'` → 原样转发（仅探测代理可达性）
 *   2. 请求体已带 `client_secret` → 原样转发（调用方自带凭据）
 *   3. 其余情况注入 secret（env.GITHUB_CLIENT_SECRET，可选 env.GITHUB_CLIENT_ID 覆盖）
 *
 * 部署后在 Pages 项目设置中添加 secret：GITHUB_CLIENT_SECRET（见 wrangler.jsonc 注释）。
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** 允许调用的来源（生产域名 + 本地开发任意端口）。 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https:\/\/[^/]*\.pages\.dev$/.test(origin)) return true;
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

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ error: 'invalid_request', error_description: 'Body must be JSON' }, 400, request);
  }

  // 前端可达性探测：原样转发，GitHub 返回的 JSON 即可让前端判定“代理在线”。
  if (payload.client_id === 'reachability-check') {
    // no-op: 不消耗 GitHub 凭据，直接返回可解析的 JSON。
    return jsonResponse({ ok: true, proxy: 'pages-function' }, 200, request);
  }

  let body = payload;
  if (!payload.client_secret) {
    const secret = env && env.GITHUB_CLIENT_SECRET;
    if (!secret) {
      return jsonResponse({
        error: 'misconfigured_proxy',
        error_description: 'Missing GitHub OAuth client secret. Add the GITHUB_CLIENT_SECRET secret to the Pages project.',
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
        'User-Agent': 'StorageHub-TokenProxy',
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

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet() {
  return new Response('Method not allowed', { status: 405 });
}
