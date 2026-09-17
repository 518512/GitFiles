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
 * sessions / repository_access 的**可选列**（github_avatar、checked_at、
 * refresh_token、refresh_expires_at、client_id）都是后加的。
 *
 * 已部署的库未必执行过 migration，因此读与写都必须能退回到旧列集合——
 * 写尤其重要：INSERT 若引用不存在的列，用户会彻底无法登录。
 *
 * 用 `PRAGMA table_info` 一次性内省真实列名（每个 isolate 只查一次），
 * 按实际存在的列动态拼语句。这比逐个属性 try/catch 级联可靠：
 * 上一次的登录故障正是级联只覆盖了 SELECT、漏了 INSERT。
 */
let introspected = null;

/** 每张表按「历史最早」到「最新」排列的已知列；内省失败时用它兜底。 */
const KNOWN_COLUMNS = {
  sessions: ['id', 'github_login', 'access_token', 'expires_at', 'created_at',
    'github_avatar', 'refresh_token', 'refresh_expires_at', 'client_id'],
  repository_access: ['session_id', 'owner', 'repo', 'can_read', 'can_write', 'checked_at'],
};

async function tableColumns(env, table) {
  if (introspected?.[table]) return introspected[table];
  introspected = introspected || {};
  try {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const names = (results || []).map((r) => r.name).filter(Boolean);
    introspected[table] = names.length ? new Set(names) : new Set(KNOWN_COLUMNS[table]);
  } catch {
    // 内省失败时按**最保守**的旧列集合处理：保证登录等核心路径可用，
    // 新列（头像/续期）缺失只是功能降级，不会让旧库写失败。
    introspected[table] = new Set(KNOWN_COLUMNS[table].slice(0, table === 'sessions' ? 4 : 5));
  }
  return introspected[table];
}

/** 只保留目标表里真实存在的列，并按 KNOWN_COLUMNS 的顺序输出，供语句拼接。 */
async function pickColumns(env, table, wanted) {
  const available = await tableColumns(env, table);
  return KNOWN_COLUMNS[table].filter((c) => wanted.includes(c) && available.has(c));
}

/**
 * 重置内省缓存。仅供测试使用：模块级缓存会跨用例保留，
 * 导致"先跑缺列用例、再跑有列用例"时后者被错误地走旧语句。
 */
export function __resetSessionColumnCache() {
  introspected = null;
}

function isMissingColumnError(error) {
  // D1 的报错形如：D1_ERROR: table sessions has no column named github_avatar: SQLITE_ERROR
  return /no column named/i.test(String(error?.message || error));
}

/** 读取 ACL 行；缺 checked_at 时该行没有时间戳，调用方按过期处理（强制回源）。 */
async function selectAclRow(env, sessionId, owner, repo) {
  const cols = await pickColumns(env, 'repository_access', ['session_id', 'owner', 'repo', 'can_read', 'can_write', 'checked_at']);
  const row = await env.DB.prepare(
    `SELECT ${cols.join(', ')} FROM repository_access WHERE session_id = ? AND owner = ? AND repo = ?`
  ).bind(sessionId, owner, repo).first();
  // 旧库没有时间戳，无法判断新鲜度 —— 一律视为过期，让调用方回源校验。
  return row ? { ...row, checked_at: row.checked_at ?? null } : row;
}

/** 写入 ACL 行；只写目标库实际存在的列。导出供 repos.js 复用。 */
export async function upsertAclRow(env, row) {
  const wanted = { session_id: row.sessionId, owner: row.owner, repo: row.repo, can_read: row.canRead, can_write: row.canWrite, checked_at: row.checkedAt };
  const cols = await pickColumns(env, 'repository_access', Object.keys(wanted));
  const placeholders = cols.map(() => '?').join(', ');
  await env.DB.prepare(
    `INSERT OR REPLACE INTO repository_access (${cols.join(', ')}) VALUES (${placeholders})`
  ).bind(...cols.map((c) => wanted[c])).run();
}

