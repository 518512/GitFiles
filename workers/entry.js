import { apiError, assertSameOrigin, json } from './http.js';
import { clearSessionCookie, deleteSession, insertSession, purgeExpiredSessions, requireSession, sessionCookie } from './session.js';
import { createRepository, handleRepoList, handleRepositoryApi } from './repos.js';
import { githubRequest } from './github.js';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TOKEN_PATH = '/api/github/oauth/token';

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return origin && origin === new URL(request.url).origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

function responseWithCors(response, request) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

async function createSession(env, tokenPayload) {
  if (!env.DB) throw new Error('D1 session storage is not configured');
  if (!tokenPayload.access_token) throw new Error('GitHub did not return an access token');
  const session = { access_token: tokenPayload.access_token };

  // Only the profile is needed to create the session. Repository ACL discovery
  // is intentionally lazy and runs when the repository picker is opened.
  const { payload: user } = await githubRequest(session, '/user');
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + Number(tokenPayload.expires_in || 60 * 60 * 24 * 7) * 1000;
  // GitHub App 的交换响应会带 refresh_token（约 6 个月）与 expires_in（约 8 小时）。
  // 必须把两者都落库：access token 过期后由 requireSession 静默续期，
  // 否则用户隔夜重开 PWA 就要重新走一遍 OAuth。
  const refreshExpiresAt = tokenPayload.refresh_token_expires_in
    ? Date.now() + Number(tokenPayload.refresh_token_expires_in) * 1000
    : null;
  // insertSession 只写目标库实际存在的列，未执行 migration 的部署也不会登录失败。
  await insertSession(env, {
    id,
    login: user.login,
    avatar: user.avatar_url || null,
    accessToken: tokenPayload.access_token,
    expiresAt,
    refreshToken: tokenPayload.refresh_token || null,
    refreshExpiresAt,
    clientId: tokenPayload.clientId || null,
  });

  return { id, refreshExpiresAt };
}

async function handleTokenExchange(request, env) {
  assertSameOrigin(request);
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'validation_error', message: 'Body must be valid JSON' }, 422);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'validation_error', message: 'Body must be a JSON object' }, 422);
  }
  if (payload.client_id === 'reachability-check') return json({ ok: true, proxy: 'worker' });
  if (!env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'service_unavailable', message: 'GITHUB_CLIENT_SECRET is not configured' }, 503);
  }
  if (!env.DB) {
    return json({ error: 'service_unavailable', message: 'D1 session storage is not configured' }, 503);
  }

  const { client_secret: _untrustedSecret, ...safePayload } = payload;
  const body = { ...safePayload, client_secret: env.GITHUB_CLIENT_SECRET };
  if (env.GITHUB_CLIENT_ID) body.client_id = env.GITHUB_CLIENT_ID;
  const upstream = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'GitFiles-Worker' },
    body: JSON.stringify(body),
  });
  const tokenPayload = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !tokenPayload.access_token) {
    return json({ error: 'github_oauth_error', message: tokenPayload.error_description || tokenPayload.error || 'GitHub OAuth exchange failed' }, upstream.status || 502);
  }
  try {
    // client_id 是后续 refresh_token 续期的必要参数（GitHub App 流程），
    // 记进 session 行，避免为此新增运行时配置。
    const result = await createSession(env, { ...tokenPayload, clientId: body.client_id || null });
    // Cookie 寿命对齐 refresh token：有则最长 180 天，否则维持 7 天。
    // 之前固定 7 天，而 GitHub App 的 refresh 可用 6 个月 —— Cookie 先过期
    // 会把"已续期的会话"重新打回登录页。
    const maxAge = result.refreshExpiresAt
      ? Math.min(60 * 60 * 24 * 180, Math.max(60 * 60 * 24 * 7, Math.round((result.refreshExpiresAt - Date.now()) / 1000)))
      : undefined;
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(result.id, maxAge, request) });
  } catch (error) {
    return json({ error: 'service_unavailable', message: error.message }, 503);
  }
}

async function handleApi(request, env, url) {
  if (url.pathname === TOKEN_PATH) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: 'Method not allowed' }, 405);
    return handleTokenExchange(request, env);
  }
  if (url.pathname === '/api/logout') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: 'Method not allowed' }, 405);
    assertSameOrigin(request);
    await deleteSession(request, env);
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
  }
  if (url.pathname === '/api/me') {
    const session = await requireSession(request, env);
    // Opportunistic cleanup: there is no cron binding, so expired sessions are
    // reaped on the cheap endpoint that every page load already calls.
    await purgeExpiredSessions(env);
    const login = session.github_login || null;
    // Migrated rows have no github_avatar; fall back to the canonical avatar URL
    // built from the login so the header still shows a real picture.
    const avatar = session.github_avatar
      || (login ? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}` : null);
    return json({ login, avatar });
  }
  if (url.pathname === '/api/repos') {
    if (request.method === 'GET') return handleRepoList(request, env);
    if (request.method === 'POST') return createRepository(request, env);
    return json({ error: 'method_not_allowed', message: 'Method not allowed' }, 405);
  }
  const repoResponse = await handleRepositoryApi(request, env, url);
  if (repoResponse) return repoResponse;
  return json({ error: 'not_found', message: 'API route was not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return responseWithCors(await handleApi(request, env, url), request);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return responseWithCors(apiError(error), request);
    }
  },
};
