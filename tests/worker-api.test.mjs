import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/entry.js';
import { executeOperations } from '../workers/operations.js';
import { githubRequest } from '../workers/github.js';
import { __resetSessionColumnCache, clearSessionCookie, insertSession, requireRepositoryAccess, sessionCookie } from '../workers/session.js';

function request(path, options = {}) {
  return new Request(`https://gitfiles.example${path}`, options);
}

function dbWith({ session = null, access = null } = {}) {
  // 默认视为"已完整迁移"的库：PRAGMA 返回全部列
  const tables = {
    sessions: ['id', 'github_login', 'github_avatar', 'refresh_token', 'refresh_expires_at', 'client_id', 'access_token', 'expires_at', 'created_at'],
    repository_access: ['session_id', 'owner', 'repo', 'can_read', 'can_write', 'checked_at'],
  };
  return {
    prepare(sql) {
      if (sql.startsWith('PRAGMA table_info')) {
        const table = sql.includes('repository_access') ? 'repository_access' : 'sessions';
        const results = tables[table].map((name) => ({ name }));
        const all = async () => ({ results });
        return { all, bind: () => ({ all }) };
      }
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('SELECT id, github_login')) return session;
              if (sql.startsWith('SELECT can_read')) return access;
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { success: true, args }; },
          };
        },
      };
    },
  };
}

async function responseJson(path, env, options) {
  const response = await worker.fetch(request(path, options), env);
  return { response, body: await response.json() };
}

/**
 * 用内存 mock 跑一次 executeOperations（真实 Worker 管线）。
 *
 * 这些用例是把原先只覆盖 `js/github/*`（已删除的历史引擎）的 §22 场景
 * （move/copy 子树复用 Blob、mkdir、混合批处理、100 条批处理、空操作跳过提交）
 * 迁移到**生产实际使用的** `workers/operations.js` 上。
 */
