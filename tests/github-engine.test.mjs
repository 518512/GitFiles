/**
 * Node test suite for the Git Data engine (js/github/*).
 *
 * Covers the PROJECT_SPEC §24 checklist that can be verified without network:
 * - file create/update/delete/rename/move/copy
 * - directory mkdir/delete/move/copy + nested directories
 * - batch operations (mixed, large)
 * - Move/Copy reuse Blob SHAs
 * - one logical batch -> one tree + one commit + one ref update (CAS)
 * - CAS conflict -> ConflictError (409 semantics)
 *
 * Run: node tests/github-engine.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Load the engine scripts the same way the browser does (plain scripts on globalThis).
for (const name of ['client', 'repository', 'blob', 'reference', 'tree', 'commit', 'operations']) {
  const code = readFileSync(path.join(ROOT, 'js/github', `${name}.js`), 'utf8');
  new Function(code).call(globalThis);
}

const { applyOperations, executeCommitPipeline, makeUniquePath, isFolderPath } = globalThis.GithubOperations;
const { GithubApiError } = globalThis.GithubClient;
const { ConflictError } = globalThis.GithubReference;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, err });
      console.error(`  ✗ ${name}\n      ${err && err.stack ? err.stack.split('\n')[0] : err}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function assertRejects(fn, matchName, message) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(`${message || 'expected rejection'}: but the call succeeded`);
  if (matchName && caught.name !== matchName) {
    throw new Error(`${message || 'wrong error'}: expected ${matchName}, got ${caught.name}: ${caught.message}`);
  }
  return caught;
}

function entry(path, sha, size = 5) {
  return { path, mode: '100644', type: 'blob', sha, size };
}

function findByPath(entries, path) {
  return entries.find((e) => e.path === path) || null;
}

const FIXTURE = [
  entry('a.md', 'sha-a', 10),
  entry('b.txt', 'sha-b', 20),
  entry('docs/.keep', 'sha-keep'),
  entry('docs/b.md', 'sha-docs-b', 30),
  entry('docs/sub/c.md', 'sha-docs-c', 40),
  entry('docs/sub/d.md', 'sha-docs-d', 50),
  entry('empty/.keep', 'sha-keep'),
];

function fakeCreateBlob(counter = { n: 0 }) {
  return async ({ content }) => {
    counter.n += 1;
    return `sha-new-${counter.n}`;
  };
}

async function runPlanner(entries, operations, counter) {
  return applyOperations({ entries, operations, createBlob: fakeCreateBlob(counter) });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

console.log('File operations');

await test('create file -> blob created, entry added', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'create', path: 'new.md', content: 'hello' }], counter);
  const created = findByPath(result.entries, 'new.md');
  assert(created, 'new.md missing');
  assertEqual(created.sha, 'sha-new-1');
  assertEqual(counter.n, 1, 'blob creations');
  assertEqual(result.entries.filter((e) => e.path === 'a.md').length, 1, 'existing intact');
});

await test('create file with existing path -> ValidationError', async () => {
  await assertRejects(
    () => runPlanner(FIXTURE, [{ type: 'create', path: 'a.md', content: 'x' }], { n: 0 }),
    'ValidationError'
  );
});

await test('update file -> blob recreated at same path, other SHAs untouched', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'update', path: 'a.md', content: 'updated' }], counter);
  const updated = findByPath(result.entries, 'a.md');
  assertEqual(updated.sha, 'sha-new-1');
  assertEqual(findByPath(result.entries, 'b.txt').sha, 'sha-b');
  assertEqual(counter.n, 1, 'blob creations');
});

await test('update missing file -> ValidationError', async () => {
  await assertRejects(
    () => runPlanner(FIXTURE, [{ type: 'update', path: 'missing.md', content: 'x' }], { n: 0 }),
    'ValidationError'
  );
});

await test('delete file -> removed', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'delete', path: 'a.md' }], counter);
  assertEqual(findByPath(result.entries, 'a.md'), null);
  assertEqual(counter.n, 0, 'no blob creations');
});

// ---------------------------------------------------------------------------
// Rename / Move (Blob SHA reuse)
// ---------------------------------------------------------------------------

console.log('Rename / Move');

await test('rename file reuses original Blob SHA', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'rename', from: 'a.md', to: 'z.md' }], counter);
  assertEqual(findByPath(result.entries, 'a.md'), null, 'old path gone');
  const renamed = findByPath(result.entries, 'z.md');
  assert(renamed, 'new path missing');
  assertEqual(renamed.sha, 'sha-a', 'blob SHA must be reused');
  assertEqual(counter.n, 0, 'no blob uploads');
});

await test('move directory rewrites all descendant paths with same SHAs (one planner pass)', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'move', from: 'docs', to: 'archive/docs' }], counter);
  const expect = {
    'archive/docs/.keep': 'sha-keep',
    'archive/docs/b.md': 'sha-docs-b',
    'archive/docs/sub/c.md': 'sha-docs-c',
    'archive/docs/sub/d.md': 'sha-docs-d',
  };
  for (const [path, sha] of Object.entries(expect)) {
    const found = findByPath(result.entries, path);
    assert(found, `${path} missing`);
    assertEqual(found.sha, sha, `${path} SHA`);
  }
  assertEqual(result.entries.filter((e) => e.path.startsWith('docs/')).length, 0, 'old subtree gone');
  assertEqual(counter.n, 0, 'no blob uploads for a move');
});

await test('move directory into itself -> ValidationError', async () => {
  await assertRejects(
    () => runPlanner(FIXTURE, [{ type: 'move', from: 'docs', to: 'docs/sub/docs' }], { n: 0 }),
    'ValidationError'
  );
});

await test('move onto existing path -> ValidationError (no silent overwrite)', async () => {
  await assertRejects(
    () => runPlanner(FIXTURE, [{ type: 'move', from: 'a.md', to: 'b.txt' }], { n: 0 }),
    'ValidationError'
  );
});

// ---------------------------------------------------------------------------
// Copy (Blob SHA reuse)
// ---------------------------------------------------------------------------

console.log('Copy');

await test('copy file reuses original Blob SHA', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'copy', from: 'a.md', to: 'copy/a.md' }], counter);
  assertEqual(findByPath(result.entries, 'a.md').sha, 'sha-a', 'source intact');
  assertEqual(findByPath(result.entries, 'copy/a.md').sha, 'sha-a', 'copy reuses SHA');
  assertEqual(counter.n, 0, 'no re-upload');
});

await test('copy directory duplicates whole subtree with same SHAs', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'copy', from: 'docs', to: 'docs-backup' }], counter);
  const expect = {
    'docs-backup/.keep': 'sha-keep',
    'docs-backup/b.md': 'sha-docs-b',
    'docs-backup/sub/c.md': 'sha-docs-c',
    'docs-backup/sub/d.md': 'sha-docs-d',
  };
  for (const [path, sha] of Object.entries(expect)) {
    const found = findByPath(result.entries, path);
    assert(found, `${path} missing`);
    assertEqual(found.sha, sha, `${path} SHA`);
  }
  assert(findByPath(result.entries, 'docs/b.md'), 'original subtree intact');
  assertEqual(counter.n, 0, 'no re-upload for folder copy');
});

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

console.log('Directories');

await test('mkdir creates folder/.keep marker', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'mkdir', path: 'photos' }], counter);
  const keep = findByPath(result.entries, 'photos/.keep');
  assert(keep, '.keep missing');
  assertEqual(counter.n, 1, 'empty blob created once');
});

await test('mkdir reuses the well-known empty blob SHA when present', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(
    [...FIXTURE, entry('other/.keep', globalThis.GithubBlob.EMPTY_BLOB_SHA)],
    [{ type: 'mkdir', path: 'photos' }],
    counter
  );
  const keep = findByPath(result.entries, 'photos/.keep');
  assertEqual(keep.sha, globalThis.GithubBlob.EMPTY_BLOB_SHA, 'reuses empty blob sha');
  assertEqual(counter.n, 0, 'no network blob creation');
});

await test('delete directory removes all descendants', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'delete', path: 'docs' }], counter);
  assertEqual(result.entries.filter((e) => e.path.startsWith('docs/') || e.path === 'docs').length, 0);
  assert(findByPath(result.entries, 'a.md'), 'unrelated files intact');
  assertEqual(counter.n, 0, 'no blob creations');
});

await test('nested directory move (multi-level)', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [{ type: 'move', from: 'docs/sub', to: 'docs/deep/sub2' }], counter);
  assert(findByPath(result.entries, 'docs/deep/sub2/c.md'), 'c.md moved');
  assertEqual(findByPath(result.entries, 'docs/deep/sub2/c.md').sha, 'sha-docs-c');
  assertEqual(findByPath(result.entries, 'docs/sub/c.md'), null, 'old path gone');
  assertEqual(counter.n, 0, 'no uploads');
});

await test('isFolderPath distinguishes files from folders', () => {
  assertEqual(isFolderPath(FIXTURE, 'docs'), true);
  assertEqual(isFolderPath(FIXTURE, 'a.md'), false);
  assertEqual(isFolderPath(FIXTURE, 'missing'), false);
});

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

console.log('Batch');

await test('mixed batch (delete + copy + rename + create) applies sequentially in memory', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [
    { type: 'delete', path: 'b.txt' },
    { type: 'copy', from: 'a.md', to: 'backup/a.md' },
    { type: 'rename', from: 'a.md', to: 'renamed.md' },
    { type: 'create', path: 'new/a.md', content: 'x' },
  ], counter);
  assertEqual(findByPath(result.entries, 'b.txt'), null, 'deleted');
  assert(findByPath(result.entries, 'new/a.md'), 'created');
  assert(findByPath(result.entries, 'renamed.md'), 'renamed');
  assert(findByPath(result.entries, 'backup/a.md'), 'copied');
  assertEqual(findByPath(result.entries, 'backup/a.md').sha, 'sha-a', 'copy reuses SHA');
  assertEqual(findByPath(result.entries, 'renamed.md').sha, 'sha-a', 'rename reuses SHA');
});

await test('sequential semantics: copy of a source renamed earlier in the batch fails', async () => {
  await assertRejects(
    () => runPlanner(FIXTURE, [
      { type: 'rename', from: 'a.md', to: 'renamed.md' },
      { type: 'copy', from: 'a.md', to: 'backup/a.md' },
    ], { n: 0 }),
    'ValidationError'
  );
});

await test('delete + recreate the same path in one batch is allowed', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [
    { type: 'delete', path: 'b.txt' },
    { type: 'create', path: 'b.txt', content: 'recreated' },
  ], counter);
  const recreated = findByPath(result.entries, 'b.txt');
  assert(recreated, 'recreated');
  assertEqual(recreated.sha, 'sha-new-1');
  assertEqual(counter.n, 1);
});

await test('create then update same path in one batch uploads the blob only once', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [
    { type: 'create', path: 'draft.md', content: 'v1' },
    { type: 'update', path: 'draft.md', content: 'v2' },
  ], counter);
  assertEqual(counter.n, 1, 'single blob upload');
  assertEqual(findByPath(result.entries, 'draft.md').sha, 'sha-new-1');
});

await test('copy of a just-created file shares the deferred blob (no re-upload)', async () => {
  const counter = { n: 0 };
  const result = await runPlanner(FIXTURE, [
    { type: 'create', path: 'draft.md', content: 'v1' },
    { type: 'copy', from: 'draft.md', to: 'draft (copy).md' },
  ], counter);
  assertEqual(counter.n, 1, 'single blob upload shared by both paths');
  assertEqual(findByPath(result.entries, 'draft.md').sha, 'sha-new-1');
  assertEqual(findByPath(result.entries, 'draft (copy).md').sha, 'sha-new-1');
});

await test('batch of 100 deletes applies in one pass', async () => {
  const entries = [];
  for (let i = 0; i < 100; i += 1) entries.push(entry(`bulk/file-${i}.md`, `sha-bulk-${i}`));
  const operations = [{ type: 'delete', path: 'bulk' }];
  const result = await runPlanner(entries, operations, { n: 0 });
  assertEqual(result.entries.filter((e) => e.path.startsWith('bulk/')).length, 0);
});

await test('batch of 100 creates produces exactly 100 blob creations and one entry set', async () => {
  const counter = { n: 0 };
  const operations = [];
  for (let i = 0; i < 100; i += 1) {
    operations.push({ type: 'create', path: `many/file-${i}.md`, content: `content ${i}` });
  }
  const result = await runPlanner(FIXTURE, operations, counter);
  assertEqual(counter.n, 100, 'blob creations');
  assertEqual(result.entries.filter((e) => e.path.startsWith('many/')).length, 100);
});

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

console.log('Naming');

await test('makeUniquePath uses "(copy)" then "(copy N)" naming', () => {
  const entries = [entry('a.md', 'sha-a')];
  assertEqual(makeUniquePath(entries, 'a.md'), 'a (copy).md');
  const taken = new Set(['a (copy).md']);
  assertEqual(makeUniquePath(entries, 'a.md', taken), 'a (copy 2).md');
  assertEqual(makeUniquePath([entry('x/c.md', 's')], 'x/c.md'), 'x/c (copy).md');
});

// ---------------------------------------------------------------------------
// Pipeline (one batch = one tree + one commit + one CAS ref update)
// ---------------------------------------------------------------------------

console.log('Mutation pipeline / CAS');

function stubPipeline({ head = 'head-A', treeSha = 'tree-A', tree = FIXTURE, conflictOnUpdate = false } = {}) {
  const calls = {
    blobs: 0,
    createCommitOnHead: 0,
    updateRef: 0,
    refArgs: null,
    createBlobArgs: [],
  };
  globalThis.GithubRepository.getBranchState = async () => ({ head, treeSha });
  globalThis.GithubTree.getTreeAt = async () => ({ head, treeSha, tree });
  globalThis.GithubBlob.createBlob = async (p) => {
    calls.blobs += 1;
    calls.createBlobArgs.push(p);
    return `sha-pipe-${calls.blobs}`;
  };
  globalThis.GithubCommit.createCommitOnHead = async (p) => {
    calls.createCommitOnHead += 1;
    calls.commitArgs = p;
    return { commitSha: 'head-B', treeSha: 'tree-B' };
  };
  globalThis.GithubReference.updateRefCas = async (p) => {
    calls.updateRef += 1;
    calls.refArgs = p;
    if (conflictOnUpdate) {
      throw new ConflictError(p.expectedHead, 'head-X', 'Update is not a fast forward');
    }
  };
  return calls;
}

await test('batch of 3 operations -> exactly one commit and one CAS ref update', async () => {
  const calls = stubPipeline();
  const result = await executeCommitPipeline({
    owner: 'o', repo: 'r', branch: 'main', token: 't',
    message: 'Batch file operations',
    operations: [
      { type: 'create', path: 'one.md', content: '1' },
      { type: 'rename', from: 'a.md', to: 'renamed.md' },
      { type: 'delete', path: 'b.txt' },
    ],
  });
  assertEqual(result.head, 'head-B');
  assertEqual(result.skipped, false);
  assertEqual(calls.createCommitOnHead, 1, 'one createCommit call');
  assertEqual(calls.updateRef, 1, 'one ref update');
  assertEqual(calls.refArgs.expectedHead, 'head-A', 'CAS expectedHead');
  assertEqual(calls.refArgs.newHead, 'head-B');
  // moved path keeps its blob SHA inside the created tree
  const renamed = calls.commitArgs.entries.find((e) => e.path === 'renamed.md');
  assert(renamed, 'renamed entry in tree');
  assertEqual(renamed.sha, 'sha-a', 'move reuses blob SHA');
});

await test('no-op batch (move onto itself) skips the commit entirely', async () => {
  const calls = stubPipeline();
  const result = await executeCommitPipeline({
    owner: 'o', repo: 'r', branch: 'main', token: 't',
    message: 'Move a.md to a.md',
    operations: [{ type: 'move', from: 'a.md', to: 'a.md' }],
  });
  assertEqual(result.skipped, true);
  assertEqual(calls.createCommitOnHead, 0, 'no commit for no-op');
  assertEqual(calls.updateRef, 0, 'no ref update for no-op');
});

await test('remote HEAD moved during commit -> ConflictError, no silent overwrite', async () => {
  const calls = stubPipeline({ conflictOnUpdate: true });
  let caught = null;
  try {
    await executeCommitPipeline({
      owner: 'o', repo: 'r', branch: 'main', token: 't',
      message: 'Create file one.md',
      operations: [{ type: 'create', path: 'one.md', content: '1' }],
    });
  } catch (err) {
    caught = err;
  }
  assert(caught, 'pipeline must reject');
  assert(caught instanceof ConflictError || caught.name === 'ConflictError', `expected ConflictError, got ${caught.name}`);
  assertEqual(caught.expectedHead, 'head-A');
  assertEqual(caught.remoteHead, 'head-X');
  assertEqual(calls.updateRef, 1, 'CAS update attempted once');
});

await test('expectedHead mismatch (client observed stale HEAD) -> ConflictError before commit', async () => {
  const calls = stubPipeline();
  let caught = null;
  try {
    await executeCommitPipeline({
      owner: 'o', repo: 'r', branch: 'main', token: 't',
      message: 'stale client',
      operations: [{ type: 'create', path: 'one.md', content: '1' }],
      expectedHead: 'stale-head',
    });
  } catch (err) {
    caught = err;
  }
  assert(caught && caught.name === 'ConflictError', 'expected ConflictError');
  assertEqual(calls.createCommitOnHead, 0, 'no commit attempted');
});

// ---------------------------------------------------------------------------
// Conflict classification
// ---------------------------------------------------------------------------

console.log('Conflict classification');

await test('422 fast-forward payload is classified as conflict', () => {
  const err = new GithubApiError('Update is not a fast forward', 422, null);
  assertEqual(err.isConflict, true);
});

await test('422 validation error is NOT a conflict', () => {
  const err = new GithubApiError('Invalid request', 422, { errors: [{ code: 'missing_field' }] });
  assertEqual(err.isConflict, false);
  assertEqual(err.isValidation, true);
});

await test('409 is always a conflict', () => {
  assertEqual(new GithubApiError('Conflict', 409, null).isConflict, true);
});

await test('404 is not a conflict but is not-found', () => {
  const err = new GithubApiError('Not Found', 404, null);
  assertEqual(err.isConflict, false);
  assertEqual(err.isNotFound, true);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
