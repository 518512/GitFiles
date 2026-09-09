const GithubOAuthDeliver = (() => {
  const OAUTH_MESSAGE_SOURCE = 'storage-hub-github-oauth';
  const OAUTH_CHANNEL = 'storage-hub-github-oauth';
  const LEGACY_OAUTH_CHANNEL = 'mikus-drive-github-oauth';

  function oauthStorageKey(state) {
    return `storage_hub_github_oauth_${state}`;
  }

  function legacyOauthStorageKey(state) {
    return `mikus_github_oauth_${state}`;
  }

  function extractOpenerOrigin(state) {
    if (!state) return null;
    const sep = state.indexOf('|');
    if (sep <= 0) return null;
    const origin = state.slice(0, sep);
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function deliverPayload(payload) {
    const openerOrigin = extractOpenerOrigin(payload.state) || location.origin;

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, openerOrigin);
      }
    } catch {
      // opener may be unavailable after cross-origin navigation
    }

    try {
      const channel = new BroadcastChannel(OAUTH_CHANNEL);
      channel.postMessage(payload);
      channel.close();
    } catch {
      // BroadcastChannel not available
    }

    try {
      const legacyChannel = new BroadcastChannel(LEGACY_OAUTH_CHANNEL);
      legacyChannel.postMessage(payload);
      legacyChannel.close();
    } catch {
      // Legacy channel not available
    }

    if (payload.state) {
      try {
        localStorage.setItem(
          oauthStorageKey(payload.state),
          JSON.stringify({ ...payload, ts: Date.now() })
        );
        localStorage.removeItem(legacyOauthStorageKey(payload.state));
      } catch {
        // ignore storage errors
      }
    }
  }

  function deliverFromSearchParams(search = location.search) {
    const params = new URLSearchParams(search);
    const state = params.get('state');
    if (!state) return false;
    if (!params.has('code') && !params.has('error')) return false;

    const payload = {
      source: OAUTH_MESSAGE_SOURCE,
      code: params.get('code'),
      state,
      error: params.get('error'),
      error_description: params.get('error_description'),
    };

    deliverPayload(payload);
    return true;
  }

  function runIfPopupCallback() {
    if (!window.opener) return false;

    const params = new URLSearchParams(location.search);
    if (!params.get('state')) return false;
    if (!params.has('code') && !params.has('error')) return false;

    deliverFromSearchParams();

    if (params.has('code')) {
      document.documentElement.classList.add('github-oauth-popup-callback');
      const style = document.createElement('style');
      style.textContent =
        'html.github-oauth-popup-callback body > * { visibility: hidden !important; }' +
        'html.github-oauth-popup-callback body::before {' +
        'content: "正在完成 GitHub 登录…"; display: block; padding: 2rem;' +
        'font: 16px system-ui, sans-serif; visibility: visible; position: fixed; inset: 0; background: #fff; }';
      document.head.appendChild(style);
      setTimeout(() => window.close(), 500);
    }

    return true;
  }

  return {
    OAUTH_MESSAGE_SOURCE,
    extractOpenerOrigin,
    deliverFromSearchParams,
    runIfPopupCallback,
  };
})();
