const GithubDisk = (() => {
  const ROOT_ID = 'root';
  const FOLDER_MIME = 'application/x-github-folder';
  const ID_PREFIX = 'github:';
  const STORAGE_KEY = 'storage_hub_github_disks';
  const LEGACY_STORAGE_KEY = 'mikus_drive_github_disks';
  const OAUTH_MESSAGE_SOURCE = 'storage-hub-github-oauth';
  // GitHub docs: repos above ~100 GB may be blocked.
  const MAX_REPO_SIZE_BYTES = 100 * 1024 * 1024 * 1024;

  let disks = [];
  const pendingByFolder = new Map();
  const saveStateByPath = new Map();
  const deleteStateByPath = new Map();
  const moveStateByPath = new Map();
  const pendingConfirmTimers = new Map();
  const saveConfirmTimers = new Map();
  const moveConfirmTimers = new Map();
  const deleteConfirmTimers = new Map();
  let listChangeListener = null;
  let saveStateListener = null;
  let conflictListener = null;
  let transferListener = null;

  function setTransferListener(listener) {
    transferListener = typeof listener === 'function' ? listener : null;
  }

  function setSaveStateListener(listener) {
    saveStateListener = typeof listener === 'function' ? listener : null;
  }

  function setConflictListener(listener) {
    conflictListener = typeof listener === 'function' ? listener : null;
  }

  function getFileSaveState(diskId, filePath) {
    return saveStateByPath.get(saveStateKey(diskId, filePath)) || null;
  }

  function saveStateKey(diskId, filePath) {
    return `${diskId}\0${normalizePath(filePath)}`;
  }

  function getPendingStatusLabel(status, options = {}) {
    if (status === 'syncing' && options.kind === 'delete') return '正在删除…';
    if (status === 'syncing') return '正在上传…';
    if (status === 'saving') return '正在保存…';
    if (status === 'moving') return '正在移动…';
    if (status === 'conflict') return '冲突：远端已更新';
    if (status === 'pending') {
      if (options.kind === 'save') return '等待保存…';
      if (options.kind === 'move') return '等待移动…';
      if (options.kind === 'delete') return '正在完成删除…';
      return '等待 GitHub 完成…';
    }
    if (status === 'error') return options.error || '操作失败';
    return '正在同步…';
  }

  function moveStateKey(diskId, sourcePath) {
    return `${diskId}\0${normalizePath(sourcePath)}`;
  }

  function getActiveMoves(diskId) {
    const prefix = `${diskId}\0`;
    const moves = [];
    for (const [key, state] of moveStateByPath.entries()) {
      if (key.startsWith(prefix)) moves.push(state);
    }
    return moves;
  }

  function findActiveMoveForPath(diskId, filePath) {
    const path = normalizePath(filePath);
    if (!path) return null;
    for (const move of getActiveMoves(diskId)) {
      const source = normalizePath(move.sourcePath);
      if (!source) continue;
      if (path === source || path.startsWith(`${source}/`) || source.startsWith(`${path}/`)) {
        return move;
      }
    }
    return null;
  }

  function notifySaveStateChange(diskId, filePath) {
    const state = getFileSaveState(diskId, filePath);
    saveStateListener?.(diskId, filePath, state);
    notifyListChange(diskId);
  }
  function setListChangeListener(listener) {
    listChangeListener = typeof listener === 'function' ? listener : null;
  }

  function notifyListChange(diskId) {
    listChangeListener?.(diskId);
  }

  async function requireDisk(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    return disk;
  }

  function isConflictError(err) {
    return !!err && (err.name === 'ConflictError' || err.isConflict === true);
  }

  /**
   * A remote CAS failure is never silently overwritten: the user must choose
   * to rebase their operation onto the latest remote state (explicit overwrite)
   * or cancel. PROJECT_SPEC §5.
   */
  async function offerConflictResolution(diskId, err) {
    const disk = getDisk(diskId);
    conflictListener?.({
      id: `${diskId}:${Date.now()}`,
      diskId,
      repository: disk ? `${disk.owner}/${disk.repo}` : diskId,
      expectedHead: err.expectedHead || null,
      remoteHead: err.remoteHead || null,
      message: err.message || '远端分支已发生变化。',
      createdAt: Date.now(),
    });
    if (typeof Dialog === 'undefined') return false;
    const lines = [
      '操作执行期间，分支已被其他设备更新。',
      '',
      `本地基线：${err.expectedHead || '未知'}`,
      `远端 HEAD：${err.remoteHead || '未知'}`,
      '',
      '本次操作未应用。覆盖远端更改必须由你明确确认。',
    ];
    try {
      const choice = await Dialog.choose({
        title: '检测到冲突',
        message: lines.join('\n'),
        buttons: [
          { id: 'overwrite', label: '应用到最新远端状态', primary: true },
          { id: 'cancel', label: '取消' },
        ],
      });
      if (choice === 'overwrite') {
        invalidateRepoTree(diskId);
        return true;
      }
    } catch {
      // Dialog unavailable or dismissed — treat as cancel.
    }
    return false;
  }

  /**
   * Run one logical group of operations as ONE tree + ONE commit
   * (Git Data API, CAS-protected).
   */
  async function executeOperations(diskId, operations, message) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    // Read the current server head immediately before mutation. The Worker
    // repeats this comparison before it writes the ref, providing CAS.
    if (!disk.head) await getRepoTreeState(disk, { force: true });
    try {
      const result = await GithubApi.request(
        `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/operations`,
        {
          method: 'POST',
          body: {
            branch: disk.branch || 'main',
            expectedHead: disk.head,
            message,
            operations,
          },
        }
      );
      disk.head = result.head;
      invalidateRepoTree(diskId);
      return result;
    } catch (err) {
      if (err?.status === 409) {
        const conflict = new Error(err.message);
        conflict.name = 'ConflictError';
        conflict.expectedHead = err.payload?.details?.expectedHead ?? disk.head;
        conflict.remoteHead = err.payload?.details?.remoteHead ?? null;
        throw conflict;
      }
      throw err;
    }
  }

  function invalidateRepoTree(diskId) {
    // Worker reads are authoritative. Keep this hook for UI refresh callers;
    // no browser-side Git tree cache or credential exists to clear.
    const disk = getDisk(diskId);
    if (disk) disk.head = null;
  }

  function pendingFolderKey(diskId, parentId) {
    const parent = !parentId || parentId === ROOT_ID ? ROOT_ID : normalizePath(parentId);
    return `${diskId}\0${parent}`;
  }

  function trackOperationStart(itemId, kind, size = 0) {
    if (typeof OperationProgress === 'undefined' || !itemId) return;
    OperationProgress.start(itemId, OperationProgress.key('github', kind), { size });
  }

  function trackOperationFinish(itemId, success = true) {
    if (typeof OperationProgress === 'undefined' || !itemId) return;
    OperationProgress.finish(itemId, success);
  }

  function trackOperationTransfer(fromId, toId) {
    if (typeof OperationProgress === 'undefined' || !fromId || !toId || fromId === toId) return;
    OperationProgress.transfer(fromId, toId);
  }

  function pendingOperationKey(entry) {
    if (typeof OperationProgress === 'undefined') return null;
    return OperationProgress.key('github', entry?.kind || 'create');
  }

  function applyPendingEntryToFile(file, entry) {
    return {
      ...file,
      pending: true,
      pendingStatus: entry.status,
      pendingKind: entry.kind || 'create',
      pendingError: entry.error,
      pendingStartedAt: entry.progressStartedAt || Date.now(),
      pendingOperationKey: pendingOperationKey(entry),
      pendingSize: entry.size || 0,
      dateFormatted: getPendingStatusLabel(entry.status, {
        kind: entry.kind || 'create',
        error: entry.error,
      }),
    };
  }

  function applyPendingStateFromEntries(diskId, parentId, files) {
    const entries = getPendingEntries(diskId, parentId);
    if (!entries.length) return files;

    const pendingByName = new Map();
    entries.forEach((entry) => {
      if (entry.status === 'error') return;
      pendingByName.set(entry.name.toLowerCase(), entry);
    });
    if (!pendingByName.size) return files;

    return files.map((file) => {
      if (file.pending || file.isFolder) return file;
      const entry = pendingByName.get(file.name.toLowerCase());
      if (!entry) return file;
      trackOperationTransfer(entry.tempId, file.id);
      return applyPendingEntryToFile(file, entry);
    });
  }

  function addPending(diskId, parentId, meta) {
    const tempId = `pending:${crypto.randomUUID()}`;
    const key = pendingFolderKey(diskId, parentId);
    const list = pendingByFolder.get(key) || [];
    list.push({
      tempId,
      name: meta.name,
      isFolder: !!meta.isFolder,
      mimeType: meta.mimeType || (meta.isFolder ? FOLDER_MIME : inferMimeType(meta.name)),
      size: meta.size || 0,
      status: meta.status || 'syncing',
      kind: meta.kind || 'create',
      error: null,
      expectedPath: meta.expectedPath || null,
      sourcePath: meta.sourcePath || null,
      progressStartedAt: performance.now(),
    });
    pendingByFolder.set(key, list);
    trackOperationStart(tempId, meta.kind || 'create', meta.size || 0);
    notifyListChange(diskId);
    return tempId;
  }

  function findPendingEntry(tempId) {
    for (const [key, list] of pendingByFolder.entries()) {
      const entry = list.find((item) => item.tempId === tempId);
      if (!entry) continue;
      const [diskId, parentId] = key.split('\0');
      return { key, entry, diskId, parentId };
    }
    return null;
  }

  function resolvePending(tempId) {
    for (const [key, list] of pendingByFolder.entries()) {
      const idx = list.findIndex((entry) => entry.tempId === tempId);
      if (idx === -1) continue;
      const entry = list[idx];
      list.splice(idx, 1);
      if (!list.length) pendingByFolder.delete(key);
      else pendingByFolder.set(key, list);
      trackOperationFinish(tempId, true);
      if (entry?.expectedPath) {
        trackOperationFinish(normalizePath(entry.expectedPath), true);
      }
      notifyListChange(key.split('\0')[0]);
      return;
    }
  }

  function failPending(tempId, message, options = {}) {
    for (const [key, list] of pendingByFolder.entries()) {
      const entry = list.find((item) => item.tempId === tempId);
      if (!entry) continue;
      entry.status = options.conflict ? 'conflict' : 'error';
      entry.error = message || 'Upload failed';
      trackOperationFinish(tempId, false);
      notifyListChange(key.split('\0')[0]);
      return;
    }
  }

  function getPendingEntries(diskId, parentId) {
    return (pendingByFolder.get(pendingFolderKey(diskId, parentId)) || []).slice();
  }

  function mapPendingFile(diskId, parentId, entry) {
    const parent = !parentId || parentId === ROOT_ID ? ROOT_ID : normalizePath(parentId);
    const mimeType = entry.mimeType || (entry.isFolder ? FOLDER_MIME : inferMimeType(entry.name));
    const isError = entry.status === 'error';
    const statusLabel = getPendingStatusLabel(entry.status, { kind: entry.kind || 'create', error: entry.error });
    return {
      id: entry.tempId,
      name: entry.name,
      isFolder: !!entry.isFolder,
      mimeType,
      icon: entry.isFolder ? '📁' : mimeType === 'application/json' ? '📋' : mimeType.startsWith('text/') ? '📝' : '📄',
      parents: [parent],
      parentId: parent,
      size: entry.size || 0,
      sizeFormatted: entry.size ? formatSize(entry.size) : '—',
      dateFormatted: statusLabel,
      typeName: entry.isFolder ? 'Folder' : 'File',
      pending: true,
      pendingStatus: entry.status,
      pendingKind: entry.kind || 'create',
      pendingError: entry.error,
      pendingStartedAt: entry.progressStartedAt || performance.now(),
      pendingOperationKey: pendingOperationKey(entry),
      pendingSize: entry.size || 0,
    };
  }

  function applyMoveStateToFiles(diskId, files) {
    return files.map((file) => {
      if (file.pending) return file;
      const moveState = findActiveMoveForPath(diskId, file.id);
      if (!moveState) return file;
      return {
        ...file,
        pending: true,
        pendingStatus: moveState.status,
        pendingKind: 'move',
        pendingError: moveState.error,
        pendingStartedAt: moveState.progressStartedAt || performance.now(),
        pendingOperationKey: typeof OperationProgress !== 'undefined'
          ? OperationProgress.key('github', 'move')
          : null,
        pendingSize: moveState.size || file.size || 0,
        dateFormatted: getPendingStatusLabel(moveState.status, {
          kind: 'move',
          error: moveState.error,
        }),
      };
    });
  }

  function resolveMove(diskId, sourcePath) {
    const key = moveStateKey(diskId, sourcePath);
    const moveState = moveStateByPath.get(key);
    if (!moveState) return;
    if (moveState.destPendingId) resolvePending(moveState.destPendingId);
    trackOperationFinish(normalizePath(sourcePath), true);
    moveStateByPath.delete(key);
    moveConfirmTimers.delete(key);
    notifyListChange(diskId);
  }

  function isSourcePathGoneFromTree(tree, sourcePath, isFolder) {
    const path = normalizePath(sourcePath);
    if (!path) return true;
    if (isFolder) {
      return !tree.some((entry) => {
        const entryPath = entry.path || '';
        return entryPath === path
          || entryPath === `${path}/.keep`
          || entryPath.startsWith(`${path}/`);
      });
    }
    return !tree.some((entry) => entry.type === 'blob' && entry.path === path);
  }

  async function confirmMoveOnServer(diskId, sourcePath) {
    const key = moveStateKey(diskId, sourcePath);
    const moveState = moveStateByPath.get(key);
    if (!moveState || (moveState.status !== 'pending' && moveState.status !== 'moving')) return false;

    const disk = getDisk(diskId);
    if (!disk) {
      resolveMove(diskId, sourcePath);
      return true;
    }

    const destPath = normalizePath(moveState.destPath);
    try {
      const tree = await getRepoTree(disk, { force: true });
      const destVisible = isPathVisibleInTree(tree, destPath, moveState.isFolder);
      const sourceGone = isSourcePathGoneFromTree(tree, moveState.sourcePath, moveState.isFolder);
      if (destVisible && sourceGone) {
        resolveMove(diskId, sourcePath);
        invalidateRepoTree(diskId);
        return true;
      }
    } catch {
      // GitHub may still be updating — keep polling.
    }
    return false;
  }

  function scheduleMoveConfirmation(diskId, sourcePath) {
    const key = moveStateKey(diskId, sourcePath);
    if (moveConfirmTimers.has(key)) return;

    let attempts = 0;
    const maxAttempts = 90;

    const tick = async () => {
      attempts += 1;
      const moveState = moveStateByPath.get(key);
      if (!moveState || (moveState.status !== 'pending' && moveState.status !== 'moving')) {
        moveConfirmTimers.delete(key);
        return;
      }

      const confirmed = await confirmMoveOnServer(diskId, sourcePath);
      if (confirmed) {
        moveConfirmTimers.delete(key);
        return;
      }

      if (attempts >= maxAttempts) {
        moveState.status = 'error';
        moveState.error = 'Timed out waiting for GitHub to confirm the move';
        if (moveState.destPendingId) failPending(moveState.destPendingId, moveState.error);
        trackOperationFinish(normalizePath(sourcePath), false);
        notifyListChange(diskId);
        moveConfirmTimers.delete(key);
        return;
      }

      moveConfirmTimers.set(key, setTimeout(tick, 2000));
    };

    moveConfirmTimers.set(key, setTimeout(tick, 1000));
  }

  async function runPendingMove(diskId, sourcePath, toParentId, meta, action) {
    const key = moveStateKey(diskId, sourcePath);
    const normalizedSource = normalizePath(sourcePath);
    const destPendingId = addPending(diskId, toParentId, {
      name: meta.name,
      isFolder: meta.isFolder,
      mimeType: meta.mimeType,
      size: meta.size || 0,
      status: 'moving',
      kind: 'move',
      sourcePath: normalizedSource,
      expectedPath: normalizePath(meta.destPath),
    });
    trackOperationStart(normalizedSource, 'move', meta.size || 0);

    moveStateByPath.set(key, {
      status: 'moving',
      sourcePath: normalizePath(sourcePath),
      destPath: normalizePath(meta.destPath),
      destParentId: toParentId,
      destPendingId,
      name: meta.name,
      isFolder: !!meta.isFolder,
      mimeType: meta.mimeType,
      size: meta.size || 0,
      progressStartedAt: performance.now(),
      error: null,
    });
    notifyListChange(diskId);

    try {
      await action();
      // The Worker returns only after the Git commit and CAS ref update have
      // succeeded. Do not wait for a second tree listing to finish the UI;
      // GitHub's listing can lag and otherwise leaves items stuck as pending.
      resolveMove(diskId, sourcePath);
      invalidateRepoTree(diskId);
      notifyListChange(diskId);
      return { id: meta.destPath, name: meta.name, isFolder: !!meta.isFolder };
    } catch (err) {
      failPending(destPendingId, err?.message || String(err), { conflict: isConflictError(err) });
      trackOperationFinish(normalizedSource, false);
      moveStateByPath.set(key, {
        ...moveStateByPath.get(key),
        status: isConflictError(err) ? 'conflict' : 'error',
        error: err?.message || String(err),
      });
      notifyListChange(diskId);
      if (isConflictError(err)) {
        const retry = await offerConflictResolution(diskId, err);
        if (retry) return runPendingMove(diskId, sourcePath, toParentId, meta, action);
      }
      throw err;
    }
  }

  function applySaveStateToFiles(diskId, files) {
    return files.map((file) => {
      if (file.isFolder || file.pending) return file;
      const saveState = getFileSaveState(diskId, file.id);
      if (!saveState) return file;
      return {
        ...file,
        pending: true,
        pendingStatus: saveState.status,
        pendingError: saveState.error,
        pendingKind: 'save',
        pendingStartedAt: saveState.progressStartedAt || performance.now(),
        pendingOperationKey: typeof OperationProgress !== 'undefined'
          ? OperationProgress.key('github', 'save')
          : null,
        pendingSize: saveState.size || file.size || 0,
        dateFormatted: getPendingStatusLabel(saveState.status, {
          kind: 'save',
          error: saveState.error,
        }),
      };
    });
  }

  function applyDeleteStateToFiles(diskId, files) {
    return files.map((file) => {
      if (file.pending) return file;
      const state = deleteStateByPath.get(saveStateKey(diskId, file.id));
      if (!state) return file;
      return {
        ...file,
        pending: true,
        pendingStatus: state.status,
        pendingKind: 'delete',
        pendingError: state.error,
        pendingStartedAt: state.progressStartedAt || performance.now(),
        pendingOperationKey: typeof OperationProgress !== 'undefined'
          ? OperationProgress.key('github', 'delete')
          : null,
        pendingSize: state.size || file.size || 0,
        dateFormatted: getPendingStatusLabel(state.status, {
          kind: 'delete',
          error: state.error,
        }),
      };
    });
  }

  function isMissingGitHubPathError(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    return /404|not found/.test(msg);
  }

  async function isDeletedOnServer(disk, filePath, isFolder) {
    const path = normalizePath(filePath);
    if (!path) return true;

    if (!isFolder) {
      try {
        await getFileContentMeta(disk, path);
        return false;
      } catch (err) {
        return isMissingGitHubPathError(err);
      }
    }

    try {
      const tree = await getRepoTree(disk, { force: true });
      return !isPathVisibleInTree(tree, path, true);
    } catch (err) {
      if (isEmptyGitTreeError(err)) return true;
      throw err;
    }
  }

  function resolveDeleteState(diskId, filePath) {
    const path = normalizePath(filePath);
    const key = saveStateKey(diskId, path);
    if (!deleteStateByPath.has(key)) return;
    deleteStateByPath.delete(key);
    deleteConfirmTimers.delete(key);
    trackOperationFinish(path, true);
    invalidateRepoTree(diskId);
    notifyListChange(diskId);
  }

  async function confirmDeleteOnServer(diskId, filePath, isFolder) {
    const path = normalizePath(filePath);
    const key = saveStateKey(diskId, path);
    const state = deleteStateByPath.get(key);
    if (!state || state.status !== 'pending') return false;

    const disk = getDisk(diskId);
    if (!disk) {
      resolveDeleteState(diskId, path);
      return true;
    }

    try {
      if (await isDeletedOnServer(disk, path, isFolder)) {
        resolveDeleteState(diskId, path);
        return true;
      }
    } catch {
      // GitHub may still be updating — keep polling.
    }
    return false;
  }

  function scheduleDeleteConfirmation(diskId, filePath, isFolder) {
    const path = normalizePath(filePath);
    const key = saveStateKey(diskId, path);
    if (deleteConfirmTimers.has(key)) return;

    let attempts = 0;
    const maxAttempts = 90;

    const tick = async () => {
      attempts += 1;
      const state = deleteStateByPath.get(key);
      if (!state || state.status !== 'pending') {
        deleteConfirmTimers.delete(key);
        return;
      }

      const confirmed = await confirmDeleteOnServer(diskId, path, isFolder);
      if (confirmed) {
        deleteConfirmTimers.delete(key);
        return;
      }

      if (attempts >= maxAttempts) {
        deleteStateByPath.set(key, {
          ...state,
          status: 'error',
          error: 'Timed out waiting for GitHub to confirm the delete',
        });
        trackOperationFinish(path, false);
        notifyListChange(diskId);
        deleteConfirmTimers.delete(key);
        return;
      }

      deleteConfirmTimers.set(key, setTimeout(tick, 2000));
    };

    deleteConfirmTimers.set(key, setTimeout(tick, 1000));
  }

  async function runPendingDelete(diskId, filePath, meta, action) {
    const path = normalizePath(filePath);
    const key = saveStateKey(diskId, path);
    const isFolder = !!meta?.isFolder;
    const startedAt = performance.now();
    deleteStateByPath.set(key, {
      status: 'syncing',
      error: null,
      name: meta?.name || path.split('/').pop(),
      isFolder,
      size: meta?.size || 0,
      progressStartedAt: startedAt,
      kind: 'delete',
    });
    trackOperationStart(path, 'delete', meta?.size || 0);
    notifyListChange(diskId);

    try {
      await action();
      const existing = deleteStateByPath.get(key);
      deleteStateByPath.set(key, {
        status: 'pending',
        error: null,
        name: meta?.name || path.split('/').pop(),
        isFolder,
        size: meta?.size || 0,
        progressStartedAt: existing?.progressStartedAt || startedAt,
        kind: 'delete',
      });
      // A successful operations response means the delete commit is complete.
      // Clear the optimistic state immediately instead of waiting for a delayed
      // GitHub tree read that can keep showing “正在完成删除…” indefinitely.
      resolveDeleteState(diskId, path);
      invalidateRepoTree(diskId);
      notifyListChange(diskId);
    } catch (err) {
      deleteStateByPath.set(key, {
        status: isConflictError(err) ? 'conflict' : 'error',
        error: err?.message || String(err),
        name: meta?.name || path.split('/').pop(),
        isFolder,
        size: meta?.size || 0,
        progressStartedAt: startedAt,
        kind: 'delete',
      });
      trackOperationFinish(path, false);
      notifyListChange(diskId);
      if (isConflictError(err)) {
        const retry = await offerConflictResolution(diskId, err);
        if (retry) return runPendingDelete(diskId, filePath, meta, action);
      }
      throw err;
    }
  }

  function resolveFileSave(diskId, filePath) {
    const key = saveStateKey(diskId, filePath);
    if (!saveStateByPath.has(key)) return;
    saveStateByPath.delete(key);
    saveConfirmTimers.delete(key);
    trackOperationFinish(normalizePath(filePath), true);
    notifySaveStateChange(diskId, filePath);
  }

  async function confirmFileSaveOnServer(diskId, filePath) {
    const key = saveStateKey(diskId, filePath);
    const saveState = saveStateByPath.get(key);
    if (!saveState || saveState.status !== 'pending') return false;

    const disk = getDisk(diskId);
    if (!disk) {
      resolveFileSave(diskId, filePath);
      return true;
    }

    const path = normalizePath(filePath);
    try {
      if (saveState.expectedSha) {
        const meta = await getFileContentMeta(disk, path);
        if (meta?.sha === saveState.expectedSha) {
          resolveFileSave(diskId, filePath);
          invalidateRepoTree(diskId);
          return true;
        }
      } else {
        const tree = await getRepoTree(disk, { force: true });
        if (isPathVisibleInTree(tree, path, false)) {
          resolveFileSave(diskId, filePath);
          invalidateRepoTree(diskId);
          return true;
        }
      }
    } catch {
      // GitHub may still be updating — keep polling.
    }
    return false;
  }

  function scheduleFileSaveConfirmation(diskId, filePath) {
    const key = saveStateKey(diskId, filePath);
    if (saveConfirmTimers.has(key)) return;

    let attempts = 0;
    const maxAttempts = 90;

    const tick = async () => {
      attempts += 1;
      const saveState = saveStateByPath.get(key);
      if (!saveState || saveState.status !== 'pending') {
        saveConfirmTimers.delete(key);
        return;
      }

      const confirmed = await confirmFileSaveOnServer(diskId, filePath);
      if (confirmed) {
        saveConfirmTimers.delete(key);
        return;
      }

      if (attempts >= maxAttempts) {
        saveState.status = 'error';
        saveState.error = 'Timed out waiting for GitHub to confirm the save';
        trackOperationFinish(normalizePath(filePath), false);
        notifySaveStateChange(diskId, filePath);
        saveConfirmTimers.delete(key);
        return;
      }

      saveConfirmTimers.set(key, setTimeout(tick, 2000));
    };

    saveConfirmTimers.set(key, setTimeout(tick, 1000));
  }

  function markFileSavePending(diskId, filePath, expectedSha) {
    const key = saveStateKey(diskId, filePath);
    const existing = saveStateByPath.get(key);
    if (!existing) return;
    existing.status = 'pending';
    existing.expectedSha = expectedSha || null;
    saveStateByPath.set(key, existing);
    notifySaveStateChange(diskId, filePath);
    scheduleFileSaveConfirmation(diskId, filePath);
    confirmFileSaveOnServer(diskId, filePath);
  }

  async function runPendingFileSave(diskId, filePath, meta, action) {
    const path = normalizePath(filePath);
    const key = saveStateKey(diskId, path);
    trackOperationStart(path, 'save', meta?.size || 0);
    saveStateByPath.set(key, {
      status: 'saving',
      error: null,
      expectedSha: null,
      kind: 'save',
      name: meta?.name || path.split('/').pop(),
      size: meta?.size || 0,
      progressStartedAt: performance.now(),
    });
    notifySaveStateChange(diskId, path);

    try {
      const result = await action();
      // The mutation request is acknowledged only after the Worker commits and
      // updates the branch ref. Finish the visible save state immediately.
      resolveFileSave(diskId, path);
      invalidateRepoTree(diskId);
      return result;
    } catch (err) {
      saveStateByPath.set(key, {
        status: isConflictError(err) ? 'conflict' : 'error',
        error: err?.message || String(err),
        expectedSha: null,
        kind: 'save',
        name: meta?.name || path.split('/').pop(),
        size: meta?.size || 0,
      });
      trackOperationFinish(path, false);
      notifySaveStateChange(diskId, path);
      if (isConflictError(err)) {
        const retry = await offerConflictResolution(diskId, err);
        if (retry) return runPendingFileSave(diskId, filePath, meta, action);
      }
      throw err;
    }
  }

  function mergePendingFiles(diskId, parentId, files) {
    const withSaveState = applySaveStateToFiles(diskId, files);
    const withDeleteState = applyDeleteStateToFiles(diskId, withSaveState);
    const withMoveState = applyMoveStateToFiles(diskId, withDeleteState);
    const withServerPending = applyPendingStateFromEntries(diskId, parentId, withMoveState);
    const pending = getPendingEntries(diskId, parentId);
    if (!pending.length) return withServerPending;
    const names = new Set(withServerPending.map((file) => file.name.toLowerCase()));
    const extras = pending
      .filter((entry) => {
        if (names.has(entry.name.toLowerCase())) return false;
        return entry.status === 'syncing'
          || entry.status === 'moving'
          || entry.status === 'pending'
          || entry.status === 'error';
      })
      .map((entry) => mapPendingFile(diskId, parentId, entry));
    return [...withServerPending, ...extras].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function buildExpectedPath(parentId, name) {
    const parentPath = normalizePath(parentId);
    return parentPath ? `${parentPath}/${name}` : name;
  }

  function isPathVisibleInTree(tree, expectedPath, isFolder) {
    const path = normalizePath(expectedPath);
    if (!path) return false;
    if (isFolder) {
      return tree.some((entry) => {
        const entryPath = entry.path || '';
        return entryPath === path
          || entryPath === `${path}/.keep`
          || entryPath.startsWith(`${path}/`);
      });
    }
    return tree.some((entry) => entry.type === 'blob' && entry.path === path);
  }

  async function confirmPendingOnServer(diskId, tempId) {
    const located = findPendingEntry(tempId);
    if (!located || located.entry.status !== 'pending') return false;

    const disk = getDisk(diskId);
    if (!disk) {
      resolvePending(tempId);
      return true;
    }

    const expectedPath = located.entry.expectedPath || buildExpectedPath(located.parentId, located.entry.name);
    try {
      const tree = await getRepoTree(disk, { force: true });
      if (isPathVisibleInTree(tree, expectedPath, located.entry.isFolder)) {
        resolvePending(tempId);
        invalidateRepoTree(diskId);
        notifyListChange(diskId);
        return true;
      }
    } catch {
      // GitHub may still be updating — keep polling.
    }
    return false;
  }

  function schedulePendingConfirmation(diskId, tempId) {
    if (pendingConfirmTimers.has(tempId)) return;

    let attempts = 0;
    const maxAttempts = 90;

    const tick = async () => {
      attempts += 1;
      const located = findPendingEntry(tempId);
      if (!located || located.entry.status !== 'pending') {
        pendingConfirmTimers.delete(tempId);
        return;
      }

      const confirmed = await confirmPendingOnServer(diskId, tempId);
      if (confirmed) {
        pendingConfirmTimers.delete(tempId);
        return;
      }

      if (attempts >= maxAttempts) {
        failPending(tempId, 'Timed out waiting for GitHub to list this item');
        pendingConfirmTimers.delete(tempId);
        return;
      }

      pendingConfirmTimers.set(tempId, setTimeout(tick, 2000));
    };

    pendingConfirmTimers.set(tempId, setTimeout(tick, 1000));
  }

  function markPendingAwaitingConfirmation(tempId, expectedPath, isFolder) {
    const located = findPendingEntry(tempId);
    if (!located) return;
    located.entry.status = 'pending';
    located.entry.expectedPath = normalizePath(expectedPath);
    located.entry.isFolder = !!isFolder;
    notifyListChange(located.diskId);
    schedulePendingConfirmation(located.diskId, tempId);
    confirmPendingOnServer(located.diskId, tempId);
  }

  async function runPendingMutation(diskId, parentId, meta, action) {
    const tempId = addPending(diskId, parentId, meta);
    try {
      const result = await action();
      const expectedPath = result?.id
        ? normalizePath(result.id)
        : buildExpectedPath(parentId, meta.name);
      // The action resolves after the server-side commit succeeds. Clear the
      // temporary entry now; a delayed tree listing must not block completion.
      resolvePending(tempId);
      invalidateRepoTree(diskId);
      notifyListChange(diskId);
      return result;
    } catch (err) {
      failPending(tempId, err?.message || String(err), { conflict: isConflictError(err) });
      if (isConflictError(err)) {
        const retry = await offerConflictResolution(diskId, err);
        if (retry) return runPendingMutation(diskId, parentId, meta, action);
      }
      throw err;
    }
  }

  function isBrowserViewableFile(file) {
    if (!file || file.isFolder || file.pending) return false;
    const mime = String(file.mimeType || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    if (mime.startsWith('image/')) return true;
    if (mime === 'application/pdf') return true;
    if (mime === 'text/html') return true;
    if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|pdf|mp4|webm|mp3|wav|ogg|html?)$/i.test(name);
  }

  function getRepoWebUrl(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const base = disk.repoHtmlUrl || `https://github.com/${disk.owner}/${disk.repo}`;
    const branch = disk.branch || 'main';
    return `${base}/tree/${branch}`;
  }

  function getItemWebUrl(diskId, itemId, isFolder = false) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const path = normalizePath(itemId);
    if (String(itemId).startsWith('pending:')) {
      throw new Error('项目暂时无法在 GitHub 上访问');
    }
    if (!path || path === ROOT_ID) return getRepoWebUrl(diskId);
    const base = disk.repoHtmlUrl || `https://github.com/${disk.owner}/${disk.repo}`;
    const branch = disk.branch || 'main';
    const encodedPath = encodeRepoPath(path);
    return isFolder
      ? `${base}/tree/${branch}/${encodedPath}`
      : `${base}/blob/${branch}/${encodedPath}`;
  }

  function getFileViewUrl(diskId, fileId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const path = normalizePath(fileId);
    if (!path || String(fileId).startsWith('pending:')) {
      throw new Error('文件暂时无法打开');
    }
    const encodedPath = encodeRepoPath(path);
    const branch = disk.branch || 'main';
    if (disk.private) {
      return `https://github.com/${disk.owner}/${disk.repo}/blob/${branch}/${encodedPath}`;
    }
    return `https://raw.githubusercontent.com/${disk.owner}/${disk.repo}/${branch}/${encodedPath}`;
  }

  function loadDisks() {
    try {
      if (typeof StorageMigrate !== 'undefined') {
        StorageMigrate.migrateLocalStorageKey(STORAGE_KEY, [LEGACY_STORAGE_KEY]);
      } else if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
      }
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"disks":[]}');
      disks = (raw.disks || []).map(({ token: _legacyToken, ...disk }) => ({
        ...disk,
        id: disk.id || `${ID_PREFIX}${disk.owner}/${disk.repo}`,
      }));
    } catch {
      disks = [];
    }
  }

  function saveDisks() {
    // Repository metadata may persist for navigation, but GitHub credentials are
    // session-only until the Worker-backed HttpOnly session API is available.
    const persistentDisks = disks.map(({ token: _token, ...disk }) => disk);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ disks: persistentDisks }));
  }

  function init() {
    loadDisks();
    // The Worker session is persisted in an HttpOnly cookie and may survive a
    // page reload. Avoid forcing OAuth again before the first authenticated API
    // request has had a chance to verify that cookie.
    hasWorkerSession = true;
  }

  function isGithubId(id) {
    return typeof id === 'string' && id.startsWith(ID_PREFIX);
  }

  function getDisks() {
    return disks.slice();
  }

  function getDisk(diskId) {
    return disks.find((d) => d.id === diskId) || null;
  }

  function getDiskByName(name) {
    return disks.find((d) => d.name === name) || null;
  }

  function ensureConfigured() {
    const clientId = CONFIG.GITHUB_CLIENT_ID || '';
    if (!clientId || /^YOUR_/.test(clientId)) {
      throw new Error('GitHub 登录尚未配置。请通过 js/config.local.js 或 CONFIG_GITHUB_CLIENT_ID 构建变量设置 GITHUB_CLIENT_ID（参阅 README 的“配置客户端 ID”）。');
    }
  }

  function resolveAssetUrl(path) {
    if (!path) return path;
    if (/^https?:/i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) return path;
    return typeof BasePath !== 'undefined' ? BasePath.prefixRelativeAsset(path) : path;
  }

  function randomString(size = 64) {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function toBase64Url(bytes) {
    let str = '';
    bytes.forEach((b) => {
      str += String.fromCharCode(b);
    });
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function createCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return toBase64Url(new Uint8Array(digest));
  }

  function isGithubPagesHost() {
    return /(^|\.)github\.io$/i.test(location.hostname);
  }

  function getAppDirectoryFromLocation() {
    if (typeof BasePath !== 'undefined') {
      return BasePath.get();
    }

    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (/\.html$/i.test(path)) {
      return path.slice(0, path.lastIndexOf('/')) || '';
    }
    return '';
  }

  function getOAuthRedirectUri() {
    if (CONFIG.GITHUB_REDIRECT_URI) {
      return String(CONFIG.GITHUB_REDIRECT_URI).replace(/\/$/, '');
    }

    let basePath = '';
    if (isGithubPagesHost()) {
      basePath = typeof BasePath !== 'undefined' ? BasePath.get() : '';
    } else {
      basePath = getAppDirectoryFromLocation();
    }

    const path = basePath ? `${basePath}/github-oauth-callback.html` : '/github-oauth-callback.html';
    return new URL(path, location.origin).href.replace(/\/$/, '');
  }

  function getAllowedOAuthMessageOrigins() {
    const origins = new Set([location.origin]);
    try {
      origins.add(new URL(getOAuthRedirectUri()).origin);
    } catch {
      // ignore invalid redirect URI
    }
    return origins;
  }

  function createOAuthState() {
    return `${location.origin}|${randomString(24)}`;
  }

  function getOAuthRedirectUriHelp() {
    return `Set this exact URL as Authorization callback URL in your GitHub OAuth App:\n${getOAuthRedirectUri()}`;
  }

  function getTokenExchangeUrl() {
    if (CONFIG.GITHUB_TOKEN_EXCHANGE_URL) {
      return String(CONFIG.GITHUB_TOKEN_EXCHANGE_URL).replace(/\/$/, '');
    }

    let basePath = '';
    if (isGithubPagesHost()) {
      basePath = typeof BasePath !== 'undefined' ? BasePath.get() : '';
    } else {
      basePath = getAppDirectoryFromLocation();
    }

    const path = basePath ? `${basePath}/api/github/oauth/token` : '/api/github/oauth/token';
    return new URL(path, location.origin).href;
  }

  function isIdePreviewServer() {
    return location.port === '63342';
  }

  function getIdePreviewHelp() {
    return (
      'IntelliJ/WebStorm preview (port 63342) cannot host the OAuth token proxy.\n\n' +
      'Easiest: retry and choose "Use personal access token" (repo scope).\n\n' +
      'For OAuth popup instead:\n' +
      '  1. Run: python3 serve.py and open http://localhost:8080\n' +
      '  2. Or set GITHUB_TOKEN_EXCHANGE_URL in js/config.js to a deployed proxy (see README)\n' +
      '  3. Register this callback URL in your GitHub OAuth App:\n' +
      `     ${getOAuthRedirectUri()}`
    );
  }

  function prefersPatSignIn() {
    if (CONFIG.GITHUB_USE_PAT) return true;
    if (CONFIG.GITHUB_TOKEN_EXCHANGE_URL) return false;
    return isIdePreviewServer();
  }

  function buildPopupClosedError() {
    if (isIdePreviewServer()) {
      return `GitHub sign-in popup closed before authorization finished.\n\n${getIdePreviewHelp()}`;
    }
    return (
      'GitHub sign-in popup closed before authorization finished.\n\n' +
      'Allow popups for this site. If you approved access on GitHub, retry once.\n\n' +
      getOAuthRedirectUriHelp()
    );
  }

  function getTokenExchangeHelp() {
    if (isGithubPagesHost() && !CONFIG.GITHUB_TOKEN_EXCHANGE_URL) {
      return (
        'GitHub blocks browser token exchange (CORS). GitHub Pages is static hosting,\n' +
        'so you need a token proxy (see README → "GitHub OAuth token proxy").\n\n' +
        'Set GITHUB_TOKEN_EXCHANGE_URL in js/config.js to your deployed proxy URL.\n\n' +
        'For local development run: python3 serve.py and open http://localhost:8080'
      );
    }
    return getTokenProxyUnavailableHelp();
  }

  function getTokenProxyUnavailableHelp() {
    const proxyUrl = getTokenExchangeUrl();
    const lines = [];

    if (isIdePreviewServer()) {
      lines.push(
        'You are on IntelliJ/WebStorm preview (port 63342).',
        'This server cannot run the OAuth token proxy.',
        '',
        'Easiest: retry and choose "Use personal access token" (repo scope).',
        '',
        'For OAuth popup instead, run python3 serve.py and open http://localhost:8080,',
        'or set GITHUB_TOKEN_EXCHANGE_URL in js/config.js to a deployed proxy (see README).',
        '',
        `Token proxy not reachable: ${proxyUrl}`,
      );
    } else if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      lines.push(
        'The GitHub token proxy is not running.',
        '',
        'Use the project dev server (not python3 -m http.server):',
        '  python3 serve.py',
        '',
        'Then open http://localhost:8080 and register this callback URL in GitHub:',
        '  http://localhost:8080/github-oauth-callback.html',
        '',
        `Expected token proxy: ${proxyUrl}`,
      );
    } else {
      lines.push(
        'GitHub blocks browser token exchange (CORS).',
        '',
        'For local development run: python3 serve.py',
        'then open http://localhost:8080',
        '',
        `Expected token proxy: ${proxyUrl}`,
      );
    }
    return lines.join('\n');
  }

  async function exchangeCodeForToken(code, codeVerifier, redirectUri, clientId) {
    const url = getTokenExchangeUrl();
    let tokenRes;
    try {
      tokenRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
    } catch (err) {
      const message = err?.message || String(err);
      if (/failed to fetch|networkerror|load failed/i.test(message)) {
        throw new Error(`GitHub sign-in failed (${message}).\n\n${getTokenExchangeHelp()}`);
      }
      throw err;
    }

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.ok) {
      const detail = tokenJson.message || tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
      if (/incorrect_client_credentials/i.test(`${tokenJson.error || ''} ${detail}`)) {
        throw new Error(
          `${detail}\n\n` +
          'GitHub rejected the OAuth app credentials.\n' +
          '1. Confirm GITHUB_CLIENT_ID in js/config.js matches your GitHub OAuth App.\n' +
          '2. Confirm .github_secret contains that app\'s client secret.\n' +
          '3. Restart python3 serve.py after changing .github_secret (old processes ignore updates).'
        );
      }
      if (tokenRes.status === 404) {
        throw new Error(`${detail}\n\n${getTokenExchangeHelp()}`);
      }
      throw new Error(detail || 'Failed to obtain GitHub access token');
    }
    // The Worker stores the OAuth token in its HttpOnly session. Never expose
    // it to the browser, even transiently.
    return true;
  }

  function waitForOauthCode(popup, state) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const storageKey = `storage_hub_github_oauth_${state}`;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const handlePayload = (data) => {
        if (!data || data.source !== OAUTH_MESSAGE_SOURCE) return;
        if (data.state !== state) {
          finish(() => reject(new Error('GitHub OAuth 状态无效')));
          return;
        }
        if (data.error) {
          finish(() => reject(new Error(data.error_description || data.error || 'GitHub authorization failed')));
          return;
        }
        if (!data.code) {
          finish(() => reject(new Error('GitHub 未返回授权码')));
          return;
        }
        finish(() => resolve(data.code));
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('GitHub 登录等待超时')));
      }, 120000);

      const onMessage = (event) => {
        if (!getAllowedOAuthMessageOrigins().has(event.origin)) return;
        handlePayload(event.data);
      };

      let channel;
      try {
        channel = new BroadcastChannel('storage-hub-github-oauth');
        channel.onmessage = (event) => handlePayload(event.data);
      } catch {
        // BroadcastChannel not available
      }

      const onStorage = (event) => {
        if (event.key !== storageKey) return;
        try {
          handlePayload(JSON.parse(event.newValue || '{}'));
        } catch {
          // ignore malformed payload
        }
      };

      let closeTimer = null;
      const interval = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(interval);
          closeTimer = setTimeout(() => {
            finish(() => reject(new Error(buildPopupClosedError())));
          }, 1500);
        }
      }, 200);

      function cleanup() {
        clearTimeout(timeout);
        clearInterval(interval);
        if (closeTimer) clearTimeout(closeTimer);
        window.removeEventListener('message', onMessage);
        window.removeEventListener('storage', onStorage);
        if (channel) {
          try {
            channel.close();
          } catch {
            // ignore
          }
        }
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // ignore
        }
      }

      window.addEventListener('message', onMessage);
      window.addEventListener('storage', onStorage);

      try {
        const legacyKey = `mikus_github_oauth_${state}`;
        const cached = localStorage.getItem(storageKey) || localStorage.getItem(legacyKey);
        if (cached) handlePayload(JSON.parse(cached));
      } catch {
        // ignore
      }
    });
  }

  async function oauthSignIn() {
    ensureConfigured();
    const clientId = CONFIG.GITHUB_CLIENT_ID;
    const state = createOAuthState();
    const codeVerifier = randomString(48);
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const redirectUri = getOAuthRedirectUri();
    const scope = CONFIG.GITHUB_SCOPES || 'repo';

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const popup = window.open(
      `https://github.com/login/oauth/authorize?${params}`,
      'storage_hub_github_oauth',
      'width=560,height=720'
    );

    if (!popup) {
      throw new Error('无法打开 GitHub 登录窗口，请允许此网站打开弹窗。');
    }

    let code;
    try {
      code = await waitForOauthCode(popup, state);
    } catch (err) {
      if (/redirect_uri|misconfigured/i.test(err.message || '')) {
        throw new Error(`${err.message}\n\n${getOAuthRedirectUriHelp()}`);
      }
      throw err;
    }
    popup.close();

    return exchangeCodeForToken(code, codeVerifier, redirectUri, clientId);
  }

  function parseRepoInput(input, defaultOwner) {
    const trimmed = String(input || '').trim();
    if (!trimmed) throw new Error('仓库名称不能为空');

    let path = trimmed
      .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[parts.length - 1] };
    }
    if (parts.length === 1) {
      return { owner: defaultOwner, repo: parts[0] };
    }
    throw new Error('请输入 owner/repo、仓库名称，或 github.com/owner/repo URL');
  }

  async function connectExistingRepository() {
    if (typeof Dialog === 'undefined') throw new Error('选择仓库需要应用对话框组件。');
    const { repositories = [] } = await GithubApi.request('/api/repos');
    const mounted = new Set(disks.map((disk) => disk.id));
    const choices = repositories.filter((repo) => repo.can_write && !mounted.has(`${ID_PREFIX}${repo.owner}/${repo.repo}`));
    if (!choices.length) throw new Error('当前 Worker 会话中没有可写仓库。');
    const result = await Dialog.form({
      title: '连接 GitHub 仓库',
      message: '请选择 Worker 会话已授权且可写入的仓库。',
      fields: [{
        id: 'repo', label: '仓库', type: 'select',
        options: choices.map((repo) => ({ value: `${repo.owner}/${repo.repo}`, label: `${repo.owner}/${repo.repo}` })),
      }],
      submitLabel: '连接',
    });
    if (!result) throw new Error('GitHub 登录已取消');
    const { owner, repo } = parseRepoInput(result.repo, '');
    const repository = await GithubApi.request(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return repository.repository;
  }


  let hasWorkerSession = false;

  async function acquireAccessToken() {
    // OAuth exchange creates an HttpOnly Worker session. The browser never
    // receives or stores a GitHub credential.
    if (hasWorkerSession) {
      try {
        await GithubApi.request('/api/me');
        return true;
      } catch {
        hasWorkerSession = false;
      }
    }
    await oauthSignIn();
    // The Worker only returns ok after it has created the HttpOnly session.
    // Avoid a second /api/me round trip on the login critical path.
    hasWorkerSession = true;
    return true;
  }

  function isEmptyGitTreeError(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    return /repository is empty/.test(msg)
      || /git repository is empty/.test(msg)
      || /no commit found/.test(msg);
  }

  function isDuplicateNameError(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    return /"sha"\s+wasn't supplied|sha wasn't supplied|already exists in this folder|file already exists|path already exists/i.test(msg);
  }

  function makeUniqueSiblingName(name, existsFn) {
    if (!existsFn(name)) return name;
    const match = name.match(/^(.*?)(\.[^.]+)?$/);
    const stem = match?.[1] || name;
    const ext = match?.[2] || '';
    let candidate = `${stem} (2)${ext}`;
    let counter = 3;
    while (existsFn(candidate)) {
      candidate = `${stem} (${counter})${ext}`;
      counter += 1;
    }
    return candidate;
  }

  function upsertDiskFromRepo(profile, repo) {
    const id = `${ID_PREFIX}${repo.owner.login}/${repo.name}`;
    const existing = getDisk(id);
    const disk = {
      id,
      name: repo.name,
      owner: repo.owner.login,
      repo: repo.name,
      branch: repo.default_branch || 'main',
      accountLogin: profile.login,
      accountName: profile.name || profile.login,
      accountAvatar: resolveAssetUrl(profile.avatar_url || ''),
      createdAt: existing?.createdAt || Date.now(),
      repoHtmlUrl: repo.html_url,
      private: !!repo.private,
    };
    if (existing) {
      Object.assign(existing, disk);
    } else {
      disks.push(disk);
    }
    saveDisks();
    return getDisk(id);
  }

  async function createNewRepository() {
    await acquireAccessToken();
    const name = await Dialog.prompt('Repository name', '', {
      title: '创建私有仓库',
      submitLabel: '创建',
    });
    if (!name?.trim()) throw new Error('已取消创建仓库');
    const { repository } = await GithubApi.request('/api/repos', {
      method: 'POST',
      body: { name: name.trim(), private: true },
    });
    const profile = await GithubApi.request('/api/me');
    return upsertDiskFromRepo(profile, repository);
  }

  // Mounts are derived from the Worker session ACL. Creating a repository is
  // always an explicit, separately confirmed action.
  async function ensureGithubStorage() {
    await acquireAccessToken();
    const choice = await Dialog.choose({
      title: '添加 GitHub 仓库',
      message: '可以挂载当前会话已授权的仓库，或创建新的私有仓库。',
      buttons: [
        { id: 'connect', label: '挂载已有仓库', primary: true },
        { id: 'create', label: '创建私有仓库' },
        { id: 'cancel', label: '取消' },
      ],
    });
    if (choice === 'cancel' || !choice) throw new Error('已取消选择 GitHub 仓库');
    if (choice === 'create') return createNewRepository();
    const profile = await GithubApi.request('/api/me');
    const repoData = await connectExistingRepository();
    return upsertDiskFromRepo(profile, repoData);
  }

  async function reauthorizeDisk(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    await acquireAccessToken();
    const profile = await GithubApi.request('/api/me');
    disk.accountLogin = profile.login;
    disk.accountName = profile.login;
    saveDisks();
    return disk;
  }

  // T4: 只读递归收集（无 commit），供跨仓库单 commit 批量写入
  async function collectGithubItems(sourceDiskId, items) {
    const files = [];
    const emptyDirs = [];
    async function walk(list, prefix) {
      for (const item of list) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isFolder || item.mimeType === FOLDER_MIME) {
          const children = await listFiles(sourceDiskId, item.id);
          if (children.length) {
            await walk(children, rel);
          } else {
            emptyDirs.push(rel);
          }
        } else {
          const blob = await downloadFile(sourceDiskId, item.id);
          const content = isTextFileMime(item.mimeType, item.name)
            ? await blob.text()
            : new Uint8Array(await blob.arrayBuffer());
          files.push({ relPath: rel, content });
        }
      }
    }
    await walk(items, '');
    return { files, emptyDirs };
  }

  // T4: 收集结果在目标仓库单 commit 写入（create 复用 op 模型；空目录 mkdir 自动 .keep）
  async function createBatchFromCollected(destDiskId, destParentId, collected, message) {
    const parent = normalizePath(destParentId);
    const join = (rel) => (parent ? `${parent}/${rel}` : rel);
    const operations = [];
    for (const { relPath, content } of collected.files) {
      operations.push({ type: 'create', path: join(relPath), content });
    }
    for (const rel of collected.emptyDirs) {
      operations.push({ type: 'mkdir', path: join(rel) });
    }
    if (!operations.length) return null;
    return executeOperations(destDiskId, operations, message);
  }

  // T4: 批量删除（delete op 按路径前缀递归，整批一次 commit）
  async function deleteBatch(diskId, items, message) {
    const operations = items.map((item) => ({ type: 'delete', path: normalizePath(item.id) }));
    if (!operations.length) return null;
    return executeOperations(diskId, operations, message);
  }

  function notifyTransferRecovery({ sourceDiskId, destDiskId, items, stage, message, error }) {
    const source = getDisk(sourceDiskId);
    const destination = getDisk(destDiskId);
    transferListener?.({
      id: `transfer:${sourceDiskId}:${destDiskId}:${Date.now()}`,
      kind: 'transfer',
      sourceDiskId,
      destDiskId,
      sourceRepository: source ? `${source.owner}/${source.repo}` : sourceDiskId,
      destinationRepository: destination ? `${destination.owner}/${destination.repo}` : destDiskId,
      stage,
      paths: (items || []).map((item) => normalizePath(item.id)).filter(Boolean),
      message,
      error: error?.message || null,
      createdAt: Date.now(),
    });
  }

  async function removeDisk(diskId) {
    disks = disks.filter((d) => d.id !== diskId);
    saveDisks();
  }

  function encodeRepoPath(path) {
    if (!path) return '';
    return path
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  function b64EncodeUtf8(text) {
    const bytes = new TextEncoder().encode(text || '');
    return b64EncodeBytes(bytes);
  }

  function b64EncodeBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      out += String.fromCharCode(...view.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function isTextFileMime(mimeType = '', name = '') {
    const mime = String(mimeType).toLowerCase();
    const lower = String(name).toLowerCase();
    if (mime.startsWith('text/') || mime === 'application/json') return true;
    return /\.(txt|md|csv|json|log|xml|yml|yaml|html|htm|css|js|ts|tsx|jsx|py|sh|bat|sql)$/i.test(lower);
  }

  function b64DecodeUtf8(input) {
    const bytes = b64DecodeBytes(input);
    return new TextDecoder().decode(bytes);
  }

  function b64DecodeBytes(input) {
    const binary = atob((input || '').replace(/\n/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  async function readJsonResponse(res) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || contentType.includes('javascript')) {
      return res.json();
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub API returned non-JSON response (${contentType || 'unknown'})`);
    }
  }

  function getParentPath(path) {
    if (!path) return '';
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  function normalizePath(idOrPath) {
    if (!idOrPath || idOrPath === ROOT_ID) return '';
    return idOrPath.replace(/^\/+|\/+$/g, '');
  }

  function inferMimeType(name = '') {
    const lower = name.toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv') || lower.endsWith('.log')) {
      return 'text/plain';
    }
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
  }

  function formatSize(bytes = 0) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(bytes) || 0;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
      size /= 1024;
      idx += 1;
    }
    return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  }

  async function getRepoTreeState(disk, { force = false } = {}) {
    void force;
    const data = await GithubApi.request(
      `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/tree?branch=${encodeURIComponent(disk.branch || 'main')}`
    );
    disk.head = data.head;
    return { head: data.head, treeSha: data.treeSha, tree: data.tree || [] };
  }

  /**
   * Full recursive tree of the current branch HEAD.
   * Cached per owner/repo/branch/head — a moved HEAD re-keys the cache.
   */
  async function getRepoTree(disk, { force = false } = {}) {
    const state = await getRepoTreeState(disk, { force });
    return state.tree;
  }

  async function listFiles(diskId, parentId = ROOT_ID) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const tree = await getRepoTree(disk);
    const base = normalizePath(parentId);
    const folders = new Map();
    const files = [];

    tree.forEach((entry) => {
      if (entry.type !== 'blob' && entry.type !== 'tree') return;
      const path = entry.path || '';
      if (!path || path.endsWith('/.keep') || path === '.keep') return;

      if (base) {
        if (path === base) return;
        if (!path.startsWith(`${base}/`)) return;
      }

      const relative = base ? path.slice(base.length + 1) : path;
      if (!relative) return;
      const [first, ...rest] = relative.split('/');
      if (!first || first === '.keep') return;

      if (rest.length > 0) {
        const folderPath = base ? `${base}/${first}` : first;
        if (!folders.has(folderPath)) {
          folders.set(folderPath, {
            id: folderPath,
            name: first,
            isFolder: true,
            mimeType: FOLDER_MIME,
            icon: '📁',
            parents: [base || ROOT_ID],
            parentId: base || ROOT_ID,
            size: 0,
            sizeFormatted: '',
            dateFormatted: '—',
            typeName: 'Folder',
            webViewLink: getItemWebUrl(diskId, folderPath, true),
          });
        }
        return;
      }

      if (entry.type === 'tree') {
        const folderPath = base ? `${base}/${first}` : first;
        if (!folders.has(folderPath)) {
          folders.set(folderPath, {
            id: folderPath,
            name: first,
            isFolder: true,
            mimeType: FOLDER_MIME,
            icon: '📁',
            parents: [base || ROOT_ID],
            parentId: base || ROOT_ID,
            size: 0,
            sizeFormatted: '',
            dateFormatted: '—',
            typeName: 'Folder',
            webViewLink: getItemWebUrl(diskId, folderPath, true),
          });
        }
        return;
      }

      const mimeType = inferMimeType(first);
      const filePath = base ? `${base}/${first}` : first;
      files.push({
        id: filePath,
        name: first,
        isFolder: false,
        mimeType,
        icon: mimeType === 'application/json' ? '📋' : mimeType.startsWith('text/') ? '📝' : mimeType.startsWith('image/') ? '🖼️' : '📄',
        parents: [base || ROOT_ID],
        parentId: base || ROOT_ID,
        size: entry.size || 0,
        sizeFormatted: formatSize(entry.size || 0),
        dateFormatted: '—',
        typeName: mimeType === 'application/json' ? 'JSON file' : mimeType.startsWith('image/') ? 'Image' : 'File',
        viewUrl: getFileViewUrl(diskId, filePath),
        webViewLink: getItemWebUrl(diskId, filePath, false),
      });
    });

    return mergePendingFiles(diskId, parentId, [...folders.values(), ...files].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    }));
  }

  async function listTrash() {
    return [];
  }

  async function getFileContentMeta(disk, path) {
    const tree = await getRepoTree(disk, { force: true });
    const entry = tree.find((item) => item.type === 'blob' && item.path === path);
    if (!entry) {
      const isDirectory = tree.some((item) => item.path.startsWith(`${path}/`));
      if (isDirectory) return { type: 'dir', path, name: path.split('/').pop() || path };
      const error = new Error(`File not found: ${path}`);
      error.status = 404;
      throw error;
    }
    return {
      type: 'file',
      name: path.split('/').pop() || path,
      path,
      sha: entry.sha,
      size: entry.size ?? null,
    };
  }

  function assertUploadSize(bytes) {
    if (bytes.length > 100 * 1024 * 1024) {
      throw new Error('GitHub 存储支持的单文件大小上限为 100 MB');
    }
  }

  async function createFolder(diskId, parentId, name) {
    return runPendingMutation(diskId, parentId, { name, isFolder: true }, async () => {
      const parentPath = normalizePath(parentId);
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      await executeOperations(diskId, [{ type: 'mkdir', path: folderPath }], `Create folder ${folderPath}`);
      return {
        id: folderPath,
        name,
        isFolder: true,
        mimeType: FOLDER_MIME,
        parents: [parentPath || ROOT_ID],
        parentId: parentPath || ROOT_ID,
      };
    });
  }

  async function createFile(diskId, parentId, name, mimeType, content = '') {
    return runPendingMutation(diskId, parentId, { name, mimeType, size: new TextEncoder().encode(content || '').length }, async () => {
      const parentPath = normalizePath(parentId);
      const filePath = parentPath ? `${parentPath}/${name}` : name;
      await executeOperations(diskId, [{ type: 'create', path: filePath, content }], `Create file ${filePath}`);
      return {
        id: filePath,
        name,
        mimeType: mimeType || inferMimeType(name),
        parents: [parentPath || ROOT_ID],
        parentId: parentPath || ROOT_ID,
        viewUrl: getFileViewUrl(diskId, filePath),
      };
    });
  }

  async function createFileFromBlob(diskId, parentId, name, mimeType, blob) {
    const size = blob?.size || 0;
    return runPendingMutation(diskId, parentId, { name, mimeType, size }, async () => {
      const parentPath = normalizePath(parentId);
      const filePath = parentPath ? `${parentPath}/${name}` : name;
      const resolvedMime = mimeType || inferMimeType(name);
      const content = isTextFileMime(resolvedMime, name)
        ? await blob.text()
        : new Uint8Array(await blob.arrayBuffer());
      if (content instanceof Uint8Array) assertUploadSize(content);
      await executeOperations(diskId, [{ type: 'create', path: filePath, content }], `Create file ${filePath}`);
      return {
        id: filePath,
        name,
        mimeType: resolvedMime,
        parents: [parentPath || ROOT_ID],
        parentId: parentPath || ROOT_ID,
        viewUrl: getFileViewUrl(diskId, filePath),
      };
    });
  }

  async function replaceFile(diskId, parentId, name, mimeType, content = '') {
    return runPendingMutation(
      diskId,
      parentId,
      { name, mimeType, size: new TextEncoder().encode(content || '').length },
      async () => {
        const parentPath = normalizePath(parentId);
        const filePath = parentPath ? `${parentPath}/${name}` : name;
        const tree = await getRepoTree(await requireDisk(diskId));
        if (isPathVisibleInTree(tree, filePath, true) && !tree.some((e) => e.type === 'blob' && e.path === filePath)) {
          throw new Error('不能用文件替换文件夹');
        }
        await executeOperations(diskId, [{ type: 'update', path: filePath, content }], `Update file ${filePath}`);
        return {
          id: filePath,
          name,
          mimeType: mimeType || inferMimeType(name),
          parents: [parentPath || ROOT_ID],
          parentId: parentPath || ROOT_ID,
          viewUrl: getFileViewUrl(diskId, filePath),
        };
      }
    );
  }

  async function getTextFileContent(diskId, fileId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const path = normalizePath(fileId);
    const meta = await getFileContentMeta(disk, path);
    if (meta.type !== 'file') throw new Error('项目不是文件');
    if (meta.encoding === 'base64' && typeof meta.content === 'string') {
      return b64DecodeUtf8(meta.content);
    }
    const blob = await downloadFile(diskId, fileId);
    return blob.text();
  }

  async function updateFileContent(diskId, fileId, content, _mimeType) {
    const path = normalizePath(fileId);
    await runPendingFileSave(
      diskId,
      path,
      { name: path.split('/').pop(), size: new TextEncoder().encode(content || '').length },
      async () => {
        await executeOperations(diskId, [{ type: 'update', path, content }], `Update file ${path}`);
        return { expectedSha: null };
      }
    );
  }

  async function renameFile(diskId, fileId, name) {
    const oldPath = normalizePath(fileId);
    const parent = getParentPath(oldPath);
    const newPath = parent ? `${parent}/${name}` : name;
    const disk = await requireDisk(diskId);
    const tree = await getRepoTree(disk);
    const isFolder = GithubPaths.isFolderPath(tree, oldPath);
    return runPendingMove(
      diskId,
      oldPath,
      parent || ROOT_ID,
      {
        name,
        isFolder,
        mimeType: isFolder ? FOLDER_MIME : inferMimeType(name),
        size: 0,
        destPath: newPath,
      },
      async () => {
        await executeOperations(diskId, [{ type: 'rename', from: oldPath, to: newPath }], `Rename ${oldPath} → ${newPath}`);
      }
    );
  }

  async function isGithubFolder(diskId, path) {
    const normalized = normalizePath(path);
    if (!normalized) return false;
    const disk = await requireDisk(diskId);
    const tree = await getRepoTree(disk);
    return GithubPaths.isFolderPath(tree, normalized);
  }

  async function makeUniqueCopyName(diskId, parentId, name, takenPaths = null) {
    const disk = await requireDisk(diskId);
    const tree = await getRepoTree(disk);
    const targetPath = GithubPaths.joinPath(normalizePath(parentId), name);
    const uniquePath = GithubPaths.makeUniquePath(tree, targetPath, takenPaths);
    return GithubPaths.getBaseName(uniquePath);
  }

  /**
   * Delete a file or a whole directory subtree as ONE tree rewrite + ONE commit.
   * Never loops the Contents API (PROJECT_SPEC §2 Delete).
   */
  async function deleteFile(diskId, fileId) {
    const disk = await requireDisk(diskId);
    const targetPath = normalizePath(fileId);
    const fileName = targetPath.split('/').pop() || targetPath;
    let isFolder = false;
    let size = 0;

    try {
      const tree = await getRepoTree(disk);
      isFolder = GithubPaths.isFolderPath(tree, targetPath);
      const descendants = GithubPaths.collectDescendants(tree, targetPath)
        .filter((entry) => entry.type === 'blob' && entry.path !== targetPath);
      if (!isFolder && descendants.length === 0) {
        const self = tree.find((entry) => entry.type === 'blob' && entry.path === targetPath);
        size = self?.size || 0;
      }
    } catch {
      // Item may already be gone or still syncing.
      isFolder = false;
    }

    await runPendingDelete(diskId, targetPath, {
      name: fileName,
      isFolder,
      size,
    }, async () => {
      const alreadyGone = await isDeletedOnServer(disk, targetPath, isFolder);
      if (alreadyGone) return;
      try {
        await executeOperations(diskId, [{ type: 'delete', path: targetPath }], `Delete ${targetPath}`);
      } catch (err) {
        if (err?.status === 422 && /not found/i.test(err.message)
          && (await isDeletedOnServer(disk, targetPath, isFolder))) {
          return; // idempotent delete
        }
        throw err;
      }
    });
  }

  async function trashFile(diskId, fileId) {
    await deleteFile(diskId, fileId);
  }

  async function restoreFile(_diskId, _fileId) {
    throw new Error('GitHub 存储不支持从回收站恢复');
  }

  function getTreeEntrySize(tree, path) {
    const entry = tree.find((item) => item.type === 'blob' && item.path === path);
    return entry?.size || 0;
  }

  /**
   * Copy a file or a whole directory subtree as ONE tree rewrite + ONE commit.
   * Reuses the source Blob SHAs — content is never re-uploaded
   * (PROJECT_SPEC §2 Copy).
   */
  async function copyFile(diskId, fileId, parentId) {
    const disk = await requireDisk(diskId);
    const sourcePath = normalizePath(fileId);
    const destParent = normalizePath(parentId);
    const sourceName = sourcePath.split('/').pop();

    const tree = await getRepoTree(disk);
    if (!GithubPaths.isFolderInTree(tree, sourcePath)
      && !GithubPaths.isPathVisible(tree, sourcePath, false)) {
      throw new Error(`Path not found on GitHub: ${sourcePath}`);
    }
    const isFolder = GithubPaths.isFolderPath(tree, sourcePath);

    const targetPath = destParent ? `${destParent}/${sourceName}` : sourceName;
    const destPath = GithubPaths.makeUniquePath(tree, targetPath);
    const destName = GithubPaths.getBaseName(destPath);
    const size = isFolder
      ? GithubPaths.collectDescendants(tree, sourcePath)
        .filter((entry) => entry.type === 'blob')
        .reduce((sum, entry) => sum + (entry.size || 0), 0)
      : getTreeEntrySize(tree, sourcePath);

    return runPendingMutation(
      diskId,
      parentId,
      { name: destName, mimeType: isFolder ? FOLDER_MIME : inferMimeType(destName), size, isFolder },
      async () => {
        await executeOperations(
          diskId,
          [{ type: 'copy', from: sourcePath, to: destPath }],
          `Copy ${sourcePath} to ${destPath}`
        );
        return {
          id: destPath,
          name: destName,
          isFolder,
          mimeType: isFolder ? FOLDER_MIME : inferMimeType(destName),
          parents: [destParent || ROOT_ID],
          parentId: destParent || ROOT_ID,
          viewUrl: isFolder ? undefined : getFileViewUrl(diskId, destPath),
          webViewLink: getItemWebUrl(diskId, destPath, isFolder),
        };
      }
    );
  }

  /**
   * Move/Rename via Git Tree path rewrite: descendants keep their Blob SHAs,
   * one tree + one commit (PROJECT_SPEC §2 Move/Rename).
   */
  async function moveFile(diskId, fileId, fromParentId, toParentId, explicitTargetPath = null) {
    const disk = await requireDisk(diskId);
    const sourcePath = normalizePath(fileId);
    const toParent = normalizePath(toParentId);
    const sourceName = sourcePath.split('/').pop();
    const targetPath = explicitTargetPath || (toParent ? `${toParent}/${sourceName}` : sourceName);

    const tree = await getRepoTree(disk);
    const isFolder = GithubPaths.isFolderPath(tree, sourcePath);

    return runPendingMove(
      diskId,
      sourcePath,
      toParentId,
      {
        name: sourceName,
        isFolder,
        mimeType: isFolder ? FOLDER_MIME : inferMimeType(sourceName),
        size: isFolder ? 0 : getTreeEntrySize(tree, sourcePath),
        destPath: targetPath,
      },
      async () => {
        await executeOperations(
          diskId,
          [{ type: 'move', from: sourcePath, to: targetPath }],
          `Move ${sourcePath} to ${targetPath}`
        );
      }
    );
  }

  /**
   * Batch API: run a group of operations as ONE commit.
   * Used by the UI for multi-select move/copy/delete (PROJECT_SPEC §2 Batch).
   *
   * @param {Array} operations - raw Git operations, sent to Worker /operations
   */
  async function executeBatch(diskId, operations, message = 'Batch file operations') {
    const result = await executeOperations(diskId, operations, message);
    return result;
  }

  /** Pre-compute collision-free copy targets for a batch ("(copy)" naming). */
  async function buildBatchCopyOperations(diskId, items, parentId) {
    const disk = await requireDisk(diskId);
    const tree = await getRepoTree(disk);
    const taken = new Set();
    return items.map((item) => {
      const sourcePath = normalizePath(item.id);
      const sourceName = sourcePath.split('/').pop();
      const targetPath = GithubPaths.joinPath(normalizePath(parentId), sourceName);
      const destPath = GithubPaths.makeUniquePath(tree, targetPath, taken);
      return { type: 'copy', from: sourcePath, to: destPath };
    });
  }

  /** Pre-compute move targets for a batch (absolute paths, planner validates). */
  async function buildBatchMoveOperations(diskId, items, parentId) {
    void diskId;
    const destParent = normalizePath(parentId);
    return items.map((item) => {
      const sourcePath = normalizePath(item.id);
      const sourceName = sourcePath.split('/').pop();
      const destPath = destParent ? `${destParent}/${sourceName}` : sourceName;
      return { type: 'move', from: sourcePath, to: destPath };
    });
  }

  async function downloadFile(diskId, fileId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const path = normalizePath(fileId);
    const fileName = path.split('/').pop() || '';
    const response = await GithubApi.request(
      `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/file?branch=${encodeURIComponent(disk.branch || 'main')}&path=${encodeURIComponent(path)}`,
      { raw: true }
    );
    return new Blob([await response.arrayBuffer()], {
      type: response.headers.get('content-type') || inferMimeType(fileName),
    });
  }

  async function getFolderPath(_diskId, folderId) {
    const path = normalizePath(folderId);
    const crumbs = [{ id: ROOT_ID, name: 'My Drive' }];
    if (!path) return crumbs;
    let current = '';
    path.split('/').forEach((part) => {
      current = current ? `${current}/${part}` : part;
      crumbs.push({ id: current, name: part });
    });
    return crumbs;
  }

  async function getFileProperties(diskId, fileId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const path = normalizePath(fileId);
    const meta = await getFileContentMeta(disk, path);
    const isFolder = meta.type === 'dir';
    let githubLink = '—';
    try {
      githubLink = getItemWebUrl(diskId, path, isFolder);
    } catch {
      // Item may still be syncing.
    }
    return [
      { section: 'File' },
      ['Name', meta.name || path.split('/').pop() || ''],
      ['Path', meta.path || path],
      ['Type', isFolder ? 'Folder' : 'File'],
      ['Size', meta.size != null ? formatSize(meta.size) : '—'],
      ['SHA', meta.sha || '—'],
      ['Storage', `${disk.owner}/${disk.repo}`],
      ['GitHub link', githubLink],
      ['Repository URL', disk.repoHtmlUrl || `https://github.com/${disk.owner}/${disk.repo}`],
    ];
  }

  async function getStorageQuota(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const { repository: repo } = await GithubApi.request(
      `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}`
    );
    const usage = (repo.size || 0) * 1024;
    const limit = MAX_REPO_SIZE_BYTES;
    const available = Math.max(0, limit - usage);
    const usageFormatted = formatSize(usage);
    const limitFormatted = formatSize(limit);
    const availableFormatted = formatSize(available);
    return {
      usage,
      limit,
      available,
      usageFormatted,
      limitFormatted,
      availableFormatted,
      label: `${usageFormatted} used · ${availableFormatted} free of ${limitFormatted}`,
      shortLabel: `${usageFormatted} / ${limitFormatted}`,
    };
  }

  function isNotepadFile(file) {
    const mime = (file.mimeType || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    if (mime === 'text/plain' || mime === 'application/json') return true;
    return /\.(txt|json)$/i.test(name);
  }

  async function buildNotepadFilePath(diskId, file) {
    const disk = getDisk(diskId);
    const segments = [disk?.name || 'GitHub Storage', 'My Drive'];
    const path = normalizePath(file.id || file.path || file.name);
    if (path) {
      path.split('/').forEach((part) => segments.push(part));
    } else if (file.name) {
      segments.push(file.name);
    }
    return `/${segments.join('/')}`;
  }

  async function resolveFileByPath(segments) {
    if (!segments?.length) throw new Error('文件路径无效');
    const disk = getDiskByName(segments[0]);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const parts = segments[1] === 'My Drive' ? segments.slice(2) : segments.slice(1);
    const path = parts.join('/');
    const fileName = parts[parts.length - 1];
    if (!fileName) throw new Error('文件路径无效');
    const parentPath = getParentPath(path) || ROOT_ID;
    const files = await listFiles(disk.id, parentPath);
    const file = files.find((f) => !f.isFolder && f.name === fileName);
    if (file) return { diskId: disk.id, file };

    const direct = await tryResolveFileByDirectPath(disk, disk.id, path);
    if (direct) return { diskId: disk.id, file: direct };
    throw new Error('找不到文件');
  }

  async function tryResolveFileByDirectPath(disk, diskId, path) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const meta = await getFileContentMeta(disk, path);
        if (meta.type === 'dir') throw new Error('项目是文件夹');
        const fileName = path.split('/').pop() || path;
        const parentPath = getParentPath(path);
        const mimeType = inferMimeType(fileName);
        return {
          id: path,
          name: fileName,
          isFolder: false,
          mimeType,
          parents: [parentPath || ROOT_ID],
          parentId: parentPath || ROOT_ID,
          size: meta.size || 0,
          sizeFormatted: formatSize(meta.size || 0),
          dateFormatted: '—',
          typeName: mimeType === 'application/json' ? 'JSON file' : mimeType.startsWith('text/') ? 'Text file' : 'File',
          viewUrl: getFileViewUrl(diskId, path),
          webViewLink: getItemWebUrl(diskId, path, false),
        };
      } catch (err) {
        const msg = err?.message || '';
        const missing = /404|not found/i.test(msg);
        if (!missing || attempt === 3) {
          if (missing) return null;
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    return null;
  }

  return {
    ROOT_ID,
    FOLDER_MIME,
    ID_PREFIX,
    init,
    getOAuthRedirectUri,
    getOAuthRedirectUriHelp,
    getTokenExchangeUrl,
    getTokenExchangeHelp,
    prefersPatSignIn,
    acquireAccessToken,
    isGithubId,
    isBrowserViewableFile,
    getFileViewUrl,
    getItemWebUrl,
    getRepoWebUrl,
    invalidateRepoTree,
    setListChangeListener,
    setSaveStateListener,
    setConflictListener,
    setTransferListener,
    getFileSaveState,
    getDisks,
    getDisk,
    getDiskByName,
    removeDisk,
    listFiles,
    listTrash,
    createFolder,
    createFile,
    createFileFromBlob,
    replaceFile,
    isDuplicateNameError,
    makeUniqueSiblingName,
    isTextFileMime,
    renameFile,
    trashFile,
    restoreFile,
    deleteFile,
    moveFile,
    copyFile,
    executeBatch,
    buildBatchCopyOperations,
    buildBatchMoveOperations,
    isConflictError,
    getTextFileContent,
    updateFileContent,
    downloadFile,
    getFolderPath,
    getFileProperties,
    getStorageQuota,
    isNotepadFile,
    buildNotepadFilePath,
    resolveFileByPath,
    ensureGithubStorage,
    reauthorizeDisk,
    collectGithubItems,
    createBatchFromCollected,
    deleteBatch,
    notifyTransferRecovery,
    formatSize,
    formatDate,
  };
})();
