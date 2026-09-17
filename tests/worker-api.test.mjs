import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/entry.js';
import { executeOperations } from '../workers/operations.js';
import { githubRequest } from '../workers/github.js';
import { __resetSessionColumnCache, insertSession, requireRepositoryAccess } from '../workers/session.js';

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
