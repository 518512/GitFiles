const GithubDisk = (() => {
  const ROOT_ID = 'root';
  const FOLDER_MIME = 'application/x-github-folder';
  const ID_PREFIX = 'github:';
  const STORAGE_KEY = 'storage_hub_github_disks';
  const LEGACY_STORAGE_KEY = 'mikus_drive_github_disks';
  const OAUTH_MESSAGE_SOURCE = 'storage-hub-github-oauth';
  // GitHub docs: repos above ~100 GB may be blocked.
  const MAX_REPO_SIZE_BYTES = 100 * 1024 * 1024 * 1024;
  // 单文件上传上限必须与 Worker 侧 workers/operations.js 的 MAX_BINARY_BYTES
  // 一致，否则用户要等整包上传完才收到 422。两边都是 25 MB。
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

  /**
   * 文本类文件的**单一判定来源**。
   *
   * 之前 isTextFileMime / isNotepadFile / inferMimeType / app.js 的 isTextMime
   * 各维护一份扩展名表，已经漂移出 bug：`.markdown` 在 isTextFileMime 里不是文本，
   * 于是 createFileFromBlob 把它当二进制走 arrayBuffer 分支。
   */
  const TEXT_LIKE_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml))/i;
  const TEXT_EXTENSION_RE = /\.(txt|md|markdown|csv|log|xml|yml|yaml|html?|css|js|ts|tsx|jsx|py|sh|bat|sql|json)$/i;

  let disks = [];
  const pendingByFolder = new Map();
  const saveStateByPath = new Map();
  const deleteStateByPath = new Map();
  const moveStateByPath = new Map();
  const saveConfirmTimers = new Map();
  let listChangeListener = null;
  let saveStateListener = null;
  let conflictListener = null;
  let transferListener = null;

  /**
   * 仓库树缓存（AGENTS.md §19）。
   *
   * 键是 `diskId + branch`，命中前提是「缓存里的 head 与 disk.head 相等」：
   *   · 写操作成功后 disk.head 变成新的 commit SHA → 旧缓存自动失配 → 下次读回源；
   *   · 因此不需要每次写入都清空缓存，也不会读到写前的旧树。
   *
   * 注意键里**不放 head**：请求之前 head 可能还是 null（首次加载），
   * 放进去会导致永远 miss。改为读时校验 head 相等。
   */
  const repoTreeCache = new Map();
  /** 并发去重：同一 disk+branch 的多个读共享同一次在途请求。 */
  const repoTreeInflight = new Map();

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

  /**
   * 列表变化通知的合并窗口。
   *
   * 一次写操作会经 addPending / resolvePending / 函数尾各通知一次（同一 diskId），
   * 而监听方每次都会 `refreshGithubFolderView({ reloadTree: true })` —— 完整重拉
   * 文件列表 + 侧栏树。实测一次上传能因此触发 3 次重叠刷新。这里按 diskId 合并
   * 到一个很短的时间窗里只派发一次；窗口足够小，用户感知不到延迟。
   */
  const LIST_CHANGE_COALESCE_MS = 120;
  const pendingListNotices = new Set();
  let listNoticeTimer = null;

  function flushListNotices() {
    listNoticeTimer = null;
    const ids = [...pendingListNotices];
    pendingListNotices.clear();
    for (const id of ids) listChangeListener?.(id);
  }

  function notifyListChange(diskId) {
    if (!diskId || !listChangeListener) return;
    pendingListNotices.add(diskId);
    if (listNoticeTimer) clearTimeout(listNoticeTimer);
    listNoticeTimer = setTimeout(flushListNotices, LIST_CHANGE_COALESCE_MS);
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

  /** 分块把字节数组编码成 base64，避免 `String.fromCharCode(...big)` 撑爆调用栈。 */
  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < view.length; offset += chunk) {
      binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  }

  /**
   * Run one logical group of operations as ONE tree + ONE commit
   * (Git Data API, CAS-protected).
   *
   * 二进制内容以 base64 + `encoding: 'base64'` 过界：JSON 没有 typed array，
   * 早先展开成数字数组会带来约 3.6 倍体积和上千万元素的数组；base64 只有 4/3，
   * Worker 侧直接透传给 GitHub，不再需要重新编码（见 workers/operations.js）。
   */
  function serializeOperations(operations) {
    return operations.map((operation) => {
      if (!operation || !(operation.content instanceof Uint8Array)) return operation;
      return { ...operation, content: bytesToBase64(operation.content), encoding: 'base64' };
    });
  }

  async function executeOperations(diskId, operations, message) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    // JSON has no typed-array representation; normalize binary content before
    // crossing the Worker API boundary.
    const serializedOperations = serializeOperations(operations);
    // Read the current server head immediately before mutation. The Worker
    // repeats this comparison before it writes the ref, providing CAS.
    // 只在本 disk 从未读到过 head 时回源；写成功后 head 由下面的 result.head 更新，
    // 因此不会每次写都重新拉一次整棵树（AGENTS.md §3 CAS 基线由服务端重读，客户端偏旧只会拿到 409）。
    if (!disk.head) disk.head = (await getRepoTreeState(disk)).head;
    try {
      const result = await GithubApi.request(
        `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/operations`,
        {
          method: 'POST',
          body: {
            branch: disk.branch || 'main',
            expectedHead: disk.head,
            message,
            operations: serializedOperations,
          },
        }
      );
      // 先更新 HEAD 基线再丢树缓存：新 head 与旧缓存必然失配，下一次读自然回源。
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
      if (err?.status === 0) {
        // A lost response is not proof that the commit failed. Re-read the
        // authoritative branch before surfacing the result as an error.
        const expectedHead = disk.head;
        try {
          const remote = await getRepoTreeState(disk, { force: true });
          if (remote.head && remote.head !== expectedHead) {
            const conflict = new Error('操作结果未能确认：远端分支已发生变化，请检查冲突中心。');
            conflict.name = 'ConflictError';
            conflict.expectedHead = expectedHead || null;
            conflict.remoteHead = remote.head;
            throw conflict;
          }
        } catch (verificationError) {
          if (isConflictError(verificationError)) throw verificationError;
        }
      }
      throw err;
    }
  }

  function invalidateRepoTree(diskId) {
    // 只丢缓存，**不清 disk.head**：head 是 CAS 的客户端基线，写成功后由
    // executeOperations 更新为服务端返回的新 HEAD（AGENTS.md §3 CAS）。
    // 之前这里把 head 置空，导致每次写前都要重新拉一次整棵树来「找 head」，
    // 而且 executeOperations 里紧随其后的 `disk.head = result.head` 当场被覆盖。
    const disk = getDisk(diskId);
    if (disk) repoTreeCache.delete(repoTreeCacheKey(disk));
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
    notifyListChange(diskId);
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
        // 「远端是否已删除」必须看最新状态，不能被树缓存挡住。
        await getFileContentMeta(disk, path, { force: true });
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
    trackOperationFinish(path, true);
    invalidateRepoTree(diskId);
    notifyListChange(diskId);
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
        const meta = await getFileContentMeta(disk, path, { force: true });
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
    if (new URL(url, location.href).origin !== location.origin) {
      throw new Error('认证服务必须与 GitFiles 使用同一域名，否则 HttpOnly 会话 Cookie 无法建立。');
    }
    let tokenRes;
    try {
      tokenRes = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
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
        // BroadcastChannel/localStorage are shared across tabs. Ignore stale
        // callbacks from another login attempt instead of aborting this one.
        if (data.state !== state) return;
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
    // Force a fresh discovery: the cached Worker ACL list never learns about
    // repositories that were created or shared after the last crawl.
    const { repositories = [] } = await GithubApi.request('/api/repos?refresh=1');
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

  let accessTokenPromise = null;

  async function acquireAccessTokenInternal() {
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
    // Verify that the browser received the HttpOnly session cookie. The OAuth
    // exchange response alone is not proof that this app can authenticate.
    try {
      await GithubApi.request('/api/me');
    } catch (error) {
      hasWorkerSession = false;
      throw new Error(`GitHub 登录已完成，但应用会话未建立：${error?.message || '请重试'}`);
    }
    hasWorkerSession = true;
    return true;
  }

  function acquireAccessToken() {
    if (accessTokenPromise) return accessTokenPromise;
    accessTokenPromise = acquireAccessTokenInternal().finally(() => {
      accessTokenPromise = null;
    });
    return accessTokenPromise;
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
    const owner = typeof repo.owner === 'string' ? repo.owner : repo.owner?.login;
    if (!owner || !repo.name) throw new Error('仓库信息无效');
    const id = `${ID_PREFIX}${owner}/${repo.name}`;
    const existing = getDisk(id);
    const disk = {
      id,
      name: repo.name,
      owner,
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

  function isTextFileMime(mimeType = '', name = '') {
    if (TEXT_LIKE_MIME_RE.test(String(mimeType).toLowerCase())) return true;
    return TEXT_EXTENSION_RE.test(String(name).toLowerCase());
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
    const lower = String(name).toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (TEXT_EXTENSION_RE.test(lower)) return 'text/plain';
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

  function repoTreeCacheKey(disk) {
    return `${disk.id}\0${disk.branch || 'main'}`;
  }

  function buildTreeByPath(tree) {
    const byPath = new Map();
    for (const entry of tree) {
      if (entry?.path) byPath.set(entry.path, entry);
    }
    return byPath;
  }

  /**
   * 命中缓存时返回 `{ head, treeSha, updatedAt, tree, byPath }`。
   * 只有「缓存的 head 恰好等于 disk.head」才可信 —— 两者可能同为 null
   * （空仓库），这也是合法结果，因此不能用 `!disk.head` 直接排除。
   */
  function readCachedRepoTree(disk, { force = false } = {}) {
    if (force) return null;
    const entry = repoTreeCache.get(repoTreeCacheKey(disk));
    if (!entry || entry.head !== disk.head) return null;
    return entry;
  }

  async function getRepoTreeState(disk, { force = false } = {}) {
    const cached = readCachedRepoTree(disk, { force });
    if (cached) return cached;

    const key = repoTreeCacheKey(disk);
    // 并发去重：listFiles 与 loadTreeChildren 常在同一个 tick 里各读一次，
    // 共享一次在途请求而不是各发一次完整递归树。
    const inflight = repoTreeInflight.get(key);
    if (inflight) return inflight;

    const request = (async () => {
      const data = await GithubApi.request(
        `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/tree?branch=${encodeURIComponent(disk.branch || 'main')}`
      );
      disk.head = data.head;
      const entry = {
        head: data.head,
        treeSha: data.treeSha,
        updatedAt: data.updatedAt || null,
        tree: data.tree || [],
        byPath: buildTreeByPath(data.tree || []),
      };
      repoTreeCache.set(key, entry);
      return entry;
    })().finally(() => {
      repoTreeInflight.delete(key);
    });
    repoTreeInflight.set(key, request);
    return request;
  }

  /**
   * Full recursive tree of the current branch HEAD.
   * 结果按 disk+branch 缓存，写操作改变 head 后自动失配回源；
   * `force: true` 时跳过缓存（轮询确认远端状态时使用）。
   */
  async function getRepoTree(disk, { force = false } = {}) {
    const state = await getRepoTreeState(disk, { force });
    return state.tree;
  }

  /** diskId 版本的树读取，供 UI 层（如 README 视图）使用。 */
  async function getRepoTreeById(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    return getRepoTree(disk);
  }

  async function listHistory(diskId) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const data = await GithubApi.request(
      `/api/repos/${encodeURIComponent(disk.owner)}/${encodeURIComponent(disk.repo)}/history?branch=${encodeURIComponent(disk.branch || 'main')}`
    );
    return data.commits || [];
  }

  async function listFiles(diskId, parentId = ROOT_ID) {
    const disk = getDisk(diskId);
    if (!disk) throw new Error('找不到 GitHub 存储');
    const treeState = await getRepoTreeState(disk);
    const tree = treeState.tree;
    const base = normalizePath(parentId);
    const dateFormatted = formatDate(treeState.updatedAt);
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
            dateFormatted,
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
            dateFormatted,
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
        dateFormatted,
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

  /**
   * 单文件的元数据。
   *
   * 默认走树缓存（打开文件/属性面板前通常刚读过同一棵树，可省一次完整递归树）；
   * 「远端是否已出现/已消失」的确认轮询必须传 `{ force: true }` 看最新状态。
   * 返回 `updatedAt` 供调用方复用，避免再单独请求一次分支。
   */
  async function getFileContentMeta(disk, path, { force = false } = {}) {
    const treeState = await getRepoTreeState(disk, { force });
    const tree = treeState.tree;
    const indexed = treeState.byPath?.get(path);
    const entry = indexed?.type === 'blob' ? indexed : tree.find((item) => item.type === 'blob' && item.path === path);
    const updatedAt = treeState.updatedAt || null;
    if (!entry) {
      const isDirectory = indexed?.type === 'tree'
        || tree.some((item) => item.path.startsWith(`${path}/`));
      if (isDirectory) return { type: 'dir', path, name: path.split('/').pop() || path, updatedAt };
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
      updatedAt,
    };
  }

  function assertUploadSize(bytes) {
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new Error(`GitHub 存储支持的单文件大小上限为 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
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

  /**
   * 多文件上传：**一次 Tree + 一次 Commit**（AGENTS.md §3 Batch）。
   *
   * 单个文件仍走 createFileFromBlob（保留 pending 行与进度反馈）；只有多选上传
   * 走这里 —— 之前是一个文件一次 commit，100 个文件就是 100 个 commit。
   *
   * 命名冲突沿用 "(copy)" 规则自动改名而**不覆盖**同名文件；批量为空也返回结果，
   * 失败的文件通过 `failures` 如实上报，不静默吞掉（AGENTS.md §25）。
   */
  async function createFilesFromBlobs(diskId, parentId, files) {
    const disk = await requireDisk(diskId);
    const parentPath = normalizePath(parentId);
    const tree = await getRepoTree(disk);
    const taken = new Set();
    const operations = [];
    const failures = [];

    for (const file of files) {
      try {
        const name = file.name;
        const mimeType = file.type || inferMimeType(name);
        const target = parentPath ? `${parentPath}/${name}` : name;
        const uniquePath = GithubPaths.makeUniquePath(tree, target, taken);
        taken.add(uniquePath);
        const content = isTextFileMime(mimeType, name)
          ? await file.text()
          : new Uint8Array(await file.arrayBuffer());
        if (content instanceof Uint8Array) assertUploadSize(content);
        operations.push({ type: 'create', path: uniquePath, content });
      } catch (err) {
        failures.push({ name: file.name, message: err?.message || String(err) });
      }
    }

    if (!operations.length) return { created: 0, failures };
    const result = await executeOperations(
      diskId,
      operations,
      `Upload ${operations.length} file${operations.length === 1 ? '' : 's'}`
    );
    return { created: operations.length, failures, head: result?.head || disk.head };
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
    // getFileContentMeta 只返回 type/name/path/sha/size/updatedAt，从不返回
    // encoding/content，因此原先「base64 分支」永远不会命中（已删除）。
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

  async function restoreFile(_diskId, _fileId) {
    throw new Error('GitHub 存储不支持从回收站恢复');
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
    // 一次树读取同时拿到 meta 与 updatedAt：之前这里在读 meta 之后又
    // getRepoTreeState(force) 拉了一次完整递归树，只为取 Modified。
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
      ['Modified', formatDate(meta.updatedAt)],
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
    return isTextFileMime(file?.mimeType, file?.name);
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
        // 深链解析可能在文件刚由其他设备创建后立刻发生，重试必须看最新远端状态，
        // 因此逐次 force；updatedAt 直接从同一个 meta 里取，不再单独拉一次分支。
        const meta = await getFileContentMeta(disk, path, { force: true });
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
          dateFormatted: formatDate(meta.updatedAt),
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
    listHistory,
    listFiles,
    createFolder,
    createFile,
    createFileFromBlob,
    createFilesFromBlobs,
    replaceFile,
    isDuplicateNameError,
    makeUniqueSiblingName,
    isTextFileMime,
    inferMimeType,
    renameFile,
    restoreFile,
    deleteFile,
    executeBatch,
    buildBatchCopyOperations,
    buildBatchMoveOperations,
    isConflictError,
    getTextFileContent,
    getRepoTreeById,
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
