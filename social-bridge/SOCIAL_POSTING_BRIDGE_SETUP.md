# Social Media Posting — Second Brain feature + local bridge

The **Social Posting** tab in Second Brain (https://second-brain-iida.onrender.com)
shows a viral LinkedIn post to engage with, generates two AI drafts (a punchy
challenge and an expert take), lets you edit them, and has a **Post to LinkedIn**
button. Posting is executed by a local poller on your machine (the cloud app
cannot drive your logged-in LinkedIn session itself).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Page + API | `second-brain` repo (deployed) | `Social Posting` tab; `/api/social/*` endpoints |
| `sb_social_bridge.py` | this folder | `push-targets` (feed viral posts up) + `poll` (post jobs to LinkedIn) |

Data is stored server-side in `data/social-targets.json` and `data/social-posts.json`.

## One-time setup (local machine)

1. Install deps:
   ```
   pip install selenium webdriver-manager
   ```
2. Create the dedicated Chrome profile and log into LinkedIn ONCE so the session
   is saved (no password is stored):
   ```
   python sb_social_bridge.py poll --once
   ```
   Chrome opens; if it lands on the login page, log in (and pass any 2FA). After
   you see your feed, the profile at `%LOCALAPPDATA%\sb-linkedin-profile` is
   authenticated for future runs. (Or set `LINKEDIN_USERNAME` / `LINKEDIN_PASSWORD`
   in SECRETS.txt for auto-login fallback.)

## Daily use

Push the viral targets the page shows (after your discovery/find_targets run):
```
python sb_social_bridge.py push-targets --client cadient --top 8
```
(If find_targets output isn't found, the page lets you paste a post manually.)

Run the poller so Post-button jobs actually publish (keep it running, or schedule it):
```
python sb_social_bridge.py poll            # loops, 60s interval, exits <540s for watcher
python sb_social_bridge.py poll --once     # single pass
```

### Schedule the poller (every 5 min while your PC is on)
```
schtasks /create /tn "SB Social Poller" /sc minute /mo 5 /f ^
  /tr "C:\Users\manis\AppData\Local\Programs\Python\Python314\python.exe C:\Users\manis\social-selling-v4.1\social-selling-deploy\sb_social_bridge.py poll --once"
```

## Config (env first, else SECRETS.txt)

- `SECOND_BRAIN_URL` — default `https://second-brain-iida.onrender.com`
- `SOCIAL_BRIDGE_TOKEN` — optional. If set here AND in Render env, it is required
  on the bridge endpoints. If unset (default), the server's own auth is used.
- `LINKEDIN_CHROME_PROFILE` — default `%LOCALAPPDATA%\sb-linkedin-profile`
- `LINKEDIN_USERNAME` / `LINKEDIN_PASSWORD` — optional auto-login fallback
- `SOCIAL_TARGETS_FILE` — override the find_targets output path

## Notes / caveats

- LinkedIn has no official personal-posting API and actively blocks datacenter
  automation; that is why posting runs locally via your real logged-in Chrome
  profile, and only when your machine is on.
- Default post mode is **comment** on the target post (engagement). Jobs with no
  target URL post as a **standalone feed post**.
- LinkedIn DOM changes occasionally; if a post fails, the page shows the error and
  the comment-submit selectors in `_post_comment()` may need a quick update.
- Security: the bridge endpoints currently rely on the server's existing
  `GOOGLE_REFRESH_TOKEN` auth bypass (same posture as the rest of the app). Set
  `SOCIAL_BRIDGE_TOKEN` on Render + in SECRETS to lock them down.
