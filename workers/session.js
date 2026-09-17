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

/**
 * `sessions.github_avatar` 是后加的**可选**列。
 *
 * 已经部署的库未必执行过 migration。因此读与写都必须能退回到旧列集合——
 * 写尤其重要：如果 INSERT 引用了不存在的列，**用户会彻底无法登录**，
 * 连进后台补列的机会都没有。
 *
 * 用模块级标记记住探测结果：Worker isolate 内首次失败后走旧语句，
 * 不再每个请求都白跑一次失败的 SQL。
 */
let githubAvatarSupported = true;
// 同类的可选列：repository_access.checked_at 也是后加的。
let aclCheckedAtSupported = true;

const SESSION_COLUMNS_OLD = 'id, github_login, access_token, expires_at';

function isMissingColumnError(error) {
  // D1 的报错形如：D1_ERROR: table sessions has no column named github_avatar: SQLITE_ERROR
  return /no column named/i.test(String(error?.message || error));
}

/**
 * 重置列探测缓存。仅供测试使用：模块级缓存会跨用例保留，
 * 导致"先跑缺列用例、再跑有列用例"时后者被错误地走旧语句。
 */
export function __resetSessionColumnCache() {
  githubAvatarSupported = true;
  aclCheckedAtSupported = true;
}

/** 读取 ACL 行；目标库缺 checked_at 时退回旧列，并把该行视为过期强制重校。 */
async function selectAclRow(env, sessionId, owner, repo) {
  if (aclCheckedAtSupported) {
    try {
      return await env.DB.prepare(
        'SELECT can_read, can_write, checked_at FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?'
      ).bind(sessionId, owner, repo).first();
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      aclCheckedAtSupported = false;
    }
  }
  const row = await env.DB.prepare(
    'SELECT can_read, can_write FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?'
  ).bind(sessionId, owner, repo).first();
  // 旧库没有时间戳，无法判断新鲜度 —— 一律视为过期，让调用方回源校验。
  return row ? { ...row, checked_at: null } : row;
}

/** 写入 ACL 行；缺列时退回旧列集合。导出供 repos.js 复用。 */
export async function upsertAclRow(env, row) {
  if (aclCheckedAtSupported) {
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write, checked_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(row.sessionId, row.owner, row.repo, row.canRead, row.canWrite, row.checkedAt).run();
      return;
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      aclCheckedAtSupported = false;
    }
  }
  await env.DB.prepare(
    'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write) VALUES (?, ?, ?, ?, ?)'
  ).bind(row.sessionId, row.owner, row.repo, row.canRead, row.canWrite).run();
}

/** 查询 session，必要时退回不含 github_avatar 的旧列集合。 */
export async function selectSession(env, id) {
  if (githubAvatarSupported) {
    try {
      return await env.DB.prepare(
        `SELECT id, github_login, github_avatar, access_token, expires_at FROM sessions WHERE id = ?`
      ).bind(id).first();
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      githubAvatarSupported = false;
    }
  }
  return env.DB.prepare(
    `SELECT ${SESSION_COLUMNS_OLD} FROM sessions WHERE id = ?`
  ).bind(id).first();
}

/** 写入 session；同样在缺列时退回旧列集合，保证登录不被阻塞。 */
export async function insertSession(env, row) {
  if (githubAvatarSupported) {
    try {
      await env.DB.prepare(
        'INSERT INTO sessions (id, github_login, github_avatar, access_token, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(row.id, row.login, row.avatar || null, row.accessToken, row.expiresAt).run();
      return;
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      githubAvatarSupported = false;
    }
  }
  await env.DB.prepare(
    'INSERT INTO sessions (id, github_login, access_token, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(row.id, row.login, row.accessToken, row.expiresAt).run();
}

export async function requireSession(request, env) {
  if (!env.DB) throw new ApiError(503, 'service_unavailable', 'D1 session storage is not configured');
  const id = cookieValue(request, COOKIE_NAME);
  if (!id) throw new ApiError(401, 'unauthorized', 'Sign in is required');
  const row = await selectSession(env, id);
  if (!row || (row.expires_at && Number(row.expires_at) <= Date.now())) {
    throw new ApiError(401, 'unauthorized', 'Session has expired');
  }
  return row;
}

export async function requireRepositoryAccess(env, session, owner, repo, write = false) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim();
  const ttl = write ? WRITE_ACL_TTL_MS : ACL_TTL_MS;
  const row = await selectAclRow(env, session.id, normalizedOwner, normalizedRepo);

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
  await upsertAclRow(env, {
    sessionId: session.id,
    owner: normalizedOwner,
    repo: normalizedRepo,
    canRead,
    canWrite,
    checkedAt: Date.now(),
  });

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
