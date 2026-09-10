import { ApiError, assertSameOrigin, parseRepoPath, readJson, json } from './http.js';
import { requireRepositoryAccess, requireSession } from './session.js';
import { branchState, githubRaw, githubRequest, repoPrefix } from './github.js';
import { executeOperations } from './operations.js';

function defaultBranch(branch) {
  if (!branch || typeof branch !== 'string' || branch.length > 255) {
    throw new ApiError(422, 'validation_error', 'A valid branch is required');
  }
  return branch;
}

export async function handleRepositoryApi(request, env, url) {
  const session = await requireSession(request, env);
  const route = parseRepoPath(url.pathname);
  if (!route) return null;
  const { owner, repo, action } = route;

  if (request.method === 'GET' && action === '') {
    await requireRepositoryAccess(env, session, owner, repo);
    const { payload } = await githubRequest(session, repoPrefix(owner, repo));
    return json({ repository: payload });
  }

  if (request.method === 'GET' && action === 'branches') {
    await requireRepositoryAccess(env, session, owner, repo);
    const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/branches?per_page=100`);
    return json({ branches: payload });
  }

  if (request.method === 'GET' && action === 'history') {
    await requireRepositoryAccess(env, session, owner, repo);
    const branch = defaultBranch(url.searchParams.get('branch'));
    const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=30`);
    return json({ commits: payload });
  }

  if (request.method === 'GET' && action === 'tree') {
    await requireRepositoryAccess(env, session, owner, repo);
    const branch = defaultBranch(url.searchParams.get('branch'));
    const state = await branchState(session, owner, repo, branch);
    if (!state) return json({ head: null, treeSha: null, tree: [] });
    const { payload } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/trees/${encodeURIComponent(state.head)}?recursive=1`);
    if (payload?.truncated) {
      throw new ApiError(422, 'validation_error', 'Repository tree is too large to load safely');
    }
    const { payload: commit } = await githubRequest(session, `${repoPrefix(owner, repo)}/git/commits/${encodeURIComponent(state.head)}`);
    const updatedAt = commit?.committer?.date || commit?.author?.date || null;
    return json({ head: state.head, treeSha: payload.sha || state.treeSha, updatedAt, tree: payload.tree || [] });
  }

  if (request.method === 'GET' && action === 'file') {
    await requireRepositoryAccess(env, session, owner, repo);
    const branch = defaultBranch(url.searchParams.get('branch'));
    const path = url.searchParams.get('path');
    if (!path || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new ApiError(422, 'validation_error', 'A valid file path is required');
    }
    const raw = await githubRaw(session, `${repoPrefix(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    return new Response(raw.body, { headers: { 'Content-Type': raw.headers.get('content-type') || 'application/octet-stream' } });
  }

  if (request.method === 'POST' && action === 'operations') {
    assertSameOrigin(request);
    await requireRepositoryAccess(env, session, owner, repo, true);
    const body = await readJson(request);
    const branch = defaultBranch(body.branch);
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 1000) {
      throw new ApiError(422, 'validation_error', 'operations must contain between 1 and 1000 items');
    }
    if (body.expectedHead !== null && typeof body.expectedHead !== 'string') {
      throw new ApiError(422, 'validation_error', 'expectedHead must be a commit SHA or null for an empty branch');
    }
    const result = await executeOperations(session, owner, repo, {
      branch,
      expectedHead: body.expectedHead,
      operations: body.operations,
      message: typeof body.message === 'string' ? body.message.slice(0, 500) : 'Batch file operations',
    });
    return json(result);
  }

  throw new ApiError(404, 'not_found', 'Repository route was not found');
}

export async function createRepository(request, env) {
  assertSameOrigin(request);
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw new ApiError(422, 'validation_error', 'Repository name must contain only letters, numbers, dot, underscore, or hyphen');
  }
  const { payload: repository } = await githubRequest(session, '/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: body.private !== false, auto_init: true }),
  });
  await env.DB.prepare(
    'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write) VALUES (?, ?, ?, 1, 1)'
  ).bind(session.id, repository.owner.login, repository.name).run();
  return json({ repository }, 201);
}

export async function handleRepoList(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(
    'SELECT owner, repo, can_read, can_write FROM repository_access WHERE session_id = ? ORDER BY owner, repo'
  ).bind(session.id).all();
  const cached = rows.results || [];
  if (cached.length) return json({ repositories: cached });

  const discovered = [];
  for (let page = 1; page <= 10; page += 1) {
    const { payload } = await githubRequest(
      session,
      `/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`
    );
    const list = Array.isArray(payload) ? payload : [];
    discovered.push(...list);
    if (list.length < 100) break;
  }
  const statements = discovered.flatMap((repo) => {
    const owner = repo?.owner?.login;
    if (!owner || !repo?.name) return [];
    return [env.DB.prepare(
      'INSERT OR REPLACE INTO repository_access (session_id, owner, repo, can_read, can_write) VALUES (?, ?, ?, ?, ?)'
    ).bind(session.id, owner, repo.name, repo.permissions?.pull !== false ? 1 : 0, repo.permissions?.push || repo.permissions?.admin ? 1 : 0)];
  });
  if (statements.length && typeof env.DB.batch === 'function') await env.DB.batch(statements);
  else await Promise.all(statements.map((statement) => statement.run()));
  return json({ repositories: discovered.map((repo) => ({
    owner: repo.owner.login,
    repo: repo.name,
    can_read: repo.permissions?.pull !== false ? 1 : 0,
    can_write: repo.permissions?.push || repo.permissions?.admin ? 1 : 0,
  })) });
}
