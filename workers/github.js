import { ApiError } from './http.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function endpoint(path) {
  if (!path.startsWith('/')) throw new Error('GitHub API paths must start with /');
  return `${API_BASE}${path}`;
}

export async function githubRequest(session, path, options = {}) {
  let response;
  try {
    response = await fetch(endpoint(path), {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        Accept: options.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'GitFiles-Worker',
        ...(options.headers || {}),
      },
      body: options.body,
    });
  } catch {
    throw new ApiError(502, 'github_unavailable', 'GitHub API could not be reached');
  }
  // 204 responses have no body; GitHub also returns empty bodies on some
  // ref/tree writes. Avoid an unnecessary text() decode for those.
  if (response.status === 204) return { payload: null, response };
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!response.ok) {
    const message = payload?.message || `GitHub API error (${response.status})`;
    if (response.status === 401) throw new ApiError(401, 'unauthorized', 'GitHub authorization has expired');
    if (response.status === 403 && /rate limit/i.test(message)) {
      // Preserve GitHub's Retry-After so clients can back off intelligently
      // instead of hammering the API (AGENTS.md §27).
      const retryAfter = response.headers.get('retry-after');
      const reset = response.headers.get('x-ratelimit-reset');
      throw new ApiError(429, 'rate_limited', message, {
        retryAfter: retryAfter ? Number(retryAfter) : null,
        resetAt: reset ? Number(reset) * 1000 : null,
      });
    }
    if (response.status === 403) throw new ApiError(403, 'forbidden', message);
    if (response.status === 404) throw new ApiError(404, 'not_found', message);
    if (response.status === 409) throw new ApiError(409, 'conflict', message, payload);
    if (response.status === 422) {
      const textBody = `${message} ${JSON.stringify(payload || {})}`;
      if (/fast.?forward|head|out of date/i.test(textBody)) throw new ApiError(409, 'conflict', message, payload);
      throw new ApiError(422, 'validation_error', message, payload);
    }
    throw new ApiError(502, 'github_error', message, payload);
  }
  return { payload, response };
}

export function repoPrefix(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Stream a file body straight through to the client without ever buffering it
 * in the Worker (AGENTS.md §25: no fake success; a memory-limit crash mid
 * download must not look like a completed transfer).
 *
 * - forwards the client's Range header so media can seek
 * - forwards 206/416 upstream instead of masking them as 200
 * - caps the number of buffered bytes the Worker holds in memory
 */
export async function streamFile(request, session, upstreamPath, { maxBytes = 95 * 1024 * 1024, accept } = {}) {
  const range = request.headers.get('Range');
  const headers = {
    Authorization: `Bearer ${session.access_token}`,
    Accept: accept || 'application/vnd.github.raw',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'GitFiles-Worker',
  };
  // Only forward a well-formed single-range request; ignore anything else so a
  // malformed header cannot be used to talk GitHub into an unusual response.
  if (range && /^bytes=\d*-\d*$/.test(range.trim())) headers.Range = range.trim();

  let response;
  try {
    response = await fetch(endpoint(upstreamPath), { headers, redirect: 'follow' });
  } catch {
    throw new ApiError(502, 'github_unavailable', 'GitHub API could not be reached');
  }
  if (response.status === 404) throw new ApiError(404, 'not_found', 'File was not found');
  if (response.status === 403) throw new ApiError(403, 'forbidden', 'GitHub denied file access');
  if (response.status === 416) {
    return new Response(null, { status: 416, headers: { 'Content-Range': response.headers.get('content-range') || 'bytes */*' } });
  }
  if (!response.ok) throw new ApiError(502, 'github_error', `GitHub API error (${response.status})`);

  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxBytes) {
    throw new ApiError(413, 'payload_too_large', `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB download limit`);
  }

  const out = new Headers({
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  });
  const contentRange = response.headers.get('content-range');
  const contentLength = response.headers.get('content-length');
  if (contentRange) out.set('Content-Range', contentRange);
  if (contentLength) out.set('Content-Length', contentLength);
  const disposition = response.headers.get('content-disposition');
  if (disposition) out.set('Content-Disposition', disposition);

  return new Response(response.body, { status: response.status, headers: out });
}

export async function branchState(session, owner, repo, branch) {
  try {
    const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/branches/${encodeURIComponent(branch)}`);
    const head = payload?.commit?.sha;
    const treeSha = payload?.commit?.commit?.tree?.sha || null;
    if (!head) throw new ApiError(404, 'not_found', 'Branch was not found');
    return { head, treeSha };
  } catch (error) {
    // A repository can be freshly created without a branch. Callers decide
    // whether an empty tree is valid for their operation.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
