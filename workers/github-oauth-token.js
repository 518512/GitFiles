/**
 * Deprecated standalone OAuth proxy.
 *
 * OAuth must be handled by workers/entry.js, which stores the GitHub token in
 * D1 and returns only an HttpOnly session cookie. This endpoint intentionally
 * refuses requests so an old deployment cannot leak access tokens to browsers.
 */
const TOKEN_PATH = '/api/github/oauth/token';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== TOKEN_PATH) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify({
      error: 'deprecated_endpoint',
      message: 'Use the GitFiles Worker OAuth endpoint with D1 session storage.',
    }), {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
