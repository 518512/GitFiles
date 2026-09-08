# Storage Hub

A browser-based file manager with a Windows-style explorer UI, developed by [Mykhailo Mikus](https://github.com/MishaMikusEleks). Mount multiple storage backends in one place — **Google Drive**, **local browser storage**, and **GitHub repositories** — then browse folders, copy files between drives, edit `.txt`/`.json` in Notepad, and share deep links. Works on desktop and mobile; deploys to GitHub Pages.

**Live demo:** [https://mishamikuseleks.github.io/storage-hub/](https://mishamikuseleks.github.io/storage-hub/)

## Application description

Use this text on OAuth registration forms (Google consent screen, GitHub OAuth App, etc.):

> **Storage Hub** is a client-side web file manager. Users choose which storage to connect: Google Drive accounts, local browser storage (IndexedDB), or private GitHub repositories created for file storage. The app runs entirely in the browser and talks to Google Drive and GitHub APIs only after the user signs in and grants permission. It does not operate a backend server or store user files on developer-owned infrastructure. Features include folder browsing, file create/rename/move/delete, cross-drive copy/paste where supported, a built-in Notepad for text and JSON files, and shareable path-based URLs.

Shorter variant (GitHub OAuth **Application description** field, ~350 characters):

> Storage Hub is a browser file manager. After you authorize GitHub access, you can create or connect a private repository and use it as personal file storage from the app UI (browse, upload, edit, and delete files via the GitHub API). No backend server; data stays in your GitHub account.

**Legal pages (for OAuth consent screens):**

| Field | URL |
|-------|-----|
| Application home page | https://mishamikuseleks.github.io/storage-hub/ |
| Privacy policy | https://mishamikuseleks.github.io/storage-hub/privacy.html |
| Terms of Service | https://mishamikuseleks.github.io/storage-hub/terms.html |

> **Note:** Storage Hub is an independent project and is not affiliated with Google LLC.

## Features

- **Three storage types** — add from **Add storage** in the sidebar:
  - **Google Drive** — sign in with Google; mount one or more accounts
  - **Local Storage** — browser-only volumes (IndexedDB + localStorage metadata)
  - **GitHub repo** — sign in with GitHub; auto-create a private `Drive-N` repository and use it as file storage
- Windows-style explorer: tree, breadcrumbs, grid/list views, context menus
- Path-based URLs (e.g. `/storage-hub/jane.doe/My%20Drive/Projects` or `/storage-hub/Drive-1/My%20Drive/notes.txt`)
- Cross-drive cut/copy/paste (Google ↔ Google, Local ↔ Local, Google ↔ Local; GitHub same-repo operations; cross-type with GitHub is limited)
- Built-in Notepad for `.txt` and `.json` (opens in a new tab)
- Mobile layout with slide-out navigation
- Offline shell caching via `sw.js` (service worker)

## Quick start (local)

### 1. Google Cloud project

See [Google OAuth setup for external users](#google-oauth-setup-for-external-users) below.

### 2. Configure the app

Edit `js/config.js` (Google + GitHub OAuth) and `js/site-config.js` (branding and base path):

```js
const CONFIG = {
  BASE_PATH: '/storage-hub', // must match your GitHub Pages repo name
  CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  GITHUB_CLIENT_ID: 'YOUR_GITHUB_CLIENT_ID',
  GITHUB_SCOPES: 'repo',
  SCOPES: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/drive',
  ].join(' '),
};
```

Never commit OAuth client secrets or downloaded `client_secret_*.json` files.

**GitHub storage is optional.** Leave `GITHUB_CLIENT_ID` as `YOUR_GITHUB_CLIENT_ID` until you register a GitHub OAuth App (see [GitHub OAuth setup](#github-oauth-setup-for-storage)).

### 3. Run locally

OAuth requires HTTP (not `file://`):

```bash
python3 serve.py
# or: python3 -m http.server 8080
```

Open `http://localhost:8080` (or the port shown). Add that origin in Google Cloud **Authorized JavaScript origins**.

For GitHub storage, set the OAuth app **Authorization callback URL** to `http://localhost:8080/github-oauth-callback.html` (adjust port if needed).

---

## GitHub OAuth setup (for storage)

GitHub repo storage uses the OAuth **Authorization Code flow with PKCE** in the browser. You only need a **Client ID** in the frontend (no client secret in the app).

### Step 1 — Create a GitHub OAuth App

GitHub allows **only one** Authorization callback URL per OAuth App. Use separate OAuth Apps for local dev and production, or change the callback URL when you switch environments.

1. Sign in to GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
2. Fill in:

   | Field | Local dev | GitHub Pages (project site) |
   |-------|-----------|------------------------------|
   | Application name | Storage Hub (local) | Storage Hub |
   | Homepage URL | `http://localhost:8080` | `https://yourname.github.io/storage-hub` |
   | Authorization callback URL | `http://localhost:8080/github-oauth-callback.html` | `https://yourname.github.io/storage-hub/github-oauth-callback.html` |

   **Important:** the callback URL must match **exactly** (scheme, host, port, path). Common mistakes:
   - Using `/storage-hub/github-oauth-callback.html` on localhost (wrong — local server has no `/storage-hub` prefix)
   - Omitting `/storage-hub` on GitHub Pages (wrong — project sites need the repo path)
   - `http` vs `https` mismatch
   - Trailing slash (`...html/` vs `...html`)

3. Click **Register application**
4. Copy the **Client ID** into `js/config.js` → `GITHUB_CLIENT_ID`

To see which callback URL the app will use right now, open the browser console on your running app and run:

```js
GithubDisk.getOAuthRedirectUri()
```

If it does not match your GitHub OAuth App, either update GitHub settings or set an override in `js/config.js`:

```js
GITHUB_REDIRECT_URI: 'https://yourname.github.io/storage-hub/github-oauth-callback.html',
```

### Troubleshooting: “redirect_uri is not associated with this application”

1. Run `GithubDisk.getOAuthRedirectUri()` in the browser console.
2. Copy the printed URL **character for character** into GitHub → your OAuth App → **Authorization callback URL** → **Update application**.
3. Retry **Add storage → GitHub repo**.

| You are testing on | Callback URL to register |
|--------------------|---------------------------|
| `http://localhost:8080` (`python3 serve.py`) | `http://localhost:8080/github-oauth-callback.html` |
| JetBrains IDE (`localhost:63342/.../index.html`) | `http://localhost:63342/<project-folder>/github-oauth-callback.html` (run `GithubDisk.getOAuthRedirectUri()` to get the exact path) |
| `https://mishamikuseleks.github.io/storage-hub/` | `https://mishamikuseleks.github.io/storage-hub/github-oauth-callback.html` |

**JetBrains / IntelliJ users:** the built-in preview server (port `63342`) serves the app from a project subfolder (e.g. `/my_google/`). The callback must include that folder. **GitHub sign-in does not work on the IDE server alone** — use `python3 serve.py` and open `http://localhost:8080` instead.

### Troubleshooting: “Failed to fetch” after GitHub login

GitHub’s token endpoint blocks direct browser requests (CORS). The app exchanges the authorization code through a **local proxy** built into `serve.py`:

```
POST /api/github/oauth/token
```

1. Stop using the IDE preview server for OAuth.
2. Run `python3 serve.py` and open `http://localhost:8080`.
3. Register `http://localhost:8080/github-oauth-callback.html` in your GitHub OAuth App.
4. Retry **Add storage → GitHub repo**.

If you must keep the IDE preview on port `63342`, run `python3 serve.py` in parallel and add to `js/config.js`:

```js
GITHUB_TOKEN_EXCHANGE_URL: 'http://localhost:8080/api/github/oauth/token',
```

GitHub Pages (static hosting) has no built-in proxy; GitHub storage there requires deploying your own token-exchange endpoint and setting `GITHUB_TOKEN_EXCHANGE_URL`.

#### GitHub OAuth token proxy (GitHub Pages / production)

GitHub’s token endpoint blocks browser requests (CORS). For the live site on GitHub Pages, deploy the included Cloudflare Worker:

1. [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Create Worker**
2. Replace the default script with [`workers/github-oauth-token.js`](workers/github-oauth-token.js)
3. Add your GitHub Pages origin to `ALLOWED_ORIGINS` in that file (e.g. `https://yourname.github.io`)
4. **Deploy** and copy the worker URL (e.g. `https://github-oauth-token.your-subdomain.workers.dev`)
5. In `js/config.js`:

```js
GITHUB_TOKEN_EXCHANGE_URL: 'https://github-oauth-token.your-subdomain.workers.dev/api/github/oauth/token',
```

6. Register the GitHub Pages callback URL in your GitHub OAuth App (see table above)

Local development uses the proxy built into `serve.py` — no Cloudflare Worker needed.

### Step 2 — Scope

The app requests the `repo` scope so it can create private repositories and read/write file contents on your behalf. You can set `GITHUB_SCOPES: 'repo'` in `js/config.js` (default).

### Step 3 — Use GitHub storage in the app

1. Open Storage Hub → **Add storage** → **GitHub repo**
2. Approve access in the GitHub popup
3. The app creates a private repository named `Drive-1`, `Drive-2`, … and mounts it in the sidebar
4. Use **My Drive** inside that volume like any other storage backend

### Limits

- GitHub [Contents API](https://docs.github.com/en/rest/repos/contents): **100 MB** per file; directory listings capped at **1000** entries per folder
- Each save creates a **git commit** (fine for documents; avoid rapid autosave on large files)
- Cross-drive copy/paste **to/from** GitHub and Google/Local is not fully supported yet; operations within the same GitHub repo work

---

## Deploy to GitHub Pages

### 1. Rename the repository (if migrating from `my_google`)

In GitHub: **Settings → General → Repository name** → rename to `storage-hub`.

Then update your local remote:

```bash
git remote set-url origin https://github.com/MishaMikusEleks/storage-hub.git
```

GitHub Pages will serve the app at `https://mishamikuseleks.github.io/storage-hub/`.

### 2. Push and enable Pages

Enable **GitHub Pages** for the repo:

- **Settings → Pages → Build and deployment → Source:** Deploy from branch
- Branch: `main` (or `master`), folder: `/ (root)`

### 3. Files required for SPA routing

This repo includes:

| File | Purpose |
|------|---------|
| `404.html` | GitHub Pages SPA fallback (same as `index.html`) |
| `sw.js` | Caches static assets; serves shell on offline navigation |
| `.nojekyll` | Ensures GitHub Pages serves all paths as static files |
| `js/base-path.js` | Detects `/repo-name` base path automatically |

### 4. Base path

For a project site (`username.github.io/repo-name`), set the base path in `js/site-config.js`:

```js
basePath: '/storage-hub',
```

### 5. Update Google OAuth origins

Add these **Authorized JavaScript origins** in Google Cloud Console:

- `https://mishamikuseleks.github.io`
- `https://mishamikuseleks.github.io/storage-hub`
- `http://localhost:8080` (and any local port you use)

No redirect URI is required for the Google Identity Services token client used by this app.

---

## Google OAuth branding verification

Google requires a unique app name and proof that you own the homepage ([requirements](https://support.google.com/cloud/answer/13807376)). The most common failure is Search Console ownership not linked to your Cloud project.

### Critical: use the same Google account everywhere

The Google account that verifies the site in **Search Console** must also be **Owner** or **Editor** on your **Google Cloud** project (the one with your OAuth client). If you verified with a personal Gmail but your Cloud project uses a work account, Google will still report “website not registered to you.”

Check Cloud project access: [Google Cloud Console → IAM](https://console.cloud.google.com/iam-admin/iam) — your verifying account must be listed as Owner or Editor.

### Step 1 — Verify in Google Search Console

1. Open [Google Search Console](https://search.google.com/search-console) **while signed in with the same account as your Cloud project**.
2. Click **Add property** → choose **URL prefix** (not “Domain”).
3. Enter exactly: `https://mishamikuseleks.github.io/storage-hub/`
4. Pick a verification method:

   **Option A — HTML tag (recommended)**  
   Google gives you a meta tag like:
   ```html
   <meta name="google-site-verification" content="YOUR_TOKEN" />
   ```
   - Copy the `content` value.
   - Put it in `js/site-config.js` → `googleSiteVerification`.
   - Also update the static meta tag inside `<head>` in `index.html`, `404.html`, `privacy.html`, and `terms.html` (Google’s crawler reads static HTML; it does not run JavaScript).
   - Push to GitHub Pages, wait ~1 minute, then click **Verify** in Search Console.

   **Option B — HTML file**  
   Google gives you a file like `googleXXXXXXXX.html`. This repo already includes `google73af96c778f7385a.html` at the site root. After deploy it must be reachable at:
   `https://mishamikuseleks.github.io/storage-hub/google73af96c778f7385a.html`  
   If Search Console gave you a *different* filename, replace the file in the repo root with the one Google provided.

5. Confirm Search Console shows **Ownership verified** for the URL prefix property.

### Step 2 — Match OAuth consent screen URLs

In [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent), set:

| Field | Value |
|-------|-------|
| App name | Storage Hub |
| User support email | your email |
| App logo | upload `assets/logo-512.png` |
| Application home page | https://mishamikuseleks.github.io/storage-hub/ |
| Privacy policy | https://mishamikuseleks.github.io/storage-hub/privacy.html |
| Terms of Service | https://mishamikuseleks.github.io/storage-hub/terms.html |

Under **Authorized domains**, Google may list `github.io`. You cannot verify `github.io` itself — verify the **URL prefix** property above instead. Google’s OAuth check links your verified Search Console property to the homepage URL on the consent screen.

### Step 3 — Resubmit verification

After Search Console shows verified:

1. Open the OAuth verification request in Cloud Console.
2. Confirm the homepage URL is exactly `https://mishamikuseleks.github.io/storage-hub/`.
3. Resubmit for verification (or reply to Google’s email confirming ownership is verified).

### If verification still fails

GitHub Pages on `*.github.io` is a shared platform. If Google continues to reject it, the reliable fix is a **custom domain** you own (e.g. `storagehub.dev`):

1. Buy a domain and add it in GitHub Pages → **Settings → Pages → Custom domain**.
2. Verify that domain in Search Console (DNS TXT record).
3. Update homepage, privacy, and terms URLs on the OAuth consent screen to use the custom domain.
4. Add the custom domain origin to **Authorized JavaScript origins**.

### App name

Use **Storage Hub** (not a generic name like "My Google"). The OAuth consent screen app name must match the branding shown on your homepage.

### OAuth consent screen URLs (reference)

The table above is the single source of truth for consent screen URLs. After updating, save and resubmit for verification.

### Remove the “This app hasn’t been verified” warning

Homepage / brand verification only proves you own the site. The scary consent screen appears because **Storage Hub** uses the sensitive scope `https://www.googleapis.com/auth/drive` and Google has not yet approved the full **OAuth app verification**.

Until full verification is approved, every user must click **Advanced → Go to Storage Hub (unsafe)** on Google’s sign-in page. The login screen includes instructions for this.

To remove the warning for all users:

1. Open [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) → **Prepare for verification** (app must be **In production**).
2. Provide **scope justification** — explain why Storage Hub needs full Drive access (browse folders, create/edit/delete files, multi-account file manager).
3. Upload a **demo video** (YouTube, unlisted is fine) showing:
   - The app homepage and privacy policy link
   - Clicking Sign in with Google and the consent screen
   - Browsing Drive, opening a folder, and one file operation (e.g. create or edit a text file)
4. Confirm all URLs match the live site and resubmit.

Review usually takes several business days. While waiting, users can still sign in via **Advanced** as described on the login page.

**Testing mode alternative:** If the app stays in **Testing**, add each user under **Test users** on the consent screen (max 100). Test users can sign in without publishing, but the unverified warning may still appear for sensitive scopes.

---

## Google OAuth setup for external users

Use this checklist so **anyone** (not just you) can sign in when you publish the app.

### Step 1 — Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (e.g. "Storage Hub")

### Step 2 — Enable Google Drive API

1. **APIs & Services → Library**
2. Search **Google Drive API** → **Enable**

### Step 3 — OAuth consent screen (External)

1. **APIs & Services → OAuth consent screen**
2. User type: **External**
3. Fill in:
   - **App name** — **Storage Hub**
   - **User support email** — your email
   - **Developer contact email** — your email
4. **Scopes → Add or remove scopes**, add:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/drive` (full Drive access — **sensitive**)
5. **Test users** (while app is in *Testing*):
   - Add every Google account that should be allowed to sign in during development
   - Only test users can authenticate until the app is published

### Step 4 — Publish for production (any external user)

While the app is in **Testing**, only listed test users can sign in.

To allow **any Google user**:

1. **OAuth consent screen → Publish app**
2. For the **Drive** scope, Google may require **app verification** before public users see a trusted consent screen. Until verified, users may see an "unverified app" warning and must click **Advanced → Go to … (unsafe)**.
3. Submit verification if you need a production-ready, trusted consent screen for a public audience.

### Step 5 — OAuth 2.0 Client ID (Web application)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**
2. Application type: **Web application**
3. **Authorized JavaScript origins** — add every URL where the app is hosted:

   | Environment | Example origin |
   |-------------|----------------|
   | Local dev | `http://localhost:8080` |
   | GitHub Pages (user site) | `https://yourname.github.io` |
   | GitHub Pages (project site) | `https://yourname.github.io/storage-hub` |
   | Custom domain | `https://drive.example.com` |

4. **Authorized redirect URIs** — leave empty (this app uses GIS `initTokenClient`, not redirect-based OAuth)
5. Copy the **Client ID** into `js/config.js`

### Step 6 — Security practices

- Use only the **Client ID** in frontend code
- Do **not** commit `client_secret_*.json` or paste client secrets in the repo
- Add `client_secret_*.json` to `.gitignore` if you download credentials
- Rotate credentials if a secret was ever exposed

### What users see on first sign-in

1. Google account picker
2. Consent screen listing Drive + profile permissions
3. After approval, the app stores tokens in `localStorage` for that browser

Users who signed in under an old readonly scope may be prompted to sign in again after you upgrade scopes.

---

## Project structure

```
├── index.html                  # Main explorer
├── notepad.html                # Standalone text editor
├── github-oauth-callback.html  # GitHub OAuth popup callback
├── 404.html                    # GitHub Pages SPA fallback
├── sw.js                       # Service worker
├── manifest.webmanifest        # PWA manifest
├── css/style.css
├── js/
│   ├── site-config.js          # App name, URLs, Search Console verification
│   ├── config.js               # Google + GitHub client IDs, scopes, BASE_PATH
│   ├── base-path.js            # GitHub Pages base path detection
│   ├── register-sw.js          # Service worker registration
│   ├── auth.js                 # Google multi-user OAuth
│   ├── drive.js                # Google Drive API
│   ├── localdisk.js            # Local browser storage backend
│   ├── githubdisk.js           # GitHub repository storage backend
│   ├── localuser.js            # Local profile display name
│   ├── router.js               # Path-based URLs
│   ├── notepad.js
│   ├── contextmenu.js
│   └── app.js
└── serve.py                    # Local dev server with SPA fallback
```

## URL formats

| Page | Example |
|------|---------|
| Explorer root | `https://user.github.io/storage-hub/` |
| Google Drive folder | `https://user.github.io/storage-hub/jane.doe/My%20Drive/Work` |
| Local storage folder | `https://user.github.io/storage-hub/Local%20Storage/My%20Drive/Projects` |
| GitHub repo folder | `https://user.github.io/storage-hub/Drive-1/My%20Drive/notes` |
| Notepad | `https://user.github.io/storage-hub/notepad.html?file=/Drive-1/My%20Drive/notes.txt` |

## Notes

- **Google Drive:** full Drive scope allows create, edit, delete, and copy; Shared / Starred / Recent are flat lists
- **Local storage:** data stays in the browser (IndexedDB); clearing site data removes volumes
- **GitHub storage:** files live in repositories you own; tokens and mount metadata are stored in `localStorage`
- Service worker caches static assets only; API calls use the network
- On iOS Safari, "Add to Home Screen" uses `manifest.webmanifest` for a standalone-like experience

## Fork: Git Data Engine (this fork only)

This fork (`MbAIGC/GitFiles`) evolves Storage Hub toward the architecture in
[`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md). Do **not** open PRs against the
upstream repository.

### What changed

- **Git Data API write engine** (`js/github/` — `client`, `repository`, `reference`,
  `tree`, `blob`, `commit`, `operations`): all GitHub writes now go through
  Blob → Tree → Commit → Ref instead of the Contents API.
- **Move/Rename** rewrite tree paths and **reuse the original Blob SHAs**
  (no download → upload → delete).
- **Copy** duplicates tree entries with the same Blob SHAs (no re-upload);
  folder copies are a single commit.
- **Delete** of a file or a whole directory subtree is **one tree + one commit**.
- **Batch operations**: same-disk multi-select move/copy produce **one commit**
  (`GithubDisk.executeBatch`).
- **CAS concurrency control**: ref updates are non-forced; a remote change
  between read and write raises `ConflictError` (409 semantics), surfaced in the
  UI with an explicit "apply to latest remote state / cancel" dialog. Silent
  overwrites are impossible.
- **TreeIndex cache** is keyed by `owner/repo/branch/head`; a moved HEAD
  invalidates it automatically.
- **Service worker** never caches `/api/*`.

### Tests

```bash
node tests/github-engine.test.mjs
```

Covers file/directory create, update, delete, rename, move, copy (incl. nested),
batch (10/100/mixed), Blob-SHA reuse, one-commit batching and CAS conflict handling.

### Known remaining gaps (tracked in docs/PROJECT_SPEC.md)

- GitHub tokens are still kept in browser `localStorage` by the legacy PAT flow;
  the target architecture (GitHub App + Cloudflare Pages Functions + D1 sessions
  with HttpOnly cookies) is not implemented yet.
- The Conflict Center is dialog-based for now (reload/overwrite), not a full
  diff/merge UI.
