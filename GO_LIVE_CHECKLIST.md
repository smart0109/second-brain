# Second Brain — Multi-Tenant Go-Live Checklist

Goal: validate the whole branch against **sandbox/test accounts** before any
production data is touched, then merge to `main`. Every provider below has a
free test path, so you can do the entire dry run without risking a live account.

## 0. Test/sandbox accounts (all free)

| Provider | Test option | Notes |
|---|---|---|
| Postgres | Render free Postgres (in render.yaml) or local Docker | Ephemeral is fine for testing. |
| Google | OAuth client in **Testing** publishing status + add yourself as a test user | Up to 100 test users, no Google verification needed. Use a throwaway Gmail. |
| Microsoft | **Microsoft 365 Developer Program** E5 sandbox: 25 users + admin, renewable, Teams + sample calendar/mail data | This is the ONLY way to test Teams transcripts (needs admin consent, which you control in your own sandbox tenant). Eligibility now requires a Visual Studio subscription or qualifying program — check the FAQ. |
| HubSpot | **Developer account → developer test account** (free, up to 10, 90-day) | Apps can't install on the developer account itself — install on a test account. |
| Zoho | Free Zoho CRM account (or a paid-plan Sandbox) | A free CRM org is enough to exercise read/move/note. |
| Recall.ai | **Free signup credits + free developer sandbox** | Pay-as-you-go after: ~$0.50/recording-hr + $0.15/hr transcription; Calendar API free; media stored 7 days free. |

## 1. Provision the test environment (Render, separate service)

1. Create a NEW Render web service from the `multiuser-msauth` branch (do not point it at prod).
2. Add the free Render Postgres (render.yaml declares `second-brain-db`).
3. Generate the encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → set `TOKEN_ENC_KEY`.
4. Set `SESSION_SECRET`, `ALLOWED_EMAIL` (your test email), `NODE_ENV=production`.
5. Deploy. Confirm logs show `[startup] Postgres schema ready.` and `/health` returns `{multiUser:true}`.

## 2. Auth + isolation

- [ ] Visit the app → see Google + Microsoft sign-in buttons.
- [ ] Sign in with an **allowlisted** test email → lands on dashboard.
- [ ] Sign in with a **non-allowlisted** email → "Access denied" page (allowlist works).
- [ ] Add a second test email via `POST /api/admin/allowlist`, sign in as them in a separate browser.
- [ ] **Isolation check:** connect a data source as user A; confirm user B sees none of A's connections (`GET /api/connections`).
- [ ] Log out → session cleared; protected routes return 401.

## 3. Google data (test-user OAuth)

- [ ] Google client redirect URIs include `https://<test-app>/auth/google/callback`.
- [ ] Sign in with Google → confirm Gmail/Calendar/Drive calls work for that user only.

## 4. Microsoft 365 (dev sandbox tenant)

- [ ] Entra app registered in the sandbox tenant; redirect URIs include both
      `/auth/microsoft/callback` and `/connect/microsoft/callback`.
- [ ] Microsoft login works (identity).
- [ ] Connections → Microsoft 365 → grant calendar/Teams scopes (admin-consent in sandbox).
- [ ] `GET /api/ms/calendar` returns sandbox events.
- [ ] Record a Teams meeting in the sandbox, then `GET /api/ms/transcripts?joinUrl=...`
      → resolves the meeting and lists transcripts. (Confirms the admin-consent path.)

## 5. Recall.ai (free sandbox)

- [ ] Connections → Recall.ai → paste sandbox API key + region.
- [ ] `POST /api/transcription/bot {meetingUrl}` with a real test meeting URL → bot joins.
- [ ] After the meeting, `GET /api/transcription/bot/:id/transcript` → normalized text.
- [ ] Confirm spend is on free credits; set a billing alert before going to production volume.

## 6. CRM Kanban + chat-to-change (HubSpot test account and/or free Zoho)

- [ ] HubSpot app redirect URI includes `/connect/hubspot/callback`; install on the **test account**.
- [ ] Connections → HubSpot (or Zoho) → connect.
- [ ] **CRM Board** opens; columns + deals render from the test pipeline.
- [ ] Drag a card to another column → refresh the test CRM → stage actually changed.
- [ ] Chat: "move <deal> to <stage> and add a note: test" → **preview** appears, nothing written yet.
- [ ] Click **Apply** → changes land in the test CRM; bad/ambiguous requests don't write.
- [ ] Confirm the field allowlist: a chat asking to change a non-allowlisted field is ignored.

## 7. Regression + security spot-checks

- [ ] All existing dashboard tabs still load for a logged-in user.
- [ ] `npm test` (5 suites, 164 checks) passes in CI/build.
- [ ] No secrets in logs; connect errors don't leak tokens.
- [ ] Removing a user from the allowlist: confirm behavior matches expectation (note: existing
      sessions live up to 7 days — see "known gaps" below; decide if you want immediate revocation).

## 8. Cutover

- [ ] Set the **production** Entra/HubSpot/Google redirect URIs and prod env vars.
- [ ] Merge `multiuser-msauth` → `main` (Render auto-deploys main).
- [ ] Sign in once with Google to seed your own tokens; reconnect Zoho/Granola/Recall.
- [ ] Remove the now-unused `GOOGLE_REFRESH_TOKEN` / `ZOHO_REFRESH_TOKEN` env vars.

## Known gaps to decide on before/at go-live

1. **Shared-admin Recall key** — if several admins use the env `RECALL_API_KEY` fallback
   instead of each connecting their own, they share one Recall account and can see each
   other's bots/transcripts. Mitigation: have each admin connect their own key, or ask me to
   add per-user bot-ownership tracking.
2. **Allowlist removal doesn't kill live sessions** — a removed user keeps access until their
   session cookie expires (≤7 days). If you need instant revocation, add an allowlist re-check
   in `requireAuth`.
3. **Two memory subsystems** still coexist (canonical + legacy org-memory). Safe, but worth a
   future consolidation.
