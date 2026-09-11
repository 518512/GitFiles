const App = (() => {
  const ROOT_ID = 'home';
  const ROOT_NAME = typeof SITE !== 'undefined' ? SITE.name : 'GitFiles';
  const DRIVE_ROOT_ID = 'root';
  const TREE_PAGE_SIZE = 10;

  const state = {
    level: 'home',
    currentUserId: null,
    currentFolderId: DRIVE_ROOT_ID,
    view: 'grid',
    section: 'my-drive',
    files: [],
    breadcrumbs: [{ id: ROOT_ID, name: ROOT_NAME }],
    history: [{ level: 'home', userId: null, folderId: null, section: 'my-drive' }],
    historyIndex: 0,
    selectedId: null,
    selectedIds: new Set(),
    searchQuery: '',
    sortBy: 'name',
    sortDirection: 'asc',
    expandedUsers: new Set(),
    expandedFolders: new Set(),
    treeChildren: {},
    treeVisibleCount: {},
    userQuotas: {},
    processingItemIds: new Set(),
    githubSession: 'checking',
    conflicts: [],
    repositoryView: 'files',
    overviewMode: 'all',
  };

  let urlPushPending = false;
  let initialRouteApplied = false;
  let progressTimer = null;
  let deferredInstallPrompt = window.gitFilesInstallPrompt || null;

  const USER_SECTIONS = [
    { id: 'my-drive', icon: '📁', label: '我的云端硬盘' },
    { id: 'recent', icon: '🕐', label: '最近使用' },
    { id: 'shared', icon: '👥', label: '与我共享' },
    { id: 'starred', icon: '⭐', label: '已加星标' },
    { id: 'trash', icon: '🗑️', label: '回收站' },
  ];

  const LOCAL_DISK_SECTIONS = [
    { id: 'trash', icon: '🗑️', label: '回收站' },
  ];

  const SECTION_LABELS = {
    shared: '与我共享',
    starred: '已加星标',
    recent: '最近使用',
    trash: '回收站',
  };

  const SECTION_BY_LABEL = Object.fromEntries(
    Object.entries(SECTION_LABELS).map(([id, label]) => [label, id])
  );

  const $ = (sel) => document.querySelector(sel);

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setLoading(on) {
    on ? show($('#loading')) : hide($('#loading'));
  }

  function showError(msg) {
    const el = $('#error');
    if (msg) {
      el.textContent = msg;
      show(el);
      showStatus(msg, 'error');
    } else {
      hide(el);
    }
  }

  let statusTimer = null;

  function showStatus(msg, kind = 'info') {
    const text = msg || '';
    $('#status-selected').textContent = text;
    const banner = $('#app-status');
    if (banner) {
      banner.textContent = text;
      banner.dataset.kind = kind;
      banner.classList.toggle('hidden', !text);
      if (statusTimer) clearTimeout(statusTimer);
      if (text && kind === 'success') statusTimer = setTimeout(() => banner.classList.add('hidden'), 4200);
    }
  }

  function visibleFiles() {
    const query = state.searchQuery.trim().toLocaleLowerCase();
    const files = state.files.filter((file) => !query || String(file.name || '').toLocaleLowerCase().includes(query));
    const direction = state.sortDirection === 'desc' ? -1 : 1;
    return files.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      let left = a.name || '';
      let right = b.name || '';
      if (state.sortBy === 'size') { left = Number(a.size || 0); right = Number(b.size || 0); }
      if (state.sortBy === 'modified') { left = a.dateFormatted || ''; right = b.dateFormatted || ''; }
      if (state.sortBy === 'type') { left = a.typeName || ''; right = b.typeName || ''; }
      return (typeof left === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN')) * direction;
    });
  }

  function updateSelectionBar() {
    const bar = $('#selection-bar');
    const count = state.selectedIds.size;
    if (!bar) return;
    bar.classList.toggle('hidden', count === 0);
    $('#selection-count').textContent = `已选择 ${count} 项`;
  }

  function renderGithubSessionState() {
    const el = $('#worker-session-state');
    const signOut = $('#btn-sign-out');
    if (signOut) signOut.classList.toggle('hidden', state.githubSession !== 'connected');
    const headerState = $('#header-repo-state');
    const activeDisk = state.currentUserId && GithubDisk.isGithubId(state.currentUserId)
      ? GithubDisk.getDisk(state.currentUserId)
      : null;
    if (headerState) {
      headerState.textContent = activeDisk
        ? `${activeDisk.owner}/${activeDisk.repo} · ${activeDisk.branch || '默认分支'}`
        : state.githubSession === 'connected' ? 'GitHub 已连接' : '未连接仓库';
    }
    if (!el) return;
    const labels = {
      checking: 'GitHub 会话：检查中',
      connected: 'GitHub 会话：已连接',
      expired: 'GitHub 会话：需要登录',
      unavailable: 'GitHub API：不可用',
    };
    el.textContent = labels[state.githubSession] || labels.checking;
    el.dataset.state = state.githubSession;
  }

  let sessionCheckPromise = null;

  function refreshGithubSessionState() {
    if (sessionCheckPromise) return sessionCheckPromise;
    state.githubSession = 'checking';
    renderGithubSessionState();
    sessionCheckPromise = GithubApi.request('/api/me')
      .then(() => {
        state.githubSession = 'connected';
        return true;
      })
      .catch((err) => {
        state.githubSession = err?.status === 401 ? 'expired' : 'unavailable';
        return false;
      })
      .finally(() => {
        renderGithubSessionState();
        sessionCheckPromise = null;
      });
    return sessionCheckPromise;
  }

  function addConflictRecord(record) {
    const conflict = {
      id: record.id || `conflict:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      createdAt: record.createdAt || Date.now(),
      ...record,
    };
    state.conflicts.push(conflict);
    $('#btn-conflict-center')?.classList.remove('hidden');
    showStatus(record.kind === 'transfer'
      ? '仓库转移需要恢复，请查看冲突中心。'
      : '检测到远端更新，请查看冲突中心。');
    return conflict;
  }

  async function openConflictCenter() {
    const conflicts = state.conflicts.slice().reverse();
    if (!conflicts.length) {
      await Dialog.alert('暂无未解决的仓库冲突。', { title: '冲突中心' });
      return;
    }
    const selected = await Dialog.form({
      title: `冲突中心（${conflicts.length}）`,
      message: '请选择一个仓库冲突进行查看。远端更改不会被自动覆盖。',
      fields: [{
        id: 'conflict', label: '未解决的冲突', type: 'select',
        options: conflicts.map((item) => ({
          value: item.id,
          label: item.kind === 'transfer'
            ? `${item.sourceRepository} → ${item.destinationRepository}`
            : `${item.repository} | ${String(item.remoteHead || '未知').slice(0, 12)}`,
        })),
      }],
      submitLabel: '查看',
    });
    if (!selected) return;
    const current = state.conflicts.find((item) => item.id === selected.conflict);
    if (!current) return;
    const choice = await Dialog.choose({
      title: '冲突详情',
      message: current.kind === 'transfer'
        ? `${current.sourceRepository} → ${current.destinationRepository}\n\n阶段：${current.stage}\n路径：${(current.paths || []).join(', ') || '未知'}\n\n${current.message}`
        : `${current.repository}\n\n本地基线：${current.expectedHead || '未知'}\n远端 HEAD：${current.remoteHead || '未知'}\n\n${current.message}`,
      buttons: [
        { id: 'reload', label: '重新加载远端状态', primary: true },
        { id: 'dismiss', label: '忽略记录' },
        { id: 'keep', label: '保持打开' },
      ],
    });
    if (choice === 'reload') {
      if (current.kind === 'transfer') {
        try {
          await GithubDisk.deleteBatch(
            current.sourceDiskId,
            (current.paths || []).map((path) => ({ id: path })),
            `Complete moved item deletion (${(current.paths || []).length})`
          );
          GithubDisk.invalidateRepoTree(current.sourceDiskId);
          GithubDisk.invalidateRepoTree(current.destDiskId);
        } catch (error) {
          current.error = error.message;
          current.message = '源仓库删除仍在等待中。请检查源仓库状态后再重试。';
          showStatus(current.message);
          return;
        }
      } else {
        GithubDisk.invalidateRepoTree(current.diskId);
        if (state.currentUserId === current.diskId) await refreshGithubFolderView({ reloadTree: true });
      }
    }
    if (choice === 'reload' || choice === 'dismiss') {
      state.conflicts = state.conflicts.filter((item) => item.id !== current.id);
      const button = $('#btn-conflict-center');
      button?.classList.toggle('hidden', state.conflicts.length === 0);
      if (choice === 'reload') await refreshCurrentDrive({ reloadTree: true });
    }
  }

  function isCurrentLocalDrive() {
    return LocalDisk.isLocalId(state.currentUserId);
  }

  function isCurrentGithubDrive() {
    return GithubDisk.isGithubId(state.currentUserId);
  }

  function isLocalOrGithubDrive(id) {
    return LocalDisk.isLocalId(id) || GithubDisk.isGithubId(id);
  }

  function buildFileContext(file) {
    if (file.isLocalDisk) {
      return {
        type: 'local-disk',
        diskId: file.userId,
        disk: LocalDisk.getDisk(file.userId),
      };
    }
    if (file.isGithubDisk) {
      return {
        type: 'github-disk',
        diskId: file.userId,
        disk: GithubDisk.getDisk(file.userId),
      };
    }
    if (file.isUserDrive) {
      return {
        type: 'user',
        userId: file.userId,
        user: Auth.getUsers().find((u) => u.id === file.userId),
      };
    }
    return {
      type: file.isFolder ? 'folder' : 'file',
      file,
      userId: file.userId || state.currentUserId,
      folderId: state.currentFolderId,
      section: state.level === 'home' ? 'my-drive' : state.section,
    };
  }

  function attachFileContextMenu(el, file) {
    const openMenu = () => {
      selectFile(file.id);
      ContextMenu.showContext(buildFileContext(file));
    };

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectFile(file.id);
      ContextMenu.show(e, buildFileContext(file));
    });

    attachLongPress(el, openMenu);

    el.querySelector('.item-more-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu();
    });
  }

  function attachLongPress(el, callback) {
    let pressTimer = null;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;

    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    el.addEventListener('touchstart', (e) => {
      if (e.target.closest('.item-more-btn, .tree-item-more')) return;
      longPressFired = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      pressTimer = setTimeout(() => {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate(12);
        callback();
      }, 480);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 12 || Math.abs(touch.clientY - startY) > 12) {
        clearPress();
      }
    }, { passive: true });

    el.addEventListener('touchend', clearPress, { passive: true });
    el.addEventListener('touchcancel', clearPress, { passive: true });

    el.addEventListener('click', (e) => {
      if (!longPressFired) return;
      e.preventDefault();
      e.stopPropagation();
      longPressFired = false;
    }, true);
  }

  function createItemMoreButton(label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-more-btn';
    btn.setAttribute('aria-label', label || 'Actions');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
    return btn;
  }

  function addTreeMoreButton(row, getContext) {
    if (!row || row.querySelector('.tree-item-more')) return;
    const btn = createItemMoreButton('Actions');
    btn.classList.add('tree-item-more');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ContextMenu.showContext(getContext());
    });
    row.appendChild(btn);
    attachLongPress(row, () => ContextMenu.showContext(getContext()));
  }

  function snapshot() {
    return {
      level: state.level,
      userId: state.currentUserId,
      folderId: state.currentFolderId,
      section: state.section,
    };
  }

  function pushHistory() {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snapshot());
    state.historyIndex = state.history.length - 1;
    urlPushPending = true;
  }

  function resetHistoryToCurrent() {
    state.history = [snapshot()];
    state.historyIndex = 0;
  }

  function getUrlSegments() {
    if (state.level === 'home') return [];

    const segments = [];
    if (LocalDisk.isLocalId(state.currentUserId)) {
      const disk = LocalDisk.getDisk(state.currentUserId);
      if (!disk) return segments;
      segments.push(disk.name);
      if (state.section !== 'my-drive') {
        segments.push(SECTION_LABELS[state.section] || state.section);
        return segments;
      }
      segments.push('My Drive');
      if (state.currentFolderId !== LocalDisk.ROOT_ID && state.breadcrumbs.length > 2) {
        state.breadcrumbs.slice(2)
          .filter((crumb) => crumb.id !== LocalDisk.ROOT_ID && crumb.name !== 'My Drive')
          .forEach((crumb) => segments.push(crumb.name));
      }
      return segments;
    }

    if (GithubDisk.isGithubId(state.currentUserId)) {
      const disk = GithubDisk.getDisk(state.currentUserId);
      if (!disk) return segments;
      segments.push(disk.name);
      segments.push('My Drive');
      if (state.currentFolderId !== GithubDisk.ROOT_ID && state.breadcrumbs.length > 2) {
        state.breadcrumbs.slice(2)
          .filter((crumb) => crumb.id !== GithubDisk.ROOT_ID && crumb.name !== 'My Drive')
          .forEach((crumb) => segments.push(crumb.name));
      }
      return segments;
    }

    const user = Auth.getUsers().find((u) => u.id === state.currentUserId);
    if (!user) return segments;

    segments.push(userLabel(user));

    if (state.section !== 'my-drive') {
      segments.push(SECTION_LABELS[state.section] || state.section);
      return segments;
    }

    segments.push('My Drive');
    if (state.currentFolderId !== Drive.ROOT_ID && state.breadcrumbs.length > 2) {
      state.breadcrumbs.slice(2)
        .filter((crumb) => crumb.id !== Drive.ROOT_ID && crumb.name !== 'My Drive')
        .forEach((crumb) => segments.push(crumb.name));
    }
    return segments;
  }

  async function resolveFolderPath(token, folderNames, rootId = Drive.ROOT_ID, listFn = Drive.listFiles) {
    let parentId = rootId;
    for (const name of folderNames) {
      const items = await listFn(token, parentId);
      const folder = items.find((f) => f.isFolder && f.name === name);
      if (!folder) throw new Error(`找不到文件夹：${name}`);
      parentId = folder.id;
    }
    return parentId;
  }

  async function routeFromSegments(segments) {
    if (!segments?.length) return { level: 'home' };

    if (segments[0] === '__legacy__') {
      const [, userId, second] = segments;
      const user = Auth.getUsers().find((u) => u.id === userId);
      if (!user) return { level: 'home' };
      if (!second) {
        return { level: 'drive', userId: user.id, section: 'my-drive', folderId: Drive.ROOT_ID };
      }
      if (['shared', 'starred', 'recent', 'trash'].includes(second)) {
        return { level: 'drive', userId: user.id, section: second, folderId: Drive.ROOT_ID };
      }
      return { level: 'drive', userId: user.id, section: 'my-drive', folderId: second };
    }

    let parts = segments;
    if (parts[0] === Router.ROOT_LABEL) parts = parts.slice(1);
    if (!parts.length) return { level: 'home' };

    const localDisk = LocalDisk.getDiskByName(parts[0]);
    if (localDisk) {
      if (parts.length === 1) {
        return {
          level: 'drive',
          userId: localDisk.id,
          section: 'my-drive',
          folderId: LocalDisk.ROOT_ID,
        };
      }
      const second = parts[1];
      if (SECTION_BY_LABEL[second]) {
        return {
          level: 'drive',
          userId: localDisk.id,
          section: SECTION_BY_LABEL[second],
          folderId: LocalDisk.ROOT_ID,
        };
      }
      let folderNames = second === 'My Drive' ? parts.slice(2) : parts.slice(1);
      if (second === 'My Drive' && folderNames[0] === 'My Drive') {
        folderNames = folderNames.slice(1);
      }
      let folderId = LocalDisk.ROOT_ID;
      if (folderNames.length > 0) {
        folderId = await resolveFolderPath(
          localDisk.id,
          folderNames,
          LocalDisk.ROOT_ID,
          (diskId, parentId) => LocalDisk.listFiles(diskId, parentId)
        );
      }
      return {
        level: 'drive',
        userId: localDisk.id,
        section: 'my-drive',
        folderId,
      };
    }

    const githubDisk = GithubDisk.getDiskByName(parts[0]);
    if (githubDisk) {
      if (parts.length === 1) {
        return {
          level: 'drive',
          userId: githubDisk.id,
          section: 'my-drive',
          folderId: GithubDisk.ROOT_ID,
        };
      }
      const second = parts[1];
      let folderNames = second === 'My Drive' ? parts.slice(2) : parts.slice(1);
      if (second === 'My Drive' && folderNames[0] === 'My Drive') {
        folderNames = folderNames.slice(1);
      }
      let folderId = GithubDisk.ROOT_ID;
      if (folderNames.length > 0) {
        folderId = await resolveFolderPath(
          githubDisk.id,
          folderNames,
          GithubDisk.ROOT_ID,
          (diskId, parentId) => GithubDisk.listFiles(diskId, parentId)
        );
      }
      return {
        level: 'drive',
        userId: githubDisk.id,
        section: 'my-drive',
        folderId,
      };
    }

    const user = Auth.getUsers().find((u) => userLabel(u) === parts[0]);
    if (!user) return null;

    if (parts.length === 1) {
      return { level: 'drive', userId: user.id, section: 'my-drive', folderId: Drive.ROOT_ID };
    }

    const second = parts[1];
    if (SECTION_BY_LABEL[second]) {
      return {
        level: 'drive',
        userId: user.id,
        section: SECTION_BY_LABEL[second],
        folderId: Drive.ROOT_ID,
      };
    }

    let folderNames = second === 'My Drive' ? parts.slice(2) : parts.slice(1);
    if (second === 'My Drive' && folderNames[0] === 'My Drive') {
      folderNames = folderNames.slice(1);
    }
    let folderId = Drive.ROOT_ID;

    if (folderNames.length > 0) {
      const token = await Auth.tryGetValidToken(user.id);
      if (token) {
        folderId = await resolveFolderPath(token, folderNames);
      }
    }

    return {
      level: 'drive',
      userId: user.id,
      section: 'my-drive',
      folderId,
    };
  }

  async function applyRoute(route, addToHistory = false) {
    if (!route) return;

    if (route.level === 'home') {
      state.level = 'home';
      state.currentUserId = null;
      state.currentFolderId = Drive.ROOT_ID;
      state.section = 'my-drive';
      state.expandedUsers.clear();
      if (addToHistory) pushHistory();
      else resetHistoryToCurrent();
      await loadCurrentLocation();
      return;
    }

    const isLocal = LocalDisk.isLocalId(route.userId);
    const isGithub = GithubDisk.isGithubId(route.userId);
    const user = isLocal
      ? LocalDisk.getDisk(route.userId)
      : isGithub
        ? GithubDisk.getDisk(route.userId)
        : Auth.getUsers().find((u) => u.id === route.userId);
    if (!user) {
      await applyRoute({ level: 'home' }, false);
      return;
    }

    state.level = 'drive';
    state.currentUserId = route.userId;
    state.currentFolderId = route.folderId || (isLocal ? LocalDisk.ROOT_ID : isGithub ? GithubDisk.ROOT_ID : Drive.ROOT_ID);
    state.section = route.section || 'my-drive';
    state.expandedUsers.clear();
    state.expandedUsers.add(route.userId);
    if (!isLocal && !isGithub) Auth.setActiveUser(route.userId);
    if (addToHistory) pushHistory();
    else resetHistoryToCurrent();
    await loadCurrentLocation();
  }

  async function applySegments(segments, addToHistory = false) {
    const route = await routeFromSegments(segments);
    if (!route) {
      await applyRoute({ level: 'home' }, false);
      return;
    }
    await applyRoute(route, addToHistory);
  }

  function userLabel(user) {
    return Auth.formatDisplayEmail(user.email);
  }

  function getQuotaLabel(userId) {
    return state.userQuotas[userId]?.label || '…';
  }

  function getQuotaShort(userId) {
    return state.userQuotas[userId]?.shortLabel || '…';
  }

  function localDisksAsFileItems() {
    return LocalDisk.getDisks().map((disk) => ({
      id: `local:${disk.id}`,
      name: disk.name,
      isFolder: true,
      isLocalDisk: true,
      userId: disk.id,
      quotaLabel: getQuotaShort(disk.id),
      typeName: 'Local Storage',
      sizeFormatted: getQuotaShort(disk.id),
      dateFormatted: '—',
    }));
  }

  function githubDisksAsFileItems() {
    return GithubDisk.getDisks().map((disk) => ({
      id: `github:${disk.id}`,
      name: disk.name,
      isFolder: true,
      isGithubDisk: true,
      userId: disk.id,
      picture: disk.accountAvatar,
      quotaLabel: getQuotaShort(disk.id),
      typeName: 'GitHub Repo',
      sizeFormatted: getQuotaShort(disk.id),
      dateFormatted: '—',
    }));
  }

  function homeDriveItems() {
    return [...localDisksAsFileItems(), ...githubDisksAsFileItems()];
  }

  async function refreshUserQuotas() {
    const localDisks = LocalDisk.getDisks();
    const githubDisks = GithubDisk.getDisks();
    await Promise.all([
      ...localDisks.map(async (disk) => {
        try {
          state.userQuotas[disk.id] = await LocalDisk.getStorageQuota(disk.id);
        } catch {
          state.userQuotas[disk.id] = {
            label: '存储不可用',
            shortLabel: '—',
          };
        }
      }),
      ...githubDisks.map(async (disk) => {
        try {
          state.userQuotas[disk.id] = await GithubDisk.getStorageQuota(disk.id);
        } catch {
          state.userQuotas[disk.id] = {
            label: '存储不可用',
            shortLabel: '—',
          };
        }
      }),
    ]);

    document.querySelectorAll('.tree-user-quota').forEach((el) => {
      const userId = el.dataset.userId;
      const quota = state.userQuotas[userId];
      el.textContent = getQuotaLabel(userId);
      el.classList.toggle('tree-user-quota-reauth', !!quota?.needsReauth);
    });

    if (state.level === 'home') {
      state.files = homeDriveItems();
      renderCurrentView();
    }
  }

  async function ejectLocalDisk(diskId) {
    await LocalDisk.removeDisk(diskId);
    delete state.userQuotas[diskId];
    clearTreeCache(diskId);
    state.expandedUsers.delete(diskId);

    if (state.currentUserId === diskId) {
      state.currentUserId = null;
      navigateToHome();
      if (state.githubSession === 'connected') showExplorer();
      else showLogin();
      return;
    }

    renderSidebarTree();
    if (state.level === 'home') {
      state.files = homeDriveItems();
      renderCurrentView();
    }
  }

  async function ejectGithubDisk(diskId) {
    await GithubDisk.removeDisk(diskId);
    delete state.userQuotas[diskId];
    clearTreeCache(diskId);
    state.expandedUsers.delete(diskId);

    if (state.currentUserId === diskId) {
      state.currentUserId = null;
      navigateToHome();
      if (state.githubSession === 'connected') showExplorer();
      else showLogin();
      return;
    }

    renderSidebarTree();
    if (state.level === 'home') {
      state.files = homeDriveItems();
      renderCurrentView();
    }
  }

  async function ejectAllDrives() {
    const localIds = LocalDisk.getDisks().map((d) => d.id);
    const githubIds = GithubDisk.getDisks().map((d) => d.id);
    for (const diskId of localIds) {
      await LocalDisk.removeDisk(diskId);
      delete state.userQuotas[diskId];
      clearTreeCache(diskId);
    }
    for (const diskId of githubIds) {
      await GithubDisk.removeDisk(diskId);
      delete state.userQuotas[diskId];
      clearTreeCache(diskId);
    }
    Auth.signOutAll();
    navigateToHome();
    if (state.githubSession === 'connected') showExplorer();
    else showLogin();
  }

  function signOutUser(userId) {
    Auth.removeUser(userId);
    delete state.userQuotas[userId];
    clearTreeCache(userId);
    state.expandedUsers.delete(userId);

    if (state.currentUserId === userId) {
      state.currentUserId = null;
      navigateToHome();
      if (state.githubSession === 'connected') showExplorer();
      else showLogin();
      return;
    }

    renderSidebarTree();
    if (state.level === 'home') {
      state.files = homeDriveItems();
      renderCurrentView();
    }
  }

  function renderUserAvatar(picture, className) {
    const src = escapeHtml(Auth.getAvatarUrl(picture));
    const cls = escapeHtml(`${className} avatar-img`.trim());
    return `<img src="${src}" alt="" class="${cls}" loading="lazy" />`;
  }

  function renderLocalStorageIcon(sizeClass = '') {
    const size = sizeClass === 'user-drive-avatar' ? 48
      : sizeClass === 'file-icon-wrap--small' ? 20
        : sizeClass === 'file-icon-wrap--tiny' ? 18
          : sizeClass ? 40 : 22;
    const cls = `local-storage-icon ${sizeClass}`.trim();
    return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
      <path fill="currentColor" d="M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.62V20c0 1.1 1.1 2 2 2h12c1.1 0 2-.9 2-2V8.63c.57-.28 1-.9 1-1.62V4c0-1.1-1-2-2-2zm-5 14H9v-2h6v2zm5-6H4V5h16v5z"/>
    </svg>`;
  }

  function renderGoogleDriveIcon(user, className = 'user-drive-avatar') {
    return renderUserAvatar(user?.picture, className);
  }

  function renderBreadcrumbs() {
    const container = $('#breadcrumbs');
    container.innerHTML = '';

    state.breadcrumbs.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        container.appendChild(sep);
      }

      const isLast = i === state.breadcrumbs.length - 1;
      const el = document.createElement('span');
      el.className = isLast ? 'breadcrumb-current' : 'breadcrumb-item';
      el.textContent = crumb.name;
      if (!isLast) {
        el.addEventListener('click', () => navigateToCrumb(crumb));
      }
      container.appendChild(el);
    });
  }

  function navigateToCrumb(crumb) {
    if (crumb.id === ROOT_ID) {
      navigateToHome();
    } else if (LocalDisk.getDisk(crumb.id)) {
      navigateToLocalDisk(crumb.id, LocalDisk.ROOT_ID);
    } else if (GithubDisk.getDisk(crumb.id)) {
      navigateToGithubDisk(crumb.id, GithubDisk.ROOT_ID);
    } else if (crumb.id?.startsWith('user:')) {
      navigateToUser(crumb.id.slice(5), Drive.ROOT_ID);
    } else if (crumb.id === Drive.ROOT_ID || crumb.id === LocalDisk.ROOT_ID || crumb.id === GithubDisk.ROOT_ID) {
      if (LocalDisk.isLocalId(state.currentUserId)) {
        navigateToLocalDisk(state.currentUserId, LocalDisk.ROOT_ID);
      } else if (GithubDisk.isGithubId(state.currentUserId)) {
        navigateToGithubDisk(state.currentUserId, GithubDisk.ROOT_ID);
      } else {
        navigateToUser(state.currentUserId, Drive.ROOT_ID);
      }
    } else if (['shared', 'starred', 'recent', 'trash'].includes(crumb.id)) {
      state.level = 'drive';
      state.section = crumb.id;
      state.currentFolderId = Drive.ROOT_ID;
      pushHistory();
      loadCurrentLocation();
    } else {
      navigateToFolder(crumb.id);
    }
  }

  function getFileTypeIcon(file) {
    return file.icon || Drive.getDefaultIcon(file) || '📄';
  }

  function renderFileIcon(file, sizeClass = '') {
    const inner = renderFileIconContent(file, sizeClass);
    return wrapFileIconWithProgress(file, inner, sizeClass);
  }

  function renderFileIconContent(file, sizeClass = '') {
    if (file.isUserDrive) {
      const user = Auth.getUsers().find((u) => u.id === file.userId);
      return renderGoogleDriveIcon(user || { picture: file.picture }, 'user-drive-avatar');
    }
    if (file.isLocalDisk) {
      return renderLocalStorageIcon(sizeClass || 'user-drive-avatar');
    }
    if (file.isGithubDisk) {
      return renderUserAvatar(file.picture || GithubDisk.getDisk(file.userId)?.accountAvatar, 'user-drive-avatar');
    }

    const fallback = getFileTypeIcon(file);
    const previewSrc = !file.isFolder && (file.thumbnailLink || file.iconLink);

    if (!previewSrc) {
      return `<span class="file-type-fallback ${sizeClass}">${fallback}</span>`;
    }

    const src = escapeHtml(previewSrc);
    const wrapClass = `file-icon-wrap ${sizeClass}`.trim();
    return `<span class="${wrapClass}">
      <span class="file-type-fallback">${fallback}</span>
      <img src="${src}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()" />
    </span>`;
  }

  function shouldShowFileProgress(file) {
    if (typeof OperationProgress === 'undefined') return false;
    if (state.processingItemIds.has(file.id)) return true;
    if (file.pending && file.pendingStatus !== 'error') return true;
    return false;
  }

  function resolveFileProgressSnapshot(file) {
    if (typeof OperationProgress === 'undefined') return null;
    return OperationProgress.findSnapshotForFile(file.id, file);
  }

  function wrapFileIconWithProgress(file, innerHtml, sizeClass = '') {
    if (!shouldShowFileProgress(file)) return innerHtml;

    const snap = resolveFileProgressSnapshot(file);
    const percent = snap?.percent ?? (file.pendingKind === 'delete' ? 12 : 6);
    const eta = snap?.remainingMs ? OperationProgress.formatEta(snap.remainingMs) : '';
    const shellClass = ['file-icon-shell', sizeClass].filter(Boolean).join(' ');
    const progressId = snap?.id || file.id;

    return `<span class="${shellClass}" data-progress-id="${escapeHtml(progressId)}" data-progress-fallback="${file.pendingStartedAt ? '1' : '0'}" data-progress-key="${escapeHtml(file.pendingOperationKey || '')}" data-progress-started="${file.pendingStartedAt || ''}" data-progress-size="${file.pendingSize || file.size || 0}">
      <span class="file-icon-shell__content">${innerHtml}</span>
      <span class="file-icon-progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"${eta ? ` title="~${escapeHtml(eta)} left"` : ''}>
        <span class="file-icon-progress__bar" style="width:${percent}%"></span>
      </span>
    </span>`;
  }

  function updateProgressBars() {
    if (typeof OperationProgress === 'undefined') return;
    document.querySelectorAll('[data-progress-id]').forEach((shell) => {
      let snap = OperationProgress.getSnapshot(shell.dataset.progressId);
      if (!snap && shell.dataset.progressFallback === '1') {
        const started = Number(shell.dataset.progressStarted);
        const operationKey = shell.dataset.progressKey;
        const size = Number(shell.dataset.progressSize) || 0;
        if (started && operationKey) {
          snap = OperationProgress.snapshotFromStartedAt(operationKey, started, size);
        }
      }
      if (!snap) return;
      const bar = shell.querySelector('.file-icon-progress__bar');
      const track = shell.querySelector('.file-icon-progress');
      if (bar) bar.style.width = `${snap.percent}%`;
      if (track) {
        track.setAttribute('aria-valuenow', String(snap.percent));
        const eta = OperationProgress.formatEta(snap.remainingMs);
        if (eta) track.title = `预计还需 ${eta}`;
      }
    });

    document.querySelectorAll('.file-item[data-id], .list-row[data-id]').forEach((el) => {
      const file = state.files.find((entry) => entry.id === el.dataset.id);
      if (!file || (!file.pending && !state.processingItemIds.has(file.id))) return;
      const label = getPendingDisplayLabel(file);
      const badge = el.querySelector('.file-pending-badge');
      if (badge) badge.textContent = label;
      const modified = el.querySelector('.col-modified');
      if (modified && file.pending) modified.textContent = label;
    });
  }

  function hasRenderableProgress() {
    if (typeof OperationProgress !== 'undefined' && OperationProgress.hasActive()) return true;
    if (state.processingItemIds.size > 0) return true;
    return state.files.some((file) => file.pending && file.pendingStatus !== 'error');
  }

  function syncProgressLoop() {
    if (!hasRenderableProgress()) {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      return;
    }
    updateProgressBars();
    if (!progressTimer) {
      progressTimer = setInterval(() => {
        if (!hasRenderableProgress()) {
          clearInterval(progressTimer);
          progressTimer = null;
          return;
        }
        updateProgressBars();
      }, 250);
    }
  }

  function markItemsProcessing(itemIds = []) {
    itemIds.forEach((id) => state.processingItemIds.add(id));
    renderCurrentView();
  }

  function unmarkItemsProcessing(itemIds = []) {
    if (!itemIds.length) state.processingItemIds.clear();
    else itemIds.forEach((id) => state.processingItemIds.delete(id));
    renderCurrentView();
  }

  function getPendingDisplayLabel(file) {
    if (typeof OperationProgress !== 'undefined') {
      const snap = resolveFileProgressSnapshot(file);
      if (snap?.remainingMs) {
        const eta = OperationProgress.formatEta(snap.remainingMs);
        if (eta) return `${getPendingStatusText(file)} · ~${eta}`;
      }
    }
    return getPendingStatusText(file);
  }

  function getFilePendingClasses(file) {
    if (!file.pending && !state.processingItemIds.has(file.id)) return '';
    const status = file.pendingStatus || 'syncing';
    const kindClass = file.pendingKind === 'delete' ? ' file-item--pending-kind-delete' : '';
    return ` file-item--pending file-item--pending-${status}${kindClass}`;
  }

  function getPendingStatusText(file) {
    if (file.pendingKind === 'delete') {
      if (file.pendingStatus === 'pending') return '正在完成删除…';
      if (file.pendingStatus === 'error') return file.pendingError || '删除失败';
      return '正在删除…';
    }
    if (state.processingItemIds.has(file.id)) return '正在删除…';
    if (file.pendingStatus === 'error') return file.pendingError || '操作失败';
    if (file.pending && file.dateFormatted && !file.dateFormatted.includes('~')) return file.dateFormatted;
    if (file.pendingStatus === 'saving') return '正在保存…';
    if (file.pendingStatus === 'moving') return '正在移动…';
    if (file.pendingStatus === 'pending') {
      if (file.pendingKind === 'save') return '等待保存…';
      if (file.pendingKind === 'move') return '等待移动…';
      return '等待 GitHub 完成…';
    }
    if (file.pendingStatus === 'syncing') return '正在上传…';
    return '正在同步…';
  }

  function renderFileStatusBadge(file) {
    if (file.pending || state.processingItemIds.has(file.id)) {
      const label = getPendingDisplayLabel(file);
      const status = file.pendingStatus || (state.processingItemIds.has(file.id) ? 'syncing' : 'syncing');
      return `<span class="file-pending-badge file-pending-badge--${status}">${escapeHtml(label)}</span>`;
    }
    if (file.isUserDrive || file.isLocalDisk || file.isGithubDisk) {
      return `<span class="file-quota">${escapeHtml(file.quotaLabel || '…')}</span>`;
    }
    return '';
  }

  function renderGrid() {
    const grid = $('#file-grid');
    grid.innerHTML = '';

    visibleFiles().forEach((file) => {
      const item = document.createElement('div');
      const pendingClass = getFilePendingClasses(file);
      item.className = 'file-item' + (state.selectedIds.has(file.id) ? ' selected' : '') + pendingClass;
      item.dataset.id = file.id;
      const statusHtml = renderFileStatusBadge(file);
      item.innerHTML = `
        <button type="button" class="item-more-btn" aria-label="${escapeHtml(file.name)} 的操作">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
        <div class="file-icon">${renderFileIcon(file)}</div>
        <span class="file-name">${escapeHtml(file.name)}</span>
        ${statusHtml}
      `;
      item.addEventListener('click', (event) => selectFile(file.id, event));
      item.addEventListener('dblclick', () => openFile(file));
      attachFileContextMenu(item, file);
      bindDragDropForWorkspaceItem(item, file);
      grid.appendChild(item);
    });
    Auth.applyAvatarFallbacks(grid);
  }

  function renderList() {
    const body = $('#file-list-body');
    body.innerHTML = '';

    visibleFiles().forEach((file) => {
      const row = document.createElement('div');
      const pendingClass = getFilePendingClasses(file);
      row.className = 'list-row' + (state.selectedIds.has(file.id) ? ' selected' : '') + pendingClass;
      row.dataset.id = file.id;
      const modifiedLabel = (file.pending || state.processingItemIds.has(file.id))
        ? getPendingDisplayLabel(file)
        : file.dateFormatted;
      row.innerHTML = `
        <span class="col-name">
          <span class="list-icon">${renderFileIcon(file, 'file-icon-wrap--small')}</span>
          <span class="list-name-text">${escapeHtml(file.name)}</span>
        </span>
        <span class="col-modified">${escapeHtml(modifiedLabel)}</span>
        <span class="col-size">${file.sizeFormatted}</span>
        <span class="col-type">${file.typeName}</span>
        <button type="button" class="item-more-btn" aria-label="${escapeHtml(file.name)} 的操作">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      `;
      row.addEventListener('click', (event) => selectFile(file.id, event));
      row.addEventListener('dblclick', () => openFile(file));
      attachFileContextMenu(row, file);
      bindDragDropForWorkspaceItem(row, file);
      body.appendChild(row);
    });
    Auth.applyAvatarFallbacks(body);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function selectFile(id, event = null) {
    if (event?.ctrlKey || event?.metaKey || event?.shiftKey) {
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
    } else {
      state.selectedIds = new Set([id]);
    }
    state.selectedId = id;
    updateSelectionBar();
    renderCurrentView();
    const file = state.files.find((f) => f.id === id);
    $('#status-selected').textContent = file ? file.name : '';
  }

  async function downloadLocalFile(file) {
    const blob = await LocalDisk.downloadFile(state.currentUserId, file.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(`正在下载“${file.name}”`);
  }

  function openFile(file, userId = state.currentUserId, options = {}) {
    if (file.isUserDrive) {
      navigateToUser(file.userId, Drive.ROOT_ID);
    } else if (file.isLocalDisk) {
      navigateToLocalDisk(file.userId, LocalDisk.ROOT_ID);
    } else if (file.isGithubDisk) {
      navigateToGithubDisk(file.userId, GithubDisk.ROOT_ID);
    } else if (file.isFolder && state.section !== 'trash') {
      navigateToFolder(file.id);
    } else if (
      userId
      && (
        Drive.isNotepadFile(file)
        || (LocalDisk.isLocalId(userId) && LocalDisk.isNotepadFile(file))
        || (GithubDisk.isGithubId(userId) && GithubDisk.isNotepadFile(file))
      )
      && (options.fromTree || state.section === 'my-drive')
    ) {
      Notepad.openInTab(file, userId).catch(showError);
    } else if (userId && LocalDisk.isLocalId(userId) && !file.isFolder) {
      const prevUserId = state.currentUserId;
      state.currentUserId = userId;
      downloadLocalFile(file).catch(showError).finally(() => {
        state.currentUserId = prevUserId;
      });
    } else if (userId && GithubDisk.isGithubId(userId) && !file.isFolder) {
      if (file.pending) {
        showStatus(getPendingDisplayLabel(file));
        return;
      }
      if (GithubDisk.isBrowserViewableFile(file)) {
        try {
          const url = file.viewUrl || GithubDisk.getFileViewUrl(userId, file.id);
          window.open(url, '_blank', 'noopener');
        } catch (err) {
          showError(err.message);
        }
        return;
      }
      GithubDisk.downloadFile(userId, file.id).then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }).catch(showError);
    } else if (file.webViewLink) {
      window.open(file.webViewLink, '_blank');
    }
  }

  async function loadRepositoryHistory(force = false) {
    const diskId = state.currentUserId;
    if (!GithubDisk.isGithubId(diskId)) return;
    const list = $('#repository-history-list');
    const empty = $('#repository-history-empty');
    if (!list) return;
    if (force || !list.dataset.loaded) {
      list.textContent = '正在加载提交历史…';
      empty?.classList.add('hidden');
      try {
        const commits = await GithubDisk.listHistory(diskId);
        list.innerHTML = '';
        commits.forEach((commit) => {
          const item = document.createElement('article');
          item.className = 'history-item';
          const message = commit?.commit?.message || '无提交说明';
          const author = commit?.commit?.author?.name || commit?.author?.login || '未知作者';
          const date = commit?.commit?.author?.date;
          item.innerHTML = '<strong></strong><span></span><code></code>';
          item.querySelector('strong').textContent = message.split('\n')[0];
          item.querySelector('span').textContent = `${author}${date ? ` · ${new Date(date).toLocaleString()}` : ''}`;
          item.querySelector('code').textContent = (commit?.sha || '').slice(0, 7);
          list.appendChild(item);
        });
        list.dataset.loaded = 'true';
        empty?.classList.toggle('hidden', commits.length > 0);
      } catch (error) {
        list.textContent = '';
        empty?.classList.remove('hidden');
        empty.textContent = `加载提交历史失败：${error?.message || error}`;
      }
    }
  }

  function setRepositoryView(view) {
    if (!['files', 'history'].includes(view)) return;
    state.repositoryView = view;
    document.querySelectorAll('[data-repository-view]').forEach((button) => {
      const active = button.dataset.repositoryView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('#repository-history')?.classList.toggle('hidden', view !== 'history');
    $('#file-grid')?.classList.toggle('hidden', view !== 'files');
    $('#file-list')?.classList.toggle('hidden', view !== 'files' || state.view !== 'list');
    if (view === 'history') loadRepositoryHistory();
    else renderCurrentView();
  }

  function renderOverview() {
    const local = LocalDisk.getDisks();
    const github = GithubDisk.getDisks();
    const disks = state.overviewMode === 'repositories' ? github : [...local, ...github];
    const list = $('#overview-storage-list');
    const empty = $('#overview-empty');
    if (!list) return;
    list.innerHTML = '';
    $('#overview-repo-count').textContent = String(github.length);
    $('#overview-local-count').textContent = String(local.length);
    $('#overview-total-count').textContent = String(local.length + github.length);
    const title = $('#overview-title');
    if (title) title.textContent = state.overviewMode === 'repositories' ? '仓库' : '概览';
    const summary = $('#overview-summary');
    if (summary) summary.textContent = state.overviewMode === 'repositories'
      ? '选择一个已挂载的 GitHub 仓库以浏览文件和提交历史。'
      : '管理已挂载的本地存储和 GitHub 仓库。';
    empty?.classList.toggle('hidden', disks.length > 0);
    disks.forEach((disk) => {
      const isGithub = GithubDisk.isGithubId(disk.id);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'overview-storage-item';
      item.innerHTML = `<span class="overview-storage-icon">${isGithub ? '◫' : '▣'}</span><span class="overview-storage-copy"><strong></strong><small></small></span><span aria-hidden="true">›</span>`;
      item.querySelector('strong').textContent = isGithub ? `${disk.owner}/${disk.repo}` : disk.name;
      item.querySelector('small').textContent = isGithub ? `GitHub · ${disk.branch || '默认分支'}` : '本地存储';
      item.addEventListener('click', () => isGithub
        ? navigateToGithubDisk(disk.id, GithubDisk.ROOT_ID)
        : navigateToLocalDisk(disk.id, LocalDisk.ROOT_ID));
      list.appendChild(item);
    });
  }

  function renderCurrentView() {
    const overview = $('#overview-panel');
    const isOverview = state.level === 'home';
    overview?.classList.toggle('hidden', !isOverview);
    if (isOverview) renderOverview();
    setSidebarActive(getActiveNavId());
    renderGithubSessionState();
    const repoHeader = $('#repository-header');
    const repoName = $('#repository-name');
    const repoMeta = $('#repository-meta');
    const disk = state.currentUserId && GithubDisk.isGithubId(state.currentUserId)
      ? GithubDisk.getDisk(state.currentUserId)
      : null;
    if (repoHeader) repoHeader.classList.toggle('hidden', !disk);
    if (repoName && disk) repoName.textContent = `${disk.owner}/${disk.repo}`;
    if (repoMeta && disk) repoMeta.textContent = `${disk.private ? '私有仓库' : '公开仓库'} · 分支 ${disk.branch || '默认分支'}`;

    const isHistory = !isOverview && state.repositoryView === 'history' && !!disk;
    const isFileWorkspace = !isOverview && !isHistory;
    $('.file-tools')?.classList.toggle('hidden', !isFileWorkspace);
    $('.view-toggle')?.classList.toggle('hidden', !isFileWorkspace);
    $('.address-bar')?.classList.toggle('hidden', isOverview);
    document.querySelectorAll('[data-repository-view]').forEach((button) => {
      const active = button.dataset.repositoryView === (isHistory ? 'history' : 'files');
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('#repository-history')?.classList.toggle('hidden', !isHistory);
    if (isOverview || isHistory) {
      hide($('#file-grid'));
      hide($('#file-list'));
      if (isHistory) loadRepositoryHistory();
    } else if (state.view === 'grid') {
      show($('#file-grid'));
      hide($('#file-list'));
      renderGrid();
    } else {
      hide($('#file-grid'));
      show($('#file-list'));
      renderList();
    }

    if (isOverview) {
      hide($('#empty-state'));
      hide($('#no-storage-state'));
    } else if (!hasMountedDrives()) {
      // 登录后尚未挂载任何存储：欢迎空态引导添加 Repository（Mutation 由用户显式发起）
      hide($('#empty-state'));
      show($('#no-storage-state'));
    } else {
      hide($('#no-storage-state'));
      if (state.files.length === 0) {
        show($('#empty-state'));
      } else {
        hide($('#empty-state'));
      }
    }

    const count = visibleFiles().length;
    $('#status-count').textContent = state.searchQuery ? `${count} / ${state.files.length} 个项目` : `${count} 个项目`;
    updateSelectionBar();
    syncProgressLoop();
  }

  function setView(view) {
    state.view = view;
    $('#btn-view-grid').classList.toggle('active', view === 'grid');
    $('#btn-view-list').classList.toggle('active', view === 'list');
    renderCurrentView();
  }

  function folderKey(userId, folderId) {
    return `${userId}:${folderId}`;
  }

  function toDiskNavId(diskId) {
    return diskId.replace(':', '-');
  }

  function fromDiskNavId(navId) {
    return navId.replace(/^local-/, 'local:');
  }

  function toGithubNavId(diskId) {
    return encodeURIComponent(diskId);
  }

  function fromGithubNavId(navId) {
    return decodeURIComponent(navId);
  }

  function folderNavId(userId, folderId) {
    return `folder|${userId}|${folderId}`;
  }

  function parseFolderNav(nav) {
    if (!nav?.startsWith('folder|')) return null;
    const parts = nav.split('|');
    if (parts.length < 3) return null;
    return { userId: parts[1], folderId: parts.slice(2).join('|') };
  }

  function getDriveRootId() {
    if (isCurrentLocalDrive()) return LocalDisk.ROOT_ID;
    if (isCurrentGithubDrive()) return GithubDisk.ROOT_ID;
    return DRIVE_ROOT_ID;
  }

  function getActiveNavId() {
    if (state.level === 'home') return state.overviewMode === 'repositories' ? 'repositories' : 'home';
    if (!state.currentUserId) return 'home';
    if (state.section === 'my-drive') {
      const rootId = getDriveRootId();
      if (state.currentFolderId !== rootId) {
        return folderNavId(state.currentUserId, state.currentFolderId);
      }
      if (isCurrentLocalDrive()) {
        return `disk:${toDiskNavId(state.currentUserId)}:my-drive`;
      }
      if (isCurrentGithubDrive()) {
        return `github:${toGithubNavId(state.currentUserId)}:my-drive`;
      }
      return `user:${state.currentUserId}:my-drive`;
    }
    if (isCurrentLocalDrive()) {
      return `disk:${toDiskNavId(state.currentUserId)}:${state.section}`;
    }
    if (isCurrentGithubDrive()) {
      return `github:${toGithubNavId(state.currentUserId)}:${state.section}`;
    }
    return `user:${state.currentUserId}:${state.section}`;
  }

  function setSidebarActive(itemId) {
    document.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === itemId);
    });
  }

  function isUserExpanded(userId) {
    return state.expandedUsers.has(userId);
  }

  function isFolderExpanded(userId, folderId) {
    return state.expandedFolders.has(folderKey(userId, folderId));
  }

  function createTreeToggle({ type, userId, folderId, expanded }) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.dataset.treeToggle = type;
    if (userId) toggle.dataset.userId = userId;
    if (folderId) toggle.dataset.folderId = folderId;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? '折叠' : '展开');
    toggle.innerHTML = '<span class="tree-chevron" aria-hidden="true"></span>';
    return toggle;
  }

  function createTreeSpacer() {
    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    return spacer;
  }

  function clearTreeCache(userId) {
    Object.keys(state.treeChildren).forEach((key) => {
      if (key.startsWith(`${userId}:`)) {
        delete state.treeChildren[key];
        delete state.treeVisibleCount[key];
      }
    });
  }

  async function loadTreeChildren(userId, token, parentId) {
    const key = folderKey(userId, parentId);
    if (state.treeChildren[key]) return state.treeChildren[key];

    const files = LocalDisk.isLocalId(userId)
      ? await LocalDisk.listFiles(userId, parentId)
      : GithubDisk.isGithubId(userId)
        ? await GithubDisk.listFiles(userId, parentId)
        : await Drive.listFiles(token, parentId);
    state.treeChildren[key] = files.map((f) => ({
      id: f.id,
      name: f.name,
      isFolder: f.isFolder,
      icon: f.icon,
      webViewLink: f.webViewLink,
      mimeType: f.mimeType,
      parents: f.parents || [],
      typeName: f.typeName,
      sizeFormatted: f.sizeFormatted,
      dateFormatted: f.dateFormatted,
    }));
    if (!state.treeVisibleCount[key]) {
      state.treeVisibleCount[key] = TREE_PAGE_SIZE;
    }
    return state.treeChildren[key];
  }

  function showMoreTreeItems(key) {
    const total = state.treeChildren[key]?.length || 0;
    const current = state.treeVisibleCount[key] || TREE_PAGE_SIZE;
    state.treeVisibleCount[key] = Math.min(current + TREE_PAGE_SIZE, total);
    renderSidebarTree();
  }

  function findTreeItem(userId, itemId) {
    for (const key of Object.keys(state.treeChildren)) {
      if (!key.startsWith(`${userId}:`)) continue;
      const item = state.treeChildren[key].find((i) => i.id === itemId);
      if (item) return item;
    }
    return null;
  }

  function findTreeFile(userId, fileId) {
    return findTreeItem(userId, fileId);
  }

  async function syncTreeWithCurrentPath(userId, token) {
    if (state.section !== 'my-drive') return;

    const rootId = LocalDisk.isLocalId(userId)
      ? LocalDisk.ROOT_ID
      : GithubDisk.isGithubId(userId)
        ? GithubDisk.ROOT_ID
        : Drive.ROOT_ID;
    state.expandedUsers.add(userId);
    state.expandedFolders.add(folderKey(userId, rootId));
    await loadTreeChildren(userId, token, rootId);

    if (state.currentFolderId === rootId) return;

    const path = LocalDisk.isLocalId(userId)
      ? await LocalDisk.getFolderPath(userId, state.currentFolderId)
      : GithubDisk.isGithubId(userId)
        ? await GithubDisk.getFolderPath(userId, state.currentFolderId)
        : await Drive.getFolderPath(token, state.currentFolderId);
    for (const crumb of path) {
      await loadTreeChildren(userId, token, crumb.id);
      if (crumb.id !== rootId) {
        state.expandedFolders.add(folderKey(userId, crumb.id));
      }
    }
  }

  function renderTreeMoreButton(key, container) {
    const total = state.treeChildren[key]?.length || 0;
    const limit = state.treeVisibleCount[key] || TREE_PAGE_SIZE;
    if (total <= limit) return;

    const li = document.createElement('li');
    li.className = 'tree-more-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.appendChild(createTreeSpacer());

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-item tree-more-item';
    btn.dataset.treeMore = key;
    const remaining = total - limit;
    btn.textContent = '…';
    btn.title = `显示更多（剩余 ${remaining} 项）`;
    row.appendChild(btn);
    li.appendChild(row);
    container.appendChild(li);
  }

  function renderTreeNodes(userId, parentId, container) {
    const key = folderKey(userId, parentId);
    const items = state.treeChildren[key] || [];
    const limit = state.treeVisibleCount[key] || TREE_PAGE_SIZE;
    const visible = items.slice(0, limit);

    visible.forEach((item) => {
      if (item.isFolder) {
        const expanded = isFolderExpanded(userId, item.id);
        const li = document.createElement('li');
        li.className = 'tree-folder-node' + (expanded ? '' : ' collapsed');

        const row = document.createElement('div');
        row.className = 'tree-row';

        const toggle = createTreeToggle({
          type: 'folder',
          userId,
          folderId: item.id,
          expanded,
        });

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item tree-folder-item';
        btn.dataset.nav = folderNavId(userId, item.id);
        btn.innerHTML = `<span class="sidebar-icon tree-entry-icon" aria-hidden="true">📁</span><span class="tree-folder-label">${escapeHtml(item.name)}</span>`;

        row.appendChild(toggle);
        row.appendChild(btn);
        bindDragDropForTreeItem(btn, { ...item, isFolder: true }, userId);
        addTreeMoreButton(row, () => ({
          type: 'folder',
          file: { ...item, isFolder: true },
          userId,
          folderId: item.id,
          section: 'my-drive',
        }));
        li.appendChild(row);

        const childUl = document.createElement('ul');
        childUl.className = 'tree-children tree-level-folder';
        if (expanded) {
          renderTreeNodes(userId, item.id, childUl);
        }
        li.appendChild(childUl);
        container.appendChild(li);
        return;
      }

      const li = document.createElement('li');
      li.className = 'tree-file-node';
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.appendChild(createTreeSpacer());

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar-item tree-file-item';
      btn.dataset.nav = `file|${userId}|${item.id}`;
      btn.innerHTML = `<span class="sidebar-icon tree-entry-icon" aria-hidden="true">${escapeHtml(getFileTypeIcon(item))}</span><span class="tree-file-label">${escapeHtml(item.name)}</span>`;
      row.appendChild(btn);
      bindDragDropForTreeItem(btn, item, userId);
      addTreeMoreButton(row, () => ({
        type: 'file',
        file: item,
        userId,
        folderId: item.parentId || item.parents?.[0] || (LocalDisk.isLocalId(userId) ? LocalDisk.ROOT_ID : GithubDisk.isGithubId(userId) ? GithubDisk.ROOT_ID : Drive.ROOT_ID),
        section: 'my-drive',
      }));
      li.appendChild(row);
      container.appendChild(li);
    });

    renderTreeMoreButton(key, container);
  }

  function renderSidebarTree() {
    ContextMenu.hide();
    const list = $('#sidebar-tree-users');
    list.innerHTML = '';

    const users = [];

    if (false) users.forEach((user) => {
      const expanded = isUserExpanded(user.id);
      const userNav = `user:${user.id}`;

      const li = document.createElement('li');
      li.className = 'tree-user-node' + (expanded ? '' : ' collapsed');

      const row = document.createElement('div');
      row.className = 'tree-row';

      const toggle = createTreeToggle({
        type: 'user',
        userId: user.id,
        expanded,
      });

      const userBtn = document.createElement('button');
      userBtn.type = 'button';
      userBtn.className = 'sidebar-item user-drive-item tree-user-btn';
      userBtn.dataset.nav = userNav;

      const img = document.createElement('img');
      img.className = 'sidebar-user-avatar avatar-img';
      img.alt = userLabel(user);
      img.src = Auth.getAvatarUrl(user.picture);
      Auth.applyAvatarFallback(img);

      const info = document.createElement('div');
      info.className = 'tree-user-info';

      const label = document.createElement('span');
      label.className = 'sidebar-user-label';
      label.textContent = userLabel(user);

      const quota = document.createElement('span');
      quota.className = 'tree-user-quota';
      quota.dataset.userId = user.id;
      quota.dataset.reauthUser = user.id;
      quota.textContent = getQuotaLabel(user.id);
      if (state.userQuotas[user.id]?.needsReauth) {
        quota.classList.add('tree-user-quota-reauth');
      }

      info.appendChild(label);
      info.appendChild(quota);
      userBtn.appendChild(img);
      userBtn.appendChild(info);
      attachDropTarget(userBtn, () => ({
        destUserId: user.id,
        destParentId: Drive.ROOT_ID,
      }));
      row.appendChild(toggle);
      row.appendChild(userBtn);
      addTreeMoreButton(row, () => ({ type: 'user', userId: user.id, user }));

      const children = document.createElement('ul');
      children.className = 'tree-children tree-level-2';

      USER_SECTIONS.forEach((section) => {
        const sectionLi = document.createElement('li');
        sectionLi.className = 'tree-section-node';

        if (section.id === 'my-drive') {
          const myDriveExpanded = isFolderExpanded(user.id, Drive.ROOT_ID);
          sectionLi.classList.toggle('collapsed', !myDriveExpanded);

          const sectionRow = document.createElement('div');
          sectionRow.className = 'tree-row';

          const sectionToggle = createTreeToggle({
            type: 'my-drive',
            userId: user.id,
            folderId: Drive.ROOT_ID,
            expanded: myDriveExpanded,
          });

          const sectionBtn = document.createElement('button');
          sectionBtn.type = 'button';
          sectionBtn.className = 'sidebar-item tree-child-item';
          sectionBtn.dataset.nav = `user:${user.id}:my-drive`;
          sectionBtn.innerHTML = `
            <span class="sidebar-icon">${section.icon}</span>
            <span>${section.label}</span>
          `;

          sectionRow.appendChild(sectionToggle);
          sectionRow.appendChild(sectionBtn);
          sectionLi.appendChild(sectionRow);

          const folderTree = document.createElement('ul');
          folderTree.className = 'tree-children tree-level-3';
          if (myDriveExpanded) {
            renderTreeNodes(user.id, Drive.ROOT_ID, folderTree);
          }
          sectionLi.appendChild(folderTree);
        } else {
          const sectionRow = document.createElement('div');
          sectionRow.className = 'tree-row';
          sectionRow.appendChild(createTreeSpacer());

          const sectionBtn = document.createElement('button');
          sectionBtn.type = 'button';
          sectionBtn.className = 'sidebar-item tree-child-item';
          sectionBtn.dataset.nav = `user:${user.id}:${section.id}`;
          sectionBtn.innerHTML = `
            <span class="sidebar-icon">${section.icon}</span>
            <span>${section.label}</span>
          `;

          sectionRow.appendChild(sectionBtn);
          sectionLi.appendChild(sectionRow);
        }

        children.appendChild(sectionLi);
      });

      li.appendChild(row);
      li.appendChild(children);
      list.appendChild(li);
    });

    LocalDisk.getDisks().forEach((disk) => {
      const expanded = isUserExpanded(disk.id);
      const diskNav = `disk:${toDiskNavId(disk.id)}`;

      const li = document.createElement('li');
      li.className = 'tree-user-node tree-local-node' + (expanded ? '' : ' collapsed');

      const row = document.createElement('div');
      row.className = 'tree-row';

      const toggle = createTreeToggle({
        type: 'local-disk',
        userId: disk.id,
        expanded,
      });

      const diskBtn = document.createElement('button');
      diskBtn.type = 'button';
      diskBtn.className = 'sidebar-item local-drive-item tree-user-btn';
      diskBtn.dataset.nav = diskNav;

      const icon = document.createElement('span');
      icon.className = 'sidebar-icon local-storage-icon-wrap';
      icon.innerHTML = renderLocalStorageIcon();

      const info = document.createElement('div');
      info.className = 'tree-user-info';

      const label = document.createElement('span');
      label.className = 'sidebar-user-label';
      label.textContent = disk.name;
      const repoMeta = document.createElement('span');
      repoMeta.className = 'tree-repo-meta';
      repoMeta.textContent = disk.owner && disk.repo ? `${disk.owner}/${disk.repo} · ${disk.branch || 'main'}` : '本地存储';

      const quota = document.createElement('span');
      quota.className = 'tree-user-quota';
      quota.dataset.userId = disk.id;
      quota.textContent = getQuotaLabel(disk.id);

      info.appendChild(label);
      info.appendChild(repoMeta);
      info.appendChild(quota);
      diskBtn.appendChild(icon);
      diskBtn.appendChild(info);
      attachDropTarget(diskBtn, () => ({
        destUserId: disk.id,
        destParentId: LocalDisk.ROOT_ID,
      }));
      row.appendChild(toggle);
      row.appendChild(diskBtn);
      addTreeMoreButton(row, () => ({ type: 'local-disk', diskId: disk.id, disk }));

      const children = document.createElement('ul');
      children.className = 'tree-children tree-level-2';
      const rootTree = document.createElement('ul');
      rootTree.className = 'tree-children tree-level-3';
      if (expanded && isFolderExpanded(disk.id, LocalDisk.ROOT_ID)) {
        renderTreeNodes(disk.id, LocalDisk.ROOT_ID, rootTree);
      }
      children.appendChild(rootTree);

      LOCAL_DISK_SECTIONS.forEach((section) => {
        const sectionLi = document.createElement('li');
        sectionLi.className = 'tree-section-node';

        if (section.id === 'my-drive') {
          const myDriveExpanded = isFolderExpanded(disk.id, LocalDisk.ROOT_ID);
          sectionLi.classList.toggle('collapsed', !myDriveExpanded);

          const sectionRow = document.createElement('div');
          sectionRow.className = 'tree-row';

          const sectionToggle = createTreeToggle({
            type: 'my-drive',
            userId: disk.id,
            folderId: LocalDisk.ROOT_ID,
            expanded: myDriveExpanded,
          });

          const sectionBtn = document.createElement('button');
          sectionBtn.type = 'button';
          sectionBtn.className = 'sidebar-item tree-child-item';
          sectionBtn.dataset.nav = `${diskNav}:my-drive`;
          sectionBtn.innerHTML = `
            <span class="sidebar-icon">${section.icon}</span>
            <span>${section.label}</span>
          `;

          sectionRow.appendChild(sectionToggle);
          sectionRow.appendChild(sectionBtn);
          sectionLi.appendChild(sectionRow);

          const folderTree = document.createElement('ul');
          folderTree.className = 'tree-children tree-level-3';
          if (myDriveExpanded) {
            renderTreeNodes(disk.id, LocalDisk.ROOT_ID, folderTree);
          }
          sectionLi.appendChild(folderTree);
        } else {
          const sectionRow = document.createElement('div');
          sectionRow.className = 'tree-row';
          sectionRow.appendChild(createTreeSpacer());

          const sectionBtn = document.createElement('button');
          sectionBtn.type = 'button';
          sectionBtn.className = 'sidebar-item tree-child-item';
          sectionBtn.dataset.nav = `${diskNav}:${section.id}`;
          sectionBtn.innerHTML = `
            <span class="sidebar-icon">${section.icon}</span>
            <span>${section.label}</span>
          `;

          sectionRow.appendChild(sectionBtn);
          sectionLi.appendChild(sectionRow);
        }

        children.appendChild(sectionLi);
      });

      li.appendChild(row);
      li.appendChild(children);
      list.appendChild(li);
    });

    GithubDisk.getDisks().forEach((disk) => {
      const expanded = isUserExpanded(disk.id);
      const diskNav = `github:${toGithubNavId(disk.id)}`;

      const li = document.createElement('li');
      li.className = 'tree-user-node tree-local-node' + (expanded ? '' : ' collapsed');

      const row = document.createElement('div');
      row.className = 'tree-row';

      const toggle = createTreeToggle({
        type: 'github-disk',
        userId: disk.id,
        expanded,
      });

      const diskBtn = document.createElement('button');
      diskBtn.type = 'button';
      diskBtn.className = 'sidebar-item user-drive-item tree-user-btn';
      diskBtn.dataset.nav = diskNav;

      const img = document.createElement('img');
      img.className = 'sidebar-user-avatar avatar-img';
      img.alt = disk.name;
      img.src = disk.accountAvatar || Auth.getDefaultAvatarUrl();
      Auth.applyAvatarFallback(img);

      const info = document.createElement('div');
      info.className = 'tree-user-info';

      const label = document.createElement('span');
      label.className = 'sidebar-user-label';
      label.textContent = disk.name;
      const repoMeta = document.createElement('span');
      repoMeta.className = 'tree-repo-meta';
      repoMeta.textContent = disk.owner && disk.repo ? `${disk.owner}/${disk.repo} · ${disk.branch || 'main'}` : '本地存储';

      const quota = document.createElement('span');
      quota.className = 'tree-user-quota';
      quota.dataset.userId = disk.id;
      quota.textContent = getQuotaLabel(disk.id);

      info.appendChild(label);
      info.appendChild(repoMeta);
      info.appendChild(quota);
      diskBtn.appendChild(img);
      diskBtn.appendChild(info);
      attachDropTarget(diskBtn, () => ({
        destUserId: disk.id,
        destParentId: GithubDisk.ROOT_ID,
      }));
      row.appendChild(toggle);
      row.appendChild(diskBtn);
      addTreeMoreButton(row, () => ({ type: 'github-disk', diskId: disk.id, disk }));

      const children = document.createElement('ul');
      children.className = 'tree-children tree-level-2';
      const rootTree = document.createElement('ul');
      rootTree.className = 'tree-children tree-level-3';
      if (expanded && isFolderExpanded(disk.id, GithubDisk.ROOT_ID)) {
        renderTreeNodes(disk.id, GithubDisk.ROOT_ID, rootTree);
      }
      children.appendChild(rootTree);

      li.appendChild(row);
      li.appendChild(children);
      list.appendChild(li);
    });

    setSidebarActive(getActiveNavId());
  }

  async function handleTreeToggle(toggle) {
    ContextMenu.hide();
    const type = toggle.dataset.treeToggle;

    if (type === 'user' || type === 'local-disk' || type === 'github-disk') {
      const userId = toggle.dataset.userId;
      if (state.expandedUsers.has(userId)) {
        state.expandedUsers.delete(userId);
        renderSidebarTree();
        return;
      }
      state.expandedUsers.clear();
      state.expandedUsers.add(userId);
      const rootId = LocalDisk.isLocalId(userId)
        ? LocalDisk.ROOT_ID
        : GithubDisk.isGithubId(userId)
          ? GithubDisk.ROOT_ID
          : Drive.ROOT_ID;
      state.expandedFolders.add(folderKey(userId, rootId));
      try {
        const token = !isLocalOrGithubDrive(userId) ? await Auth.tryGetValidToken(userId) : null;
        await loadTreeChildren(userId, token, rootId);
      } catch (error) {
        showError(error?.message || '加载存储目录失败');
      }
      renderSidebarTree();
      return;
    }

    if (type === 'my-drive' || type === 'folder') {
      const userId = toggle.dataset.userId;
      const folderId = toggle.dataset.folderId;
      const key = folderKey(userId, folderId);

      if (state.expandedFolders.has(key)) {
        state.expandedFolders.delete(key);
        renderSidebarTree();
        return;
      }

      state.expandedFolders.add(key);
      try {
        if (LocalDisk.isLocalId(userId)) {
          await loadTreeChildren(userId, null, folderId);
        } else if (GithubDisk.isGithubId(userId)) {
          await loadTreeChildren(userId, null, folderId);
        } else {
          const token = await Auth.tryGetValidToken(userId);
          if (!token) throw new Error('需要登录 Google：请右键点击侧栏中的 Google 云端硬盘并选择“重新登录”。');
          await loadTreeChildren(userId, token, folderId);
        }
        renderSidebarTree();
      } catch (err) {
        state.expandedFolders.delete(key);
        showError(err.message);
      }
    }
  }

  function dedupeBreadcrumbs(crumbs) {
    return crumbs.filter((crumb, i) => i === 0 || crumb.name !== crumbs[i - 1].name);
  }

  async function buildBreadcrumbs(token, folderId, user) {
    const isLocal = LocalDisk.isLocalId(user.id);
    const isGithub = GithubDisk.isGithubId(user.id);
    const driveLabel = isLocal || isGithub ? user.name : userLabel(user);
    const driveCrumbId = isLocal || isGithub ? user.id : `user:${user.id}`;
    const rootId = isLocal ? LocalDisk.ROOT_ID : isGithub ? GithubDisk.ROOT_ID : Drive.ROOT_ID;

    if (state.section !== 'my-drive') {
      return dedupeBreadcrumbs([
        { id: ROOT_ID, name: ROOT_NAME },
        { id: driveCrumbId, name: driveLabel },
        { id: state.section, name: SECTION_LABELS[state.section] || state.section },
      ]);
    }

    const drivePath = isLocal
      ? await LocalDisk.getFolderPath(user.id, folderId)
      : isGithub
        ? await GithubDisk.getFolderPath(user.id, folderId)
        : await Drive.getFolderPath(token, folderId);
    const foldersAfterUser = folderId === rootId ? [] : drivePath.slice(1);

    return dedupeBreadcrumbs([
      { id: ROOT_ID, name: ROOT_NAME },
      { id: driveCrumbId, name: driveLabel },
      ...foldersAfterUser,
    ]);
  }

  function isMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function closeSidebar() {
    $('.sidebar')?.classList.remove('open');
    $('#sidebar-overlay')?.classList.add('hidden');
    document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
  }

  function openSidebar() {
    $('.sidebar')?.classList.add('open');
    $('#sidebar-overlay')?.classList.remove('hidden');
    document.body.classList.add('sidebar-open');
  }

  function toggleSidebar() {
    if (isMobileLayout()) {
      if ($('.sidebar')?.classList.contains('open')) closeSidebar();
      else openSidebar();
      return;
    }
    document.body.classList.toggle('sidebar-collapsed');
  }

  async function refreshGithubFolderView({ reloadTree = true, silent = false } = {}) {
    if (!GithubDisk.isGithubId(state.currentUserId)) return;
    const diskId = state.currentUserId;
    const disk = GithubDisk.getDisk(diskId);
    if (!disk) return;

    try {
      if (!silent) showError(null);
      if (reloadTree) GithubDisk.invalidateRepoTree(diskId);
      state.files = await GithubDisk.listFiles(diskId, state.currentFolderId);
      state.breadcrumbs = await buildBreadcrumbs(null, state.currentFolderId, disk);
      renderBreadcrumbs();
      renderCurrentView();
      if (reloadTree) {
        clearTreeCache(diskId);
        await syncTreeWithCurrentPath(diskId, null);
        renderSidebarTree();
      } else {
        setSidebarActive(getActiveNavId());
      }
    } catch (err) {
      if (!silent) showError(err.message);
    }
  }

  async function refreshCurrentDrive(options = {}) {
    if (GithubDisk.isGithubId(state.currentUserId)) {
      await refreshGithubFolderView(options);
      return;
    }
    await loadCurrentLocation();
  }

  async function loadCurrentLocation() {
    if (isMobileLayout()) closeSidebar();
    setLoading(true);
    showError(null);
    state.selectedId = null;
    state.selectedIds.clear();
    state.searchQuery = '';
    const searchInput = $('#file-search');
    if (searchInput) searchInput.value = '';
    updateSelectionBar();
    $('#status-selected').textContent = '';

    try {
      if (state.level === 'home') {
        renderSidebarTree();
        state.files = homeDriveItems();
        state.breadcrumbs = [{ id: ROOT_ID, name: ROOT_NAME }];
        setSidebarActive(getActiveNavId());
        refreshUserQuotas();
      } else {
        const userId = state.currentUserId || Auth.getActiveUser()?.id;
        if (!userId) throw new Error('未选择存储空间');

        if (LocalDisk.isLocalId(userId)) {
          const disk = LocalDisk.getDisk(userId);
          if (!disk) throw new Error('找不到本地存储');
          state.currentUserId = userId;

          let files;
          if (state.section === 'trash') {
            files = await LocalDisk.listTrash(userId);
          } else {
            files = await LocalDisk.listFiles(userId, state.currentFolderId);
          }

          state.files = files;
          state.breadcrumbs = await buildBreadcrumbs(null, state.currentFolderId, disk);
          await syncTreeWithCurrentPath(userId, null);
          renderSidebarTree();
          refreshUserQuotas();
        } else if (GithubDisk.isGithubId(userId)) {
          const disk = GithubDisk.getDisk(userId);
          if (!disk) throw new Error('找不到 GitHub 存储');
          state.currentUserId = userId;
          state.files = await GithubDisk.listFiles(userId, state.currentFolderId);
          state.breadcrumbs = await buildBreadcrumbs(null, state.currentFolderId, disk);
          await syncTreeWithCurrentPath(userId, null);
          renderSidebarTree();
          refreshUserQuotas();
        } else {
          const token = await Auth.tryGetValidToken(userId);
          if (!token) {
            throw new Error('需要登录 Google：请右键点击侧栏中的 Google 云端硬盘并选择“重新登录”。');
          }
          const user = Auth.getUsers().find((u) => u.id === userId);
          Auth.setActiveUser(userId);
          state.currentUserId = userId;

          let files;
          switch (state.section) {
            case 'shared':
              files = await Drive.listShared(token);
              break;
            case 'starred':
              files = await Drive.listStarred(token);
              break;
            case 'recent':
              files = await Drive.listRecent(token);
              break;
            case 'trash':
              files = await Drive.listTrash(token);
              break;
            default:
              files = await Drive.listFiles(token, state.currentFolderId);
          }

          state.files = files;
          state.breadcrumbs = await buildBreadcrumbs(token, state.currentFolderId, user);
          await syncTreeWithCurrentPath(userId, token);
          renderSidebarTree();
          refreshUserQuotas({ [userId]: token });
        }
      }

      renderBreadcrumbs();
      renderCurrentView();
    } catch (err) {
      if (!isScopeError(err.message)) {
        showError(err.message);
      }
    } finally {
      setLoading(false);
      Router.syncUrl(getUrlSegments(), urlPushPending);
      urlPushPending = false;
    }
  }

  function navigateToHome(mode = 'all') {
    state.level = 'home';
    state.overviewMode = mode;
    state.currentUserId = null;
    state.currentFolderId = DRIVE_ROOT_ID;
    state.section = 'my-drive';
    state.expandedUsers.clear();
    pushHistory();
    loadCurrentLocation();
  }

  function navigateToUser(userId, folderId = DRIVE_ROOT_ID) {
    if (!LocalDisk.isLocalId(userId) && !GithubDisk.isGithubId(userId)) {
      navigateToHome();
      return;
    }
    if (LocalDisk.isLocalId(userId)) return navigateToLocalDisk(userId, folderId);
    return navigateToGithubDisk(userId, folderId);
  }

  function navigateToLocalDisk(diskId, folderId = LocalDisk.ROOT_ID) {
    state.level = 'drive';
    state.currentUserId = diskId;
    state.currentFolderId = folderId;
    state.section = 'my-drive';
    state.expandedUsers.clear();
    state.expandedUsers.add(diskId);
    pushHistory();
    loadCurrentLocation();
  }

  function navigateToGithubDisk(diskId, folderId = GithubDisk.ROOT_ID) {
    state.level = 'drive';
    state.currentUserId = diskId;
    state.repositoryView = 'files';
    $('#repository-history-list')?.removeAttribute('data-loaded');
    renderGithubSessionState();
    state.currentFolderId = folderId;
    state.section = 'my-drive';
    state.expandedUsers.clear();
    state.expandedUsers.add(diskId);
    pushHistory();
    loadCurrentLocation();
  }

  function navigateToFolder(folderId) {
    if (state.level !== 'drive') return;
    state.currentFolderId = folderId;
    state.section = 'my-drive';
    pushHistory();
    loadCurrentLocation();
  }

  function switchUserSection(userId, section) {
    state.level = 'drive';
    state.currentUserId = userId;
    state.section = section;
    state.currentFolderId = LocalDisk.isLocalId(userId) ? LocalDisk.ROOT_ID : GithubDisk.isGithubId(userId) ? GithubDisk.ROOT_ID : Drive.ROOT_ID;
    state.expandedUsers.clear();
    state.expandedUsers.add(userId);
    if (!isLocalOrGithubDrive(userId)) {
      Auth.setActiveUser(userId);
    }
    pushHistory();
    loadCurrentLocation();
  }

  function handleTreeNav(nav) {
    ContextMenu.hide();
    if (nav === 'home') {
      navigateToHome();
      return;
    }

    const diskSectionMatch = nav.match(/^disk:([^:]+):(my-drive|trash)$/);
    if (diskSectionMatch) {
      switchUserSection(fromDiskNavId(diskSectionMatch[1]), diskSectionMatch[2]);
      return;
    }

    const diskMatch = nav.match(/^disk:([^:]+)$/);
    if (diskMatch) {
      navigateToLocalDisk(fromDiskNavId(diskMatch[1]), LocalDisk.ROOT_ID);
      return;
    }

    const githubMatch = nav.match(/^github:([^:]+)$/);
    if (githubMatch) {
      navigateToGithubDisk(fromGithubNavId(githubMatch[1]), GithubDisk.ROOT_ID);
      return;
    }

    const folderMatch = parseFolderNav(nav);
    if (folderMatch) {
      if (LocalDisk.isLocalId(folderMatch.userId)) {
        navigateToLocalDisk(folderMatch.userId, folderMatch.folderId);
      } else if (GithubDisk.isGithubId(folderMatch.userId)) {
        navigateToGithubDisk(folderMatch.userId, folderMatch.folderId);
      } else {
        navigateToUser(folderMatch.userId, folderMatch.folderId);
      }
      return;
    }

    const fileMatch = nav.match(/^file\|([^|]+)\|(.+)$/);
    if (fileMatch) {
      const [, userId, fileId] = fileMatch;
      const file = findTreeFile(userId, fileId);
      if (file) {
        if (file.isFolder) {
          if (LocalDisk.isLocalId(userId)) navigateToLocalDisk(userId, file.id);
          else if (GithubDisk.isGithubId(userId)) navigateToGithubDisk(userId, file.id);
          else navigateToUser(userId, file.id);
        } else {
          openFile(file, userId, { fromTree: true });
        }
      }
      return;
    }

    const sectionMatch = nav.match(/^user:([^:]+):(my-drive|shared|starred|recent|trash)$/);
    if (sectionMatch) {
      switchUserSection(sectionMatch[1], sectionMatch[2]);
      return;
    }

    if (nav.startsWith('user:')) {
      navigateToUser(nav.slice(5), Drive.ROOT_ID);
    }
  }

  async function showExplorer() {
    if (state.githubSession !== 'connected') {
      showLogin();
      return false;
    }
    hide($('#app-boot'));
    hide($('#login-screen'));
    show($('#explorer'));

    if (!initialRouteApplied && Router.hasInitialRoute()) {
      initialRouteApplied = true;
      const segments = Router.migrateHashToPath() || Router.getInitialSegments();
      await applySegments(segments, false);
      return;
    }

    loadCurrentLocation();
    return true;
  }

  function hasMountedDrives() {
    return LocalDisk.getDisks().length > 0 || GithubDisk.getDisks().length > 0;
  }

  function showLogin() {
    hide($('#app-boot'));
    show($('#login-screen'));
    hide($('#explorer'));
  }

  function showLoginError(msg) {
    const el = $('#login-error');
    if (msg) {
      el.textContent = msg;
      show(el);
    } else {
      el.textContent = '';
      hide(el);
    }
  }

  async function signInWithGithub() {
    const btn = $('#btn-sign-in-github');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const label = btn.querySelector('.btn-label');
    const originalLabel = label?.textContent || '使用 GitHub 登录';
    if (label) label.textContent = '正在连接 GitHub…';
    showStatus('正在验证 GitHub 会话…');
    btn.setAttribute('aria-busy', 'true');
    showLoginError('');
    try {
      // OAuth popup 优先；代理不可达时 acquireAccessToken 内部降级为 PAT 对话框。
      // 登录只负责认证（Authentication）：不创建仓库、不挂载存储（Mutation）。
      // 无挂载存储时由 explorer 的欢迎空态引导用户添加 Repository。
      await GithubDisk.acquireAccessToken();
      state.githubSession = 'connected';
      renderGithubSessionState();
      await showExplorer();
      renderSidebarTree();
    } catch (err) {
      const message = err?.message || String(err);
      state.githubSession = 'expired';
      renderGithubSessionState();
      if (!/sign-in cancelled|popup closed/i.test(message)) {
        showLoginError(`GitHub 登录失败：${message}`);
      }
    } finally {
      if (label) label.textContent = originalLabel;
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  // 欢迎空态的添加仓库入口：点击后才发起 Mount（连接已有 ∥ 创建新仓库）
  async function addRepositoryFromWelcome() {
    if (state.githubSession !== 'connected') {
      await signInWithGithub();
      if (state.githubSession !== 'connected') {
        showError('请先完成 GitHub 登录，再添加仓库。');
        return;
      }
    }
    const btn = $('#btn-add-repository');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      await GithubDisk.ensureGithubStorage();
      await showExplorer();
      renderSidebarTree();
    } catch (err) {
      const message = err?.message || String(err);
      if (!/sign-in cancelled|popup closed/i.test(message)) {
        showError(`添加仓库失败：${message}`);
      }
    } finally {
      btn.disabled = false;
    }
  }

  function getFileParentId(file, userId) {
    return file.parentId || file.parents?.[0] || (LocalDisk.isLocalId(userId) ? LocalDisk.ROOT_ID : GithubDisk.isGithubId(userId) ? GithubDisk.ROOT_ID : Drive.ROOT_ID);
  }

  const DRAG_MIME = 'application/x-storage-hub-item';

  function getDescendantFolderIds(userId, folderId) {
    const ids = new Set([folderId]);
    const walk = (parentId) => {
      const key = folderKey(userId, parentId);
      (state.treeChildren[key] || []).forEach((child) => {
        if (child.isFolder) {
          ids.add(child.id);
          walk(child.id);
        }
      });
    };
    walk(folderId);
    return ids;
  }

  function canDropItem(payload, target) {
    const { userId: sourceUserId, parentId: sourceParentId, item } = payload;
    const { destUserId, destParentId } = target;
    if (!item || !destUserId || destParentId == null) return false;
    if (item.id === destParentId) return false;
    if (sourceUserId === destUserId && sourceParentId === destParentId && !item.isFolder) return false;
    if (item.isFolder && sourceUserId === destUserId) {
      const descendants = getDescendantFolderIds(sourceUserId, item.id);
      if (descendants.has(destParentId)) return false;
    }
    return true;
  }

  function attachDragSource(el, file, userId, parentId) {
    if (file.pending || file.isUserDrive || file.isLocalDisk || file.isGithubDisk) return;
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      const payload = {
        userId,
        parentId,
        item: {
          id: file.id,
          name: file.name,
          isFolder: !!file.isFolder,
          mimeType: file.mimeType,
          parents: file.parents,
          parentId: file.parentId,
        },
      };
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('drag-source');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('drag-source');
      document.querySelectorAll('.drop-target-active').forEach((node) => {
        node.classList.remove('drop-target-active');
      });
    });
  }

  function attachDropTarget(el, getTarget) {
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target-active');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target-active');
    });
    el.addEventListener('drop', async (e) => {
      el.classList.remove('drop-target-active');
      if (![...e.dataTransfer.types].includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      const target = getTarget();
      if (!target || !canDropItem(payload, target)) return;
      await handleItemDrop(payload, target);
    });
  }

  async function handleItemDrop(payload, target) {
    if (state.level !== 'home' && state.section !== 'my-drive') {
      showError('拖放仅适用于文件区域。');
      return;
    }
    const { userId: sourceUserId, parentId: sourceParentId, item } = payload;
    try {
      setLoading(true);
      await ContextMenu.transferItems(
        [item],
        sourceUserId,
        sourceParentId,
        target.destUserId,
        target.destParentId,
        'cut'
      );
      showStatus(`已移动“${item.name}”`);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function bindDragDropForWorkspaceItem(el, file) {
    if (file.isUserDrive) {
      attachDropTarget(el, () => ({
        destUserId: file.userId,
        destParentId: Drive.ROOT_ID,
      }));
      return;
    }
    if (file.isLocalDisk) {
      attachDropTarget(el, () => ({
        destUserId: file.userId,
        destParentId: LocalDisk.ROOT_ID,
      }));
      return;
    }
    if (file.isGithubDisk) {
      attachDropTarget(el, () => ({
        destUserId: file.userId,
        destParentId: GithubDisk.ROOT_ID,
      }));
      return;
    }
    if (state.section !== 'my-drive' || !state.currentUserId) return;
    const userId = state.currentUserId;
    const parentId = getFileParentId(file, userId);
    attachDragSource(el, file, userId, parentId);
    if (file.isFolder) {
      attachDropTarget(el, () => ({
        destUserId: userId,
        destParentId: file.id,
      }));
    }
  }

  function bindDragDropForTreeItem(el, file, userId) {
    const parentId = getFileParentId(file, userId);
    attachDragSource(el, file, userId, parentId);
    if (file.isFolder) {
      attachDropTarget(el, () => ({
        destUserId: userId,
        destParentId: file.id,
      }));
    }
  }

  function updateInstallUi() {
    deferredInstallPrompt = deferredInstallPrompt || window.gitFilesInstallPrompt || null;
    const button = $('#btn-install-pwa');
    const hint = $('#pwa-install-hint');
    if (!button) return;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) {
      button.classList.add('hidden');
      if (hint) hint.textContent = 'GitFiles 已安装为独立应用。';
      return;
    }
    button.classList.remove('hidden');
    if (hint) hint.textContent = deferredInstallPrompt
      ? '点击安装 GitFiles，或从 Edge 菜单“应用”中安装。'
      : 'Edge 未提供快捷提示时，请从菜单 → 应用 → 将此站点安装为应用。';
  }

  async function promptInstallPwa() {
    if (!deferredInstallPrompt) {
      showStatus('请使用 Edge 菜单 → 应用 → 将此站点安装为应用');
      return;
    }
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    window.gitFilesInstallPrompt = null;
    updateInstallUi();
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') showStatus('GitFiles 正在安装…');
      else showStatus('已取消安装，可稍后再次点击。');
    } catch (error) {
      showStatus(`安装未完成：${error?.message || '请使用 Edge 菜单安装'}`);
    } finally {
      updateInstallUi();
    }
  }

  function bindEvents() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      window.gitFilesInstallPrompt = event;
      updateInstallUi();
    });
    window.addEventListener('gitfiles:install-ready', updateInstallUi);
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      window.gitFilesInstallPrompt = null;
      updateInstallUi();
      showStatus('GitFiles 已安装');
    });
    $('#btn-install-pwa')?.addEventListener('click', promptInstallPwa);
    updateInstallUi();
    $('#btn-sidebar-toggle')?.addEventListener('click', toggleSidebar);
    $('#sidebar-overlay')?.addEventListener('click', closeSidebar);

    $('#btn-sign-in-github')?.addEventListener('click', () => signInWithGithub());
    $('#app-brand')?.addEventListener('click', navigateToHome);
    const openAddStorageMenu = (event) => {
      event?.preventDefault();
      event?.stopPropagation();
      const rect = event?.currentTarget?.getBoundingClientRect();
      ContextMenu.showAddDiskMenu(rect?.left ?? 8, rect?.bottom ?? 8);
    };
    $('#btn-header-add')?.addEventListener('click', openAddStorageMenu);
    window.addEventListener('online', () => showStatus('网络已恢复'));
    window.addEventListener('offline', () => showStatus('当前离线：本地存储仍可用，GitHub 操作需要联网'));
    $('#btn-add-repository')?.addEventListener('click', () => addRepositoryFromWelcome());
    document.querySelectorAll('.sidebar-nav [data-nav]').forEach((el) => {
      el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav === 'home') {
          navigateToHome('all');
          return;
        }
        if (nav === 'repositories') {
          navigateToHome('repositories');
        }
      });
    });
    document.querySelectorAll('[data-repository-view]').forEach((button) => {
      button.addEventListener('click', () => setRepositoryView(button.dataset.repositoryView));
    });

    $('#btn-sign-out').addEventListener('click', async () => {
      try {
        await GithubApi.request('/api/logout', { method: 'POST', body: {} });
      } catch {
        // Local drive sign-out still proceeds if the Worker session is unavailable.
      }
      state.githubSession = 'expired';
      renderGithubSessionState();
      ejectAllDrives();
    });
    $('#btn-conflict-center')?.addEventListener('click', () => openConflictCenter());

    $('#btn-refresh').addEventListener('click', () => {
      if (state.repositoryView === 'history' && GithubDisk.isGithubId(state.currentUserId)) {
        loadRepositoryHistory(true);
        return;
      }
      if (state.currentUserId) clearTreeCache(state.currentUserId);
      if (GithubDisk.isGithubId(state.currentUserId)) {
        GithubDisk.invalidateRepoTree(state.currentUserId);
        refreshGithubFolderView({ reloadTree: true });
        return;
      }
      loadCurrentLocation();
    });

    $('#btn-view-grid').addEventListener('click', () => setView('grid'));
    $('#btn-view-list').addEventListener('click', () => setView('list'));
    $('#file-search')?.addEventListener('input', (event) => {
      state.searchQuery = event.target.value;
      renderCurrentView();
    });
    $('#file-sort')?.addEventListener('change', (event) => {
      state.sortBy = event.target.value;
      renderCurrentView();
    });
    $('#btn-sort-direction')?.addEventListener('click', (event) => {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      event.currentTarget.textContent = state.sortDirection === 'asc' ? '↑' : '↓';
      renderCurrentView();
    });
    $('#selection-bar')?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-selection-action]')?.dataset.selectionAction;
      if (!action) return;
      if (action === 'clear') {
        state.selectedIds.clear();
        state.selectedId = null;
        updateSelectionBar();
        renderCurrentView();
      } else {
        const files = [...state.selectedIds].map((id) => state.files.find((item) => item.id === id)).filter(Boolean);
        const file = files[0];
        if (!file) return;
        if (isCurrentGithubDrive() && files.length > 1 && action === 'delete') {
          GithubDisk.deleteBatch(state.currentUserId, files, `Delete ${files.length} items`).catch(showError);
          return;
        }
        if (files.length > 1) {
          showStatus('多选复制和移动请使用右键菜单中的批量操作');
          return;
        }
        ContextMenu.runAction(action, buildFileContext(file));
      }
    });
    $('.content').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.file-item, .list-row, .item-more-btn')) return;
      if (state.level === 'home') {
        ContextMenu.show(e, { type: 'root' });
        return;
      }
      if (state.level !== 'drive' || !state.currentUserId) return;
      ContextMenu.show(e, {
        type: 'empty',
        userId: state.currentUserId,
        folderId: state.currentFolderId,
        section: state.section,
      });
    });

    $('.sidebar-tree-section').addEventListener('mousedown', (e) => {
      if (e.target.closest('.sidebar-add-btn')) return;
      ContextMenu.hide();
    });
    $('.sidebar-tree-section').addEventListener('focusin', () => ContextMenu.hide());

    $('.sidebar-tree-section').addEventListener('contextmenu', (e) => {
      const rootBtn = e.target.closest('.tree-root-item');
      if (rootBtn) {
        e.preventDefault();
        ContextMenu.show(e, { type: 'root' });
        return;
      }

      const localBtn = e.target.closest('.local-drive-item');
      if (localBtn) {
        e.preventDefault();
        const diskMatch = localBtn.dataset.nav?.match(/^disk:([^:]+)$/);
        if (diskMatch) {
          const disk = LocalDisk.getDisk(fromDiskNavId(diskMatch[1]));
          if (disk) {
            ContextMenu.show(e, { type: 'local-disk', diskId: disk.id, disk });
          }
        }
        return;
      }

      const githubBtn = e.target.closest('.tree-user-btn[data-nav^="github:"]');
      if (githubBtn) {
        e.preventDefault();
        const diskMatch = githubBtn.dataset.nav?.match(/^github:([^:]+)$/);
        if (diskMatch) {
          const disk = GithubDisk.getDisk(fromGithubNavId(diskMatch[1]));
          if (disk) {
            ContextMenu.show(e, { type: 'github-disk', diskId: disk.id, disk });
          }
        }
        return;
      }

      const userBtn = e.target.closest('.tree-user-btn');
      if (userBtn) {
        e.preventDefault();
        const userId = userBtn.dataset.nav?.slice(5);
        const user = Auth.getUsers().find((u) => u.id === userId);
        if (user) {
          ContextMenu.show(e, { type: 'user', userId: user.id, user });
        }
        return;
      }

      const folderBtn = e.target.closest('.tree-folder-item');
      const fileBtn = e.target.closest('.tree-file-item');
      if (!folderBtn && !fileBtn) return;
      e.preventDefault();

      const nav = (folderBtn || fileBtn).dataset.nav;
      const folderMatch = parseFolderNav(nav);
      const fileMatch = nav?.match(/^file\|([^|]+)\|(.+)$/);

      if (folderMatch) {
        const { userId, folderId } = folderMatch;
        const item = findTreeItem(userId, folderId);
        if (item) {
          ContextMenu.show(e, {
            type: 'folder',
            file: { ...item, isFolder: true },
            userId,
            folderId,
            section: 'my-drive',
          });
        }
        return;
      }

      if (fileMatch) {
        const [, userId, fileId] = fileMatch;
        const file = findTreeItem(userId, fileId);
        if (file) {
          ContextMenu.show(e, {
            type: 'file',
            file,
            userId,
            folderId: file.parentId || file.parents?.[0] || (LocalDisk.isLocalId(userId) ? LocalDisk.ROOT_ID : GithubDisk.isGithubId(userId) ? GithubDisk.ROOT_ID : Drive.ROOT_ID),
            section: 'my-drive',
          });
        }
      }
    });

    $('.sidebar-tree-section').addEventListener('click', async (e) => {
      const reauthEl = e.target.closest('.tree-user-quota-reauth');
      if (reauthEl?.dataset.reauthUser) {
        e.preventDefault();
        const userId = reauthEl.dataset.reauthUser;
        Auth.setActiveUser(userId);
        renderSidebarTree();
        Auth.refreshTokenInteractive(userId)
          .then(() => {
            refreshUserQuotas();
            const user = Auth.getUsers().find((u) => u.id === userId);
            showStatus(`已登录：${userLabel(user)}`);
          })
          .catch((err) => showError(err.message));
        return;
      }

      const moreBtn = e.target.closest('[data-tree-more]');
      if (moreBtn) {
        e.preventDefault();
        showMoreTreeItems(moreBtn.dataset.treeMore);
        return;
      }

      const toggle = e.target.closest('[data-tree-toggle]');
      if (toggle) {
        e.preventDefault();
        e.stopPropagation();
        handleTreeToggle(toggle);
        return;
      }

      const navBtn = e.target.closest('[data-nav]');
      if (navBtn?.dataset.nav) {
        handleTreeNav(navBtn.dataset.nav);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!$('#explorer') || $('#explorer').classList.contains('hidden')) return;
      const file = getSelectedFile();
      const ctx = file && !file.isUserDrive && !file.isLocalDisk && !file.isGithubDisk ? buildFileContext(file) : null;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'c' && ctx) {
          e.preventDefault();
          ContextMenu.runAction('copy', ctx);
        }
        if (e.key === 'x' && ctx && state.section === 'my-drive') {
          e.preventDefault();
          ContextMenu.runAction('cut', ctx);
        }
        if (e.key === 'v' && state.level === 'drive' && state.section === 'my-drive') {
          e.preventDefault();
          ContextMenu.runAction('paste', {
            type: 'empty',
            userId: state.currentUserId,
            folderId: state.currentFolderId,
            section: state.section,
          });
        }
      }

      if (!ctx) return;

      if (e.key === 'F2' && state.section === 'my-drive') {
        e.preventDefault();
        ContextMenu.runAction('rename', ctx);
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        const action = state.section === 'trash' ? 'delete-forever' : 'delete';
        if (state.section === 'my-drive' || state.section === 'trash') {
          ContextMenu.runAction(action, ctx);
        }
      }
    });
  }

  function getSelectedFile() {
    return state.files.find((f) => f.id === state.selectedId);
  }

  async function init() {
    if (typeof BasePath !== 'undefined') {
      BasePath.redirectBareRootIfNeeded();
    }
    Dialog.init();
    LocalUser.init();
    try {
      await LocalDisk.init();
    } catch (err) {
      showError(err.message);
    }
    GithubDisk.init();
    GithubDisk.setListChangeListener((diskId) => {
      if (GithubDisk.isGithubId(state.currentUserId) && state.currentUserId === diskId) {
        refreshGithubFolderView({ reloadTree: true, silent: true });
      }
    });
    GithubDisk.setConflictListener?.((conflict) => addConflictRecord(conflict));
    GithubDisk.setTransferListener?.((transfer) => addConflictRecord(transfer));
    const authenticated = await refreshGithubSessionState();

    ContextMenu.init({
      openFile,
      navigateToUser,
      navigateToLocalDisk,
      navigateToGithubDisk,
      navigateToHome: () => navigateToHome(),
      refresh: () => refreshCurrentDrive({ reloadTree: true }),
      refreshGithubFolder: () => refreshGithubFolderView({ reloadTree: true }),
      refreshUserQuotas,
      markItemsProcessing,
      unmarkItemsProcessing,
      clearTreeCache,
      showError,
      showStatus,
      signOutUser,
      ejectLocalDisk,
      ejectGithubDisk,
      ejectAllDrives,
      signOutAll: () => {
        ejectAllDrives();
      },
      getUserQuota: (userId) => state.userQuotas[userId] || null,
      setUserQuota: (userId, quota) => {
        state.userQuotas[userId] = quota;
      },
    });

    Router.init(async (segments) => {
      if (!$('#explorer') || $('#explorer').classList.contains('hidden')) return;
      if (Router.segmentsEqual(segments, getUrlSegments())) return;
      await applySegments(segments, false);
    });

    bindEvents();

    if (isMobileLayout()) state.view = 'list';

    if (authenticated) showExplorer();
    else showLogin();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init().catch((err) => {
    console.error(err);
    const message = err?.message || String(err);
    const errorEl = document.querySelector('#login-error');
    if (errorEl) {
      errorEl.textContent = `应用初始化失败：${message}`;
      errorEl.classList.remove('hidden');
    }
  });
});
