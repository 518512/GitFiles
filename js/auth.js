// Google authentication was removed. This compatibility facade keeps old
// routes and persisted data from crashing the GitHub/local-only application.
const Auth = (() => {
  const DEFAULT_AVATAR = 'assets/default-avatar.svg';
  const REMOVED_KEYS = ['storage_hub_users', 'mikus_drive_users', 'my_google_users'];

  function purgeLegacyGoogleData() {
    REMOVED_KEYS.forEach((key) => {
      try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
    });
  }

  function removedError() {
    const error = new Error('Google Drive 功能已移除，请使用本地存储或 GitHub 仓库。');
    error.code = 'GOOGLE_REMOVED';
    return error;
  }

  function init(callback) {
    purgeLegacyGoogleData();
    callback?.({ initialized: false, reason: 'google-removed' });
  }

  function getAvatarUrl(url) {
    return url || DEFAULT_AVATAR;
  }

  function getDefaultAvatarUrl() {
    return DEFAULT_AVATAR;
  }

  function applyAvatarFallback(img) {
    if (!img) return;
    img.addEventListener('error', () => {
      img.onerror = null;
      img.src = DEFAULT_AVATAR;
    }, { once: true });
  }

  function applyAvatarFallbacks(root = document) {
    root?.querySelectorAll?.('img').forEach(applyAvatarFallback);
  }

  return {
    init,
    signIn: () => { throw removedError(); },
    addUser: () => { throw removedError(); },
    refreshTokenInteractive: async () => { throw removedError(); },
    ensureValidToken: async () => { throw removedError(); },
    tryGetValidToken: async () => null,
    isTokenFresh: () => false,
    getUsers: () => [],
    getActiveUser: () => null,
    setActiveUser: () => {},
    removeUser: () => {},
    signOutAll: purgeLegacyGoogleData,
    hasUsers: () => false,
    formatDisplayEmail: (value) => String(value || ''),
    getAvatarUrl,
    getDefaultAvatarUrl,
    applyAvatarFallback,
    applyAvatarFallbacks,
    purgeLegacyGoogleData,
  };
})();
