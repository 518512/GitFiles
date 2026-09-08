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
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!response.ok) {
    const message = payload?.message || `GitHub API error (${response.status})`;
    if (response.status === 401) throw new ApiError(401, 'unauthorized', 'GitHub authorization has expired');
    if (response.status === 403 && /rate limit/i.test(message)) throw new ApiError(429, 'rate_limited', message);
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

export async function githubRaw(session, path, options = {}) {
  let response;
  try {
    response = await fetch(endpoint(path), {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        Accept: options.accept || 'application/vnd.github.raw',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'GitFiles-Worker',
      },
    });
  } catch {
    throw new ApiError(502, 'github_unavailable', 'GitHub API could not be reached');
  }
  if (!response.ok) {
    if (response.status === 404) throw new ApiError(404, 'not_found', 'File was not found');
    if (response.status === 403) throw new ApiError(403, 'forbidden', 'GitHub denied file access');
    throw new ApiError(502, 'github_error', `GitHub API error (${response.status})`);
  }
  return response;
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
