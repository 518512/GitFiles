/**
 * GithubRepository — repository level read operations.
 * Plain browser global: `GithubRepository`.
 */
(function registerGithubRepository(global) {
  'use strict';

  const { request, GithubApiError } = global.GithubClient;

  function encode(name) {
    return encodeURIComponent(name);
  }

  async function getUser(token) {
    return request('/user', { token });
  }

  async function getRepo(owner, repo, token) {
    return request(`/repos/${encode(owner)}/${encode(repo)}`, { token });
  }

  /**
   * Fetch the current branch state in one request.
   *
   * @returns {Promise<{head:string, treeSha:string}|null>} null when the branch/repo does not exist yet (empty repo)
   */
  async function getBranchState(owner, repo, branch, token) {
    try {
      const data = await request(
        `/repos/${encode(owner)}/${encode(repo)}/branches/${encode(branch)}`,
        { token }
      );
      const head = data && data.commit && data.commit.sha;
      const treeSha = data && data.commit && data.commit.commit
        && data.commit.commit.tree && data.commit.commit.tree.sha;
      if (!head) return null;
      return { head, treeSha: treeSha || null };
    } catch (err) {
      if (err instanceof GithubApiError && err.isNotFound) return null;
      throw err;
    }
  }
  async function getBranches(owner, repo, token) {
    return request(`/repos/${encode(owner)}/${encode(repo)}/branches?per_page=100`, { token });
  }

  async function getHistory(owner, repo, branch, token) {
    return request(`/repos/${encode(owner)}/${encode(repo)}/commits?sha=${encode(branch)}&per_page=30`, { token });
  }

  global.GithubRepository = {
    getUser,
    getRepo,
    getBranchState,
    getBranches,
    getHistory,
  };
})(typeof window !== 'undefined' ? window : globalThis);
