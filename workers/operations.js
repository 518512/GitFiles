import { ApiError } from './http.js';
import { branchState, githubRequest, repoPrefix } from './github.js';

const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_BLOB_CONCURRENCY = 8;
const MAX_LAZY_DIRECTORIES = 2000;

function pathOf(value) {
  if (!value || typeof value !== 'string') throw new ApiError(422, 'validation_error', 'A repository path is required');
  // Unicode normalize as NFC so the same visible name always maps to one Git
  // path. macOS/NAS uploads arrive as NFD while Git usually stores NFC;
  // without this the two forms become distinct files (AGENTS.md §24).
  const path = value.normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!path || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ApiError(422, 'validation_error', `Invalid repository path: ${value}`);
  }
  return path;
}

function isUnder(path, parent) {
  return path === parent || path.startsWith(`${parent}/`);
}

function typeOf(operation) {
  const type = operation?.type;
  if (!['create', 'update', 'upload', 'mkdir', 'delete', 'rename', 'move', 'copy'].includes(type)) {
    throw new ApiError(422, 'validation_error', `Unsupported operation type: ${type}`);
  }
  return type;
}

const CONTENT_ENCODINGS = new Set(['utf-8', 'base64']);

function operationOf(raw) {
  const type = typeOf(raw);
  if (['create', 'update', 'upload'].includes(type)) {
    if (!Object.hasOwn(raw, 'content')) throw new ApiError(422, 'validation_error', `${type} requires content`);
    // encoding 省略时按 utf-8 处理（历史行为，纯文本客户端不受影响）。
    // base64 供二进制使用：客户端不必把 Uint8Array 展开成数字数组再 JSON 化
    // （那是约 3.6 倍体积、且会产生上千万元素的数组）。
    const encoding = raw.encoding == null ? 'utf-8' : String(raw.encoding).toLowerCase();
    if (!CONTENT_ENCODINGS.has(encoding)) {
      throw new ApiError(422, 'validation_error', `Unsupported content encoding: ${raw.encoding}`);
    }
    return { type, path: pathOf(raw.path), content: raw.content, encoding };
  }
  if (type === 'mkdir' || type === 'delete') return { type, path: pathOf(raw.path) };
  const from = pathOf(raw.from || raw.path);
  const to = pathOf(raw.to || raw.targetPath);
  return { type, from, to };
}

/**
 * 校验客户端已编码好的 base64 内容。
 *
 * 严格校验字符集与长度，并按解码后的字节数执行 25MB 上限
 * ——否则一个超长字符串会先被送进 GitHub 才失败（AGENTS.md §25）。
 */
function validateBase64(content) {
  if (typeof content !== 'string') {
    throw new ApiError(422, 'validation_error', 'Base64 content must be a string');
  }
  const normalized = content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new ApiError(422, 'validation_error', 'Content is not valid base64');
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const size = (normalized.length / 4) * 3 - padding;
  if (size > MAX_BINARY_BYTES) {
    throw new ApiError(422, 'validation_error', `File content must be no larger than ${Math.floor(MAX_BINARY_BYTES / (1024 * 1024))} MB`);
  }
  return normalized;
}

