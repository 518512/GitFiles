/**
 * GithubOperations — Git Data operation engine.
 *
 * Pure planner (`applyOperations`) rewrites tree entries in memory:
 *   create / update / upload / mkdir / delete / rename / move / copy
 * Move/Rename/Copy reuse the original blob SHAs (no download→upload),
 * Delete rewrites paths to nothing, and a whole logical batch collapses
 * into ONE tree + ONE commit (PROJECT_SPEC §2/§3/§11).
 *
 * `executeCommitPipeline` implements the Mutation Pipeline (§6):
 *   read HEAD → read tree → apply ops in memory → create blobs →
 *   create tree → create commit → CAS ref update → new HEAD.
 * The ref update never uses force, so a remote change between read and
 * write raises `ConflictError` (409 semantics, PROJECT_SPEC §4).
 *
 * Plain browser global: `GithubOperations`. Dependency-injected, so the pure
 * parts are unit-testable in Node without network access.
 */
(function registerGithubOperations(global) {
  'use strict';

  const { EMPTY_BLOB_SHA } = global.GithubBlob;
  const { ConflictError } = global.GithubReference;

  const FOLDER_KEEP = '.keep';

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  function normalizePath(path) {
    if (!path || path === 'root') return '';
    const normalized = String(path).replace(/^\/+|\/+$/g, '');
    if (!normalized) return '';
    if (normalized.includes('\0') || normalized.split('/').some((segment) => (
      !segment || segment === '.' || segment === '..'
    ))) {
      throw new ValidationError(`Invalid repository path: ${String(path)}`);
    }
    return normalized;
  }

  function getParentPath(path) {
    const p = normalizePath(path);
    if (!p) return '';
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  }

  function getBaseName(path) {
    const p = normalizePath(path);
    if (!p) return '';
    return p.split('/').pop() || p;
  }

  function joinPath(parent, name) {
    const p = normalizePath(parent);
    return p ? `${p}/${name}` : name;
  }

  function isInsidePath(child, ancestor) {
    const c = normalizePath(child);
    const a = normalizePath(ancestor);
    if (!a || !c) return false;
    return c === a || c.startsWith(`${a}/`);
  }

  function isFolderInTree(entries, path) {
    const p = normalizePath(path);
    if (!p) return entries.length > 0;
    return entries.some((entry) => {
      const entryPath = entry.path || '';
      return entryPath === p
        || entryPath === `${p}/${FOLDER_KEEP}`
        || entryPath.startsWith(`${p}/`);
    });
  }

  /** Strict: true only when the path behaves like a directory (not a file blob). */
  function isFolderPath(entries, path) {
    const p = normalizePath(path);
    if (!p) return entries.length > 0;
    const isSelfBlob = entries.some((entry) => entry.type === 'blob' && entry.path === p);
    return !isSelfBlob && isFolderInTree(entries, p);
  }

  function isPathVisible(entries, path, isFolder) {
    const p = normalizePath(path);
    if (!p) return false;
    if (isFolder) return isFolderInTree(entries, p);
    return entries.some((entry) => entry.type === 'blob' && entry.path === p);
  }

  function collectDescendants(entries, path) {
    const p = normalizePath(path);
    if (!p) return entries.slice();
    return entries.filter((entry) => isInsidePath(entry.path, p));
  }

  function collectBlobPaths(entries, path) {
    return collectDescendants(entries, path)
      .filter((entry) => entry.type === 'blob')
      .map((entry) => entry.path);
  }

  function hasDescendantBlobs(entries, path) {
    const p = normalizePath(path);
    if (!p) return entries.some((entry) => entry.type === 'blob');
    return entries.some((entry) => entry.type === 'blob' && isInsidePath(entry.path, p));
  }

  /**
   * Find a target path that does not collide with existing entries or
   * previously taken names. Mirrors the historical "(copy)" naming.
   */
  function makeUniquePath(entries, path, takenPaths) {
    const taken = takenPaths instanceof Set ? takenPaths : null;
    const exists = (candidate) => {
      if (isPathVisible(entries, candidate, false) || isFolderInTree(entries, candidate)) return true;
      if (taken && taken.has(candidate)) return true;
      return false;
    };
    if (!exists(path)) return path;
    const parent = getParentPath(path);
    const name = getBaseName(path);
    const match = name.match(/^(.*?)(\.[^.]+)?$/);
    const stem = match && match[1] ? match[1] : name;
    const ext = match && match[2] ? match[2] : '';
    let candidate = joinPath(parent, `${stem} (copy)${ext}`);
    let counter = 2;
    while (exists(candidate)) {
      candidate = joinPath(parent, `${stem} (copy ${counter})${ext}`);
      counter += 1;
    }
    if (taken) taken.add(candidate);
    return candidate;
  }

  // ---------------------------------------------------------------------------
  // Operation normalization + validation
  // ---------------------------------------------------------------------------

  const OPERATION_TYPES = new Set([
    'create', 'update', 'upload', 'mkdir', 'delete', 'rename', 'move', 'copy',
  ]);

  function normalizeOperation(op) {
    if (!op || typeof op !== 'object') {
      throw new Error('Invalid operation: expected an object');
    }
    const type = op.type;
    if (!OPERATION_TYPES.has(type)) {
      throw new Error(`Invalid operation type: ${type}`);
    }
    switch (type) {
      case 'create':
      case 'update':
      case 'upload': {
        const path = normalizePath(op.path);
        if (!path) throw new Error(`${type}: path is required`);
        if (op.content == null) throw new Error(`${type}: content is required for ${path}`);
        return { type, path, content: op.content };
      }
      case 'mkdir': {
        const path = normalizePath(op.path);
        if (!path) throw new Error('mkdir: path is required');
        return { type, path };
      }
      case 'delete': {
        const path = normalizePath(op.path);
        if (!path) throw new Error('delete: path is required');
        return { type, path };
      }
      case 'rename':
      case 'move': {
        const from = normalizePath(op.from || op.path);
        const to = normalizePath(op.to || op.targetPath);
        if (!from || !to) throw new Error(`${type}: "from" and "to" are required`);
        return { type, from, to };
      }
      case 'copy': {
        const from = normalizePath(op.from);
        const to = normalizePath(op.to);
        if (!from || !to) throw new Error('copy: "from" and "to" are required');
        return { type, from, to };
      }
      default:
        throw new Error(`Invalid operation type: ${type}`);
    }
  }

  function normalizeOperations(operations) {
    if (!Array.isArray(operations) || !operations.length) {
      throw new Error('operations must be a non-empty array');
    }
    return operations.map(normalizeOperation);
  }

  class ValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ValidationError';
    }
  }

  function buildIndex(entries) {
    const index = new Map();
    (entries || []).forEach((entry) => {
      if (entry && entry.path) index.set(entry.path, entry);
    });
    return index;
  }

  function assertNoRenameIntoSelf(op) {
    if (isInsidePath(op.to, op.from) && op.to !== op.from) {
      throw new ValidationError(`Cannot move "${op.from}" into itself ("${op.to}")`);
    }
  }

  // ---------------------------------------------------------------------------
  // Pure planner: apply operations to a tree entry list
  // ---------------------------------------------------------------------------

  /**
   * Apply operations to `entries` (recursive tree entries) and produce the new
   * full blob entry list.
   *
   * Semantics are STRICTLY SEQUENTIAL: each operation sees the tree produced by
   * the previous one, and validation happens at the moment the operation is
   * applied (a copy of a file renamed earlier in the same batch correctly
   * fails with "not found").
   *
   * Blobs are created lazily: create/update/mkdir record deferred content, and
   * copies/moves made later in the same batch of a just-created/updated file
   * share that single deferred blob (no duplicate upload).
   *
   * @param {object} ctx
   *   entries:     current tree entries (from /git/trees?recursive=1)
   *   operations:  array of raw operations
   *   createBlob:  async ({path, content}) => sha   (only called for new content)
   * @returns {Promise<{entries: Array, changed: boolean, applied: number, blobsCreated: number}>}
   */
  async function applyOperations(ctx) {
    const operations = normalizeOperations(ctx.operations);
    const index = buildIndex(ctx.entries); // path -> {path, mode, type, sha, pendingRef?}
    const deferredCreates = []; // { content, shaPromise? }
    const pendingByPath = new Map(); // path -> deferred item (placeholder blob)
    let blobsCreated = 0;

    const hasEntryAtOrUnder = (p) => {
      for (const entry of index.values()) {
        if (entry.path === p || entry.path.startsWith(`${p}/`)) return true;
      }
      return false;
    };
    const isTaken = (p) => index.has(p) || hasEntryAtOrUnder(p);

    function cloneEntry(entry, newPath) {
      return {
        path: newPath,
        mode: entry.mode || '100644',
        type: entry.type,
        sha: entry.sha || null,
        pendingRef: entry.pendingRef || null,
      };
    }

    function rewriteSubtree(from, to, { keepSource = false } = {}) {
      const affected = [];
      for (const entry of index.values()) {
        if (isInsidePath(entry.path, from)) {
          const relative = entry.path.slice(from.length).replace(/^\/+/, '');
          affected.push({ entry, newPath: relative ? `${to}/${relative}` : to });
        }
      }
      affected.forEach(({ entry, newPath }) => {
        if (!keepSource) index.delete(entry.path);
        index.set(newPath, cloneEntry(entry, newPath));
      });
      return affected.length;
    }

    function registerDeferred(content, path) {
      const item = { content, shaPromise: null, used: true };
      deferredCreates.push(item);
      pendingByPath.set(path, item);
      return item;
    }

    for (const op of operations) {
      switch (op.type) {
        case 'create': {
          if (isTaken(op.path)) {
            throw new ValidationError(`Path already exists: ${op.path}`);
          }
          const item = registerDeferred(op.content, op.path);
          index.set(op.path, { path: op.path, mode: '100644', type: 'blob', sha: null, pendingRef: item });
          break;
        }
        case 'update':
        case 'upload': {
          const existing = index.get(op.path);
          if (!existing || existing.type !== 'blob') {
            throw new ValidationError(`File not found on GitHub: ${op.path}`);
          }
          const item = registerDeferred(op.content, op.path);
          index.set(op.path, { path: op.path, mode: '100644', type: 'blob', sha: null, pendingRef: item });
          break;
        }
        case 'mkdir': {
          if (isTaken(op.path)) {
            throw new ValidationError(`Path already exists: ${op.path}`);
          }
          const keepPath = `${op.path}/${FOLDER_KEEP}`;
          const item = registerDeferred('', keepPath);
          index.set(keepPath, { path: keepPath, mode: '100644', type: 'blob', sha: null, pendingRef: item });
          break;
        }
        case 'delete': {
          // Idempotent: deleting a path that is already gone is a no-op.
          for (const entry of [...index.values()]) {
            if (entry.path === op.path || entry.path.startsWith(`${op.path}/`)) {
              index.delete(entry.path);
            }
          }
          break;
        }
        case 'rename':
        case 'move': {
          assertNoRenameIntoSelf(op);
          if (op.from !== op.to && isTaken(op.to)) {
            throw new ValidationError(`Path already exists: ${op.to}`);
          }
          if (!hasEntryAtOrUnder(op.from)) {
            throw new ValidationError(`Path not found on GitHub: ${op.from}`);
          }
          rewriteSubtree(op.from, op.to);
          break;
        }
        case 'copy': {
          if (isInsidePath(op.to, op.from)) {
            throw new ValidationError(`Cannot copy "${op.from}" into itself ("${op.to}")`);
          }
          if (isTaken(op.to)) {
            throw new ValidationError(`Path already exists: ${op.to}`);
          }
          if (!hasEntryAtOrUnder(op.from)) {
            throw new ValidationError(`Path not found on GitHub: ${op.from}`);
          }
          const copied = rewriteSubtree(op.from, op.to, { keepSource: true });
          if (!copied && isFolderPath([...index.values()], op.from)) {
            // Empty folder: mirror it with a .keep marker (deferred empty blob).
            const keepPath = `${op.to}/${FOLDER_KEEP}`;
            const item = registerDeferred('', keepPath);
            index.set(keepPath, { path: keepPath, mode: '100644', type: 'blob', sha: null, pendingRef: item });
          }
          break;
        }
        default:
          throw new ValidationError(`Invalid operation type: ${op.type}`);
      }
    }

    // Create blobs for deferred content that is still referenced.
    const usedRefs = new Set();
    for (const entry of index.values()) {
      if (entry.type === 'blob' && entry.pendingRef) usedRefs.add(entry.pendingRef);
    }

    let emptyBlobPromise = null;
    async function resolveDeferred(item) {
      const isEmpty = item.content === ''
        || (item.content && item.content.byteLength === 0);
      if (isEmpty) {
        // The empty blob is content-addressed; reuse the well-known sha when it
        // already exists in the repo, otherwise upload it once per batch.
        const emptyExists = [...index.values()].some(
          (entry) => entry.type === 'blob' && entry.sha === EMPTY_BLOB_SHA
        );
        if (emptyExists) return EMPTY_BLOB_SHA;
        if (!emptyBlobPromise) {
          emptyBlobPromise = ctx.createBlob({ path: '(empty .keep)', content: '' });
          blobsCreated += 1;
        }
        return emptyBlobPromise;
      }
      const sha = await ctx.createBlob({ path: '(content)', content: item.content });
      blobsCreated += 1;
      return sha;
    }

    const shaByRef = new Map();
    for (const item of deferredCreates) {
      if (!usedRefs.has(item)) continue;
      shaByRef.set(item, await resolveDeferred(item));
    }

    const finalEntries = [...index.values()]
      .filter((entry) => entry.type === 'blob')
      .map((entry) => {
        const sha = entry.pendingRef ? shaByRef.get(entry.pendingRef) : entry.sha;
        return { path: entry.path, mode: entry.mode || '100644', type: 'blob', sha };
      })
      .filter((entry) => !!entry.sha)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const originalSorted = (ctx.entries || [])
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, sha: entry.sha }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const changed = finalEntries.length !== originalSorted.length
      || finalEntries.some((entry, i) => {
        const before = originalSorted[i];
        return !before || before.path !== entry.path || before.sha !== entry.sha;
      });

    return {
      entries: finalEntries,
      changed,
      applied: operations.length,
      blobsCreated,
    };
  }

  // ---------------------------------------------------------------------------
  // Keyed serial queue — prevents concurrent pipelines from racing each other
  // ---------------------------------------------------------------------------

  const queues = new Map();

  function runExclusive(key, fn) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(fn, fn);
    queues.set(key, next.catch(() => {}));
    return next;
  }

  // ---------------------------------------------------------------------------
  // Mutation Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Execute a logical batch of operations as ONE tree + ONE commit with CAS.
   *
   * @param {object} p
   *   owner, repo, branch, token
   *   message:    commit message
   *   operations: raw operations array
   *   expectedHead: optional client-observed head (informational; the CAS gate
   *                 is the non-forced ref update itself)
   * @returns {Promise<{head: string|null, skipped: boolean, blobsCreated: number}>}
   */
  async function executeCommitPipeline(p) {
    const operations = normalizeOperations(p.operations);
    return runExclusive(`${p.owner}/${p.repo}/${p.branch}`, async () => {
      const token = p.token;
      const state = await global.GithubRepository.getBranchState(p.owner, p.repo, p.branch, token);
      const parentHead = state ? state.head : null;

      if (p.expectedHead && parentHead && p.expectedHead !== parentHead) {
        throw new ConflictError(p.expectedHead, parentHead, 'Branch HEAD changed before the operation started.');
      }

      let tree;
      let treeSha = state ? state.treeSha : null;
      if (parentHead) {
        const treeState = await global.GithubTree.getTreeAt(p.owner, p.repo, p.branch, token, {
          head: parentHead,
          treeSha,
        });
        tree = treeState.tree;
        treeSha = treeState.treeSha;
      } else {
        tree = [];
      }

      const planned = await applyOperations({
        entries: tree,
        operations,
        createBlob: async ({ content }) => global.GithubBlob.createBlob({
          owner: p.owner,
          repo: p.repo,
          token,
          content,
        }),
      });

      if (!planned.changed) {
        return { head: parentHead, skipped: true, blobsCreated: 0 };
      }

      let commitSha;
      if (parentHead) {
        const result = await global.GithubCommit.createCommitOnHead({
          owner: p.owner,
          repo: p.repo,
          token,
          message: p.message,
          entries: planned.entries,
          baseTreeSha: treeSha,
          parentHead,
        });
        commitSha = result.commitSha;
      } else {
        // Empty repository: create the initial commit and the branch ref.
        const treeData = await global.GithubCommit.createTree({
          owner: p.owner,
          repo: p.repo,
          token,
          entries: planned.entries,
        });
        const commitData = await global.GithubCommit.createCommit({
          owner: p.owner,
          repo: p.repo,
          token,
          message: p.message,
          treeSha: treeData.sha,
          parents: [],
        });
        commitSha = commitData.sha;
        await global.GithubReference.createRefCas({
          owner: p.owner,
          repo: p.repo,
          branch: p.branch,
          token,
          expectedHead: null,
          newHead: commitSha,
        });
      }

      if (parentHead) {
        await global.GithubReference.updateRefCas({
          owner: p.owner,
          repo: p.repo,
          branch: p.branch,
          token,
          expectedHead: parentHead,
          newHead: commitSha,
        });
      }

      // Cache is keyed by head: publish the new index, drop the stale one.
      global.GithubTree.putCached(p.owner, p.repo, p.branch, commitSha, planned.entries, null);
      global.GithubTree.dropCached(p.owner, p.repo, p.branch, parentHead);

      return { head: commitSha, skipped: false, blobsCreated: planned.blobsCreated };
    });
  }

  global.GithubOperations = {
    ConflictError,
    ValidationError,
    FOLDER_KEEP,
    // pure helpers (shared with githubdisk.js + tests)
    normalizePath,
    getParentPath,
    getBaseName,
    joinPath,
    isInsidePath,
    isFolderInTree,
    isFolderPath,
    isPathVisible,
    collectDescendants,
    collectBlobPaths,
    hasDescendantBlobs,
    makeUniquePath,
    normalizeOperation,
    normalizeOperations,
    applyOperations,
    // executor
    executeCommitPipeline,
    runExclusive,
  };
})(typeof window !== 'undefined' ? window : globalThis);
