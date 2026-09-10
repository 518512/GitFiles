import { apiError, assertSameOrigin, json } from './http.js';
import { clearSessionCookie, deleteSession, sessionCookie } from './session.js';
import { createRepository, handleRepoList, handleRepositoryApi } from './repos.js';
import { githubRequest } from './github.js';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TOKEN_PATH = '/api/github/oauth/token';

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return origin && origin === new URL(request.url).origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', Vary: 'Origin' }
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
  const expiresAt = Date.now() + (Number(tokenPayload.expires_in || 60 * 60 * 24 * 7) * 1000);
  await env.DB.prepare(
    'INSERT INTO sessions (id, github_login, access_token, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(id, user.login, tokenPayload.access_token, expiresAt).run();

  return id;
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
    const sessionId = await createSession(env, tokenPayload);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sessionId, undefined, request) });
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
    const { requireSession } = await import('./session.js');
    const session = await requireSession(request, env);
    return json({ login: session.github_login || null });
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