async function runMutation({
  treeEntries = [],
  treeSha = 'tree-A',
  head = 'head-A',
  branch = 'main',
  operations,
  expectedHead = head,
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let blobs = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith(`/branches/${branch}`)
      ? { commit: { sha: head, commit: { tree: { sha: treeSha } } } }
      : path.endsWith(`/git/trees/${head}`) ? { sha: treeSha, tree: treeEntries }
        : path.endsWith('/git/blobs') ? { sha: `blob-new-${++blobs}` }
          : path.endsWith('/git/trees') ? { sha: 'tree-B' }
            : path.endsWith('/git/commits') ? { sha: 'head-B' }
              : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch, expectedHead, operations,
    });
    const treeCall = calls.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST');
    return {
      result,
      calls,
      blobsCreated: blobs,
      tree: treeCall ? JSON.parse(treeCall.body).tree : null,
      commitCalls: calls.filter((call) => call.path.endsWith('/git/commits')),
      refCalls: calls.filter((call) => call.path.includes('/git/refs')),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const blobsOf = (tree) => tree.filter((entry) => entry.type === 'blob');
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('GitHub requests include the required User-Agent header', async () => {
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_url, options) => {
    headers = options.headers;
    return new Response(JSON.stringify({ login: 'octo' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await githubRequest({ access_token: 'secret' }, '/user');
    assert.equal(headers['User-Agent'], 'GitFiles-Worker');
    assert.equal(headers.Authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('me fails closed when D1 is not configured', async () => {
  const { response, body } = await responseJson('/api/me', {});
  assert.equal(response.status, 503);
  assert.equal(body.error, 'service_unavailable');
});

test('repo list requires a session cookie', async () => {
  const { response, body } = await responseJson('/api/repos', { DB: dbWith() });
  assert.equal(response.status, 401);
  assert.equal(body.error, 'unauthorized');
});

test('logout revokes the D1 session and clears its cookie', async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                statements.push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  const { response, body } = await responseJson('/api/logout', env, {
    method: 'POST',
    headers: { Cookie: 'gitfiles_session=s1', Origin: 'https://gitfiles.example' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /DELETE FROM repository_access/);
  assert.match(statements[1].sql, /DELETE FROM sessions/);
  assert.match(response.headers.get('Set-Cookie'), /gitfiles_session=;/);
});

test('repository reads reject an uncached repository without GitHub read permission', async () => {
  const env = {
    DB: dbWith({
      session: { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 60_000 },
      access: null,
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ permissions: { pull: false, push: false } }), { status: 200 });
  try {
    const { response, body } = await responseJson('/api/repos/octo/private/tree?branch=main', env, {
      headers: { Cookie: 'gitfiles_session=s1' },
    });
    assert.equal(response.status, 403);
    assert.equal(body.error, 'forbidden');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uncached repository access is discovered from GitHub and persisted', async () => {
  const writes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { return sql.startsWith('SELECT can_read') ? null : null; },
              async run() { writes.push({ sql, args }); return { success: true }; },
            };
          },
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ permissions: { pull: true, push: true } }), { status: 200 });
  try {
    const access = await requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'repo', true);
    assert.equal(access.can_read, 1);
    assert.equal(access.can_write, 1);
    assert.equal(typeof access.checked_at, 'number');
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /INSERT OR REPLACE INTO repository_access/);
    assert.match(writes[0].sql, /checked_at/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a fresh cached ACL is reused without calling GitHub', async () => {
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() { return { can_read: 1, can_write: 1, checked_at: Date.now() }; },
              async run() { throw new Error('a fresh ACL must not be rewritten'); },
            };
          },
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response('{}', { status: 200 }); };
  try {
    const access = await requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'repo');
    assert.equal(access.can_write, 1);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a stale cached ACL is re-validated so revoked write access is not trusted', async () => {
  const writes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              // Row exists but its checked_at is old, and it claims can_write=1.
              async first() { return { can_read: 1, can_write: 1, checked_at: Date.now() - 60 * 60 * 1000 }; },
              async run() { writes.push({ sql, args }); return { success: true }; },
            };
          },
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  // GitHub now reports read-only (the collaborator was downgraded).
  globalThis.fetch = async () => new Response(JSON.stringify({ permissions: { pull: true, push: false } }), { status: 200 });
  try {
    await assert.rejects(
      () => requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'repo', true),
      (error) => error.status === 403
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[4], 0, 'can_write must be persisted as revoked');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a repository the session cannot see is reported as 403, not 404', async () => {
  const env = {
    DB: {
      prepare() {
        return { bind() { return { async first() { return null; }, async run() { return { success: true }; } }; } };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  try {
    await assert.rejects(
      () => requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'secret-repo'),
      (error) => error.status === 403
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('operations require same-origin and reject before GitHub access', async () => {
  const env = {
    DB: dbWith({
      session: { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 60_000 },
      access: { can_read: 1, can_write: 1 },
    }),
  };
  const { response, body } = await responseJson('/api/repos/octo/private/operations', env, {
    method: 'POST',
    headers: { Cookie: 'gitfiles_session=s1', 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ branch: 'main', expectedHead: 'a', operations: [{ type: 'delete', path: 'a.md' }] }),
  });
  assert.equal(response.status, 403);
  assert.equal(body.error, 'forbidden');
});

test('OAuth token exchange allows credentialed same-origin session responses', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    const payload = fetchCount === 1 ? { access_token: 'secret', expires_in: 3600 } : { login: 'octo' };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    const env = {
      GITHUB_CLIENT_SECRET: 'secret',
      DB: {
        prepare() {
          return { bind() { return { async first() { return null; }, async run() { return { success: true }; } }; } };
        },
      },
    };
    const response = await worker.fetch(request('/api/github/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://gitfiles.example' },
      body: JSON.stringify({ client_id: 'client', code: 'code', code_verifier: 'verifier' }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.match(response.headers.get('Set-Cookie'), /HttpOnly/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OAuth token exchange never returns an access token', async () => {
  const { response, body } = await responseJson('/api/github/oauth/token', {}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://gitfiles.example' },
    body: JSON.stringify({ client_id: 'reachability-check' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, proxy: 'worker' });
  assert.equal(Object.hasOwn(body, 'access_token'), false);
});

test('Worker mutation reuses a Blob SHA for rename and performs one CAS ref update', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [{ path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-A' }] }
      : path.endsWith('/git/trees') ? { sha: 'tree-B' }
      : path.endsWith('/git/commits') ? { sha: 'head-B' }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', message: 'Rename a.md',
      operations: [{ type: 'rename', from: 'a.md', to: 'b.md' }],
    });
    assert.equal(result.head, 'head-B');
    assert.equal(calls.filter((call) => call.path.endsWith('/git/blobs')).length, 0);
    const tree = calls.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST');
    assert.ok(tree);
    const treeBody = JSON.parse(tree.body);
    assert.deepEqual(treeBody.tree, [{ path: 'b.md', mode: '100644', type: 'blob', sha: 'blob-A' }]);
    assert.equal(Object.hasOwn(treeBody, 'base_tree'), false);
    const ref = calls.find((call) => call.path.endsWith('/git/refs/heads/main'));
    assert.equal(ref.method, 'PATCH');
    assert.deepEqual(JSON.parse(ref.body), { sha: 'head-B', force: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a truncated recursive tree is walked through subtrees instead of blocking the write', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith('/branches/main')
      ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      // Root listing is truncated, so the reader must descend into `docs`.
      : path.endsWith('/git/trees/head-A')
        ? { sha: 'tree-A', truncated: true, tree: [{ path: 'visible.md', type: 'blob', sha: 'blob-A' }, { path: 'docs', type: 'tree', sha: 'tree-docs' }] }
        : path.endsWith('/git/trees/tree-docs')
          ? { sha: 'tree-docs', tree: [{ path: 'guide.md', mode: '100644', type: 'blob', sha: 'blob-B' }] }
          : path.endsWith('/git/trees') ? { sha: 'tree-B' }
            : path.endsWith('/git/commits') ? { sha: 'head-B' }
              : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'new.md', content: 'new' }],
    });
    // The subtree was fetched with the correct path prefix.
    assert.equal(calls.some((call) => call.path.endsWith('/git/trees/tree-docs')), true);
    const treeCall = calls.find((call) => call.path === '/repos/octo/repo/git/trees' && call.method === 'POST');
    assert.ok(treeCall, 'a new tree must still be created');
    const body = JSON.parse(treeCall.body);
    const paths = body.tree.map((entry) => entry.path).sort();
    // The lazy walk must recover the nested blob, not silently drop it.
    assert.deepEqual(paths, ['docs/guide.md', 'new.md', 'visible.md']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker preserves gitlink entries in rewritten trees', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [{ path: 'module', mode: '160000', type: 'commit', sha: 'commit-module' }] }
      : path.endsWith('/git/trees') ? { sha: 'tree-B' }
      : path.endsWith('/git/commits') ? { sha: 'head-B' }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'new.md', content: 'new' }],
    });
    const tree = calls.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST');
    assert.match(tree.body, /commit-module/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker encodes large byte arrays in chunks and rejects invalid bytes', async () => {
  const originalFetch = globalThis.fetch;
  let blobBody;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/branches/main')) return new Response(JSON.stringify({ commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }), { status: 200 });
    if (path.endsWith('/git/trees/head-A')) return new Response(JSON.stringify({ sha: 'tree-A', tree: [] }), { status: 200 });
    if (path.endsWith('/git/blobs')) { blobBody = JSON.parse(options.body); return new Response(JSON.stringify({ sha: 'blob-A' }), { status: 201 }); }
    return new Response(JSON.stringify({ sha: 'tree-B' }), { status: 200 });
  };
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'image.bin', content: Array(200000).fill(65) }],
    });
    assert.equal(blobBody.encoding, 'base64');
    assert.equal(blobBody.content.length, 266668);
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'bad.bin', content: [256] }],
      }),
      (error) => error.status === 422
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker accepts pre-encoded base64 content and forwards it unchanged', async () => {
  // 客户端二进制上传改为 base64 + encoding:'base64'（避免把 Uint8Array 展开成
  // 数字数组）。Worker 必须原样透传，而不是把 base64 文本再当 utf-8 编码一遍。
  const originalFetch = globalThis.fetch;
  const blobBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/branches/main')) return new Response(JSON.stringify({ commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }), { status: 200 });
    if (path.endsWith('/git/trees/head-A')) return new Response(JSON.stringify({ sha: 'tree-A', tree: [] }), { status: 200 });
    if (path.endsWith('/git/blobs')) { blobBodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ sha: 'blob-A' }), { status: 201 }); }
    return new Response(JSON.stringify({ sha: 'tree-B' }), { status: 200 });
  };
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const encoded = bytes.toString('base64');
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A',
      operations: [{ type: 'create', path: 'blob.bin', content: encoded, encoding: 'base64' }],
    });
    assert.equal(blobBodies.length, 1);
    assert.equal(blobBodies[0].encoding, 'base64');
    assert.equal(blobBodies[0].content, encoded, 'base64 内容必须原样透传');
    assert.deepEqual([...Buffer.from(blobBodies[0].content, 'base64')], [...bytes]);
    // 带换行的 base64（常见于多行编码）应被规范化后接受
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A',
      operations: [{ type: 'create', path: 'wrapped.bin', content: `${encoded.slice(0, 4)}\n${encoded.slice(4)}`, encoding: 'base64' }],
    });
    assert.equal(blobBodies[1].content, encoded);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker rejects malformed or unsupported content encodings with 422', async () => {
  const originalFetch = globalThis.fetch;
  let blobCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/blobs')) blobCalls += 1;
    if (path.endsWith('/branches/main')) return new Response(JSON.stringify({ commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }), { status: 200 });
    if (path.endsWith('/git/trees/head-A')) return new Response(JSON.stringify({ sha: 'tree-A', tree: [] }), { status: 200 });
    return new Response(JSON.stringify({ sha: 'blob-A' }), { status: 201 });
  };
  try {
    // 非法字符
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'bad.bin', content: 'not*base64', encoding: 'base64' }],
      }),
      (error) => error.status === 422
    );
    // 长度不是 4 的倍数
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'bad2.bin', content: 'AAAAA', encoding: 'base64' }],
      }),
      (error) => error.status === 422
    );
    // 未知 encoding
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'bad3.bin', content: 'AAAA', encoding: 'utf-16' }],
      }),
      (error) => error.status === 422
    );
    // base64 非字符串
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'bad4.bin', content: [1, 2, 3], encoding: 'base64' }],
      }),
      (error) => error.status === 422
    );
    assert.equal(blobCalls, 0, '非法内容不得产生任何 Blob 上传');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker enforces the 25 MB limit on decoded base64 before calling GitHub', async () => {
  const originalFetch = globalThis.fetch;
  let blobCalls = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/blobs')) blobCalls += 1;
    if (path.endsWith('/branches/main')) return new Response(JSON.stringify({ commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }), { status: 200 });
    if (path.endsWith('/git/trees/head-A')) return new Response(JSON.stringify({ sha: 'tree-A', tree: [] }), { status: 200 });
    return new Response(JSON.stringify({ sha: 'blob-A' }), { status: 201 });
  };
  // 26MB 原始字节 → base64 长度 4/3，全为 'A' 也是合法 base64
  const oversized = 'A'.repeat(Math.ceil((26 * 1024 * 1024) / 3) * 4);
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'huge.bin', content: oversized, encoding: 'base64' }],
      }),
      (error) => error.status === 422 && /25 MB/.test(error.message)
    );
    assert.equal(blobCalls, 0, '超限内容必须在调用 GitHub 之前就失败');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


  const originalFetch = globalThis.fetch;
