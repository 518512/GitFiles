import { ApiError } from './http.js';
import { githubRequest, repoPrefix } from './github.js';

const COOKIE_NAME = 'gitfiles_session';
// How long a cached repository ACL may be trusted before it is re-validated
// against GitHub. Permission changes in GitHub must not require a re-login,
// but re-checking on every request would burn the API rate limit (AGENTS.md §27).
const ACL_TTL_MS = 5 * 60 * 1000;
// Writes always re-validate, so a revoked collaborator cannot mutate a repo
// with a stale cached `can_write=1` row.
const WRITE_ACL_TTL_MS = 0;

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

export async function deleteSession(request, env) {
  if (!env.DB) throw new ApiError(503, 'service_unavailable', 'D1 session storage is not configured');
  const id = cookieValue(request, COOKIE_NAME);
  if (!id) return false;
  // Do not rely on SQLite foreign-key enforcement being enabled in every D1
  // deployment; explicitly remove ACL rows with the server-side session.
  await env.DB.prepare('DELETE FROM repository_access WHERE session_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  return true;
}

export async function requireSession(request, env) {
  if (!env.DB) throw new ApiError(503, 'service_unavailable', 'D1 session storage is not configured');
  const id = cookieValue(request, COOKIE_NAME);
  if (!id) throw new ApiError(401, 'unauthorized', 'Sign in is required');
  // 先按最新 schema 查询；若目标库尚未执行 migration（缺 github_avatar 列），
  // 回退到旧列集合，避免整个应用因一个可选字段而 500。
  let row;
  try {
    row = await env.DB.prepare(
      'SELECT id, github_login, github_avatar, access_token, expires_at FROM sessions WHERE id = ?'
    ).bind(id).first();
  } catch {
    row = await env.DB.prepare(
      'SELECT id, github_login, access_token, expires_at FROM sessions WHERE id = ?'
    ).bind(id).first();
  }
  if (!row || (row.expires_at && Number(row.expires_at) <= Date.now())) {
    throw new ApiError(401, 'unauthorized', 'Session has expired');
  }
  return row;
}

export async function requireRepositoryAccess(env, session, owner, repo, write = false) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim();
  const ttl = write ? WRITE_ACL_TTL_MS : ACL_TTL_MS;
  const row = await env.DB.prepare(
    'SELECT can_read, can_write, checked_at FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?'
  ).bind(session.id, normalizedOwner, normalizedRepo).first();

  const fresh = row && row.checked_at != null && (Date.now() - Number(row.checked_at)) < ttl;
  if (fresh) {
    if ((!write && !row.can_read) || (write && !row.can_write)) {
      throw new ApiError(403, 'forbidden', 'You do not have permission for this repository');
    }
    return row;
  }

  // ACL discovery and re-validation share one path: ask GitHub for the exact
  // permissions and persist them. A repository the session cannot see returns
  // 404 upstream, which we surface as 403 so we never confirm its existence.
  let payload;
  try {
    ({ payload } = await githubRequest(session, `${repoPrefix(normalizedOwner, normalizedRepo)}`));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(403, 'forbidden', 'You do not have permission for this repository');
    }
    throw error;
  }
  const canRead = payload?.permissions?.pull !== false ? 1 : 0;
  const canWrite = payload?.permissions?.push || payload?.permissions?.admin ? 1 : 0;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write, checked_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(session.id, normalizedOwner, normalizedRepo, canRead, canWrite, Date.now()).run();

  const resolved = { can_read: canRead, can_write: canWrite, checked_at: Date.now() };
  if ((!write && !resolved.can_read) || (write && !resolved.can_write)) {
    throw new ApiError(403, 'forbidden', 'You do not have permission for this repository');
  }
  return resolved;
}

/**
 * Drop sessions that are already past their expiry (and their ACL rows).
 *
 * There is no cron binding in this Workers deployment, so cleanup is
 * opportunistic. It is throttled because it is best-effort housekeeping, not
 * part of any request's contract (AGENTS.md §32).
 */
let lastPurgeAt = 0;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

export async function purgeExpiredSessions(env) {
  if (!env.DB) return 0;
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return 0;
  lastPurgeAt = now;
  try {
    await env.DB.prepare(
      'DELETE FROM repository_access WHERE session_id IN (SELECT id FROM sessions WHERE expires_at <= ?)'
    ).bind(now).run();
    const result = await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
    return result?.meta?.changes ?? 0;
  } catch (error) {
    // Cleanup must never break a user request.
    console.error('purgeExpiredSessions failed', error);
    return 0;
  }
}
