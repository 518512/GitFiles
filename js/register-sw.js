const GitFilesCache = (() => {
  const VERSION_KEY = 'storage_hub_app_version';
  const LEGACY_VERSION_KEY = 'mikus_drive_app_version';

  // App shell cache only — never clear Google sessions, local storage volumes, or profiles.
  const PRESERVED_LOCAL_STORAGE_KEYS = [
    'storage_hub_users',
    'mikus_drive_users',
    'my_google_users',
    'storage_hub_local_disks',
    'mikus_drive_local_disks',
    'storage_hub_local_user',
    'mikus_drive_local_user',
    'storage_hub_github_disks',
    'mikus_drive_github_disks',
    VERSION_KEY,
    LEGACY_VERSION_KEY,
  ];

  const SW_RELOAD_KEY = 'storage_hub_sw_reload';
  const LEGACY_SW_RELOAD_KEY = 'mikus_sw_reload';

  function migrateVersionKey() {
    if (typeof StorageMigrate !== 'undefined') {
      StorageMigrate.migrateLocalStorageKey(VERSION_KEY, [LEGACY_VERSION_KEY]);
      return;
    }
    if (!localStorage.getItem(VERSION_KEY) && localStorage.getItem(LEGACY_VERSION_KEY)) {
      localStorage.setItem(VERSION_KEY, localStorage.getItem(LEGACY_VERSION_KEY));
    }
  }

  async function clearAllCaches() {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHES' });
    }
  }

  async function unregisterServiceWorkers() {
    if (!('serviceWorker' in navigator)) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((reg) => reg.unregister()));
  }

  async function invalidateAppCaches() {
    await clearAllCaches();
    if (typeof APP_VERSION !== 'undefined') {
      localStorage.setItem(VERSION_KEY, APP_VERSION);
    }
  }

  function reloadIfNeeded() {
    if (sessionStorage.getItem(SW_RELOAD_KEY) === '1' || sessionStorage.getItem(LEGACY_SW_RELOAD_KEY) === '1') {
      sessionStorage.removeItem(SW_RELOAD_KEY);
      sessionStorage.removeItem(LEGACY_SW_RELOAD_KEY);
      return;
    }
    sessionStorage.setItem(SW_RELOAD_KEY, '1');
    location.reload();
  }

  async function handleVersionChange() {
    migrateVersionKey();
    if (typeof APP_VERSION === 'undefined') return false;
    const stored = localStorage.getItem(VERSION_KEY);
    if (!stored) {
      localStorage.setItem(VERSION_KEY, APP_VERSION);
      return false;
    }
    if (stored === APP_VERSION) return false;

    await invalidateAppCaches();
    reloadIfNeeded();
    return true;
  }

  async function register() {
    if (!('serviceWorker' in navigator)) return;

    if (await handleVersionChange()) return;

    const base = typeof BasePath !== 'undefined' ? BasePath.get() : '';
    const prefix = base ? `${base}/` : '/';

    try {
      const registration = await navigator.serviceWorker.register(`${prefix}sw.js`, { scope: prefix });

      if (typeof APP_VERSION !== 'undefined') {
        localStorage.setItem(VERSION_KEY, APP_VERSION);
      }

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearAllCaches().then(reloadIfNeeded);
      });

      if (registration.waiting && navigator.serviceWorker.controller) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      registration.update();
    } catch {
      // Service worker optional (e.g. file:// or blocked context)
    }
  }

  return {
    clearAllCaches,
    unregisterServiceWorkers,
    invalidateAppCaches,
    preservedLocalStorageKeys: PRESERVED_LOCAL_STORAGE_KEYS,
    register,
  };
})();

window.StorageHub = window.StorageHub || {};
window.StorageHub.clearCache = () => StorageHubCache.invalidateAppCaches().then(() => location.reload());
window.MikusDrive = window.StorageHub;

window.addEventListener('load', () => {
  GitFilesCache.register();
});