function encodeContent(content, encoding = 'utf-8') {
  if (encoding === 'base64') return validateBase64(content);
  if (typeof content === 'string') {
    // TextEncoder replaces the legacy btoa(unescape(encodeURIComponent(...)))
    // chain, which threw URIError (and therefore a 500) on any lone surrogate.
    // TextEncoder alone would silently substitute U+FFFD, which would commit
    // corrupted bytes, so reject unpaired surrogates explicitly (AGENTS.md §25).
    if (hasLoneSurrogate(content)) {
      throw new ApiError(422, 'validation_error', 'File content contains invalid UTF-16 (unpaired surrogate)');
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > MAX_BINARY_BYTES) {
      throw new ApiError(422, 'validation_error', 'File content must be no larger than 25 MB');
    }
    return bytesToBase64(bytes);
  }
  if (!Array.isArray(content) || content.length > MAX_BINARY_BYTES) {
    throw new ApiError(422, 'validation_error', 'File content must be a string or byte array up to 25 MB');
  }
  let encoded = '';
  for (let offset = 0; offset < content.length; offset += 0x8000) {
    const chunk = content.slice(offset, offset + 0x8000);
    if (chunk.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new ApiError(422, 'validation_error', 'Byte array must contain integers from 0 to 255');
    }
    encoded += String.fromCharCode(...chunk);
  }
  return btoa(encoded);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** True when the string contains a UTF-16 surrogate that is not part of a pair. */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Dedupe key for a pending blob; keeps identical content to a single upload.
 *
 * · utf-8 字符串按内容精确分组；
 * · base64 字符串同样按内容精确分组（值本身已是字符串，不会额外放大）；
 * · 字节数组**只按长度分组**：`join(',')` 会为 25MB 的数组造出上百 MB 的临时
 *   字符串（Worker 内存上限约 128MB）。长度相同但内容不同的情况由 applyOperations
 *   里的 `sameContent` 复核后另起分组，因此不会把两份不同内容合并成同一个 Blob。
 */
function contentKeyOf(content, encoding = 'utf-8') {
  if (typeof content !== 'string') return `bytes:${content.length}`;
  return encoding === 'base64' ? `base64:${content}` : `text:${content}`;
}

async function createBlob(session, owner, repo, content, encoding = 'utf-8') {
  const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: encodeContent(content, encoding), encoding: 'base64' }),
  });
  return payload.sha;
}

async function fetchTree(session, owner, repo, sha) {
  const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
  return payload;
}

/**
 * Read a commit's tree into a flat blob/submodule index.
 *
 * GitHub truncates the recursive tree endpoint at ~100k entries / ~7 MB (and on
 * recursive depth). Rather than refusing to write at all, fall back to walking
 * subtrees directory-by-directory so large repositories stay editable
 * (AGENTS.md §27: avoid blocking legitimate work).
 */
async function readTreeIndex(session, owner, repo, head) {
  const root = await fetchTree(session, owner, repo, head);
  const entries = new Map();
  const addBlobs = (texts) => {
    for (const entry of texts) {
      if (entry.type !== 'blob' && entry.type !== 'commit') continue;
      entries.set(entry.path, {
        path: entry.path,
        mode: entry.mode || (entry.type === 'commit' ? '160000' : '100644'),
        type: entry.type,
        sha: entry.sha,
      });
    }
  };
  if (!root?.truncated) {
    addBlobs(root.tree || []);
    return { treeSha: root?.sha || null, index: entries };
  }

  const queue = [];
  let directories = 0;
  for (const entry of root.tree || []) {
    if (entry.type === 'tree') queue.push({ path: entry.path, sha: entry.sha });
    else addBlobs([entry]);
  }
  while (queue.length) {
    if (directories++ > MAX_LAZY_DIRECTORIES) {
      throw new ApiError(422, 'validation_error', 'Repository has too many directories for a safe mutation; no changes were made');
    }
    const dir = queue.shift();
    const payload = await fetchTree(session, owner, repo, dir.sha);
    for (const entry of payload.tree || []) {
      // The non-recursive tree endpoint returns `name`; be tolerant of `path`
      // so both shapes produce a correct nested path.
      const name = entry.name || entry.path;
      if (!name) continue;
      const path = `${dir.path}/${name}`;
      if (entry.type === 'tree') queue.push({ path, sha: entry.sha });
      else if (entry.type === 'blob' || entry.type === 'commit') {
        entries.set(path, {
          path,
          mode: entry.mode || (entry.type === 'commit' ? '160000' : '100644'),
          type: entry.type,
          sha: entry.sha,
        });
      }
    }
  }
  return { treeSha: root?.sha || null, index: entries };
}

/** Every ancestor prefix of a path: "a/b/c" → {"a", "a/b"}. */
function ancestorPrefixes(path) {
  const parts = path.split('/');
  const prefixes = [];
  for (let index = 1; index < parts.length; index += 1) prefixes.push(parts.slice(0, index).join('/'));
  return prefixes;
}