test('Worker delete sends a complete tree without the deleted path', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [
        { path: 'delete.md', mode: '100644', type: 'blob', sha: 'blob-delete' },
        { path: 'keep.md', mode: '100644', type: 'blob', sha: 'blob-keep' },
      ] }
      : path.endsWith('/git/trees') ? { sha: 'tree-B' }
      : path.endsWith('/git/commits') ? { sha: 'head-B' }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'delete', path: 'delete.md' }],
    });
    assert.equal(result.head, 'head-B');
    const tree = calls.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST');
    const body = JSON.parse(tree.body);
    assert.deepEqual(body.tree, [{ path: 'keep.md', mode: '100644', type: 'blob', sha: 'blob-keep' }]);
    assert.equal(Object.hasOwn(body, 'base_tree'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker mutation rejects stale expectedHead before tree writes', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ commit: { sha: 'head-B', commit: { tree: { sha: 'tree-B' } } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A', operations: [{ type: 'delete', path: 'a.md' }],
      }),
      (error) => error.status === 409 && error.code === 'conflict'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker initializes an empty repository with one ref create', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.endsWith('/branches/main')) {
      return new Response(JSON.stringify({ message: 'Branch not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const payload = path.endsWith('/git/blobs') ? { sha: 'blob-A' }
      : path.endsWith('/git/trees') ? { sha: 'tree-A' }
      : path.endsWith('/git/commits') ? { sha: 'head-A' }
      : {};
    return new Response(JSON.stringify(payload), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: null, operations: [{ type: 'create', path: 'first.md', content: 'first' }],
    });
    assert.equal(result.head, 'head-A');
    const ref = calls.find((call) => call.path.endsWith('/git/refs'));
    assert.equal(ref.method, 'POST');
    assert.deepEqual(JSON.parse(ref.body), { ref: 'refs/heads/main', sha: 'head-A' });
    assert.equal(calls.some((call) => call.path.endsWith('/git/refs/heads/main')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker maps concurrent initial ref creation to conflict', async () => {
  const originalFetch = globalThis.fetch;
  let branchCalls = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/branches/main')) {
      branchCalls += 1;
      const payload = branchCalls === 1 ? { message: 'Branch not found' } : { commit: { sha: 'head-other', commit: { tree: { sha: 'tree-other' } } } };
      return new Response(JSON.stringify(payload), { status: branchCalls === 1 ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
    }
    const status = path.endsWith('/git/refs') ? 422 : 201;
    const payload = path.endsWith('/git/blobs') ? { sha: 'blob-A' }
      : path.endsWith('/git/trees') ? { sha: 'tree-A' }
      : path.endsWith('/git/commits') ? { sha: 'head-A' }
      : { message: 'Reference already exists' };
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: null, operations: [{ type: 'create', path: 'first.md', content: 'first' }],
      }),
      (error) => error.status === 409 && error.details?.remoteHead === 'head-other'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Encoding, path normalization, rate limits and streaming (review follow-ups)
// ---------------------------------------------------------------------------

test('content with a lone surrogate is rejected as 422 validation_error, not a 500', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [] }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        // A truncated UTF-8 sequence decodes to a lone surrogate in JS.
        branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'a.txt', content: 'abc\uD800def' }],
      }),
      (error) => error.status === 422 && error.code === 'validation_error'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NFD and NFC spellings of a path resolve to the same NFC repository path', async () => {
  const originalFetch = globalThis.fetch;
  let treeBody = null;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/trees') && options.method === 'POST') treeBody = JSON.parse(options.body);
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [] }
      : path.endsWith('/git/blobs') ? { sha: 'blob-A' }
      : path.endsWith('/git/trees') ? { sha: 'tree-B' }
      : path.endsWith('/git/commits') ? { sha: 'head-B' }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // "e" + combining acute (NFD) must be stored as the precomposed NFC form.
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'cafe\u0301.md', content: 'x' }],
    });
    assert.equal(treeBody.tree[0].path, 'caf\u00e9.md');
    assert.equal(treeBody.tree[0].path.normalize('NFC'), treeBody.tree[0].path);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('delete of a path that never existed reports skipped with missingPaths', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [{ path: 'real.md', type: 'blob', sha: 'blob-A' }] }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'delete', path: 'never/existed.md' }],
    });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.missingPaths, ['never/existed.md']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rate limit errors preserve Retry-After for client backoff', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '42', 'X-RateLimit-Reset': '1700000000' },
  });
  try {
    await assert.rejects(
      () => githubRequest({ access_token: 'secret' }, '/user'),
      (error) => error.status === 429
        && error.details?.retryAfter === 42
        && error.details?.resetAt === 1700000000000
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('file download streams the upstream body and forwards Range/206', async () => {
  const originalFetch = globalThis.fetch;
  let sentRange = null;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.includes('/contents/')) {
      sentRange = options.headers?.Range ?? null;
      return new Response('BINARY', {
        status: 206,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '6', 'Content-Range': 'bytes 0-5/100' },
      });
    }
    return new Response(JSON.stringify({ permissions: { pull: true, push: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const env = { DB: dbWith({ session: { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 100000 } }) };
  try {
    const response = await worker.fetch(
      request('/api/repos/octo/repo/file?branch=main&path=img.png', { headers: { Cookie: 'gitfiles_session=s1', Range: 'bytes=0-5' } }),
      env
    );
    assert.equal(response.status, 206);
    assert.equal(sentRange, 'bytes=0-5');
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-5/100');
    assert.equal(await response.text(), 'BINARY');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('operations on a pre-existing NFD path still match after NFC normalization', async () => {
  const originalFetch = globalThis.fetch;
  let treeBody = null;
  // The repository already stores the NFD spelling from before the NFC change.
  const nfdPath = 'cafe\u0301.md';
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/trees') && options.method === 'POST') treeBody = JSON.parse(options.body);
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [{ path: nfdPath, type: 'blob', sha: 'blob-NFD' }] }
      : path.endsWith('/git/trees') ? { sha: 'tree-B' }
        : path.endsWith('/git/commits') ? { sha: 'head-B' }
          : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // Rename it to a new NFC name; older NFD paths must not become undeletable.
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A',
      operations: [{ type: 'rename', from: 'cafe\u0301.md', to: 'renamed.md' }],
    });
    const paths = treeBody.tree.map((entry) => entry.path);
    assert.deepEqual(paths, ['renamed.md']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleting a pre-existing NFD path removes it instead of failing', async () => {
  const originalFetch = globalThis.fetch;
  let treeBody = null;
  const nfdPath = 'cafe\u0301.md';
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/trees') && options.method === 'POST') treeBody = JSON.parse(options.body);
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [{ path: nfdPath, type: 'blob', sha: 'blob-NFD' }, { path: 'keep.md', type: 'blob', sha: 'blob-K' }] }
        : path.endsWith('/git/trees') ? { sha: 'tree-B' }
          : path.endsWith('/git/commits') ? { sha: 'head-B' }
            : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations: [{ type: 'delete', path: 'cafe\u0301.md' }],
    });
    assert.deepEqual(treeBody.tree.map((entry) => entry.path), ['keep.md']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 可选列兼容：sessions.github_avatar 是后加的列，未执行 migration 的部署
// 必须仍能登录（INSERT 若引用不存在的列会让用户彻底无法登录）
// ---------------------------------------------------------------------------

/**
 * 可选列兼容测试（github_avatar / checked_at / refresh_token…）。
 *
 * 实现用 PRAGMA table_info 内省真实列名后动态拼语句，
 * 所以 mock 的核心是按场景返回不同的列清单，并按列清单校验读写。
 */
function makeColumnAwareDb({ sessions, repositoryAccess, failSql }) {
  const statements = [];
  const fail = failSql || (() => false);
  const tableOf = (sql) => (sql.includes('sessions') ? 'sessions' : 'repository_access');
  const colsOf = { sessions, repository_access: repositoryAccess };
  const used = { sessions: [], repository_access: [] };
  const db = {
    statements,
    used,
    DB: {
      prepare(sql) {
        if (/PRAGMA table_info/.test(sql)) {
          const table = sql.includes('repository_access') ? 'repository_access' : 'sessions';
          const cols = colsOf[table] || [];
          const all = async () => ({ results: cols.map((name) => ({ name })) });
          return { all, bind: () => ({ all }) };
        }
        return {
          bind(...args) {
            return {
              async first() {
                if (fail(sql)) throw new Error('D1_ERROR: forced failure');
                used[tableOf(sql)].push({ sql, args });
                return null;
              },
              async all() {
                if (fail(sql)) throw new Error('D1_ERROR: forced failure');
                used[tableOf(sql)].push({ sql, args });
                return { results: [] };
              },
              async run() {
                if (fail(sql)) throw new Error('D1_ERROR: forced failure');
                used[tableOf(sql)].push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  return db;
}

const LEGACY_DB = { sessions: ['id', 'github_login', 'access_token', 'expires_at', 'created_at'], repository_access: ['session_id', 'owner', 'repo', 'can_read', 'can_write'] };
const FULL_DB = {
  sessions: [...LEGACY_DB.sessions, 'github_avatar', 'refresh_token', 'refresh_expires_at', 'client_id'],
  repository_access: [...LEGACY_DB.repository_access, 'checked_at'],
};

test('insertSession omits github_avatar when the database lacks the column', async () => {
  __resetSessionColumnCache();
  const env = makeColumnAwareDb({ sessions: LEGACY_DB.sessions, repositoryAccess: LEGACY_DB.repository_access });
  await insertSession(env, { id: 's1', login: 'octo', avatar: 'https://example/a.png', accessToken: 't', expiresAt: 1 });
  const stmt = env.used.sessions[0];
  assert.ok(!/github_avatar/.test(stmt.sql), '旧库上不得引用 github_avatar');
  assert.ok(!/refresh_token/.test(stmt.sql), '旧库上不得引用 refresh_token');
});

test('insertSession stores refresh credentials when the columns exist', async () => {
  __resetSessionColumnCache();
  const env = makeColumnAwareDb({ sessions: FULL_DB.sessions, repositoryAccess: FULL_DB.repository_access });
  await insertSession(env, {
    id: 's2', login: 'octo', avatar: 'https://example/a.png', accessToken: 't', expiresAt: 2,
    refreshToken: 'r', refreshExpiresAt: 99, clientId: 'Ov23x',
  });
  const stmt = env.used.sessions[0];
  assert.ok(/refresh_token/.test(stmt.sql) && /client_id/.test(stmt.sql));
  assert.ok(stmt.args.includes('r') && stmt.args.includes('Ov23x'));
});

test('an expired GitHub App session is silently renewed via refresh_token', async () => {
  __resetSessionColumnCache();
  const env = makeColumnAwareDb({ sessions: FULL_DB.sessions, repositoryAccess: FULL_DB.repository_access });
  // selectSession 返回一条已过期的行（8 小时前创建的 GitHub App 会话）
  env.DB.prepare = ((orig) => (sql) => {
    if (/PRAGMA table_info/.test(sql)) return orig(sql);
    if (/FROM sessions WHERE id = /.test(sql)) {
      return { bind() { return { async first() { return { id: 's1', github_login: 'octo', access_token: 'old', expires_at: Date.now() - 1000, refresh_token: 'r1', refresh_expires_at: Date.now() + 86400000, client_id: 'Ov23x' }; } }; } };
    }
    if (/UPDATE sessions SET/.test(sql)) {
      return { bind(...args) { return { async run() { env.used.sessions.push({ sql, args }); return { success: true }; } }; } };
    }
    return orig(sql);
  })(env.DB.prepare);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('login/oauth/access_token')) {
      assert.equal(JSON.parse(options.body).grant_type, 'refresh_token');
      assert.equal(JSON.parse(options.body).refresh_token, 'r1');
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 28800, refresh_token: 'r2', refresh_token_expires_in: 5184000 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const response = await worker.fetch(request('/api/me', { headers: { Cookie: 'gitfiles_session=s1' } }), env);
    assert.equal(response.status, 200);
    // github_avatar 为空时 /api/me 按 login 推导头像（既有回退行为）
    assert.deepEqual(await response.json(), { login: 'octo', avatar: 'https://avatars.githubusercontent.com/octo' });
    const update = env.used.sessions.find((s) => /UPDATE sessions SET/.test(s.sql));
    assert.ok(update, '应把续期结果写回 session');
    assert.ok(update.args.includes('new') && update.args.includes('r2'), '新 access/refresh token 都要落库（GitHub 会轮换 refresh_token）');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired session without refresh_token still returns 401', async () => {
  __resetSessionColumnCache();
  const env = makeColumnAwareDb({ sessions: LEGACY_DB.sessions, repositoryAccess: LEGACY_DB.repository_access });
  env.DB.prepare = ((orig) => (sql) => {
    if (/PRAGMA table_info/.test(sql)) return orig(sql);
    if (/FROM sessions WHERE id = /.test(sql)) {
      return { bind() { return { async first() { return { id: 's1', github_login: 'octo', access_token: 'old', expires_at: Date.now() - 1000 }; } }; } };
    }
    return orig(sql);
  })(env.DB.prepare);
  const response = await worker.fetch(request('/api/me', { headers: { Cookie: 'gitfiles_session=s1' } }), env);
  assert.equal(response.status, 401);
});

test('a failed refresh is not masked as success', async () => {
  __resetSessionColumnCache();
  const env = makeColumnAwareDb({ sessions: FULL_DB.sessions, repositoryAccess: FULL_DB.repository_access });
  env.DB.prepare = ((orig) => (sql) => {
    if (/PRAGMA table_info/.test(sql)) return orig(sql);
    if (/FROM sessions WHERE id = /.test(sql)) {
      return { bind() { return { async first() { return { id: 's1', github_login: 'octo', access_token: 'old', expires_at: Date.now() - 1000, refresh_token: 'r1', client_id: 'Ov23x' }; } }; } };
    }
    return orig(sql);
  })(env.DB.prepare);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 400 });
  try {
    const response = await worker.fetch(request('/api/me', { headers: { Cookie: 'gitfiles_session=s1' } }), env);
    assert.equal(response.status, 401, '续期失败必须如实返回 401，不得伪装成功');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requireRepositoryAccess tolerates a database without repository_access.checked_at', async () => {
  __resetSessionColumnCache();
  const writes = [];
  const env = makeColumnAwareDb({ sessions: FULL_DB.sessions, repositoryAccess: LEGACY_DB.repository_access });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ permissions: { pull: true, push: true } }), { status: 200 });
  try {
    const access = await requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'repo', true);
    assert.equal(access.can_write, 1);
    const write = env.used.repository_access.find((s) => /INSERT OR REPLACE/.test(s.sql));
    assert.ok(write && !/checked_at/.test(write.sql), '旧库上不得引用 checked_at');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a repository_access row read from a legacy database counts as stale', async () => {
  __resetSessionColumnCache();
  let githubCalls = 0;
  const env = makeColumnAwareDb({ sessions: FULL_DB.sessions, repositoryAccess: LEGACY_DB.repository_access });
  // 旧库返回的行没有 checked_at
  env.DB.prepare = ((orig) => (sql) => {
    if (/PRAGMA table_info/.test(sql)) return orig(sql);
    if (/FROM repository_access WHERE/.test(sql)) {
      return { bind() { return { async first() { return { can_read: 1, can_write: 1 }; } }; } };
    }
    if (/INSERT OR REPLACE INTO repository_access/.test(sql)) {
      return { bind(...args) { return { async run() { env.used.repository_access.push({ sql, args }); return { success: true }; } }; } };
    }
    return orig(sql);
  })(env.DB.prepare);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { githubCalls += 1; return new Response(JSON.stringify({ permissions: { pull: true, push: true } }), { status: 200 }); };
  try {
    await requireRepositoryAccess(env, { id: 's1', access_token: 'secret' }, 'octo', 'repo');
    assert.equal(githubCalls, 1, '旧库行缺时间戳，必须回源校验一次');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('API responses carry Cache-Control: no-store so PWA reopen never uses a stale cookie state', async () => {
  const env = { DB: dbWith({ session: { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 100000 } }) };
  const response = await worker.fetch(request('/api/me', { headers: { Cookie: 'gitfiles_session=s1' } }), env);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  // 文件字节流之外的 JSON 端点（含设置会话 Cookie 的登录响应）也一律禁止缓存
  const login = await worker.fetch(
    new Request('https://gitfiles.example/api/github/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://gitfiles.example' }, body: '{}' }),
    { GITHUB_CLIENT_SECRET: 'x', DB: dbWith() }
  );
  assert.equal(login.headers.get('cache-control'), 'no-store');
});

test('session cookie declares Max-Age as its own attribute (was silently a session cookie)', () => {
  // 登录响应的 Set-Cookie 必须把 Max-Age 解析为独立属性。
  // 曾经 cookieAttributes 缺尾分号，SameSite=Lax 与 Max-Age 被并成一个非法
  // 属性整体丢弃 → Max-Age 从未生效 → Cookie 退化为会话级
  // → PWA 每次关闭重开都要重新登录。
  for (const secure of [true, false]) {
    const request = new Request(secure ? 'https://x.example/' : 'http://x.example/');
    const setCookie = sessionCookie('abc123', 604800, request);
    const attrs = setCookie.split(';').map((a) => a.trim());
    const maxAge = attrs.find((a) => a.startsWith('Max-Age='));
    assert.ok(maxAge, `Max-Age 必须是独立属性，实际: ${setCookie}`);
    assert.equal(maxAge, 'Max-Age=604800');
    const sameSite = attrs.find((a) => a.startsWith('SameSite='));
    assert.equal(sameSite, 'SameSite=Lax', 'SameSite 属性值不得混入其他内容');
    assert.ok(attrs.includes('HttpOnly'), 'HttpOnly 必须齐备');
    assert.equal(attrs.includes('Secure'), secure, 'Secure 应随协议出现');
  }
  // 注销 Cookie 同样必须能独立声明 Max-Age
  const cleared = clearSessionCookie(new Request('https://x.example/'));
  assert.ok(cleared.split(';').some((a) => a.trim() === 'Max-Age=0'));
});

// ---------------------------------------------------------------------------
// Blob 去重：字节数组只按长度分组，内容必须复核后才允许合并
// ---------------------------------------------------------------------------

/** 用固定的树跑一次 executeOperations，返回所有上游调用，便于断言 Blob 数量。 */
async function runByteBatch(operations) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let blobCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const payload = path.endsWith('/branches/main') ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A') ? { sha: 'tree-A', tree: [] }
        : path.endsWith('/git/blobs') ? { sha: `blob-${++blobCount}` }
          : path.endsWith('/git/trees') ? { sha: 'tree-B' }
            : path.endsWith('/git/commits') ? { sha: 'head-B' }
              : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
      branch: 'main', expectedHead: 'head-A', operations,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const treeCall = calls.find((call) => call.path.endsWith('/git/trees') && call.method === 'POST');
  return { calls, tree: JSON.parse(treeCall.body).tree };
}

test('byte arrays of equal length but different content never share a Blob', async () => {
  // 去重键只带长度（避免 join 造出上百 MB 字符串），因此内容必须复核：
  // 一旦误合并，两个文件会指向同一个 Blob SHA —— 静默数据损坏。
  const { calls, tree } = await runByteBatch([
    { type: 'create', path: 'a.bin', content: [1, 2, 3] },
    { type: 'create', path: 'b.bin', content: [4, 5, 6] },
  ]);
  assert.equal(calls.filter((call) => call.path.endsWith('/git/blobs')).length, 2);
  const shas = tree.filter((entry) => entry.type === 'blob').map((entry) => entry.sha);
  assert.equal(new Set(shas).size, 2, '内容不同的同长度文件必须得到不同的 Blob');
});

test('identical byte arrays still dedupe to a single Blob upload', async () => {
  const { calls, tree } = await runByteBatch([
    { type: 'create', path: 'a.bin', content: [7, 8, 9] },
    { type: 'create', path: 'b.bin', content: [7, 8, 9] },
  ]);
  assert.equal(calls.filter((call) => call.path.endsWith('/git/blobs')).length, 1);
  const shas = tree.filter((entry) => entry.type === 'blob').map((entry) => entry.sha);
  assert.equal(new Set(shas).size, 1, '内容相同的文件仍应复用同一个 Blob');
});

// ---------------------------------------------------------------------------
// ACL 刷新：整批仓库必须一次 batch 落库，而不是逐条 D1 往返
// ---------------------------------------------------------------------------

test('repository ACL refresh persists every repository in one D1 batch', async () => {
  // session.js 的列内省是模块级缓存，会被前面的「缺列旧库」用例污染。
  __resetSessionColumnCache();
  const batches = [];
  const columns = {
    sessions: ['id', 'github_login', 'github_avatar', 'refresh_token', 'refresh_expires_at', 'client_id', 'access_token', 'expires_at', 'created_at'],
    repository_access: ['session_id', 'owner', 'repo', 'can_read', 'can_write', 'checked_at'],
  };
  const env = {
    DB: {
      prepare(sql) {
        if (sql.startsWith('PRAGMA table_info')) {
          const table = sql.includes('repository_access') ? 'repository_access' : 'sessions';
          const all = async () => ({ results: columns[table].map((name) => ({ name })) });
          return { all, bind: () => ({ all }) };
        }
        return {
          bind(...args) {
            return {
              sql,
              args,
              async first() {
                if (sql.startsWith('SELECT id, github_login')) {
                  return { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 60_000 };
                }
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return { success: true }; },
            };
          },
        };
      },
      async batch(statements) { batches.push(statements); return []; },
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/user/repos') {
      return new Response(JSON.stringify([
        { name: 'alpha', owner: { login: 'octo' }, permissions: { pull: true, push: true } },
        { name: 'beta', owner: { login: 'octo' }, permissions: { pull: true, push: false } },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { response, body } = await responseJson('/api/repos?refresh=1', env, {
      headers: { Cookie: 'gitfiles_session=s1' },
    });
    assert.equal(response.status, 200);
    assert.equal(body.repositories.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(batches.length, 1, '两个仓库应合并为一次 batch');
  assert.equal(batches[0].length, 2, '每个仓库一条语句');
  for (const statement of batches[0]) {
    assert.match(statement.sql, /INSERT OR REPLACE INTO repository_access/);
    assert.equal(statement.args.length, 6);
  }
});

// ---------------------------------------------------------------------------
// §22 场景迁移：这些行为原先只被 js/github/*（历史引擎）的独立测试覆盖，
// 引擎删除后必须由生产实现 workers/operations.js 自己保证。
// ---------------------------------------------------------------------------

test('move rewrites a whole subtree and reuses every original Blob SHA', async () => {
  const { tree, blobsCreated, commitCalls, refCalls } = await runMutation({
    treeEntries: [
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: 'docs/sub/b.md', mode: '100644', type: 'blob', sha: 'blob-b' },
      { path: 'keep.md', mode: '100644', type: 'blob', sha: 'blob-k' },
    ],
    operations: [{ type: 'move', from: 'docs', to: 'archive/docs' }],
  });
  assert.equal(blobsCreated, 0, 'Move 不得重新创建 Blob');
  assert.equal(commitCalls.length, 1, '批量 = 一个 commit');
  assert.equal(refCalls.length, 1);
  assert.deepEqual(tree.map((entry) => [entry.path, entry.sha]), [
    ['archive/docs/a.md', 'blob-a'],
    ['archive/docs/sub/b.md', 'blob-b'],
    ['keep.md', 'blob-k'],
  ]);
});

test('copy duplicates a subtree with the same Blob SHAs and keeps the source', async () => {
  const { tree, blobsCreated, commitCalls } = await runMutation({
    treeEntries: [
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: 'docs/sub/b.md', mode: '100644', type: 'blob', sha: 'blob-b' },
    ],
    operations: [{ type: 'copy', from: 'docs', to: 'docs-copy' }],
  });
  assert.equal(blobsCreated, 0, 'Copy 必须复用 Blob SHA');
  assert.equal(commitCalls.length, 1);
  assert.deepEqual(tree.map((entry) => [entry.path, entry.sha]), [
    ['docs-copy/a.md', 'blob-a'],
    ['docs-copy/sub/b.md', 'blob-b'],
    ['docs/a.md', 'blob-a'],
    ['docs/sub/b.md', 'blob-b'],
  ]);
});

test('mkdir creates folder/.keep as an empty Blob', async () => {
  const { tree, blobsCreated } = await runMutation({
    treeEntries: [],
    operations: [{ type: 'mkdir', path: 'newdir' }],
  });
  assert.equal(blobsCreated, 1);
  assert.deepEqual(tree.map((entry) => [entry.path, entry.sha]), [['newdir/.keep', 'blob-new-1']]);
});

test('mkdir reuses the well-known empty Blob SHA when the repository already has it', async () => {
  // e69de29... 是 Git 空 Blob 的内容寻址 SHA，全局唯一；仓库里已存在时
  // 不应再为空 .keep 上传一次 Blob。
  const empty = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const { tree, blobsCreated } = await runMutation({
    treeEntries: [{ path: 'old/.keep', mode: '100644', type: 'blob', sha: empty }],
    operations: [{ type: 'mkdir', path: 'newdir' }],
  });
  assert.equal(blobsCreated, 0, '空 Blob 已存在时不应再上传');
  assert.deepEqual(tree.map((entry) => [entry.path, entry.sha]), [
    ['newdir/.keep', empty],
    ['old/.keep', empty],
  ]);
});

test('delete of a directory removes every descendant in one commit', async () => {
  const { tree, commitCalls } = await runMutation({
    treeEntries: [
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: 'docs/sub/b.md', mode: '100644', type: 'blob', sha: 'blob-b' },
      { path: 'keep.md', mode: '100644', type: 'blob', sha: 'blob-k' },
    ],
    operations: [{ type: 'delete', path: 'docs' }],
  });
  assert.deepEqual(tree.map((entry) => entry.path), ['keep.md']);
  assert.equal(commitCalls.length, 1);
});

test('create, update and rename inside an existing directory are allowed', async () => {
  // 回归：早先 taken() 把祖先的「目录前缀」当成冲突，导致往**已存在**的目录里
  // 新建/重命名文件一律 422（`docs/new.md`、`docs/a.md → docs/b.md` 都失败），
  // 只有顶层文件或写入一个全新目录才能成功。目录只是前缀、不是条目。
  const created = await runMutation({
    treeEntries: [{ path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-a' }],
    operations: [{ type: 'create', path: 'docs/new.md', content: 'x' }],
  });
  assert.deepEqual(created.tree.map((entry) => entry.path), ['docs/a.md', 'docs/new.md']);

  const renamed = await runMutation({
    treeEntries: [{ path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'blob-a' }],
    operations: [{ type: 'rename', from: 'docs/a.md', to: 'docs/b.md' }],
  });
  assert.deepEqual(renamed.tree.map((entry) => [entry.path, entry.sha]), [['docs/b.md', 'blob-a']]);
  assert.equal(renamed.blobsCreated, 0, 'Rename 必须复用 Blob SHA');
});

test('a file ancestor still blocks writes beneath it', async () => {
  // 反向：祖先若是一个**文件**（条目），就不能在它下面建东西。
  await assert.rejects(
    () => runMutation({
      treeEntries: [{ path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-a' }],
      operations: [{ type: 'create', path: 'a.md/child.md', content: 'x' }],
    }),
    (error) => error.status === 422
  );
});

test('a mixed batch applies sequentially and produces exactly one commit', async () => {
  const { tree, commitCalls, refCalls } = await runMutation({
    treeEntries: [
      { path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-a' },
      { path: 'docs/b.md', mode: '100644', type: 'blob', sha: 'blob-b' },
      { path: 'old.md', mode: '100644', type: 'blob', sha: 'blob-old' },
    ],
    operations: [
      { type: 'delete', path: 'old.md' },
      { type: 'copy', from: 'a.md', to: 'a-copy.md' },
      { type: 'rename', from: 'docs/b.md', to: 'docs/c.md' },
      { type: 'create', path: 'new.md', content: 'hello' },
    ],
  });
  assert.equal(commitCalls.length, 1, '混合批处理必须只产生一个 commit');
  assert.equal(refCalls.length, 1);
  assert.deepEqual(tree.map((entry) => entry.path), ['a-copy.md', 'a.md', 'docs/c.md', 'new.md']);
  // copy 复用原 SHA，只有 create 需要新 Blob
  assert.equal(tree.find((entry) => entry.path === 'a-copy.md').sha, 'blob-a');
  assert.equal(tree.find((entry) => entry.path === 'docs/c.md').sha, 'blob-b');
});

test('a 100-operation batch still produces one commit', async () => {
  const operations = Array.from({ length: 100 }, (_, index) => ({
    type: 'create',
    path: `bulk/f${index}.txt`,
    content: `content-${index}`,
  }));
  const { tree, commitCalls, blobsCreated } = await runMutation({ treeEntries: [], operations });
  assert.equal(commitCalls.length, 1, '100 个文件必须只有一个 commit（AGENTS §3）');
  assert.equal(tree.length, 100);
  assert.equal(blobsCreated, 100, '内容各不相同 → 100 个 Blob');
});

test('create then update of the same path in one batch uploads the Blob once', async () => {
  const { tree, blobsCreated } = await runMutation({
    treeEntries: [],
    operations: [
      { type: 'create', path: 'draft.md', content: 'first' },
      { type: 'update', path: 'draft.md', content: 'second' },
    ],
  });
  assert.equal(blobsCreated, 1, '同一路径的中间态不应上传 Blob');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].path, 'draft.md');
});

test('a no-op batch (move onto itself) skips the commit entirely', async () => {
  const { result, commitCalls, calls } = await runMutation({
    treeEntries: [{ path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-a' }],
    operations: [{ type: 'move', from: 'a.md', to: 'a.md' }],
  });
  assert.equal(result.skipped, true);
  assert.equal(commitCalls.length, 0, '无变化不得产生 commit');
  assert.equal(calls.filter((call) => call.path.endsWith('/git/blobs')).length, 0);
});

test('batch operations apply sequentially: copying an earlier-renamed source fails', async () => {
  await assert.rejects(
    () => runMutation({
      treeEntries: [{ path: 'a.md', mode: '100644', type: 'blob', sha: 'blob-a' }],
      operations: [
        { type: 'rename', from: 'a.md', to: 'b.md' },
        { type: 'copy', from: 'a.md', to: 'c.md' },
      ],
    }),
    (error) => error.status === 422 && /not found/i.test(error.message)
  );
});

test('delete then recreate the same path in one batch is allowed', async () => {
  const { tree, blobsCreated } = await runMutation({
    treeEntries: [{ path: 'x.md', mode: '100644', type: 'blob', sha: 'blob-old' }],
    operations: [
      { type: 'delete', path: 'x.md' },
      { type: 'create', path: 'x.md', content: 'fresh' },
    ],
  });
  assert.deepEqual(tree.map((entry) => entry.path), ['x.md']);
  assert.equal(tree[0].sha, 'blob-new-1');
  assert.equal(blobsCreated, 1);
});

test('copying a file created earlier in the same batch reuses its deferred Blob', async () => {
  const { tree, blobsCreated } = await runMutation({
    treeEntries: [],
    operations: [
      { type: 'create', path: 'n.md', content: 'shared' },
      { type: 'copy', from: 'n.md', to: 'n2.md' },
    ],
  });
  assert.equal(blobsCreated, 1, '同一批内新建并复制只应上传一次 Blob');
  assert.equal(tree.length, 2);
  assert.equal(new Set(tree.map((entry) => entry.sha)).size, 1);
});

test('a 422 fast-forward ref update is reported as a conflict, not a validation error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/branches/main')) return jsonResponse({ commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } });
    if (path.endsWith('/git/trees/head-A')) return jsonResponse({ sha: 'tree-A', tree: [] });
    if (path.endsWith('/git/blobs')) return jsonResponse({ sha: 'blob-new-1' }, 201);
    if (path.endsWith('/git/trees') && options.method === 'POST') return jsonResponse({ sha: 'tree-B' });
    if (path.endsWith('/git/commits')) return jsonResponse({ sha: 'head-B' });
    if (path.includes('/git/refs/heads/main')) {
      return jsonResponse({ message: 'Update is not a fast forward' }, 422);
    }
    return jsonResponse({});
  };
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A',
        operations: [{ type: 'create', path: 'x.md', content: 'x' }],
      }),
      (error) => error.status === 409 && error.code === 'conflict'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


