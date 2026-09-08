import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/entry.js';
import { executeOperations } from '../workers/operations.js';

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

test('repository reads require explicit repository authorization', async () => {
  const env = {
    DB: dbWith({
      session: { id: 's1', github_login: 'octo', access_token: 'secret', expires_at: Date.now() + 60_000 },
      access: null,
    }),
  };
  const { response, body } = await responseJson('/api/repos/octo/private/tree?branch=main', env, {
    headers: { Cookie: 'gitfiles_session=s1' },
  });
  assert.equal(response.status, 403);
  assert.equal(body.error, 'forbidden');
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
    assert.deepEqual(JSON.parse(tree.body).tree, [{ path: 'b.md', mode: '100644', type: 'blob', sha: 'blob-A' }]);
    const ref = calls.find((call) => call.path.endsWith('/git/refs/heads/main'));
    assert.equal(ref.method, 'PATCH');
    assert.deepEqual(JSON.parse(ref.body), { sha: 'head-B', force: false });
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
