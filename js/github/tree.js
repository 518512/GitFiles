/**
 * GithubTree — repository tree reads + TreeIndex cache.
 *
 * Cache key (PROJECT_SPEC §6): owner/repo/branch/head — a stale head invalidates
 * the cached index automatically because the key no longer matches.
 * Plain browser global: `GithubTree`.
 */
(function registerGithubTree(global) {
  'use strict';

  const { request, GithubApiError } = global.GithubClient;

  const cache = new Map(); // `${owner}/${repo}/${branch}/${head}` -> { tree, treeSha }

  function cacheKey(owner, repo, branch, head) {
    return `${owner}/${repo}/${branch}/${head || ''}`;
  }

  function isRepositoryEmptyError(err) {
    const message = (err && (err.message || String(err))).toLowerCase();
    return /repository is empty|git repository is empty|no commit found/i.test(message);
  }

  /**
   * Read the full recursive tree at a commit.
   * @returns {Promise<{head:string, treeSha:string|null, tree:Array}>}
   */
  async function getTreeAt(owner, repo, branch, token, { head = null, treeSha = null, force = false } = {}) {
    if (!head) {
      const state = await global.GithubRepository.getBranchState(owner, repo, branch, token);
      if (!state) {
        return { head: null, treeSha: null, tree: [] };
      }
      head = state.head;
      treeSha = treeSha || state.treeSha;
    }

    const key = cacheKey(owner, repo, branch, head);
    if (!force && cache.has(key)) {
      const cached = cache.get(key);
      return { head, treeSha: cached.treeSha, tree: cached.tree };
    }

    try {
      const data = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(head)}?recursive=1`,
        { token }
      );
      const tree = data.tree || [];
      const resolvedTreeSha = data.sha || treeSha;
      cache.set(key, { tree, treeSha: resolvedTreeSha });
      return { head, treeSha: resolvedTreeSha, tree };
    } catch (err) {
      // Brand-new repos have no commits yet.
      if ((err instanceof GithubApiError && err.isNotFound) || isRepositoryEmptyError(err)) {
        cache.set(key, { tree: [], treeSha: null });
        return { head, treeSha: null, tree: [] };
      }
      throw err;
    }
  }

  function putCached(owner, repo, branch, head, tree, treeSha) {
    cache.set(cacheKey(owner, repo, branch, head), { tree, treeSha: treeSha || null });
  }

  function dropCached(owner, repo, branch, head) {
    if (!head) {
      return;
    }
    cache.delete(cacheKey(owner, repo, branch, head));
  }

  function clear() {
    cache.clear();
  }

  function cachedCount() {
    return cache.size;
  }

  global.GithubTree = {
    getTreeAt,
    putCached,
    dropCached,
    clear,
    cachedCount,
    isRepositoryEmptyError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
