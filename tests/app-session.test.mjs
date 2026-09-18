/**
 * 会话与挂载生命周期的回归测试。
 *
 * 背景：退出登录曾经调用 `ejectAllDrives()`，而 `LocalDisk.removeDisk()` 内部还会
 * `deleteAllForDisk()` —— 结果「退出再登录」不仅挂载没了，本地存储的 IndexedDB
 * 数据也被清空。修复后退出只结束会话，挂载按账号保留、重新登录同一账号自动恢复。
 *
 * 本套件用两种手段锁住这件事：
 *   1. 数据层：`GithubDisk.getVisibleDisks()` 的按账号过滤与"账号未知不过滤"回退；
 *   2. 源码层：静态断言 `signOutGithub()` 不再触碰任何卸载/删除挂载的调用。
 *
 * Run: node --test tests/app-session.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGithubDisk } from './helpers/githubdisk-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SOURCE = readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

const DISKS = [
  { id: 'github:alice/repo-a', name: 'repo-a', owner: 'alice', repo: 'repo-a', branch: 'main', head: 'H1', accountLogin: 'alice' },
  { id: 'github:ALICE/repo-b', name: 'repo-b', owner: 'ALICE', repo: 'repo-b', branch: 'main', head: 'H2', accountLogin: 'ALICE' },
  { id: 'github:bob/repo-c', name: 'repo-c', owner: 'bob', repo: 'repo-c', branch: 'main', head: 'H3', accountLogin: 'bob' },
  { id: 'github:legacy/repo-d', name: 'repo-d', owner: 'legacy', repo: 'repo-d', branch: 'main', head: 'H4' },
];

test('getVisibleDisks keeps every mount when no account is known', () => {
  // 账号未知（例如 Worker 暂时不可用）时不过滤，避免把用户的存储"藏"起来；
  // 真正的访问控制由 Worker 侧 ACL 兜底。
  const { GithubDisk } = loadGithubDisk({ disks: DISKS });
  GithubDisk.setActiveAccount(null);
  assert.equal(GithubDisk.getVisibleDisks().length, DISKS.length);
  assert.equal(GithubDisk.getDisks().length, DISKS.length);
});

test('getVisibleDisks shows only the signed-in account, case-insensitively', () => {
  const { GithubDisk } = loadGithubDisk({ disks: DISKS });
  GithubDisk.setActiveAccount('alice');
  const visible = GithubDisk.getVisibleDisks().map((disk) => disk.id);
  assert.deepEqual(visible, [
    'github:alice/repo-a',
    'github:ALICE/repo-b',
    'github:legacy/repo-d', // 早期记录没有 accountLogin，无法归属 → 按可见处理
  ]);

  GithubDisk.setActiveAccount('BOB');
  assert.deepEqual(GithubDisk.getVisibleDisks().map((disk) => disk.id), [
    'github:bob/repo-c',
    'github:legacy/repo-d',
  ]);
});

test('switching accounts never deletes other accounts mounts', () => {
  const { GithubDisk } = loadGithubDisk({ disks: DISKS });
  GithubDisk.setActiveAccount('alice');
  GithubDisk.getVisibleDisks();
  GithubDisk.setActiveAccount('bob');
  GithubDisk.getVisibleDisks();
  GithubDisk.setActiveAccount(null);
  // 换账号只是"看不见"，记录必须原样保留，等原账号回来即可恢复
  assert.equal(GithubDisk.getDisks().length, DISKS.length);
  assert.deepEqual(
    GithubDisk.getDisks().map((disk) => disk.id).sort(),
    DISKS.map((disk) => disk.id).sort()
  );
});

// ---------------------------------------------------------------------------
// 源码层静态断言：退出登录不得卸载任何存储
// ---------------------------------------------------------------------------

/** 取出 `signOutGithub` 的函数体（它是一个 async function，紧跟 resetSessionScopedState）。 */
function signOutGithubBody() {
  const start = APP_SOURCE.indexOf('async function signOutGithub');
  assert.ok(start > -1, '找不到 signOutGithub');
  const end = APP_SOURCE.indexOf('function resetSessionScopedState', start);
  assert.ok(end > start, '找不到 signOutGithub 的结束位置');
  return APP_SOURCE.slice(start, end);
}

test('signOutGithub ends the session without unloading storages', () => {
  const body = signOutGithubBody();
  // 这一条是本次 bug 的正面回归：旧实现里正是 ejectAllDrives() → removeDisk()
  // （本地卷还会 deleteAllForDisk 清空 IndexedDB），导致退出即丢数据。
  assert.doesNotMatch(body, /ejectAllDrives|ejectGithubDisk|ejectLocalDisk|removeDisk/,
    '退出登录只应结束会话，不得卸载或删除任何挂载/存储');
  assert.doesNotMatch(body, /deleteAllForDisk/);
  // 必须清账号归属，否则换账号后会继续展示上一个账号的挂载
  assert.match(body, /setActiveAccount\(null\)/);
  // 内存状态要清，但持久化数据不能动
  assert.match(body, /resetSessionScopedState\(\)/);
  assert.match(body, /\/api\/logout/);
});

test('resetSessionScopedState only clears in-memory state', () => {
  const start = APP_SOURCE.indexOf('function resetSessionScopedState');
  const end = APP_SOURCE.indexOf('\n  }', start);
  const body = APP_SOURCE.slice(start, end);
  assert.doesNotMatch(body, /removeDisk|deleteAllForDisk|localStorage\.removeItem/,
    '清理会话状态不得删除持久化的挂载或本地数据');
  assert.match(body, /GithubDisk\.invalidateRepoTree/);
});
