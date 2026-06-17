# CRO Second Brain - Deployment Guide

## 1. Prerequisites

- Node.js 18+ (check with `node --version`)
- A Google Cloud project with OAuth 2.0 credentials
- Zoho CRM API credentials (for Cadient pipeline data)
- Granola API key (for meeting transcripts, optional)
- Anthropic API key (for AI briefings via Claude Sonnet)

## 2. Google Cloud OAuth Setup

1. Go to https://console.cloud.google.com
2. Create a new project or select an existing one.
3. Navigate to APIs & Services and enable the following APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
4. Go to APIs & Services > Credentials.
5. Click "Create Credentials" > "OAuth 2.0 Client ID".
6. Select application type: **Web application**.
7. Under "Authorized redirect URIs", add:
   - `http://localhost:3000/auth/google/callback` (for local development)
   - `https://your-app.railway.app/auth/google/callback` (for production)
8. Click Create and copy the **Client ID** and **Client Secret**.

The server requests these scopes automatically during the OAuth flow:

| Scope | Purpose |
|-------|---------|
| gmail.readonly | Read emails for briefings |
| gmail.compose | Create draft replies |
| gmail.modify | Label management |
| calendar.readonly | Read calendar events |
| drive.readonly | Search and list Drive files |
| userinfo.email | Verify allowed email address |

## 3. Zoho CRM API Setup

1. Go to https://api-console.zoho.com
2. Click "Add Client" and select **Server-based Application**.
3. Set the redirect URI to any valid URL (you only need it once for the self-client flow).
4. Note your **Client ID** and **Client Secret**.
5. Scopes needed: `ZohoCRM.modules.READ, ZohoCRM.coql.READ, ZohoCRM.modules.UPDATE`
6. Generate a refresh token using the **Self Client** option:
   - Go to the Self Client tab in api-console.zoho.com.
   - Paste the scopes above, set duration to 10 minutes, and click Generate.
   - Exchange the grant token for a refresh token:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "code=YOUR_GRANT_TOKEN&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET&grant_type=authorization_code"
```

7. From the response, save the `refresh_token` value.
8. Note the API domain for your datacenter:
   - US: `https://www.zohoapis.com` (Cadient)
   - EU: `https://www.zohoapis.eu`
   - India: `https://www.zohoapis.in`

The server supports these Zoho operations: `executeCOQLQuery`, `searchRecords`, `updateRecord`, `getRecords`, `getRecord`.

## 4. Environment Variables

Copy `.env.example` to `.env` and fill in the values. Every variable is listed below:

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret from Google Cloud Console |
| `GOOGLE_REFRESH_TOKEN` | No (first run) | Obtained via the `/auth/google` flow, then set here for persistent auth. Once set, the server auto-authenticates on startup. |
| `REDIRECT_URI` | Yes | OAuth callback URL. Local: `http://localhost:3000/auth/google/callback`. Production: `https://your-app.railway.app/auth/google/callback` |
| `ZOHO_CLIENT_ID` | Yes | Zoho API Console Client ID |
| `ZOHO_CLIENT_SECRET` | Yes | Zoho API Console Client Secret |
| `ZOHO_REFRESH_TOKEN` | Yes | Zoho refresh token generated via Self Client |
| `ZOHO_API_DOMAIN` | No | Defaults to `https://www.zohoapis.com`. Change for EU/India datacenters. |
| `GRANOLA_API_KEY` | No | Bearer token for Granola meeting API. Leave blank to disable meeting features. |
| `ANTHROPIC_API_KEY` | Yes | API key from https://console.anthropic.com (powers AI briefings via Claude Sonnet) |
| `SESSION_SECRET` | Yes | Random string, at least 32 characters. Used for express-session cookie signing. |
| `ALLOWED_EMAIL` | No | Google email allowed to authenticate. Defaults to `manish696@gmail.com`. A second email (`manish@basisvps.com`) is always allowed. |
| `PORT` | No | Server port. Defaults to `3000`. Railway sets this automatically. |

## 5. Local Development

```bash
cd second-brain-app
npm install
cp .env.example .env
# Edit .env and fill in all values (see table above)
node server.js
```

The server starts on http://localhost:3000. On first run:

