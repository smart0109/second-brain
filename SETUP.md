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
