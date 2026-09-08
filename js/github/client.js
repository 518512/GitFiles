/**
 * GithubClient — GitHub API request layer.
 *
 * Responsibilities (PROJECT_SPEC §3):
 * - request auth / rate limit / retry / error normalization
 * - conflict detection helpers used by the CAS layer
 *
 * Exposed as a browser global `GithubClient` (plain script, no bundler).
 */
(function registerGithubClient(global) {
  'use strict';

  const API_BASE = 'https://api.github.com';
  const API_VERSION = '2022-11-28';

  class GithubApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = 'GithubApiError';
      this.status = status || 0;
      this.payload = payload || null;
    }
    get isNotFound() {
      return this.status === 404;
    }
    get isValidation() {
      return this.status === 422;
    }
    get isForbidden() {
      return this.status === 403;
    }
    get isRateLimit() {
      return this.status === 429
        || (this.status === 403 && /rate limit/i.test(this.message || ''));
    }
    /**
     * CAS failure: GitHub refuses a non-fast-forward ref update.
     * Git Data API answers 422 "Update is not a fast forward";
     * some proxy layers surface it as 409.
     */
    get isConflict() {
      if (this.status === 409) return true;
      if (this.status !== 422) return false;
      const text = `${this.message || ''} ${JSON.stringify(this.payload || {})}`;
      return /fast.?forward|is not at the head|does not match the expected|out of date/i.test(text);
    }
  }

  function formatPayloadError(payload, status) {
    const parts = [];
    if (payload && payload.message) parts.push(payload.message);
    const details = (payload && Array.isArray(payload.errors)
      ? payload.errors.map((entry) => entry.message || entry.code).filter(Boolean)
      : []);
    if (details.length) parts.push(details.join('; '));
    return parts.join(' — ') || `GitHub API error (${status})`;
  }

  function isNetworkError(err) {
    const message = (err && (err.message || String(err))) || '';
    return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
  }

  async function readResponseBody(res) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || contentType.includes('javascript')) {
      return res.json();
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Perform one GitHub API request.
   *
   * @param {string} path - API path beginning with "/" (server-fixed host, never user input).
   * @param {object} options - { token, method, headers, body, accept, raw }
   * @returns {Promise<object|null|Response>} parsed JSON, null for 204, or raw Response
   */
  async function request(path, options = {}) {
    const token = options.token;
    if (!token) {
      throw new GithubApiError('Missing GitHub access token', 401, null);
    }

    let attempt = 0;
    let lastError = null;

    while (attempt < 2) {
      attempt += 1;
      let res;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: options.accept || 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
            ...(options.headers || {}),
          },
          body: options.body,
          redirect: options.raw ? 'follow' : 'manual',
        });
      } catch (err) {
        if (isNetworkError(err)) {
          throw new GithubApiError(
            `GitHub API request failed (${err.message || err}). Check your network connection.`,
            0,
            null
          );
        }
        throw err;
      }

      if (res.status === 429 && attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2;
        await sleep(Math.min(retryAfter, 30) * 1000);
        lastError = new GithubApiError(await formatErrorBody(res), res.status, null);
        continue;
      }

      if (!res.ok) {
        throw new GithubApiError(await formatErrorBody(res), res.status, null);
      }
      if (options.raw) return res;
      if (res.status === 204) return null;
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        throw new GithubApiError(
          'GitHub redirected this request unexpectedly. Try downloading the file instead.',
          res.status,
          null
        );
      }
      return readResponseBody(res);
    }

    throw lastError || new GithubApiError('GitHub API rate limited', 429, null);
  }

  async function formatErrorBody(res) {
    const payload = await readResponseBody(res).catch(() => null);
    return formatPayloadError(payload, res.status);
  }

  global.GithubClient = {
    API_BASE,
    GithubApiError,
    request,
    formatPayloadError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
