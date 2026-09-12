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

function operationOf(raw) {
  const type = typeOf(raw);
  if (['create', 'update', 'upload'].includes(type)) {
    if (!Object.hasOwn(raw, 'content')) throw new ApiError(422, 'validation_error', `${type} requires content`);
    return { type, path: pathOf(raw.path), content: raw.content };
  }
  if (type === 'mkdir' || type === 'delete') return { type, path: pathOf(raw.path) };
  const from = pathOf(raw.from || raw.path);
  const to = pathOf(raw.to || raw.targetPath);
  return { type, from, to };
}

function encodeContent(content) {
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

/** Dedupe key for a pending blob; keeps identical content to a single upload. */
function contentKeyOf(content) {
  return typeof content === 'string' ? `text:${content}` : `bytes:${content.join(',')}`;
}

async function createBlob(session, owner, repo, content) {
  const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: encodeContent(content), encoding: 'base64' }),
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

/** All distinct directory prefixes occupied by the index (plus "" for root). */
function buildPrefixIndex(index) {
  const prefixes = new Set(['']);
  for (const entry of index.values()) {
    prefixes.add(entry.path);
    for (const prefix of ancestorPrefixes(entry.path)) prefixes.add(prefix);
  }
  return prefixes;
}

/**
 * Apply the logical operation list to the tree index in memory.
 *
 * Mutates and returns `index` (path → entry). Returns the set of paths that
 * disappeared from the tree so the caller can report a truthful no-op instead
 * of a silent success (AGENTS.md §25: no fake success).
 */
function applyOperations(entries, rawOperations) {
  const index = new Map(entries);
  const deleted = new Set();
  const operations = rawOperations.map(operationOf);
  let prefixes = buildPrefixIndex(index);
  // Operations arrive NFC-normalized (see pathOf). Repositories written before
  // that change may still hold NFD paths, so match and split on the NFC form
  // while always emitting the real stored path.
  let nfcPaths = new Map([...index.keys()].map((path) => [path.normalize('NFC'), path]));
  let nfcPrefixes = new Set([...prefixes].map((prefix) => prefix.normalize('NFC')));

  const existsAtOrUnder = (path) => nfcPrefixes.has(path);
  const taken = (path) => nfcPrefixes.has(path) || ancestorPrefixes(path).some((prefix) => nfcPrefixes.has(prefix));
  const reindex = () => {
    prefixes = buildPrefixIndex(index);
    nfcPaths = new Map([...index.keys()].map((path) => [path.normalize('NFC'), path]));
    nfcPrefixes = new Set([...prefixes].map((prefix) => prefix.normalize('NFC')));
  };

  for (const op of operations) {
    if (op.type === 'create') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      index.set(op.path, { path: op.path, mode: '100644', type: 'blob', deferred: op.content });
    } else if (op.type === 'update' || op.type === 'upload') {
      const target = nfcPaths.get(op.path);
      if (!target || index.get(target).type !== 'blob') {
        throw new ApiError(422, 'validation_error', `File not found: ${op.path}`);
      }
      index.set(target, { path: target, mode: '100644', type: 'blob', deferred: op.content });
    } else if (op.type === 'mkdir') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      index.set(`${op.path}/.keep`, { path: `${op.path}/.keep`, mode: '100644', type: 'blob', deferred: '' });
    } else if (op.type === 'delete') {
      // Match on the NFC form so a path typed in NFC also removes a stored NFD
      // path. Fall back to the raw path so an exactly-matching NFD delete still
      // works even if normalization ever changes the string.
      const forms = [op.path, nfcPaths.get(op.path)].filter(Boolean).map((form) => form.normalize('NFC'));
      let removed = 0;
      for (const entry of [...index.values()]) {
        const stored = entry.path.normalize('NFC');
        if (forms.some((form) => isUnder(stored, form))) {
          index.delete(entry.path);
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
        index.set(nextPath, { ...entry, path: nextPath });
      }
      if (op.type !== 'copy') for (const path of consumed) index.delete(path);
    }
    reindex();
  }

  const pending = new Map();
  for (const entry of index.values()) {
    if (!Object.hasOwn(entry, 'deferred')) continue;
    const key = contentKeyOf(entry.deferred);
    if (!pending.has(key)) pending.set(key, { content: entry.deferred, entries: [] });
    pending.get(key).entries.push(entry);
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
        const sha = await createBlob(session, owner, repo, group.content);
        created += 1;
        for (const entry of group.entries) {
          entry.sha = sha;
          delete entry.deferred;
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
