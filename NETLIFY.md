# Netlify hosting: public slip builder and private phone view

The site has two parts:

| URL | Purpose | Data source |
|---|---|---|
| `/` | Public slip builder | Current Bet9ja round fetched by a Netlify Function |
| `/remote` | Private phone view and slip builder | Latest snapshot pushed by your PC extension |

The private view is **read-only**. It does not activate models, change settings,
place bets or control the extension.

---

## 1. Files

| Path | Purpose |
|---|---|
| `web/index.html` | Public slip builder |
| `web/app.js` | Public adapter |
| `web/remote.html` | PIN-protected phone view |
| `web/remote.js` | Phone adapter and dashboard |
| `web/dashboard.css` | Shared styling |
| `web/lib/` | Copied browser modules created by the build |
| `netlify/functions/odds.js` | Public live Bet9ja fetch |
| `netlify/functions/snapshot.js` | Snapshot upload/download |
| `netlify/functions/login.js` | PIN login |
| `netlify/functions/logout.js` | Clear session |
| `netlify/functions/session.js` | Session check |
| `netlify/functions/_lib.js` | Auth, cookies and Blobs helpers |
| `lib/cloud.js` | Extension snapshot builder and upload |
| `tools/build-web.cjs` | Copies shared browser modules into `web/lib` |
| `netlify.toml` | Build, publish, functions and API redirects |

---

## 2. Netlify environment variables

Set these in **Site configuration → Environment variables**:

| Variable | What it is |
|---|---|
| `LP_WRITE_TOKEN` | Long random secret used only by the extension upload |
| `LP_SESSION_SECRET` | Long random secret used to sign the phone cookie |
| `LP_PIN` | The PIN you type on your phone |
| `LP_PIN_HASH` | Optional. SHA-256 hash of the PIN; takes priority over `LP_PIN` |

### Generate secrets

PowerShell / Command Prompt:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the output once for `LP_WRITE_TOKEN` and once for `LP_SESSION_SECRET`.

Optional PIN hash:

```powershell
node -e "console.log(require('crypto').createHash('sha256').update('123456').digest('hex'))"
```

Put that output in `LP_PIN_HASH`. If you use `LP_PIN_HASH`, you can remove `LP_PIN`.

### PIN advice

- Use at least 6 digits.
- Do not reuse a bank PIN.
- Five wrong attempts trigger a 15-minute lockout per IP.

---

## 3. Deploy

The Netlify Functions need a Git-connected site or the Netlify CLI. A plain
drag-and-drop of `web/` publishes the pages but **not** the API functions.

### Git + Netlify

1. Push this folder to a GitHub/GitLab/Bitbucket repository.
2. Netlify → **Add new site** → **Import an existing project**.
3. Select the repository.
4. Netlify reads `netlify.toml`:
   - build command: `node tools/build-web.cjs`
   - publish directory: `web`
   - functions directory: `netlify/functions`
   - API redirects to `/.netlify/functions/*`
5. Add the environment variables from section 2.
6. Deploy.

The build installs `@netlify/blobs` from `package.json` and copies the shared
modules into `web/lib`.

### Netlify CLI

```bash
npx netlify-cli login
npx netlify-cli env:set LP_WRITE_TOKEN "your-token"
npx netlify-cli env:set LP_SESSION_SECRET "your-session-secret"
npx netlify-cli env:set LP_PIN "123456"
npx netlify-cli deploy --build --prod
```

---

## 4. Connect the extension

1. Reload the extension in `chrome://extensions`.
2. Open the dashboard → **Settings**.
3. Find **Cloud sync for phone**.
4. Set:
   - **Endpoint:** `https://YOUR-SITE.netlify.app/api/snapshot`
   - **Write token:** the same value as `LP_WRITE_TOKEN`
   - **Interval:** 1 minute (or more)
   - **Enabled:** checked
5. Click **Save cloud settings**.
6. Click **☁ Sync now**.
7. The last-sync line should show **OK** and a size in KB.

The extension uploads after captures and learning refreshes, throttled by the
interval. If the PC is off or Chrome is closed, the phone shows a stale
snapshot.

---

## 5. Use the phone view

Open:

```text
https://YOUR-SITE.netlify.app/remote
```

Enter the PIN. You will see:

- snapshot age and PC-online warning;
- active calibration/weights/decision policy;
- current round decisions;
- bankroll, ROI and exposure;
- model leaderboard;
- an online slip builder using the snapshot odds;
- copy-slip and refresh buttons.

The page is read-only. It never sends activation, settings or bet commands back
to the PC.

---

## 6. Local preview

Public page:

```bash
npm run web
```

Private page local testing needs a Netlify Functions environment (Blobs and
cookies). The easiest path is:

```bash
npx netlify-cli dev
```

Then open `http://localhost:8888/remote`.

The simple `tests/serve-web.cjs` server is only for the public odds page; it
does not emulate Netlify Blobs or the PIN session.

For a UI-only demo of `/remote` with sample fixtures (no PIN, no Blobs):

```bash
npm run remote:demo
```

Then open `http://localhost:8125/remote`.

---

## 7. Snapshot contents

The extension uploads only what the phone needs:

- catalogue definitions;
- current fixtures and selection sets;
- active learning/decision state;
- recent compact ledger rows;
- performance summary (bankroll, ROI, CLV, model leaderboard);
- data counts and warnings.

It does **not** upload the full IndexedDB history, the write token or the PIN.

---

## 8. Security model

- Write endpoint: `POST /api/snapshot` requires `x-lp-token`.
- Read endpoint: `GET /api/snapshot` requires a signed HttpOnly session cookie.
- Login: PIN, rate-limited, `SameSite=Lax`, `Secure` outside localhost.
- Secrets live in Netlify environment variables, not in the static page.
- The write token is stored only in the extension's IndexedDB.
- The phone cannot activate models or change the extension.

---

## 9. Troubleshooting

- **Phone shows “No snapshot uploaded yet”**: use Settings → Sync now in the
  extension.
- **Upload fails with 401**: endpoint and `LP_WRITE_TOKEN` do not match.
- **Login says invalid PIN**: check `LP_PIN`/`LP_PIN_HASH`.
- **Login locked**: wait 15 minutes or change the PIN.
- **Page loads but no data**: check Netlify function logs for `/api/snapshot`.
- **Snapshot is stale**: PC sleep, Chrome closed, or the extension alarm did not
  run. Set Windows to never sleep when plugged in.
- **Public slip builder has no fixtures**: no upcoming round at that moment;
  reload in a minute.
- **Custom domain**: add it to `host_permissions` in `manifest.json`, for example
  `https://your-domain.example/*`, then reload the extension.

---

## 10. Safety notes

- This is an independent research tool, not affiliated with Bet9ja.
- It does not place bets or hold funds.
- The phone is a read-only window into a local research engine.
- A slip that reaches your target odds is not a guaranteed win.
- If you deploy publicly, add your own privacy notice, moderation and
  jurisdiction-specific gambling disclosures.