1. Visit http://localhost:3000
2. Click "Sign in with Google" (redirects to `/auth/google`).
3. Complete the Google OAuth consent screen.
4. The callback page displays your **refresh token**. Copy it.
5. Paste it into `.env` as `GOOGLE_REFRESH_TOKEN`.
6. Restart the server. It now auto-authenticates without the browser flow.

For hot-reload during development:

```bash
npm run dev
```

This uses `node --watch` (Node 18+) to restart on file changes.

Health check endpoint: `GET /health` returns JSON with status and which services are configured.

## 6. Railway Deployment

### Option A: Deploy from GitHub (recommended)

1. Push the repo to GitHub.
2. Go to https://railway.app and create a new project.
3. Click "Deploy from GitHub Repo" and select your repository.
4. If the repo contains multiple directories, set the **Root Directory** to `second-brain-app`.
5. Railway auto-detects Node.js via `package.json` and runs `npm start` (`node server.js`).
6. Go to the project Settings > Variables and add ALL environment variables from your `.env` file.
7. **Critical:** Set `REDIRECT_URI` to `https://your-app.railway.app/auth/google/callback` (use the actual Railway domain shown in your project settings).
8. Also add `https://your-app.railway.app/auth/google/callback` as an authorized redirect URI in Google Cloud Console.
9. Deploy. Railway builds and starts the server automatically.
10. Railway auto-deploys on every push to main.

### Option B: Deploy via Railway CLI

```bash
npm i -g @railway/cli
railway login
cd second-brain-app
railway init
railway variables set GOOGLE_CLIENT_ID=xxx
railway variables set GOOGLE_CLIENT_SECRET=xxx
railway variables set ZOHO_CLIENT_ID=xxx
railway variables set ZOHO_CLIENT_SECRET=xxx
railway variables set ZOHO_REFRESH_TOKEN=xxx
railway variables set ZOHO_API_DOMAIN=https://www.zohoapis.com
railway variables set ANTHROPIC_API_KEY=xxx
railway variables set SESSION_SECRET=xxx
railway up
railway domain
```

### First-time Google Auth on Railway

1. Visit `https://your-app.railway.app/auth/google` in your browser.
2. Complete the Google OAuth consent screen.
3. The callback page displays your refresh token. Copy it.
4. Add it as `GOOGLE_REFRESH_TOKEN` in Railway's environment variables:
   - Dashboard: Settings > Variables > Add variable
   - CLI: `railway variables set GOOGLE_REFRESH_TOKEN=xxx`
5. Railway automatically redeploys when env vars change. The server now auto-authenticates on every startup.

## 7. Architecture Notes

The server is a single Express.js app (`server.js`) that acts as an API proxy:

- **`/api/proxy`** -- Unified MCP tool proxy. Accepts `{ tool, args }` and routes to the correct service handler (Gmail, Calendar, Zoho, Granola, Drive) based on the tool name or UUID prefix.
- **`/api/ask`** -- Claude API proxy. Sends prompts with data context to Anthropic's Messages API (claude-sonnet-4-20250514, 1024 max tokens).
- **`/auth/google`** and **`/auth/google/callback`** -- OAuth 2.0 flow.
- **`/health`** and **`/auth/status`** -- Status endpoints.
- Static files served from `public/` directory.
- SPA catch-all: any unmatched GET route serves `public/index.html`.

Dependencies (3 total): `express`, `express-session`, `googleapis`.

## 8. Estimated Cost

| Service | Cost |
|---------|------|
| Railway Hobby plan | ~$5/month |
| Anthropic API (Claude Sonnet for briefings) | ~$0.50-2/month |
| Google APIs (Gmail, Calendar, Drive) | Free tier covers this usage |
| Zoho CRM API | Included with Zoho CRM subscription |
| Granola API | Included with Granola subscription |
| **Total** | **~$5-7/month** |

## 9. Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Not authenticated" on API calls | Set `GOOGLE_REFRESH_TOKEN` in your environment. Without it, every request requires a browser session via `/auth/google`. |
| Zoho token refresh fails | Verify `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN` are correct. Check that the refresh token was generated with the required scopes. If using a non-US datacenter, set `ZOHO_API_DOMAIN` accordingly. |
| "Granola not configured" | This is expected if `GRANOLA_API_KEY` is not set. The server returns a descriptive message instead of failing. |
| Calendar/Gmail not loading | Verify Gmail API + Calendar API are enabled in Google Cloud Console. |
| Railway deploy fails | Ensure `package.json` is in the root directory (or set Root Directory in Railway settings). Check that Node.js 18+ is available. Run `railway logs` to see the error. |
| OAuth callback error | Confirm the `REDIRECT_URI` env var matches exactly what is configured in Google Cloud Console's authorized redirect URIs. |

