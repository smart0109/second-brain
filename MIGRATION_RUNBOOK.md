# Second Brain — Operator Runbook

App: second-brain on Render — https://second-brain-iida.onrender.com
All config lives in Render dashboard -> second-brain -> Environment. The old
`render.env` file has been deleted from the repo; never commit secrets again
(`.gitignore` now blocks it). See `.env.example` for the variable names.

---

## 1. CREDENTIAL ROTATION (do this FIRST, ~15 min)

The old secret values sat in git history, so they are exposed. Rotation is
mandatory even though the file is now deleted.

1. Google OAuth client secret:
   1. Go to https://console.cloud.google.com -> APIs & Services -> Credentials.
   2. Open the OAuth 2.0 client used by Second Brain.
   3. Click "Reset secret" (or "Add secret", then delete the old one). Copy the new secret.
   4. In Render dashboard -> second-brain -> Environment, set `GOOGLE_CLIENT_SECRET` to the new value. Save (the service redeploys).
   5. After the deploy finishes, visit https://second-brain-iida.onrender.com/auth/google and complete the login. This mints a new `GOOGLE_REFRESH_TOKEN` — set it in Render env too.
2. Zoho client secret:
   1. Go to https://api-console.zoho.com and open the Second Brain client.
   2. Regenerate the client secret. Update `ZOHO_CLIENT_SECRET` in Render env.
   3. Generate a new grant code in the Zoho console (Generate Code with your existing scopes), exchange it for a new refresh token, and set `ZOHO_REFRESH_TOKEN` in Render env.
3. Session secret:
   1. Run: `openssl rand -hex 32`
   2. Set the output as `SESSION_SECRET` in Render env. (Everyone gets logged out once — expected.)
4. Confirm `ALLOWED_EMAIL` is still `manish696@gmail.com`, save, and let Render redeploy. Log in once to verify everything works.

## 2. FREE DURABLE MEMORY DB (~5 min, $0)

Render free tier has no persistent disk — anything stored on the box vanishes
on every deploy/restart. Fix with a free hosted Postgres.

1. Go to https://neon.tech, sign up (Google login is fine), create a free project. Neon runs on AWS, which satisfies the "hosted on AWS" requirement.
2. On the project dashboard, copy the connection string (starts with `postgres://...`).
3. In Render dashboard -> second-brain -> Environment, add `MEMORY_DATABASE_URL` = that connection string.
4. Optional: also add it as `DATABASE_URL` so login sessions survive deploys too.
5. Save; Render redeploys automatically.

Alternative: Render's own free Postgres works but expires after ~30 days on
the free tier — Neon is preferred.

## 3. PREMIUM UPGRADE PATH (later, when it matters)

1. AWS RDS Postgres `db.t4g.micro` (~$13/mo) or Aurora Serverless v2: create the instance, then change `MEMORY_DATABASE_URL` in Render env to the new connection string. Zero code changes.
2. DynamoDB is possible but needs a small adapter swap in the store layer (store.js) — only do this if you specifically want serverless AWS-native storage.

## 4. RENDER PLAN (keep the copilot warm)

The free plan sleeps the service after ~15 min idle; the next request eats a
~50 second cold start — bad for the live meeting copilot.

1. Render dashboard -> second-brain -> Settings -> Instance Type.
2. Upgrade to Starter ($7/mo). The service stays warm 24/7. No other changes needed.

## 5. OPTIONAL HISTORY SCRUB (nice-to-have, not urgent)

Deleting `render.env` removes it from the current code, but old git commits
still contain the old secret values — anyone with repo access can dig them out
of history. Once you finish Section 1, those values are dead, so this is
optional hygiene rather than an emergency. If you want them gone entirely,
run `git filter-repo --path render.env --invert-paths` on a fresh clone and
force-push; this rewrites history, so do it at a quiet moment and re-clone
afterwards.
