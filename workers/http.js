export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function apiError(error) {
  if (error instanceof ApiError) {
    return json({ error: error.code, message: error.message, details: error.details }, error.status);
  }
  console.error('Unhandled Worker API error', error);
  return json({ error: 'internal_error', message: 'An internal server error occurred' }, 500);
}

export async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(422, 'validation_error', 'Content-Type must be application/json');
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(422, 'validation_error', 'Request body must be a JSON object');
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'validation_error', 'Request body must be valid JSON');
  }
}

export function assertSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'forbidden', 'This API only accepts same-origin requests');
  }
}

export function parseRepoPath(pathname) {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  try {
    return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]), action: match[3] || '' };
  } catch {
    throw new ApiError(404, 'not_found', 'Repository route was not found');
  }
}
