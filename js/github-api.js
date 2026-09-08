const GithubApi = (() => {
  class ApiError extends Error {
    constructor(message, status = 0, payload = null) {
      super(message);
      this.name = 'GithubApiError';
      this.status = status;
      this.payload = payload;
      this.isConflict = status === 409;
    }
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw new ApiError(`Worker API request failed: ${error.message || error}`, 0);
    }
    if (options.raw) {
      if (!response.ok) throw await toError(response);
      return response;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.message || `Worker API error (${response.status})`, response.status, payload);
    return payload;
  }

  async function toError(response) {
    const payload = await response.json().catch(() => null);
    return new ApiError(payload?.message || `Worker API error (${response.status})`, response.status, payload);
  }

  return { ApiError, request };
})();
