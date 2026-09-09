import { ApiError } from './http.js';
import { githubRequest, repoPrefix } from './github.js';

const COOKIE_NAME = 'gitfiles_session';

function cookieValue(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const found = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function cookieAttributes(request) {
  const isHttps = !request || new URL(request.url).protocol === 'https:';
  return `Path=/; HttpOnly;${isHttps ? ' Secure;' : ''} SameSite=Lax`;
}

export function sessionCookie(sessionId, maxAge = 60 * 60 * 24 * 7, request = null) {
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; ${cookieAttributes(request)} Max-Age=${maxAge}`;
}

export function clearSessionCookie(request = null) {
  return `${COOKIE_NAME}=; ${cookieAttributes(request)} Max-Age=0`;
}

export async function requireSession(request, env) {
  if (!env.DB) throw new ApiError(503, 'service_unavailable', 'D1 session storage is not configured');
  const id = cookieValue(request, COOKIE_NAME);
  if (!id) throw new ApiError(401, 'unauthorized', 'Sign in is required');
  const row = await env.DB.prepare(
    'SELECT id, github_login, access_token, expires_at FROM sessions WHERE id = ?'
  ).bind(id).first();
  if (!row || (row.expires_at && Number(row.expires_at) <= Date.now())) {
    throw new ApiError(401, 'unauthorized', 'Session has expired');
  }
  return row;
}

export async function requireRepositoryAccess(env, session, owner, repo, write = false) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim();
  let row = await env.DB.prepare(
    'SELECT can_read, can_write FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?'
  ).bind(session.id, normalizedOwner, normalizedRepo).first();

  // ACL discovery is lazy. If this repository was not cached yet, validate it
  // with GitHub and persist the exact permissions before allowing access.
  if (!row) {
    const { payload } = await githubRequest(session, `${repoPrefix(normalizedOwner, normalizedRepo)}`);
    const canRead = payload?.permissions?.pull !== false ? 1 : 0;
    const canWrite = payload?.permissions?.push || payload?.permissions?.admin ? 1 : 0;
    await env.DB.prepare(
      'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write) VALUES (?, ?, ?, ?, ?)'
    ).bind(session.id, normalizedOwner, normalizedRepo, canRead, canWrite).run();
    row = { can_read: canRead, can_write: canWrite };
  }

  if ((!write && !row.can_read) || (write && !row.can_write)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission for this repository');
  }
  return row;
}
