import { ApiError } from './http.js';
import { branchState, githubRequest, repoPrefix } from './github.js';

const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const MAX_BINARY_BYTES = 25 * 1024 * 1024;

function pathOf(value) {
  if (!value || typeof value !== 'string') throw new ApiError(422, 'validation_error', 'A repository path is required');
  const path = value.replace(/^\/+|\/+$/g, '');
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
    if (new TextEncoder().encode(content).length > MAX_BINARY_BYTES) {
      throw new ApiError(422, 'validation_error', 'File content must be no larger than 25 MB');
    }
    return btoa(unescape(encodeURIComponent(content)));
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

async function createBlob(session, owner, repo, content) {
  const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: encodeContent(content), encoding: 'base64' }),
  });
  return payload.sha;
}

async function treeAt(session, owner, repo, head) {
  const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/trees/${encodeURIComponent(head)}?recursive=1`);
  if (payload?.truncated) {
    throw new ApiError(422, 'validation_error', 'Repository tree is too large for a safe mutation; no changes were made');
  }
  return {
    treeSha: payload.sha,
    entries: (payload.tree || [])
      .filter((entry) => entry.type === 'blob' || entry.type === 'commit')
      .map((entry) => ({ path: entry.path, mode: entry.mode || (entry.type === 'commit' ? '160000' : '100644'), type: entry.type, sha: entry.sha })),
  };
}

async function applyOperations(session, owner, repo, entries, rawOperations) {
  const index = new Map(entries.map((entry) => [entry.path, { path: entry.path, mode: entry.mode || (entry.type === 'commit' ? '160000' : '100644'), type: entry.type, sha: entry.sha }]));
  const deferred = new Map();
  const operations = rawOperations.map(operationOf);
  const existsAtOrUnder = (path) => [...index.values()].some((entry) => isUnder(entry.path, path));
  const taken = (path) => existsAtOrUnder(path) || [...index.values()].some((entry) => isUnder(path, entry.path));
  const rewrite = (from, to, keep) => {
    const affected = [...index.values()].filter((entry) => isUnder(entry.path, from));
    if (!affected.length) throw new ApiError(422, 'validation_error', `Path not found: ${from}`);
    for (const entry of affected) {
      const suffix = entry.path.slice(from.length).replace(/^\//, '');
      const nextPath = suffix ? `${to}/${suffix}` : to;
      if (!keep) index.delete(entry.path);
      index.set(nextPath, { ...entry, path: nextPath });
    }
  };
  for (const op of operations) {
    if (op.type === 'create') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      index.set(op.path, { path: op.path, mode: '100644', type: 'blob', deferred: op.content });
    } else if (op.type === 'update' || op.type === 'upload') {
      if (!index.has(op.path) || index.get(op.path).type !== 'blob') {
        throw new ApiError(422, 'validation_error', `File not found: ${op.path}`);
      }
      index.set(op.path, { path: op.path, mode: '100644', type: 'blob', deferred: op.content });
    } else if (op.type === 'mkdir') {
      if (taken(op.path)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.path}`);
      index.set(`${op.path}/.keep`, { path: `${op.path}/.keep`, mode: '100644', type: 'blob', deferred: '' });
    } else if (op.type === 'delete') {
      for (const entry of [...index.values()]) if (isUnder(entry.path, op.path)) index.delete(entry.path);
    } else if (op.type === 'rename' || op.type === 'move') {
      if (op.from === op.to) continue;
      if (isUnder(op.to, op.from)) throw new ApiError(422, 'validation_error', 'Cannot move a path into itself');
      if (taken(op.to)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.to}`);
      rewrite(op.from, op.to, false);
    } else if (op.type === 'copy') {
      if (isUnder(op.to, op.from)) throw new ApiError(422, 'validation_error', 'Cannot copy a path into itself');
      if (taken(op.to)) throw new ApiError(422, 'validation_error', `Path already exists: ${op.to}`);
      rewrite(op.from, op.to, true);
    }
  }
  for (const entry of index.values()) {
    if (!Object.hasOwn(entry, 'deferred')) continue;
    const contentKey = typeof entry.deferred === 'string' ? `text:${entry.deferred}` : `bytes:${entry.deferred.join(',')}`;
    if (!deferred.has(contentKey)) deferred.set(contentKey, createBlob(session, owner, repo, entry.deferred));
    entry.sha = await deferred.get(contentKey);
    delete entry.deferred;
  }
  return [...index.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function sameTree(before, after) {
  if (before.length !== after.length) return false;
  const sortedBefore = [...before].sort((a, b) => a.path.localeCompare(b.path));
  return sortedBefore.every((entry, index) => (
    entry.path === after[index].path && entry.sha === after[index].sha && (entry.mode || '100644') === (after[index].mode || '100644')
  ));
}

export async function executeOperations(session, owner, repo, { branch, expectedHead, operations, message }) {
  const state = await branchState(session, owner, repo, branch);
  if (!state && expectedHead) {
    throw new ApiError(409, 'conflict', 'Branch no longer exists', { expectedHead, remoteHead: null });
  }
  if (state && state.head !== expectedHead) {
    throw new ApiError(409, 'conflict', 'Branch HEAD changed before the operation started', { expectedHead, remoteHead: state.head });
  }
  const current = state ? await treeAt(session, owner, repo, state.head) : { treeSha: null, entries: [] };
  const entries = await applyOperations(session, owner, repo, current.entries, operations);
  if (state && sameTree(current.entries, entries)) {
    return { head: state.head, treeSha: current.treeSha || state.treeSha, blobsCreated: 0, skipped: true };
  }
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
  return { head: commit.sha, treeSha: tree.sha, blobsCreated: 0, skipped: false };
}
