<div align="center">

# GitFiles

**A GitHub Repository file manager PWA powered by Cloudflare Workers**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MbAIGC/GitFiles)
[![Tests](https://img.shields.io/badge/tests-77%20passing-2da44e)](tests/)

[简体中文](README.md) · English

</div>

## About

GitFiles treats a GitHub Repository as a reliable cloud file system. The browser calls only the same-origin Worker API; GitHub access tokens remain in Worker D1 sessions and are used through HttpOnly cookies. The Worker Git Data pipeline performs writes while preserving correct Tree, Commit, and branch-ref history.

> **Project status**: see [`docs/状态总览-20260912.md`](docs/状态总览-20260912.md) (the single source of truth for what is done and what is planned).
> **Documentation index**: see [`docs/README.md`](docs/README.md).

### Relationship to upstream

This project is derived from [fi3ik-mme/storage-hub](https://github.com/fi3ik-mme/storage-hub) by Mykhailo Mikus.
Upstream is a **client-only** browser file manager (Google Drive centric, no backend).
GitFiles adds a Cloudflare Worker + D1 backend, a Git Data mutation pipeline, and CAS,
and moves the data model from Google Drive to Git objects. See
[`docs/架构现状-20260912.md`](docs/架构现状-20260912.md) section 3.

Upstream declares no LICENSE. Do not redistribute this derivative until licensing is clarified.

## Core capabilities

- GitHub OAuth sign-in creates only a Worker session. It never automatically creates or mounts a repository.
- Mount writable repositories from the Worker ACL list; private repository creation requires explicit user confirmation.
- Same-repository create/update/delete/rename/move/copy/mkdir/upload.
- Move, Rename, and Copy reuse Blob SHAs. A logical batch becomes one Tree, one Commit, and one non-force ref update.
- CAS: the client submits `expectedHead`; the Worker rereads the remote HEAD and returns `409 Conflict` on mismatch.
- Worker session status, a basic Conflict Center, mobile navigation drawer, and large touch targets.
- PWA shell caching; the Service Worker never caches `/api/*`.

## Architecture

```text
Browser / Android PWA
        │ same-origin HTTPS + HttpOnly cookie
        ▼
Cloudflare Worker + Static Assets
        ├── D1: sessions / repository_access
        └── GitHub OAuth + Git Data API
                    │
              Blob / Tree / Commit / Ref
```

The browser neither stores GitHub tokens nor calls `api.github.com` directly. `workers/entry.js` is the API and authorization boundary; `workers/operations.js` implements the Git Data mutation pipeline.

## Deployment

The only supported production deployment is **Cloudflare Workers + Static Assets**.

1. Fork this repository, or use the Deploy to Cloudflare button above.
2. In the Cloudflare Workers project, set the Build command:

   ```bash
   node scripts/build-config.mjs
   ```

3. Set per-deployment D1 variables (the values stay in your Cloudflare deployment configuration and are not committed to this public repository):

   ```text
   D1_DATABASE_NAME=your D1 database name
   D1_DATABASE_ID=your D1 database ID
   ```

   Add both values as Build variables in Workers Builds, or as deployment variables in the Dashboard deployment settings. `wrangler.jsonc` uses them to create the fixed `DB` D1 binding. Apply the schema:

   ```bash
   npx wrangler d1 execute <database-name> --file=workers/schema.sql
   ```

4. Set the Worker runtime secret:

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

5. Set Build text variables:

   | Variable | Purpose |
   |---|---|
   | `CONFIG_GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
   | `CONFIG_BASE_PATH` | Optional site-path override |

6. Register this callback in the GitHub OAuth App:

   ```text
   https://<worker-domain>/github-oauth-callback.html
   ```

7. After deployment, use `/api/me` to verify the session. Missing D1 or secret configuration produces `503`; the application never falls back to a browser token/PAT mode.

`serve.py` remains only for static/OAuth development diagnostics. GitHub Pages, standalone token proxies, and browser PAT fallbacks are not supported secure production deployments.

## API

```text
POST /api/github/oauth/token
POST /api/logout
GET  /api/me
GET  /api/repos
POST /api/repos
GET  /api/repos/:owner/:repo
GET  /api/repos/:owner/:repo/branches
GET  /api/repos/:owner/:repo/tree?branch=main
GET  /api/repos/:owner/:repo/file?branch=main&path=docs/a.md
GET  /api/repos/:owner/:repo/history?branch=main
POST /api/repos/:owner/:repo/operations
```

Writes must include `expectedHead`; the first write to an empty repository uses `expectedHead: null`. The Worker returns `409` when a ref is created concurrently or the remote HEAD moves, and the client enters the Conflict Center.

## Development and tests

```bash
node --test tests/github-engine.test.mjs tests/worker-api.test.mjs tests/markdown-lite.test.mjs
node scripts/build-config.mjs
```

Current tests cover Git operations, Blob SHA reuse, one-commit batches, CAS, initial empty-repository refs, D1/session/ACL rejection and stale-ACL revalidation, same-origin mutations, OAuth token non-disclosure, the OAuth callback delivery-origin allowlist, path NFC normalization, rejection of invalid UTF-16 content, propagation of 429 back-off details, streaming/Range file downloads, and XSS hardening of Markdown rendering.

UI structure has its own static checks (duplicate ids, JS references to missing ids, stylesheet cascade order, unused CSS class selectors):

```bash
node scripts/check-ui.mjs
```

## Current limitations

- Sessions currently use an OAuth user token; GitHub App installation tokens and session rotation are not implemented. Expired sessions are reaped opportunistically on `/api/me` — there is no cron binding.
- Single-file downloads are capped at 95 MB (a Worker memory guard); larger files need an R2 relay to be supported.
- The Conflict Center records conflicts and reloads remote state, but does not yet provide text three-way merge or per-file diffs.
- Cross-repository Move is a recoverable two-phase flow, not one atomic Git commit; its recovery UI is still pending.
- Repository ACL reads are cached for 5 minutes; writes always re-validate against GitHub.
- README preview uses the built-in MarkdownLite (safety first: no tables, task lists or nested lists, and raw HTML is never emitted).
- Local storage is text-only; binary uploads are rejected explicitly.

See [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) for the specification, [docs/状态总览-20260912.md](docs/状态总览-20260912.md) for project status, and [docs/README.md](docs/README.md) for the documentation index.
