/**
 * GithubBlob — blob creation / reuse.
 * Plain browser global: `GithubBlob`.
 */
(function registerGithubBlob(global) {
  'use strict';

  const { request } = global.GithubClient;

  /**
   * Git blob sha of the empty blob. Content-addressed, identical in every
   * repository — used for `folder/.keep` markers without re-uploading.
   */
  const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

  function b64EncodeUtf8(text) {
    const bytes = new TextEncoder().encode(text || '');
    return b64EncodeBytes(bytes);
  }

  function b64EncodeBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      out += String.fromCharCode(...view.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function b64DecodeUtf8(input) {
    return new TextDecoder().decode(b64DecodeBytes(input));
  }

  function b64DecodeBytes(input) {
    const binary = atob((input || '').replace(/\n/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  /**
   * Create a blob in the repository and return its sha.
   * @param {object} p - { owner, repo, token, content } where content is text or Uint8Array
   * @param {object} [opts] - { encodingHint } 'utf-8' (default) or 'base64' when content already encoded
   */
  async function createBlob(p, opts = {}) {
    let contentEncoded;
    if (opts.encodingHint === 'base64' && typeof p.content === 'string') {
      contentEncoded = p.content;
    } else if (typeof p.content === 'string') {
      contentEncoded = b64EncodeUtf8(p.content);
    } else {
      contentEncoded = b64EncodeBytes(p.content);
    }
    const data = await request(
      `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/git/blobs`,
      {
        token: p.token,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentEncoded, encoding: 'base64' }),
      }
    );
    return data && data.sha;
  }

  /**
   * Ensure an empty blob exists in the repository (for .keep files).
   * Creating an empty blob twice is harmless — GitHub dedups identical content.
   */
  async function ensureEmptyBlob(p) {
    return createBlob({ owner: p.owner, repo: p.repo, token: p.token, content: '' });
  }

  async function getBlob(owner, repo, token, sha) {
    return request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,
      { token }
    );
  }

  global.GithubBlob = {
    EMPTY_BLOB_SHA,
    b64EncodeUtf8,
    b64EncodeBytes,
    b64DecodeUtf8,
    b64DecodeBytes,
    createBlob,
    ensureEmptyBlob,
    getBlob,
  };
})(typeof window !== 'undefined' ? window : globalThis);
