/**
 * GithubReference — branch HEAD reads and CAS ref updates.
 * Plain browser global: `GithubReference`.
 */
(function registerGithubReference(global) {
  'use strict';

  const { request, GithubApiError } = global.GithubClient;
  const { getBranchState } = global.GithubRepository;

  /**
   * Read the current HEAD commit sha of a branch.
   * @returns {Promise<string|null>} null when branch does not exist (empty repo)
   */
  async function getHead(owner, repo, branch, token) {
    const state = await getBranchState(owner, repo, branch, token);
    return state ? state.head : null;
  }

  /**
   * Update a branch reference (CAS).
   *
   * The update is performed WITHOUT force, so GitHub rejects the write when
   * the remote HEAD moved between our read and this write — that rejection
   * (422 fast-forward / 409) is surfaced as ConflictError.
   *
   * @param {object} p - { owner, repo, branch, token, expectedHead, newHead }
   */
  async function updateRefCas(p) {
    try {
      await request(
        `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/git/refs/heads/${encodeURIComponent(p.branch)}`,
        {
          token: p.token,
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sha: p.newHead,
            force: false,
          }),
        }
      );
    } catch (err) {
      if (err instanceof GithubApiError && err.isConflict) {
        let remoteHead = null;
        try {
          remoteHead = await getHead(p.owner, p.repo, p.branch, p.token);
        } catch {
          // keep remoteHead null; the conflict itself is the source of truth
        }
        throw new ConflictError(p.expectedHead, remoteHead, err.message);
      }
      throw err;
    }
  }

  class ConflictError extends Error {
    constructor(expectedHead, remoteHead, detail) {
      super(
        'Conflict: the branch was updated by another device while you were working.\n'
        + `Your base: ${expectedHead || 'unknown'}\n`
        + `Remote HEAD: ${remoteHead || 'unknown'}\n`
        + (detail ? `GitHub: ${detail}\n` : '')
        + 'Reload to pick up remote changes, or overwrite the remote branch explicitly.'
      );
      this.name = 'ConflictError';
      this.expectedHead = expectedHead || null;
      this.remoteHead = remoteHead || null;
    }
  }

  global.GithubReference = {
    ConflictError,
    getHead,
    updateRefCas,
  };
})(typeof window !== 'undefined' ? window : globalThis);
