import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/entry.js';
import { executeOperations } from '../workers/operations.js';
import { githubRequest } from '../workers/github.js';
import { requireRepositoryAccess } from '../workers/session.js';

function request(path, options = {}) {
  return new Request(`https://gitfiles.example${path}`, options);
}

function dbWith({ session = null, access = null } = {}) {
  return {
    prepare(sql) {
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
    assert.deepEqual(access, { can_read: 1, can_write: 1 });
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /INSERT OR REPLACE INTO repository_access/);
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

test('Worker rejects truncated trees before creating a new tree', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET' });
    const payload = path.endsWith('/branches/main')
      ? { commit: { sha: 'head-A', commit: { tree: { sha: 'tree-A' } } } }
      : path.endsWith('/git/trees/head-A')
        ? { sha: 'tree-A', truncated: true, tree: [{ path: 'visible.md', type: 'blob', sha: 'blob-A' }] }
        : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await assert.rejects(
      () => executeOperations({ access_token: 'secret' }, 'octo', 'repo', {
        branch: 'main', expectedHead: 'head-A', operations: [{ type: 'create', path: 'new.md', content: 'new' }],
      }),
      (error) => error.status === 422 && error.code === 'validation_error'
    );
    assert.equal(calls.some((call) => call.method === 'POST'), false);
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