/**
 * 内容是否完全相同。
 *
 * 字节数组的去重键只带长度（见 contentKeyOf），因此合并到同一分组前必须复核，
 * 否则「长度相同、内容不同」的两个文件会共享同一个 Blob SHA —— 数据损坏。
 */
function sameContent(left, right) {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Apply the logical operation list to the tree index in memory.
 *
 * 派生结构（NFC 路径表、目录前缀计数）是**增量维护**的。早先版本每执行一个
 * 操作就 `buildPrefixIndex` + 重建两个 Map/Set，一次 1000 条操作的批处理会做
 * 1000 次 O(条目数) 的全量重建，在 Worker 的 CPU 预算里非常昂贵（AGENTS.md §27）。
 *
 * Mutates and returns `index` (path → entry). Returns the set of paths that
 * disappeared from the tree so the caller can report a truthful no-op instead
 * of a silent success (AGENTS.md §25: no fake success).
 */
function applyOperations(entries, rawOperations) {
  const index = new Map(entries);
  const deleted = new Set();
  const operations = rawOperations.map(operationOf);

  // Operations arrive NFC-normalized (see pathOf). Repositories written before
  // that change may still hold NFD paths, so match and split on the NFC form
  // while always emitting the real stored path.
  const nfcPaths = new Map();
  // 某个 NFC 路径被多少条目占用（自身 + 作为其祖先）。计数 > 0 等价于旧实现
  // 的 `nfcPrefixes.has()`，但删除时只需递减，不必全量重建。
  const prefixCount = new Map();

  const addDerived = (path) => {
    const nfc = path.normalize('NFC');
    nfcPaths.set(nfc, path);
    prefixCount.set(nfc, (prefixCount.get(nfc) || 0) + 1);
    for (const prefix of ancestorPrefixes(nfc)) {
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  };

  const removeDerived = (path) => {
    const nfc = path.normalize('NFC');
    if (nfcPaths.get(nfc) === path) nfcPaths.delete(nfc);
    const decrement = (prefix) => {
      const next = (prefixCount.get(prefix) || 0) - 1;
      if (next > 0) prefixCount.set(prefix, next);
      else prefixCount.delete(prefix);
    };
    decrement(nfc);
    for (const prefix of ancestorPrefixes(nfc)) decrement(prefix);
  };

  for (const path of index.keys()) addDerived(path);

  const occupied = (nfcPath) => (prefixCount.get(nfcPath) || 0) > 0;
  // 条目（blob / gitlink）才有 nfcPaths 记录；目录在前缀计数里，但不是条目。
  const isEntry = (nfcPath) => nfcPaths.has(nfcPath);
  /**
   * 目标路径是否已被占用。
   *
   * 关键区别：**祖先仅仅作为"目录前缀"存在不构成冲突**——往已存在的
   * `docs/` 里新建 `docs/a.md` 是正常操作。只有某个祖先是**条目（文件/子模块）**
   * 时才不能落在它下面。
   *
   * 早先的实现对祖先一律查"前缀集合"，于是「在已存在的目录里新建或重命名文件」
   * 全部被 422 拒绝（`docs/new.md`、`docs/a.md → docs/b.md` 都失败），
   * 只有新建顶层文件或写进一个**全新**目录才能成功。
   */
  const taken = (path) => {
    const nfc = path.normalize('NFC');
    if (occupied(nfc)) return true;
    return ancestorPrefixes(nfc).some(isEntry);
  };
  const setEntry = (path, entry) => {
    if (!index.has(path)) addDerived(path);
    index.set(path, entry);
  };
  const removeEntry = (path) => {
    if (!index.has(path)) return;
    index.delete(path);
    removeDerived(path);
  };

  for (const op of operations) {
    if (op.type === 'create') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      setEntry(op.path, { path: op.path, mode: '100644', type: 'blob', deferred: op.content, deferredEncoding: op.encoding });
    } else if (op.type === 'update' || op.type === 'upload') {
      const target = nfcPaths.get(op.path.normalize('NFC'));
      if (!target || index.get(target).type !== 'blob') {
        throw new ApiError(422, 'validation_error', `File not found: ${op.path}`);
      }
      // 路径不变，派生结构无需改动。
      index.set(target, { path: target, mode: '100644', type: 'blob', deferred: op.content, deferredEncoding: op.encoding });
    } else if (op.type === 'mkdir') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      const keepPath = `${op.path}/.keep`;
      setEntry(keepPath, { path: keepPath, mode: '100644', type: 'blob', deferred: '', deferredEncoding: 'utf-8' });
    } else if (op.type === 'delete') {
      // Match on the NFC form so a path typed in NFC also removes a stored NFD
      // path. Fall back to the raw path so an exactly-matching NFD delete still
      // works even if normalization ever changes the string.
      const forms = [op.path, nfcPaths.get(op.path.normalize('NFC'))]
        .filter(Boolean)
        .map((form) => form.normalize('NFC'));
      let removed = 0;
      for (const entry of [...index.values()]) {
        const stored = entry.path.normalize('NFC');
        if (forms.some((form) => isUnder(stored, form))) {
          removeEntry(entry.path);
          removed += 1;
        }
      }
      // Deleting a path that was never there is a no-op; surface it so callers
      // can tell the user the remote already lacked it (AGENTS.md §25).
      if (removed === 0) deleted.add(op.path);
    } else if (op.type === 'rename' || op.type === 'move' || op.type === 'copy') {
      if (op.type !== 'copy' && op.from === op.to) continue;
      if (isUnder(op.to, op.from)) {
        throw new ApiError(422, 'validation_error', `Cannot ${op.type} a path into itself`);
      }
      if (taken(op.to)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.to}`);
      const from = op.from.normalize('NFC');
      const affected = [...index.values()].filter((entry) => isUnder(entry.path.normalize('NFC'), from));
      if (!affected.length) throw new ApiError(422, 'validation_error', `Path not found: ${op.from}`);
      const consumed = new Set();
      for (const entry of affected) {
        const storedNfc = entry.path.normalize('NFC');
        const suffix = storedNfc.slice(from.length).replace(/^\//, '');
        const nextPath = suffix ? `${op.to}/${suffix}` : op.to;
        consumed.add(entry.path);
        // copy keeps the source entry and adds the new one
        setEntry(nextPath, { ...entry, path: nextPath });
      }
      if (op.type !== 'copy') for (const path of consumed) removeEntry(path);
    }
  }

  const pending = new Map();
  for (const entry of index.values()) {
    if (!Object.hasOwn(entry, 'deferred')) continue;
    const encoding = entry.deferredEncoding || 'utf-8';
    const key = contentKeyOf(entry.deferred, encoding);
    let group = pending.get(key);
    // 字节数组的 key 只带长度；同长度但内容不同时必须另起分组，
    // 绝不能共享 Blob（否则写进仓库的是另一份内容）。
    if (group && !sameContent(group.content, entry.deferred)) {
      let ordinal = 1;
      let altKey = `${key}#${ordinal}`;
      while (pending.has(altKey) && !sameContent(pending.get(altKey).content, entry.deferred)) {
        ordinal += 1;
        altKey = `${key}#${ordinal}`;
      }
      group = pending.get(altKey);
      if (!group) {
        group = { content: entry.deferred, encoding, entries: [] };
        pending.set(altKey, group);
      }
    } else if (!group) {
      group = { content: entry.deferred, encoding, entries: [] };
      pending.set(key, group);
    }
    group.entries.push(entry);
  }
  return { index, pending, deleted };
}