/** 查询 session；只 SELECT 目标库实际存在的列。 */
export async function selectSession(env, id) {
  const cols = await pickColumns(env, 'sessions', ['id', 'github_login', 'github_avatar', 'refresh_token', 'refresh_expires_at', 'client_id', 'access_token', 'expires_at']);
  return env.DB.prepare(
    `SELECT ${cols.join(', ')} FROM sessions WHERE id = ?`
  ).bind(id).first();
}

/** 写入 session；只写目标库实际存在的列（缺 refresh_token 等新列时自动省略）。 */
export async function insertSession(env, row) {
  const wanted = {
    id: row.id,
    github_login: row.login,
    github_avatar: row.avatar || null,
    refresh_token: row.refreshToken || null,
    refresh_expires_at: row.refreshExpiresAt || null,
    client_id: row.clientId || null,
    access_token: row.accessToken,
    expires_at: row.expiresAt,
  };
  const cols = await pickColumns(env, 'sessions', Object.keys(wanted));
  const placeholders = cols.map(() => '?').join(', ');
  await env.DB.prepare(
    `INSERT INTO sessions (${cols.join(', ')}) VALUES (${placeholders})`
  ).bind(...cols.map((c) => wanted[c])).run();
}

/** 更新 refresh 之后的新 token 集；同样只写存在的列。 */
async function updateSessionTokens(env, id, tokens) {
  const wanted = {
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt,
    refresh_token: tokens.refreshToken || null,
    refresh_expires_at: tokens.refreshExpiresAt || null,
  };
  const cols = (await pickColumns(env, 'sessions', Object.keys(wanted)))
    .filter((c) => c !== 'id');
  if (!cols.length) return;
  const assignments = cols.map((c) => `${c} = ?`).join(', ');
  await env.DB.prepare(`UPDATE sessions SET ${assignments} WHERE id = ?`)
    .bind(...cols.map((c) => wanted[c]), id).run();
}

/**
 * 用 refresh_token 向 GitHub 换新的 access token（GitHub App 专用流程）。
 *
 * 这是「PWA 每次重新打开都要重新登录」的根治手段：用户的 Client ID 是
 * GitHub App（Ov23 前缀），user access token 默认 **8 小时**过期，
 * 而交换响应里的 refresh_token 约 6 个月有效。此前代码完全忽略了 refresh_token，
 * 会话寿命被钉死在 8 小时 —— 隔夜重开必然 401。
 *
 * 注意：GitHub 会**轮换** refresh_token（响应里带新的）。必须把新的写回，
 * 否则下次续期会失败。
 */
async function refreshAccessToken(env, row) {
  if (!row.refresh_token || !row.client_id) return null;
  if (row.refresh_expires_at && Number(row.refresh_expires_at) <= Date.now()) return null;
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'GitFiles-Worker' },
      body: JSON.stringify({
        client_id: row.client_id,
        client_secret: env.GITHUB_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: row.refresh_token,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) return null;
    return {
      accessToken: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in || 60 * 60 * 8) * 1000,
      // GitHub 会轮换 refresh_token；未返回时沿用旧的
      refreshToken: payload.refresh_token || row.refresh_token,
      refreshExpiresAt: payload.refresh_token_expires_in
        ? Date.now() + Number(payload.refresh_token_expires_in) * 1000
        : row.refresh_expires_at,
    };
  } catch {
    return null; // 续期失败按未续期处理，由调用方走 401
  }
}

export async function requireSession(request, env) {
  if (!env.DB) throw new ApiError(503, 'service_unavailable', 'D1 session storage is not configured');
  const id = cookieValue(request, COOKIE_NAME);
  if (!id) throw new ApiError(401, 'unauthorized', 'Sign in is required');
  let row = await selectSession(env, id);
  if (!row) throw new ApiError(401, 'unauthorized', 'Session has expired');

  const expired = row.expires_at && Number(row.expires_at) <= Date.now();
  if (expired) {
    // 有 refresh_token 就静默续期，让「隔夜重开」不再要求重新登录。
    const renewed = await refreshAccessToken(env, row);
    if (!renewed) throw new ApiError(401, 'unauthorized', 'Session has expired');
    await updateSessionTokens(env, id, renewed);
    row = { ...row, ...renewed };
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
