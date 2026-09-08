/**
 * GithubCommit — commit creation.
 * Plain browser global: `GithubCommit`.
 */
(function registerGithubCommit(global) {
  'use strict';

  const { request } = global.GithubClient;

  async function createTree(p) {
    const body = { tree: p.entries };
    if (p.baseTreeSha) {
      body.base_tree = p.baseTreeSha;
    }
    return request(
      `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/git/trees`,
      {
        token: p.token,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
  }

  async function createCommit(p) {
    return request(
      `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/git/commits`,
      {
        token: p.token,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: p.message,
          tree: p.treeSha,
          parents: p.parents,
        }),
      }
    );
  }

  /**
   * Create tree + commit on top of `parentHead` and return the new commit sha.
   */
  async function createCommitOnHead(p) {
    const treeData = await createTree({
      owner: p.owner,
      repo: p.repo,
      token: p.token,
      entries: p.entries,
      baseTreeSha: p.baseTreeSha,
    });
    const commitData = await createCommit({
      owner: p.owner,
      repo: p.repo,
      token: p.token,
      message: p.message,
      treeSha: treeData.sha,
      parents: [p.parentHead],
    });
    return { commitSha: commitData.sha, treeSha: treeData.sha };
  }

  global.GithubCommit = {
    createTree,
    createCommit,
    createCommitOnHead,
  };
})(typeof window !== 'undefined' ? window : globalThis);