---

# Multi-User / Multi-Tenant Upgrade (Google + Microsoft login)

The app now supports multiple users. Each user signs in with Google **or**
Microsoft, is checked against an email allowlist, and connects **their own**
data sources (Gmail/Calendar/Drive, Zoho CRM, Granola). No provider token is
shared between users — every credential is encrypted (AES-256-GCM) and stored
per-user in Postgres.

## Architecture

- `lib/db.js` — Postgres pool + idempotent migration runner; seeds the bootstrap admin.
- `migrations/001_multiuser.sql` — `users`, `allowlist`, `user_tokens` (encrypted vault), `memory_blobs`, `session`.
- `lib/tokens.js` — per-user encrypted token vault (`TOKEN_ENC_KEY`).
- `lib/auth.js` — user store, allowlist, and OAuth helpers for Google / Microsoft / Zoho.
- `lib/context.js` — `AsyncLocalStorage` binding the logged-in user to each request, so
  `getAuthedClient()` / `getZohoAccessToken()` resolve the current user's tokens.
- `lib/memstore.js` — durable per-user memory (write-through cache to Postgres).

## 1. Create the Postgres database (Render)

`render.yaml` already declares a free `second-brain-db` and wires `DATABASE_URL`
into the web service. On deploy, the schema is migrated automatically at startup.
(Local dev: create a Postgres DB and set `DATABASE_URL`, `PGSSL=disable`.)

## 2. Generate the token-encryption key

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

Set the output as `TOKEN_ENC_KEY` in Render env. **Keep it stable** — rotating it
makes existing stored tokens undecryptable (users would just reconnect).

## 3. Register the Microsoft (Entra) app

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Supported account types: pick to match `MS_TENANT`:
   - single org tenant → use your tenant GUID for `MS_TENANT`
   - any work/school + personal → `common`
3. **Redirect URI** (Web): `https://<app>.onrender.com/auth/microsoft/callback`.
4. **Certificates & secrets** → new client secret → set `MS_CLIENT_SECRET`.
5. Copy Application (client) ID → `MS_CLIENT_ID`. API permissions: delegated
   `openid`, `profile`, `email`, `User.Read` (default) are enough — login only.

## 4. Google OAuth

Reuse the existing Google OAuth client. Add the redirect URI
`https://<app>.onrender.com/auth/google/callback`. Google sign-in doubles as the
Gmail/Calendar/Drive data connection (consent requests those scopes).

## 5. Zoho (optional per user)

Register a Zoho OAuth client (one per data center) and set
`ZOHO_CLIENT_ID/SECRET` (US) and `VORRO_ZOHO_CLIENT_ID/SECRET` (India). Redirect
URI: `https://<app>.onrender.com/connect/zoho/callback`. Each user links Zoho
from the dashboard's **Connections** panel; their refresh token is stored in
their own vault row.

## 6. Allowlist management

- Bootstrap admin(s) come from `ALLOWED_EMAIL` + `ADMIN_EMAILS` (seeded on boot).
- Admins manage the allowlist via:
  - `GET /api/admin/allowlist`
  - `POST /api/admin/allowlist` `{ "email": "person@org.com" }`
  - `DELETE /api/admin/allowlist/:email`
  - `GET /api/admin/users`

## 7. Migrating the existing single-user setup

The bootstrap admin (you) is auto-created. After first deploy, sign in with
Google once to populate your encrypted Google tokens, then use **Connections**
to link Zoho/Granola. The old `GOOGLE_REFRESH_TOKEN` / `ZOHO_REFRESH_TOKEN`
env vars are **no longer read** and can be removed.

