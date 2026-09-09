const LocalUser = (() => {
  const STORAGE_KEY = 'storage_hub_local_user';
  const LEGACY_STORAGE_KEY = 'mikus_drive_local_user';
  const DEFAULT_NAME = 'Local user';
  const DEFAULT_AVATAR = 'assets/default-avatar.svg';

  let profile = null;

  function load() {
    try {
      if (typeof StorageMigrate !== 'undefined') {
        StorageMigrate.migrateLocalStorageKey(STORAGE_KEY, [LEGACY_STORAGE_KEY]);
      } else if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
      }
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (data && typeof data.name === 'string') {
        profile = {
          name: data.name,
          picture: data.picture || '',
          customized: !!data.customized,
        };
        return;
      }
    } catch {
      // fall through to default
    }
    profile = { name: DEFAULT_NAME, picture: '', customized: false };
    save();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  }

  function init() {
    load();
  }

  function getProfile() {
    return { ...profile };
  }

  function getDisplayName() {
    return profile?.name?.trim() || DEFAULT_NAME;
  }

  function getAvatarUrl() {
    return profile?.picture || DEFAULT_AVATAR;
  }

  function applyAvatarFallback(img) {
    if (typeof Auth !== 'undefined') {
      Auth.applyAvatarFallback(img);
      return;
    }
    img.addEventListener('error', () => {
      img.onerror = null;
      img.src = DEFAULT_AVATAR;
    }, { once: true });
  }

  function updateProfile({ name, picture }) {
    if (name?.trim()) profile.name = name.trim();
    if (picture !== undefined) profile.picture = picture;
    profile.customized = true;
    save();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function showEditDialog() {
    const current = getProfile();
    const values = await Dialog.form({
      title: 'Edit local profile',
      message: 'Local storage volumes belong to this user.',
      fields: [
        { id: 'name', label: 'Name', value: current.name },
        {
          id: 'avatar',
          label: 'Profile picture',
          type: 'file',
          accept: 'image/*',
          hint: 'Leave empty to keep the current picture',
        },
      ],
      submitLabel: 'Save',
    });

    if (!values) return false;

    const name = values.name?.trim();
    if (!name) {
      await Dialog.alert('Name cannot be empty.', { title: 'Edit local profile' });
      return false;
    }

    let picture = current.picture;
    if (values.avatar instanceof File) {
      if (values.avatar.size > 2 * 1024 * 1024) {
        await Dialog.alert('Image must be 2 MB or smaller.', { title: 'Edit local profile' });
        return false;
      }
      picture = await readFileAsDataUrl(values.avatar);
    }

    updateProfile({ name, picture });
    return true;
  }

  return {
    init,
    getProfile,
    getDisplayName,
    getAvatarUrl,
    applyAvatarFallback,
    updateProfile,
    showEditDialog,
    DEFAULT_NAME,
    DEFAULT_AVATAR,
  };
})();
