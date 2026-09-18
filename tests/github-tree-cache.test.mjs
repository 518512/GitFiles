/**
 * Node regression suite for the browser-side repository tree cache
 * (`js/githubdisk.js`).
 *
 * 背景：`getRepoTreeState` 原先完全没有缓存，每次 `listFiles` / `getRepoTree`
 * 都发一次完整的递归树请求，一次目录导航会重复拉多次、一次写操作还会因
 * 多次 notify 触发多轮刷新。修复后按 `diskId + branch` 缓存，并以
 * 「缓存 head === disk.head」作为命中条件。
 *
 * 本套件锁住三条行为：
 *   1. 连续/并发读取共用一次树请求；
 *   2. HEAD 变化（写成功）后缓存自动失效、下次重新回源；
 *   3. invalidateRepoTree 强制回源；getFileProperties 不再重复拉整树。
 *
 * Run: node --test tests/github-tree-cache.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGithubDisk, treeRequests } from './helpers/githubdisk-harness.mjs';

const TREE = [
  { path: 'docs', mode: '040000', type: 'tree', sha: 'tdocs' },
  { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'sha-a', size: 10 },
  { path: 'readme.md', mode: '100644', type: 'blob', sha: 'sha-r', size: 20 },
];

test('consecutive reads reuse one tree request', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.listFiles('github:o/r', 'root');
  await GithubDisk.listFiles('github:o/r', 'root');
  assert.equal(treeRequests(requests).length, 1);
});

test('concurrent reads share one in-flight request', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await Promise.all([
    GithubDisk.listFiles('github:o/r', 'root'),
    GithubDisk.listFiles('github:o/r', 'root'),
    GithubDisk.listFiles('github:o/r', 'root'),
  ]);
  assert.equal(treeRequests(requests).length, 1);
});

test('a changed HEAD invalidates the cache and the next read refetches', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.listFiles('github:o/r', 'root');
  // 模拟一次成功写入：head 前进 → 缓存失配。
  await GithubDisk.createFolder('github:o/r', 'root', 'newdir');
  const afterWrite = treeRequests(requests).length;
  await GithubDisk.listFiles('github:o/r', 'root');
  assert.ok(
    treeRequests(requests).length > afterWrite,
    'HEAD 变化后必须重新读取树'
  );
});

test('invalidateRepoTree forces the next read to go to the network', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.listFiles('github:o/r', 'root');
  const before = treeRequests(requests).length;
  GithubDisk.invalidateRepoTree('github:o/r');
  await GithubDisk.listFiles('github:o/r', 'root');
  assert.equal(treeRequests(requests).length, before + 1);
});

test('getFileProperties reads the tree exactly once', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  const rows = await GithubDisk.getFileProperties('github:o/r', 'readme.md');
  assert.equal(treeRequests(requests).length, 1);
  assert.ok(rows.some((row) => Array.isArray(row) && row[0] === 'SHA' && row[1] === 'sha-r'));
});

test('getFileProperties reuses an already warm tree cache', async () => {
  const { GithubDisk, requests } = loadGithubDisk({ treeEntries: TREE });
  await GithubDisk.listFiles('github:o/r', 'root');
  await GithubDisk.getFileProperties('github:o/r', 'readme.md');
  assert.equal(treeRequests(requests).length, 1);
});