## Endpoints added

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/google` `/auth/google/callback` | Login + connect Google data |
| GET | `/auth/microsoft` `/auth/microsoft/callback` | Login (identity only) |
| GET | `/connect/google` | Re-link Google for a logged-in user |
| GET | `/connect/zoho?which=zoho\|zoho_vorro` + `/connect/zoho/callback` | Link Zoho |
| POST | `/connect/granola` `{apiKey}` | Link Granola |
| GET | `/api/connections` | List the current user's linked sources |
| DELETE | `/api/connections/:provider` | Disconnect a source |
| GET/POST/DELETE | `/api/admin/allowlist` | Admin allowlist management |
| GET | `/api/admin/users` | Admin user list |

## Security notes

- `requireAuth` now requires a real session user; the old
  `GOOGLE_REFRESH_TOKEN`-based auto-auth bypass has been removed.
- OAuth flows use a per-session `state` parameter (CSRF protection, 10-min TTL).
- Tokens are encrypted at rest with AES-256-GCM; `/api/connections` never returns secrets.

---

# Microsoft Calendar + Teams transcription, and CRM (HubSpot/Zoho) Kanban + chat

## Microsoft 365 (calendar + Teams transcripts)

Microsoft **login** stays identity-only. To read calendar/Teams data, a logged-in
user clicks **Connections → Microsoft 365**, which runs a second consent against the
same Entra app requesting `Calendars.Read`, `OnlineMeetings.Read`,
`OnlineMeetingTranscript.Read.All`, `offline_access`. The refresh token is stored
per-user in the encrypted vault. Add `MS_DATA_REDIRECT_URI`
(`https://<app>/connect/microsoft/callback`) to the Entra app's redirect URIs.

Endpoints: `GET /api/ms/calendar` (next-7-days by default; `?start&end&top`),
`GET /api/ms/transcripts?joinUrl=...` (resolves the online meeting, lists transcripts),
`GET /api/ms/transcripts/:meetingId/:transcriptId` (VTT text).

**Limitation (important):** Teams transcripts via Graph require **admin consent** and
an **organizational tenant** — personal Microsoft accounts cannot read Teams
transcripts. Calendar works for any account. For a no-admin, cross-platform option,
use Recall.ai below.

## Teams/Zoom/Meet transcription via Recall.ai (single API key)

Recall.ai sends a meeting bot that joins by URL and returns a transcript — works for
Teams, Zoom, and Google Meet with just one API key (no per-user OAuth, no tenant
admin consent). Get a key at recall.ai, then **Connections → Recall.ai**, paste the
key + region (`us-east-1` default). An admin may instead set `RECALL_API_KEY` /
`RECALL_REGION` in env as a shared fallback.

Endpoints: `POST /api/transcription/bot {meetingUrl,botName}` (launch),
`GET /api/transcription/bot/:id` (status), `GET /api/transcription/bot/:id/transcript`
(normalized `{text, segments[]}`), `GET /api/transcription/status`.

The existing Deepgram live-transcription path is unchanged; the three lanes
(Recall.ai bot, Graph stored transcripts, Deepgram live) coexist.

## CRM: HubSpot or Zoho — Kanban board + chat-to-change

The dashboard's **CRM Board** button opens a Kanban view of the user's deal pipeline.
The CRM is chosen per user from what they connected: **HubSpot** first, else
**Zoho (Cadient)**, else **Zoho (Vorro)**. `lib/crm.js` normalizes both to one shape.

- Connect HubSpot: register a HubSpot app, set `HUBSPOT_CLIENT_ID/SECRET` and
  `HUBSPOT_REDIRECT_URI` (`https://<app>/connect/hubspot/callback`), then
  **Connections → HubSpot CRM**. Each user grants their own refresh token.
- Drag a card between columns → `POST /api/crm/deals/:id/move` updates the CRM.
- The chat box turns natural language ("move Acme to Negotiation, add a note: sent
  pricing") into a **preview** of structured changes via `POST /api/crm/chat`
  (nothing is written). Clicking **Apply** runs `POST /api/crm/apply`, which executes
  move/update/note operations through the CRM-agnostic layer. **All CRM writes are
  preview-then-confirm; nothing is written without an explicit Apply.**

Endpoints: `GET /api/crm/pipelines`, `GET /api/crm/board[?provider=&pipelineId=]`,
`POST /api/crm/deals/:id/move {stageId}`, `POST /api/crm/chat {message}`,
`POST /api/crm/apply {changes}`.

## New env vars summary

`HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`,
`MS_DATA_REDIRECT_URI`, `RECALL_API_KEY`, `RECALL_REGION`.
