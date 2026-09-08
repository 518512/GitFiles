<div align="center">

# GitFiles

**A web file manager that treats GitHub repositories as a cloud file system (PWA)**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-0969da?logo=github)](https://mbaigc.github.io/GitFiles/)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MbAIGC/GitFiles)
[![Tests](https://img.shields.io/badge/Tests-32%20passing-2da44e)](tests/github-engine.test.mjs)
[![Upstream](https://img.shields.io/badge/Upstream-fi3ik--mme%2Fstorage--hub-8b949e)](https://github.com/fi3ik-mme/storage-hub)

*A deep fork of [Storage Hub](https://github.com/fi3ik-mme/storage-hub) · Pushes to origin only — upstream PRs are not allowed*

简体中文 · [English](README_EN.md)

</div>

---

## About

GitFiles is a client-side multi-cloud file manager (PWA). It treats **GitHub repositories as a reliable cloud file system**: browse directories, upload/download, create/rename/move/copy/delete, batch operations — all landing directly in Git with **one logical operation = one commit**, keeping Git history clean and auditable.

This repository forks `fi3ik-mme/storage-hub` and rewrites the GitHub write engine according to [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md): the per-file Contents API is replaced by a Git Data API engine built around **Blob / Tree / Commit / Ref**, with CAS concurrency control.

## ✨ Features

### Three storage backends
| Backend | Description |
|---------|-------------|
| **GitHub repo** | Sign in and auto-create/mount a private `Drive-N` repository as file storage, powered by the Git Data API |
| **Google Drive** | Multi-account Google sign-in; browse, create, edit, delete, copy |
| **Local storage** | Browser-only IndexedDB volumes with a Recycle Bin |

### File management
- Windows-style explorer: directory tree, breadcrumbs, grid/list views, context menus
- Cross-drive cut/copy/paste, Recycle Bin (local storage), built-in Notepad (`.txt` / `.json`)
- Path-based deep links (e.g. `/GitFiles/Drive-1/My%20Drive/notes.txt`)
- Mobile layout with slide-out navigation; PWA offline shell caching (service worker)

### Git Data engine (core of this fork)
- **Move / Rename**: tree path rewrite that **reuses the original Blob SHAs** — no more "download → upload → delete"
- **Copy**: tree entries reuse Blob SHAs; a folder copy is **one commit** with zero re-upload
- **Delete**: a file or an entire directory subtree = **1 tree + 1 commit** (no per-file Contents DELETE)
- **Batch operations**: same-disk multi-select move/copy collapses into **a single commit** (`GithubDisk.executeBatch`)
- **CAS concurrency control**: refs update non-forced; a remote HEAD change between read and write raises `ConflictError` (409 semantics) and the UI shows an explicit conflict dialog — **silent overwrites are impossible**
- **TreeIndex cache** keyed by `owner/repo/branch/head`; a moved HEAD invalidates it automatically
- **The service worker never caches `/api/*`**, so being offline never fakes a successful commit

## 🚀 Quick start

```bash
git clone https://github.com/MbAIGC/GitFiles.git
cd GitFiles
python3 serve.py          # dev server with the OAuth token proxy + SPA fallback
# open http://localhost:8080
```

> Use **Add storage → GitHub repo** in the sidebar to connect GitHub storage; Google Drive and local storage work out of the box.

### Configuring Client IDs (fork users: no code changes needed)

`js/config.js` is a public template (a Client ID is a public identifier by design; only the secret needs protection). Configuration options, by precedence:

| Option | Use case | How |
|--------|----------|-----|
| **① Cloudflare Pages build variables (recommended)** | Fork + web deployment | Pages project → Settings → Variables and Secrets → add `CONFIG_GITHUB_CLIENT_ID` (plus optional `CONFIG_GOOGLE_CLIENT_ID`, `CONFIG_BASE_PATH`) → redeploy. The build script `scripts/build-config.mjs` generates the override automatically — **zero code changes, nothing polluting git** |
| **② js/config.local.js (local dev)** | Local `serve.py` | Copy `js/config.local.example.js` to `js/config.local.js` and fill it in (gitignored, never committed) |
| **③ Edit js/config.js directly** | Not recommended | Conflicts with upstream updates |

### GitHub sign-in configuration

> You can register the OAuth App right now (with the callback set to `http://localhost:8080/github-oauth-callback.html`) to start local development, then **edit the callback in the same app** once your real domain exists — no need to recreate it.

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in the callback URL (must match your deployment **exactly**):

| Environment | Authorization callback URL |
|-------------|----------------------------|
| Local dev | `http://localhost:8080/github-oauth-callback.html` |
| GitHub Pages | `https://mbaigc.github.io/GitFiles/github-oauth-callback.html` |
| Cloudflare Pages | `https://<your-project>.pages.dev/github-oauth-callback.html` |

3. Put the **Client ID** into `js/config.js` → `GITHUB_CLIENT_ID`

<details>
<summary>Seeing <code>redirect_uri is not associated with this application</code>?</summary>

Run `GithubDisk.getOAuthRedirectUri()` in the browser console, copy the printed URL **character for character** into the GitHub OAuth App callback field, and retry.
</details>

<details>
<summary>Sign in with a personal access token (PAT)</summary>

A **PAT mode** is available as a fallback when the OAuth proxy is unreachable: classic token `ghp_…` with the `repo` scope. IDE preview servers (port 63342) cannot host the proxy and automatically guide you to PAT sign-in.
</details>

## ☁️ Deployment

> **Order of operations**: the GitHub OAuth App is not a prerequisite for deployment — deploy first to get your `*.pages.dev` domain, then register the OAuth App, configure the secret, and redeploy. GitHub does not validate the `Homepage URL` field at all (fill in the repo URL for now); the `callback URL` can be edited later without recreating the app.

### Option 1: Connect your Git repository (recommended)

This is Cloudflare's official primary path and the most reliable one for fork users (no reliance on the one-click button):

1. **Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git**
2. Authorize and pick your forked `GitFiles` repository → **Begin setup**
3. Build settings:
   - **Project name**: becomes the domain `https://<project-name>.pages.dev` (defaults from `wrangler.jsonc` `name` = `gitfiles`)
   - **Framework preset**: `None`
   - **Build command**: `node scripts/build-config.mjs` (injects `CONFIG_*` environment variables into the frontend config; **deployment also works if left empty** — you just lose the env-var config channel)
   - **Build output directory**: `/`
4. **Settings → Variables and Secrets** (set for both Production and Preview):
   - `CONFIG_GITHUB_CLIENT_ID` = your GitHub OAuth App Client ID (optional, for GitHub sign-in)
   - `CONFIG_GOOGLE_CLIENT_ID` = your Google OAuth Client ID (optional, for Google Drive sign-in)
   - `GITHUB_CLIENT_SECRET` = your GitHub OAuth App client secret (**Secret type**, used by the token proxy)
5. Every push to `main` builds automatically; after changing variables, **Retry deployment** or push again

> If the one-click button failed for you with `WorkerResource.getWorkerResult: response missing default_environment.script`, or the build command came out empty — those are known button-flow issues. Use the Git connection above and set the Build command manually to `node scripts/build-config.mjs`.

Deployment files already included in the repo:

- `wrangler.jsonc` — Pages config (pure static; `wrangler pages deploy` CLI runs the build command automatically)
- `functions/api/github/oauth/token.js` — OAuth token-exchange Pages Function (`/api/github/oauth/token`, same-origin)
- `404.html` — SPA fallback (enabled by Pages convention)

After deploying, enable web GitHub sign-in (zero frontend code changes):

```bash
npx wrangler pages secret put GITHUB_CLIENT_SECRET   # your GitHub OAuth App client secret
```

### Option 2: wrangler CLI direct deploy

```bash
# The build command (config override generation) is declared in wrangler.jsonc and runs automatically
npx wrangler pages deploy .
```

Best when you don't want Git integration or prefer publishing from your machine.

### Option 3: Deploy to Cloudflare button (fallback)

The button URL format is `https://deploy.workers.cloudflare.com/?url=<your-repo-url>`. **Fork users should replace the repo URL with their own fork** (clicking someone else's button also works — Cloudflare guides authorization and uses a copy of the repo under your own account, but the deploy source will not be your fork).

The button at the top of this README reads `wrangler.jsonc` and guides deployment, but the flow sometimes errors on pure-static Pages projects (see above). If the build command ends up empty after using the button, fill it manually in the project's Settings → Build with `node scripts/build-config.mjs`.

GitHub's token endpoint blocks browser requests (CORS); exchanging the authorization code requires a server-side proxy:

| Option | Use case | Setup |
|--------|----------|-------|
| **Pages Function** (bundled) | Cloudflare Pages | Works out of the box; just set `GITHUB_CLIENT_SECRET` |
| **Standalone Worker** (`workers/github-oauth-token.js`) | GitHub Pages and other static hosts | Create a Worker manually and point `GITHUB_TOKEN_EXCHANGE_URL` at it |
| **serve.py built-in proxy** | Local development | Zero config; put the secret in a `.github_secret` file (never commit it) |

## 🧪 Tests

```bash
node tests/github-engine.test.mjs
# 32 passed, 0 failed
```

Covers the core PROJECT_SPEC §24 requirements:

- Files: create / update / delete / rename / move / copy
- Directories: mkdir / delete / move / copy / nested
- Batches: 10 files, 100 files, mixed operations (including sequential in-batch semantics and blob deduplication)
- Git correctness: **Move reuses Blob SHAs, Copy uploads nothing, one batch = one commit**
- Concurrency: a remote HEAD change against a non-forced update → `ConflictError` (409), never a silent overwrite

## 🏗️ Architecture

```text
┌────────────────────────────────────────────┐
│       Browser / Android PWA (vanilla JS)   │
│  Explorer · Notepad · Conflict dialog · SW │
└───────────────────┬────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  Google Drive API        js/github/ (Git Data engine)
  localdisk (IndexedDB)         │
                     Blob → Tree → Commit → Ref
                              │
                              ▼
                      GitHub Git Data API
```

`js/github/` module responsibilities:

| Module | Responsibility |
|--------|----------------|
| `client.js` | Request layer: auth / rate-limit retry / error normalization / 409 classification |
| `repository.js` | Repo, branch state and user reads |
| `reference.js` | Branch HEAD reads + CAS ref updates (`ConflictError`) |
| `tree.js` | Recursive tree reads; TreeIndex cached by `owner/repo/branch/head` |
| `blob.js` | Blob creation / reuse (empty blob reuses the well-known SHA) |
| `commit.js` | Tree + commit creation |
| `operations.js` | Strictly sequential operation planner + mutation pipeline + keyed mutex queue |

## 📁 Project structure

```text
├── index.html                  # Main explorer
├── notepad.html                # Standalone notepad
├── github-oauth-callback.html  # GitHub OAuth popup callback
├── 404.html                    # SPA fallback (GitHub Pages)
├── sw.js                       # Service worker (never caches /api/*)
├── manifest.webmanifest        # PWA manifest
├── css/style.css
├── js/
│   ├── github/                 # ★ Git Data engine (added by this fork)
│   │   ├── client.js
│   │   ├── repository.js
│   │   ├── reference.js
│   │   ├── tree.js
│   │   ├── blob.js
│   │   ├── commit.js
│   │   └── operations.js
│   ├── githubdisk.js           # GitHub storage backend (wired to the engine)
│   ├── auth.js / drive.js      # Google sign-in and Drive API
│   ├── localdisk.js            # Local storage backend
│   ├── app.js / contextmenu.js / router.js / notepad.js
│   └── config.js / site-config.js / base-path.js
├── functions/api/github/oauth/token.js   # ★ Pages Function (token proxy)
├── workers/github-oauth-token.js         # Standalone Worker token proxy
├── wrangler.jsonc                        # ★ Cloudflare Pages config
├── tests/github-engine.test.mjs          # ★ Engine test suite
├── docs/                                 # Project spec + change records (Chinese)
├── serve.py                              # Dev server (with token proxy)
└── .github/workflows/pages.yml           # Automatic GitHub Pages deployment
```

## 📊 Key differences from upstream

| Aspect | Upstream storage-hub | This fork |
|--------|----------------------|-----------|
| GitHub writes | Per-file Contents API PUT/DELETE | Git Data API (Blob/Tree/Commit/Ref) |
| Move/Rename | Download → upload → delete | Tree path rewrite, reusing Blob SHAs |
| Copy | Re-uploads content | Reuses Blob SHAs, zero upload |
| Directory delete | One API call per file, N commits | 1 tree + 1 commit |
| Batch operations | Per-item loop, one commit each | Same-disk batches merge into 1 commit |
| Concurrency control | None (remote can be silently overwritten) | CAS: non-forced updates, conflict dialog, 409 semantics |
| Directory listing cache | Cached per disk (goes stale) | Cached by `owner/repo/branch/head` |
| Token proxy | Manual Worker deployment | Bundled Pages Function + one-click deploy |

## 📝 Documentation

- [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) — target architecture spec (engine, CAS, API, testing)
- [`docs/改造记录-*.md`](docs/) — Chinese change records, one per change (`改造记录-YYYYMMDD-主题.md`)
- [`AGENTS.md`](AGENTS.md) — AI collaboration conventions (including documentation & commit rules)

## ⚠️ Known limitations

- GitHub caps files at **100 MB** and directory listings at **1000** entries per folder (Contents API limits)
- The GitHub access token is still kept in browser `localStorage` by the legacy PAT/OAuth flow — the target architecture (GitHub App + Pages Functions + D1 sessions + HttpOnly cookies) is not implemented yet, see PROJECT_SPEC
- The Conflict Center is dialog-based for now (apply latest remote state / cancel), without a diff/merge view
- Cross-drive copy between GitHub and Google/local storage is still incomplete (same-drive operations are fully supported)

## 🙏 Acknowledgements

Built on [Storage Hub](https://github.com/fi3ik-mme/storage-hub) by [Mykhailo Mikus](https://github.com/fi3ik-mme). The app is not affiliated with Google LLC or GitHub.

### Option 4: GitHub Pages

Push to `main` and the built-in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys automatically. SPA files are ready: `404.html` (fallback), `.nojekyll`, `sw.js`, and `js/base-path.js` (auto-detects the `/repo-name` prefix).

> GitHub Pages is static hosting without a server-side proxy. Deploy a token proxy (next section) or sign in with a PAT.

### OAuth token proxy (three options)

GitHub's token endpoint blocks browser requests (CORS); exchanging the authorization code requires a server-side proxy:

| Option | Use case | Setup |
|--------|----------|-------|
| **Pages Function** (bundled) | Cloudflare Pages | Works out of the box; just set `GITHUB_CLIENT_SECRET` |
| **Standalone Worker** (`workers/github-oauth-token.js`) | GitHub Pages and other static hosts | Create a Worker manually and point `GITHUB_TOKEN_EXCHANGE_URL` at it |
| **serve.py built-in proxy** | Local development | Zero config; put the secret in a `.github_secret` file (never commit it) |

### OAuth application description (for registration forms)

> **Storage Hub** is a client-side web file manager. Users choose which storage to connect: Google Drive accounts, local browser storage (IndexedDB), or private GitHub repositories created for file storage. The app runs entirely in the browser and talks to Google Drive and GitHub APIs only after the user signs in and grants permission. It does not operate a backend server or store user files on developer-owned infrastructure. Features include folder browsing, file create/rename/move/delete, cross-drive copy/paste where supported, a built-in Notepad for text and JSON files, and shareable path-based URLs.
