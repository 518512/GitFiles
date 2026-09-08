import { ApiError } from './http.js';

const COOKIE_NAME = 'gitfiles_session';

function cookieValue(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const found = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

export function sessionCookie(sessionId, maxAge = 60 * 60 * 24 * 7) {
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
  const row = await env.DB.prepare(
    'SELECT can_read, can_write FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?'
  ).bind(session.id, owner, repo).first();
  if (!row || (!write && !row.can_read) || (write && !row.can_write)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission for this repository');
  }
}