/**
 * Upload every distinct pending blob, then stamp its SHA onto all entries that
 * share the content. Bounded parallelism keeps large batches inside the Worker
 * CPU/wall-clock budget without tripping GitHub's secondary rate limits.
 */
async function createBlobs(session, owner, repo, pending) {
  const groups = [...pending.values()];
  const failures = [];
  let cursor = 0;
  let created = 0;
  const workers = Array.from({ length: Math.min(MAX_BLOB_CONCURRENCY, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor];
      cursor += 1;
      try {
        const sha = await createBlob(session, owner, repo, group.content, group.encoding || 'utf-8');
        created += 1;
        for (const entry of group.entries) {
          entry.sha = sha;
          delete entry.deferred;
          delete entry.deferredEncoding;
        }
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length) throw failures[0];
  return { created, total: groups.length };
}

/** 内容是否为空（空字符串 / 空字节数组）。空 base64 也是空字符串。 */
function isEmptyContent(content) {
  if (typeof content === 'string') return content === '';
  return Array.isArray(content) && content.length === 0;
}

function sameTree(before, after) {
  if (before.size !== after.size) return false;
  for (const [path, entry] of before) {
    const next = after.get(path);
    if (!next) return false;
    if (entry.sha !== next.sha) return false;
    if ((entry.mode || '100644') !== (next.mode || '100644')) return false;
  }
  return true;
}

export async function executeOperations(session, owner, repo, { branch, expectedHead, operations, message }) {
  const state = await branchState(session, owner, repo, branch);
  if (!state && expectedHead) {
    throw new ApiError(409, 'conflict', 'Branch no longer exists', { expectedHead, remoteHead: null });
  }
  if (state && state.head !== expectedHead) {
    throw new ApiError(409, 'conflict', 'Branch HEAD changed before the operation started', { expectedHead, remoteHead: state.head });
  }
  const current = state
    ? await readTreeIndex(session, owner, repo, state.head)
    : { treeSha: null, index: new Map() };
  const { index, pending, deleted: missingPaths } = applyOperations(current.index, operations);

  // 空内容直接复用 Git 的著名空 Blob（SHA 由内容唯一决定，是全局常量）。
  // 前提是它确实存在于当前仓库 —— 否则 GitHub 建 tree 时引用一个不存在的
  // blob。第一次 mkdir 仍会正常上传一次空的 .keep，之后所有空文件都免费。
  const knownShas = new Set();
  for (const entry of current.index.values()) knownShas.add(entry.sha);
  if (knownShas.has(EMPTY_BLOB_SHA)) {
    for (const [key, group] of [...pending]) {
      if (!isEmptyContent(group.content)) continue;
      for (const entry of group.entries) {
        entry.sha = EMPTY_BLOB_SHA;
        delete entry.deferred;
        delete entry.deferredEncoding;
      }
      pending.delete(key);
    }
  }

  if (state && sameTree(current.index, index)) {
    return {
      head: state.head,
      treeSha: current.treeSha || state.treeSha,
      blobsCreated: 0,
      skipped: true,
      // Delete targets that matched nothing: the remote already lacked them.
      missingPaths: [...missingPaths],
    };
  }

  const { created } = await createBlobs(session, owner, repo, pending);
  const entries = [...index.values()].sort((a, b) => a.path.localeCompare(b.path));
  // `entries` is the complete post-operation snapshot. Do not attach
  // `base_tree`: GitHub treats a tree with base_tree as a patch, so omitted
  // paths are retained. That made delete a no-op and rename/move keep the old
  // path. Creating a root tree from the complete snapshot gives deletions the
  // intended semantics while still reusing every unchanged Blob SHA.
  const treeBody = { tree: entries };
  const { payload: tree } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/trees`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(treeBody),
  });
  const { payload: commit } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/commits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message || 'Batch file operations', tree: tree.sha, parents: state ? [state.head] : [] }),
  });
  if (state) {
    await githubRequest(session, `${repoPrefix(owner, repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } else {
    try {
      await githubRequest(session, `${repoPrefix(owner, repo)}/git/refs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
        const remote = await branchState(session, owner, repo, branch);
        throw new ApiError(409, 'conflict', 'Branch was created by another device', { expectedHead: null, remoteHead: remote?.head || null });
      }
      throw error;
    }
  }
  return { head: commit.sha, treeSha: tree.sha, blobsCreated: created, entryCount: entries.length, skipped: false };
}
