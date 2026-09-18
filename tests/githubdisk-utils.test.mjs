/**
 * Node regression suite for githubdisk.js 的文本判定与批量上传。
 *
 * 锁住两处修复：
 *   1. 文本/扩展名判定统一到 `isTextFileMime`（此前 `.markdown` 被判成二进制，
 *      `createFileFromBlob` 会走 arrayBuffer 分支；`isNotepadFile` 与它不一致）；
 *   2. 多文件上传 = 一次 Tree + 一次 Commit（AGENTS.md §3），
 *      此前是一个文件一次 commit。
 *
 * Run: node --test tests/githubdisk-utils.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGithubDisk, treeRequests, operationRequests } from './helpers/githubdisk-harness.mjs';

const TREE = [
  { path: 'docs', mode: '040000', type: 'tree', sha: 'tdocs' },
  { path: 'readme.md', mode: '100644', type: 'blob', sha: 'sha-r', size: 20 },
];

function fakeFile(name, { type = '', text = '', bytes = null } = {}) {
  return {
    name,
    type,
    async text() { return text; },
    async arrayBuffer() { return bytes ? bytes.buffer : new ArrayBuffer(0); },
  };
}

test('isTextFileMime treats markdown and xml as text', () => {
  const { GithubDisk } = loadGithubDisk({ treeEntries: TREE });
  assert.equal(GithubDisk.isTextFileMime('', 'notes.markdown'), true);
  assert.equal(GithubDisk.isTextFileMime('application/xml', 'feed'), true);
  assert.equal(GithubDisk.isTextFileMime('application/json', 'data'), true);
  assert.equal(GithubDisk.isTextFileMime('image/png', 'logo.png'), false);
  assert.equal(GithubDisk.isTextFileMime('application/octet-stream', 'blob.bin'), false);
});

test('inferMimeType and isNotepadFile share the same extension table', () => {
  const { GithubDisk } = loadGithubDisk({ treeEntries: TREE });
  assert.equal(GithubDisk.inferMimeType('notes.markdown'), 'text/plain');
  assert.equal(GithubDisk.isNotepadFile({ name: 'notes.markdown', mimeType: '' }), true);
  // 两个判定必须一致，不能再出现「记事本能打开但上传按二进制处理」的漂移。
  for (const name of ['a.md', 'a.markdown', 'a.json', 'a.png']) {
    assert.equal(
      GithubDisk.isNotepadFile({ name, mimeType: '' }),
      GithubDisk.isTextFileMime('', name),
      `mismatch for ${name}`
    );
  }
});

test('createFilesFromBlobs commits multiple files with one request', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  const files = [
    fakeFile('a.md', { type: 'text/markdown', text: 'A' }),
    fakeFile('b.txt', { type: 'text/plain', text: 'B' }),
    fakeFile('c.md', { text: 'C' }),
  ];
  const result = await GithubDisk.createFilesFromBlobs('github:o/r', 'root', files);

  assert.equal(result.created, 3);
  assert.deepEqual(result.failures, []);
  assert.equal(operationRequests(requests).length, 1, '三个文件必须只产生一次 commit');
  const ops = operationRequests(requests)[0].body.operations;
  assert.equal(ops.length, 3);
  assert.deepEqual(ops.map((op) => op.path).sort(), ['a.md', 'b.txt', 'c.md']);
  // 文本内容以字符串提交，二进制才用字节数组。
  assert.equal(ops.find((op) => op.path === 'a.md').content, 'A');
});

test('createFilesFromBlobs never overwrites an existing path', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.createFilesFromBlobs('github:o/r', 'root', [fakeFile('readme.md', { text: 'new' })]);
  const ops = operationRequests(requests)[0].body.operations;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].path, 'readme (copy).md');
});

test('createFilesFromBlobs reports oversized binaries instead of uploading them', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  const tooBig = new Uint8Array(26 * 1024 * 1024);
  const result = await GithubDisk.createFilesFromBlobs('github:o/r', 'root', [
    fakeFile('big.bin', { type: 'application/octet-stream', bytes: tooBig }),
  ]);
  assert.equal(result.created, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /25 MB/);
  assert.equal(operationRequests(requests).length, 0, '超限文件不应产生任何 commit');
});

test('createFilesFromBlobs keeps good files when one fails', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  const tooBig = new Uint8Array(26 * 1024 * 1024);
  const result = await GithubDisk.createFilesFromBlobs('github:o/r', 'root', [
    fakeFile('ok.md', { text: 'fine' }),
    fakeFile('big.bin', { type: 'application/octet-stream', bytes: tooBig }),
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.failures.length, 1);
  const ops = operationRequests(requests)[0].body.operations;
  assert.deepEqual(ops.map((op) => op.path), ['ok.md']);
});

test('binary uploads cross the API as base64 instead of a number array', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await GithubDisk.createFilesFromBlobs('github:o/r', 'root', [
    fakeFile('blob.bin', { type: 'application/octet-stream', bytes }),
  ]);
  const op = operationRequests(requests)[0].body.operations[0];
  assert.equal(op.encoding, 'base64');
  assert.equal(typeof op.content, 'string', '二进制必须以 base64 字符串过界，而不是数字数组');
  assert.ok(!Array.isArray(op.content));
  assert.deepEqual([...Buffer.from(op.content, 'base64')], [...bytes]);
});

// ---------------------------------------------------------------------------
// js/github-paths.js：路径助手（原由 tests/github-engine.test.mjs 顺带覆盖，
// 引擎删除后必须由这里保证）
// ---------------------------------------------------------------------------

const PATHS_TREE = [
  { path: 'docs', type: 'tree', sha: 't-docs' },
  { path: 'docs/.keep', type: 'blob', sha: 'blob-keep' },
  { path: 'docs/a.md', type: 'blob', sha: 'blob-a' },
  { path: 'readme.md', type: 'blob', sha: 'blob-r' },
];

test('makeUniquePath returns the original path when it is free', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  assert.equal(GithubPaths.makeUniquePath(PATHS_TREE, 'docs/b.md'), 'docs/b.md');
});

test('makeUniquePath falls back to "(copy)" then "(copy N)"', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  const taken = new Set();
  assert.equal(GithubPaths.makeUniquePath(PATHS_TREE, 'docs/a.md', taken), 'docs/a (copy).md');
  assert.equal(GithubPaths.makeUniquePath(PATHS_TREE, 'docs/a.md', taken), 'docs/a (copy 2).md');
  assert.equal(GithubPaths.makeUniquePath(PATHS_TREE, 'docs/a.md', taken), 'docs/a (copy 3).md');
});

test('makeUniquePath treats existing directories as occupied', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  // 同名目录存在时也要改名，否则会与目录冲突
  assert.equal(GithubPaths.makeUniquePath(PATHS_TREE, 'docs'), 'docs (copy)');
});

test('isFolderPath distinguishes directories from files', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  assert.equal(GithubPaths.isFolderPath(PATHS_TREE, 'docs'), true);
  assert.equal(GithubPaths.isFolderPath(PATHS_TREE, 'docs/a.md'), false);
  assert.equal(GithubPaths.isFolderPath(PATHS_TREE, 'readme.md'), false);
});

test('joinPath / getBaseName round-trip', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  assert.equal(GithubPaths.joinPath('docs', 'a.md'), 'docs/a.md');
  assert.equal(GithubPaths.joinPath('', 'a.md'), 'a.md');
  assert.equal(GithubPaths.getBaseName('docs/a.md'), 'a.md');
});

test('normalizePath rejects traversal and empty segments', () => {
  const { GithubPaths } = loadGithubDisk({ treeEntries: PATHS_TREE });
  assert.throws(() => GithubPaths.normalizePath('docs/../etc/passwd'));
  assert.throws(() => GithubPaths.normalizePath('docs//a.md'));
  assert.equal(GithubPaths.normalizePath('/docs/a.md/'), 'docs/a.md');
});

test('tree reads are still cached across a batch upload', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.listFiles('github:o/r', 'root');
  await GithubDisk.createFilesFromBlobs('github:o/r', 'root', [fakeFile('a.md', { text: 'A' })]);
  assert.equal(treeRequests(requests).length, 1, '批量上传应复用已缓存的树');
});
