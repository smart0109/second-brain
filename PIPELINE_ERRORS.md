
## [2026-08-06] (stale-device-stage-false-dataloss): Prior session concluded 3 sessions of feature work (Phase 7/8/9: AI Transcription auto-start, Motivate/Humor buttons, hero-quote styling, Intelligence fold-in) were LOST from production. Root cause: `device_stage_files` (VirtioFS bridge) served stale cached content (735,891 bytes, Jul-22-dated) across 5+ retries despite reporting fresh metadata (771,426 bytes), so the diagnosis was built on a corrupted/truncated local copy. Re-verified this session via `windows-executor__read_file` (native IO, sha256-checked) against the true Windows-side files and confirmed via `deploy_to_github.py --dry-run` that current GitHub HEAD (38ec3a007839) tree hash matches the local files exactly (New tree == Base tree) — ALL prior feature work (Phase 7/8/9) IS present and intact in production. No data was actually lost. Fix/rule: never trust `device_stage_files` byte-count metadata alone for verification-critical work — use `windows-executor__read_file`'s sha256 (native IO, no VirtioFS truncation/mount-lag) instead, and cross-check against `deploy_to_github.py --dry-run`'s tree-hash comparison before concluding anything is missing/lost.

## [2026-08-06] (copilot-transcript-grid-overflow): User reported (with live screenshot) the AI Transcription tab's panels squeezed/off-screen with a page-wide horizontal scrollbar. Root cause: `.copilot-layout` is a `display:grid;grid-template-columns:1fr 1fr` container whose direct children had no `min-width:0` override, so a CSS grid item's default `min-width:auto` (= min-content size of its contents) let one long unbroken token in the live transcript (`#copilotTranscript .ct-line`, which also lacked `overflow-wrap`/`word-break`) force that grid column — and the whole page — wider than the viewport. Reproduced headlessly (empty-state test showed no overflow; injecting one long unbroken string into the transcript blew page width from 1568px to 2422px) which is why the bug didn't show on a static/empty check and only appeared with real long-running live caption data. Fix: added `min-width:0` to `.copilot-layout` and its direct children, `overflow-wrap:anywhere;word-break:break-word` to `.copilot-transcript`/`.ct-line`/`.mtg-transcript-box`. Verified fix eliminates the repro at all tested viewport widths with no regressions.

## [2026-08-06] (call-helper-no-timeout): Deep review (per user request to fix "various issues with pages loading") found the frontend `call()` helper (all Copilot/CRM/Calendar/Zoho/Granola data fetches go through it) had no client-side timeout — if any upstream Google/Zoho/Granola API stalled, the fetch never resolved or rejected, so the tab's loading spinner spun forever with no error shown. Fix: added a 25s `AbortController` timeout to `call()`, so any hang now surfaces as a visible error/retry banner within 25s instead of hanging indefinitely. Also fixed: (1) `checkUpcomingMeetings`/`refreshCopilotCurrentMeeting` had no reentrancy guard, so a slow API tick could overlap with the next 60s poll and race on shared meeting-detection state — added in-flight guards to both. (2) `checkUpcomingMeetings` referenced an undefined `names` variable in the desktop-notification body, which threw and was silently swallowed by an empty catch, so the "meeting starting soon" notification never actually fired — fixed by computing `names` from `attendees`.

## Session Log - 2026-08-06 (AI Transcription fit + loading deep review)
**Accomplished:** Corrected a false "3 sessions of work lost" alarm from a prior session (root cause: stale device_stage_files cache, not actual data loss - all Phase 6/7/8/9 features confirmed present in production via sha256+tree-hash verification). Found and fixed the real reported bug: AI Transcription tab horizontal overflow, root-caused to a CSS grid min-width:auto issue in .copilot-layout that only manifests with real long-running live transcript text (reproduced headlessly, confirmed fix). Also fixed 3 "pages loading" bugs surfaced by a deep-review agent: call() had no timeout (spinners could hang forever on a stalled upstream API - added 25s AbortController timeout), no reentrancy guard on the 60s meeting watcher (added in-flight guards to checkUpcomingMeetings/refreshCopilotCurrentMeeting), and a silently-broken meeting-starting-soon notification (undefined `names` var). Deployed as commit e7987b5691c5, verified live on GitHub main via independent dry-run tree-hash check.
**Pending:** Physician-persona mockup of every page (Today->priority queue, Meetings->patient visits, AI Transcription->clinical notes, Legal Assets->prescriptions/labs, Artifacts->patient training videos), with fabricated example data - queued next per user's own deferral.
**Decisions made:** Treat windows-executor__read_file (native IO + sha256) as the source of truth over device_stage_files for anything verification-critical going forward. All patches now applied via a self-verifying Python patch script (sha256-gated: refuses to touch the file if content doesn't match the expected pre-patch hash) rather than a full file overwrite, to avoid ever repeating the stale-base-file class of bug.
**New rules/learnings added:** See dated entries above (stale-device-stage-false-dataloss, copilot-transcript-grid-overflow, call-helper-no-timeout).
**Handoff note:** Production is live on commit e7987b5691c5. Render should auto-deploy from GitHub main within a few minutes; if the fix isn't visible on second-brain-iida.onrender.com shortly, check the Render dashboard for a stuck/failed deploy rather than re-pushing. Next session should pick up the physician-persona mockup task.

## [2026-08-06] (meet-caption-selectors-stale): User reported the Meet Captions Chrome extension was already paired (one-time popup setup done) but live captions with speaker names never appeared in the AI Transcription tab during real meetings. Root cause: `MEET_CAPTION_CONFIG` in server.js (fetched live by the extension's content.js self-heal `loadConfig()` call on every meet.google.com page load) was dated 2026-06-24 — six weeks stale. Google periodically rotates Meet's obfuscated caption CSS classes (`.NWpY1d`, `.nMcdL`, `.TBMuR`, `.bh44bd`, `.iTTPOb`, `.a4cQT`, etc.) when it ships new frontend builds, silently breaking class-based DOM scraping: the extension was running, paired, and even successfully auto-clicking the CC toggle (that selector, `button[aria-label*="aption" i]`, is aria-label based and stayed valid), but `scan()` found zero matching caption rows because the row/speaker/text class selectors no longer matched Meet's current DOM — so nothing ever got POSTed to `/api/live-captions`, and the extension's own "capturing this meeting" banner gave false confidence since it fires unconditionally regardless of whether scraping actually works. Researched current selectors (via recently-updated open-source Meet caption scrapers) and refreshed `MEET_CAPTION_CONFIG` to a layered priority list: semantic/aria selectors first (most stable across Google's rebuilds), then jsname/jscontroller attributes (Google keeps these more stable release-to-release than hashed classes), then the refreshed obfuscated classes, then generic attribute-substring matches last. Also hardened `content.js` itself with a structural fallback (first `<span>` in a row = speaker, region's direct children = rows if the configured row selectors match nothing) so a *future* class rotation degrades gracefully instead of going fully silent again, plus a visible in-page warning banner if captions are confirmed on but zero lines are captured after 20s (previously: silent, indistinguishable from "no one has spoken yet"). Deployed as commit 906d81cb0347. The server.js half (selector refresh) takes effect immediately for anyone already paired — no extension reload needed, since content.js fetches it live. The content.js half (structural fallback + warning banner) requires Manish to reload the unpacked extension in chrome://extensions once to pick up the new file. Fix/rule: this class of bug (silent breakage from Google's UI churn) will recur periodically — the new layered-fallback + visible-warning design is meant to make the *next* occurrence self-diagnosing instead of requiring another cold investigation from a vague "doesn't work" report.

## [2026-08-06] (transcript-line-edit-delete): Feature request: allow rewriting or deleting an individual line in the AI Transcription tab's live transcript. Design: `copilotTranscriptLines` had no line-level index in the rendered DOM and `renderCopilotTranscript()` fully overwrote `innerHTML` on every change, so any inline edit UI has to be driven from render-time state (not DOM state) to survive re-renders. Added a `copilotEditingIdx` state var; `renderCopilotTranscript()` now renders line `i` as an inline text input (Enter=save, Escape=cancel, or Save/Cancel buttons) when `i===copilotEditingIdx`, otherwise as normal text with hover-revealed edit (pencil) / delete (x) icon buttons. Added `editTranscriptLine`/`saveTranscriptEdit`/`cancelTranscriptEdit`/`deleteTranscriptLine` (delete requires a `confirm()` prompt). Added `escAttr()` since the existing `esc()` helper is only safe for element text content, not for embedding into an HTML attribute value (`value="..."`) — needed so transcript text containing quotes doesn't break the edit input. Edits/deletions mutate `copilotTranscriptLines` directly in place, which is what session-save/meeting-notes-finalize already read from, so no separate sync logic was needed. Verified via a headless Playwright test against the real file (edit/save, edit/cancel, delete/confirm, delete/reject, and an XSS-safety check with a line containing `"quotes" & <tags>`) — all passed, zero page errors. Sha256-gated patch script (`patch_transcript_edit_delete_20260806.py`) written and dry-tested against a byte-for-byte reconstruction of production `public/index.html` (2a4485c5...→df04284c...) — confirmed byte-identical to the edited working copy. NOT YET DEPLOYED as of this entry — see the github-pat-revoked entry immediately below for why.

## [2026-08-06] (github-pat-revoked): User reported (twice) that the AI Transcription tab still wasn't fixed, after this session had already logged commits e7987b5691c5 (overflow/loading fixes) and 906d81cb0347 (Meet Captions fix) as independently-verified-deployed earlier in the session. Investigating why a newly-built, fully-tested feature (transcript line edit/delete, see entry above) couldn't be deployed surfaced the real, more serious root cause: `deploy_to_github.py`'s GitHub PAT is now returning `401 Bad credentials` on every API call — meaning NOTHING can currently be pushed to GitHub, and it's unverified how long this has been broken. Two candidate tokens were tried, both dead: (1) `deploy_to_github.py`'s hardcoded `DEFAULT_PAT` (`ghp_vFRG6...`) fails with 401. (2) The `GITHUB_PAT` value stored in `social-selling-deploy/SECRETS.txt` (`ghp_LoCs...`, presumably the post-2026-06-09-rotation replacement, confirmed byte-clean via `od -c` — not a CRLF/whitespace artifact) ALSO fails with 401. No `.env` file or shell env var in WSL had a working alternative. Repo is private (unauthenticated GET on `api.github.com/repos/smart0109/second-brain/commits/main` returns 404), so there's no way to independently confirm from outside whether e7987b5691c5/906d81cb0347 actually reached GitHub without a working token — though the PIPELINE_ERRORS.md entries for both say they were verified live via `--dry-run` tree-hash match AT THE TIME, meaning the PAT was almost certainly still valid then and broke sometime after (possibly exactly when the device bridge dropped mid-session — timing unconfirmed). Fix: BLOCKED on Manish generating a fresh GitHub PAT (classic, `repo` scope, for `smart0109/second-brain`) and providing it — via updating `GITHUB_PAT=` in `social-selling-deploy/SECRETS.txt` and/or exporting it as a `GITHUB_PAT` env var before running `deploy_to_github.py`. Root cause of WHY it was revoked is unconfirmed (manual rotation, GitHub auto-revoke, org/SSO re-auth requirement, or expiration) — worth checking github.com/settings/tokens once a new one is issued. Also: `deploy_to_github.py`'s hardcoded `DEFAULT_PAT` fallback is itself part of the standing SECURITY DEBT (plaintext credential in a script) — once a working token exists, that hardcoded fallback should be removed so the script hard-requires the `GITHUB_PAT` env var instead of silently falling back to a stale embedded secret.

## Session Log - 2026-08-06 (transcript edit/delete + mockup fixes + PAT blocker)
**Accomplished:** (1) Built and fully tested (headless Playwright, zero errors, XSS-safety checked) the AI Transcription tab's rewrite/delete-a-line feature — patch script ready, NOT yet deployed (blocked, see below). (2) Fixed physician mockup drag-and-drop: root cause was native HTML5 draggable/dragstart/dragover/drop, which is unreliable in sandboxed/embedded preview contexts and has no touch support — rebuilt on plain pointer events (mousedown/mousemove/mouseup + touch equivalents), verified working on all three lists (Priority Queue schedule, Today's Visits Morning, Today's Visits Afternoon). (3) Added a "Patient Detail" card below "Care Team On Today" on the Today's Visits mockup page — clicking any real patient in Morning/Afternoon populates it (age/sex/MRN, today's reason, allergies, active meds, latest vitals, flag); non-patient blocks (Chart review block, Care team huddle) are intentionally non-clickable. Redelivered physician_mockup.html. (4) Discovered and root-caused a session-critical blocker: the GitHub PAT `deploy_to_github.py` uses is dead (401 Bad credentials) on both known candidate tokens — nothing can be pushed to GitHub/Render right now.
**Pending:** Deploy the transcript edit/delete feature (`patch_transcript_edit_delete_20260806.py`, already dry-tested byte-for-byte correct) the moment a working `GITHUB_PAT` is available. Also worth re-verifying, once deploy access is restored, that commits e7987b5691c5 and 906d81cb0347 are actually live on Render (they were confirmed pushed to GitHub at the time via dry-run tree-hash match, but Render's own deploy could separately be stuck — check the Render dashboard if the fix still isn't visible after a hard refresh once this round deploys).
**Decisions made:** Physician mockup's drag-and-drop will use pointer events going forward, not native HTML5 DnD, for reliability across embedded/iframe preview contexts. `deploy_to_github.py`'s hardcoded `DEFAULT_PAT` fallback should be removed once a working token is confirmed, so a dead/stale credential fails loudly instead of silently.
**New rules/learnings added:** See dated entries above (transcript-line-edit-delete, github-pat-revoked).
**Handoff note:** Everything is ready to ship the moment Manish supplies a working GitHub PAT (classic, `repo` scope) via `GITHUB_PAT=` in `social-selling-deploy/SECRETS.txt` or pasted directly. Once that's in hand: run `patch_transcript_edit_delete_20260806.py` on the live `public/index.html`, `deploy_to_github.py --dry-run` to confirm zero drift, then deploy with `--signatures`, then independently re-verify.

## [2026-08-11] (sales-skills-integration): User linked github.com/louisblythe/Sales-Skills (a public sales-playbook repo for AI agents: objection handling, discovery, closing, negotiation, ICP scoring, deal review, etc.) and asked how to incorporate it into Second Brain's sales-coaching logic. Scoped via AskUserQuestion — user chose the most comprehensive option ("Full build: content + library + new features") over lighter alternatives (content-only refresh, library-only, or new-features-only). Researched 14 relevant framework files from the repo via WebFetch summaries (LAER, ARC, HEAR active-listening, 7-phase Discovery, closing techniques/buying signals, negotiation/BATNA, building-rapport signal-reading, sales-psychology's 6 categories, competitive-positioning battlecards, ICP 5-dimension scoring, BANT/MEDDIC/GPCTBA/CHAMP qualification, deal-review priority-order, conversation-quality-scoring, pipeline-management coverage-ratio model) and wrote entirely original condensed in-app content referencing the named public methodologies rather than reproducing repo text (copyright-safe: summaries only, no verbatim reproduction). Built four pieces, all in index.html unless noted: (1) LAER objection-handling upgrade — added ACK_LINES/EXPLORE_QUESTIONS per objection type, rewrote generateAutoRebuttal() to render a 3-part Acknowledge/Respond/Explore card for canned rebuttals, updated the AI-generated rebuttal's system prompt to enforce LAER structure + ARC anti-pattern guardrails (no arguing/defensiveness/unprompted discounting), and rewrote all 6 copilotAction() prompts (explain/rebuttal/tone/advise/motivate/humor) to cite specific named frameworks instead of generic instructions. (2) Sales Playbooks library — added a 10-entry PLAYBOOK_LIBRARY (LAER, HEAR, Discovery, Closing, Negotiation, Rapport, Psychology, Competitive, Pipeline, Deal Review), a PLAYBOOK_TOPIC_MAP wiring existing topic-detection to relevant playbooks, surfacePlaybooks() called from the end of the existing surfaceAssets() so playbooks auto-surface live during calls using the same detection pattern assets already use, openPlaybook() to jump/expand a card from a live suggestion, and a full browsable library UI (buildPlaybookLibrary()) added to the Intelligence tab. (3) ICP firmographics — discovered scoreAgainstConfig() in server.js already had min_employees/industries config fields defined but never read; added actual employee-count and industry-match scoring logic (+3 enterprise-scale, +2 threshold-met, +2 industry match, informational notes when below/no-match) rather than building a redundant parallel feature, added matching icpEmployees/icpIndustry form fields and a "Firmographic Fit" results block on the client, updated the /api/icp/score route to pass the new fields through. (4) Deal Review — new generateDealReview() button/feature that sends the live transcript to the AI with a deal-review-framework system prompt and renders structured JSON (stage, outcome factor, process execution, competitive dynamics, qualification gaps, next action) instead of prose. All four verified via headless Playwright against the real files with zero page errors: verify_laer2.js (confirms canned rebuttal's Acknowledge/Respond/Explore renders correctly BEFORE the async AI call overwrites it — an earlier version of this test wrongly captured post-overwrite state and showed false negatives), verify_playbooks.js (10/10 library cards render, toggle works, surfacePlaybooks correctly matches 4 of 4 mapped topics and skips 1 unmapped topic, openPlaybook correctly switches view + expands + scrolls), a standalone 6-scenario Node test of the rewritten scoreAgainstConfig() (enterprise fit, small-company-below-minimum, industry-match, industry-no-match, no-data-provided backward-compat, and the disqualified-title early-return path all scored correctly), and verify_dealreview.js (empty-transcript guard, correct structured rendering, malformed-AI-response handled without crashing, plus a full regression pass confirming the transcript edit/delete feature, playbook functions, and ICP fields from earlier in this session all still work). Root cause of the one real bug hit while building this (LAER test false negative): generateAutoRebuttal() renders the canned rebuttal synchronously first, then awaits an AI call that OVERWRITES el.innerHTML with the AI version once it resolves — a test that reads the DOM after the full async chain settles will only ever see the AI-generated version, never the canned one. Fix: verify_laer2.js stubs ask() to never resolve, so the canned-state assertions run before any overwrite can occur. Status: fully built and tested locally, NOT deployed — blocked on the same dead GitHub PAT as the transcript-edit-delete feature (see github-pat-revoked entry above; re-confirmed still 401 Unauthorized as of this entry, SECRETS.txt's GITHUB_PAT unchanged since 2026-07-10, five days before this blocker was first discovered). Local files: index.html 802,794 bytes sha256 19507f44..., server.js 199,211 bytes sha256 dc3a75ab.... Baseline (last genuinely deployed) hashes this patch will be gated against: index.html 772,726 bytes sha256 2a4485c5... (commit e7987b5691c5), server.js 196,833 bytes sha256 7feb7565... (commit 906d81cb0347).

## Session Log - 2026-08-11 (Sales-Skills full-build integration)
**Accomplished:** Researched louisblythe/Sales-Skills and built all four pieces of the user-selected "Full build" scope: (1) LAER-framework objection handling (canned + AI rebuttals, all 6 Copilot AI Actions rewritten to cite named frameworks), (2) a 10-entry auto-surfacing Sales Playbook library wired into the existing live-call topic-detection + a browsable library UI on the Intelligence tab, (3) ICP Firmographic Fit scoring (employee count + industry match) wired into the pre-existing but previously-dead min_employees/industries config fields, (4) an on-demand Deal Review feature producing structured stage/outcome/process/competitive/qualification-gap/next-action output from the live transcript. All four fully tested locally via headless Playwright + Node scenario tests, zero errors, zero regressions against earlier features (transcript edit/delete, mockup fixes).
**Pending:** Deploy everything the moment a working GitHub PAT is available — this session's work AND the still-undeployed transcript edit/delete feature from 2026-08-06 are both blocked on the same dead credential. Re-checked this session: GitHub API still returns 401 Unauthorized on the current SECRETS.txt token, which has not been updated since 2026-07-10.
**Decisions made:** Deploy via a sha256-gated patch script that verifies production files still match the known last-deployed baseline, then does a full-file copy from staged sidecar files (rather than dozens of fragile anchored text replacements) — appropriate given the scale of this batch (10+ edit regions in index.html, 2 in server.js) while preserving the same safety gate as the anchored-replacement pattern.
**New rules/learnings added:** See sales-skills-integration entry above.
**Handoff note:** Nothing more to build here — this is fully done and staged, waiting only on a working GitHub PAT (classic, `repo` scope, for `smart0109/second-brain`) via `GITHUB_PAT=` in social-selling-deploy/SECRETS.txt or pasted directly in chat. Once available: run the staged install script, `deploy_to_github.py --dry-run` to confirm zero unexpected drift, deploy with `--signatures`, then independently re-verify via a fresh `--dry-run`.

## [2026-08-12] (github-pat-revoked-RESOLVED): Manish supplied a fresh classic GitHub PAT (repo scope) after being asked to generate one at github.com/settings/tokens. Rotated GITHUB_PAT in social-selling-deploy/SECRETS.txt via a gated script that refused to write unless the current line matched the known-dead token (safety check passed). Verified the new token against the real GitHub API via deploy_to_github.py --dry-run before touching anything — confirmed valid immediately (no more 401). Deployed everything that had been staged and blocked since 2026-08-06/2026-08-11 in one push: transcript line edit/delete (AI Transcription tab) + the full Sales-Skills integration (LAER objection-handling upgrade, 10-entry auto-surfacing Playbook Library, ICP Firmographic Fit scoring, Deal Review feature). Deploy signatures verified (generateDealReview, PLAYBOOK_LIBRARY, editTranscriptLine, firmographics all present) before push. Commit: 0828a943bc59 ("Sales-Skills integration: LAER rebuttals, playbook library, ICP firmographics, deal review + transcript edit/delete"). Independently re-verified post-deploy via a fresh --dry-run: new tree == base tree (73c362faffc8), confirming GitHub HEAD now exactly matches the local working-tree files with zero drift. Render's /health endpoint responded normally immediately after; full propagation of the new build depends on Render's own auto-deploy timing (typically a couple minutes) — worth a hard refresh of second-brain-iida.onrender.com to confirm the new features are visible if checking immediately.
Also fixed the standing security-debt item flagged across multiple earlier entries: removed deploy_to_github.py's hardcoded DEFAULT_PAT fallback (a stale/dead credential embedded in plaintext in the script) now that a working token is confirmed. The script now hard-requires the GITHUB_PAT env var and fails loudly with a clear error if it's unset, instead of silently substituting a stale embedded secret. Verified via two sanity checks: dry-run still succeeds with GITHUB_PAT exported (matches live HEAD), and dry-run fails with a clear error message when GITHUB_PAT is unset (previously this would have silently used the dead DEFAULT_PAT and produced a confusing 401 instead of a clear "not configured" message).
Root cause of the original PAT death was never conclusively identified (manual rotation, GitHub auto-revoke, or an org/SSO re-auth requirement were the candidates) — Manish was asked to check github.com/settings/tokens for why the old one shows revoked/expired when convenient, to avoid the replacement dying the same way silently.

## [2026-08-12] (css-main-maxwidth-overflow-RESOLVED)
Live AI Transcription tab overflowed horizontally on wide/high-DPI monitors (window.innerWidth ~3432) and the AI Action button grid ballooned to ~1200px-wide buttons.
Root cause: a later "MODERNIST LAYER" CSS override block redefined `.main { max-width: none; ... }`, removing the base theme's `max-width: 1600px` cap on the base `.main` rule (line ~93). The override wins by cascade order, so every downstream layout inherited an unbounded width on wide screens.
Fix: capped the override at `max-width: 2200px` (keeps the wider modern layout intent but stops runaway growth). Verified live via temporary style injection (bodyScrollWidth 5090px -> 3417px, action-button width 1199.5px -> 530.5px) before shipping. Deployed as commit 6c6147ce790f.

## [2026-08-12] (theme-colors-dark-leftover-RESOLVED)
Manish reported "this color pattern doesn't match the others" on the Today page (viral/LinkedIn engagement feed cards rendering as near-black cards with light-gray text) and asked to check all pages.
Root cause: several inline-styled JS-rendered components (Today page viral-post feed cards/drafts/history in spRenderSources/spRenderTargets/spRenderDrafts/spRenderHistory, the meeting-prep-tasks box, the email thread-message expander, the prospect-context widget, the Legal Assets doc viewer, and the glossary search input) hardcoded literal old dark-theme hex colors (`background:#201e1d`, `color:#d6d3d0`, `border:1px solid #3b3735`) instead of referencing the app's actual (light) theme CSS variables. These are leftovers from before the app was reskinned light (see the css-main-maxwidth-overflow-RESOLVED entry above re: the MODERNIST LAYER reskin) — the base CSS variables were updated to a light palette but these inline styles were never migrated, so they kept rendering in the old dark palette, scattered inconsistently through an otherwise light app. One instance (glossarySearch input) was an active legibility bug: light-gray text (#d6d3d0) on a light background, nearly invisible.
Fix: swapped all 24 affected inline occurrences (across the 6 components above) to `var(--bg-card)` / `var(--text-primary)` / `var(--border)` so they render consistently with the rest of the light theme. Deployed as commit bc73344c5877. Verified live via curl grep post-deploy.
Deliberately NOT touched: the Meeting Brief modal, Deal Risk Scores panel, and Memory Panel all share the SAME dark+gold-accent palette consistently among each other and may be an intentional "AI power panel" design distinct from plain data views (matches the app's persistent dark top navbar). Left as-is pending Manish confirming whether those three should also convert to the light theme, rather than guessing on a bigger design call.

## [2026-08-12] (meet-captions-extension-never-installed)
Manish reported: "if I hit join meeting from second brain and use google meet it should start transcribing correct with names, it doesn't."
Root cause: verified live against a real in-progress Google Meet tab and the live Second Brain tab simultaneously. The app's Google Meet auto-capture depends entirely on a separate unpacked Chrome extension ("Second Brain -- Meet Live Captions", source already present on disk at C:\Users\manis\social-selling-v4.1\second-brain-app\meet-captions-extension\) whose content script reads Meet's own on-screen captions and posts them to /api/live-captions with a pairing code. Reloading the Meet tab produced ZERO console output from the extension (not even its "not configured" log line, which fires unconditionally on start()) and no injected status banner -- proof the content script never ran at all, i.e. the extension has never been loaded into Chrome via chrome://extensions -> Load unpacked. The "Join Meet" button in the meeting overlay only does `window.open(joinUrl)`; it has no way to install or verify the extension. This is NOT a code bug -- the pipeline (self-healing selectors, auto-click-captions-button retry loop, stable per-user pairing code) is implemented correctly and was never exercised because the browser piece was never installed.
Fix: no code change. One-time manual action required from Manish (chrome://extensions is off-limits to browser automation): open chrome://extensions, enable Developer mode, "Load unpacked", select the meet-captions-extension folder (already exists, also duplicated under social-selling-deploy/meet-captions-extension), open the extension's popup, set App URL to https://second-brain-iida.onrender.com and pairing code B4CE0754 (Manish's stable code, never changes), click Save & connect. After that, opening any Meet/Teams/Zoom tab auto-starts capture (it also tries to auto-click the platform's own captions/CC button up to 8 times over 20s).

## [2026-08-12] (zoho-searchrecords-204-RESOLVED)
Manish reported "meeting prep is still not showing." Console showed 6 repeated `searchRecords: HTTP 502 {"error":"Unexpected end of JSON input","service":"zoho"}` failures on every dashboard load, plus `Cached 0 meetings for calendar prep`.
Root cause (searchRecords part): Zoho CRM's `/crm/v2/{module}/search` endpoint returns HTTP 204 No Content with an EMPTY body when a search matches zero records -- it does not return 200 `{data:[]}`. Our `searchRecords` handler in server.js unconditionally called `resp.json()` on the body, which throws "Unexpected end of JSON input" on an empty body; that exception got wrapped and surfaced to the client as a scary 502. This fired for every meeting-prep attendee who simply doesn't have a Zoho CRM contact record yet (a normal, expected case, not an error) -- the codebase already special-cases 204 this way in several other Zoho/Vorro endpoints (search `resp.status === 204` in server.js), this one handler was just missed.
Fix: `searchRecords` now returns `{data:[]}` on a 204 or any other empty-body success response, matching the existing pattern elsewhere in the file. Deployed as commit 1bf748797958. Verified live: reloaded the dashboard post-deploy, the 6 searchRecords 502s are gone from console.

Root cause (separate, NOT fixed -- needs Manish's input): "Cached 0 meetings for calendar prep" is a SEPARATE issue from the searchRecords bug above. `public/meetings-cache.json` (the on-disk fallback used whenever there's no live Granola API key) is dated May 18, 2026 and its newest cached meeting is from May 8, 2026 -- over 3 months stale as of today (Aug 12). Since `list_meetings` filters that cache to the last 30 days, it always returns zero. Also confirmed: there is no `GRANOLA_API_KEY` line anywhere in SECRETS.txt, so the live Granola API path in `handleGranola()` is never even attempted -- it always falls straight to the stale cache. Searched both Cowork scheduled tasks (list_triggers) and Windows Task Scheduler (schtasks /query) for anything that refreshes meetings-cache.json -- found nothing in either place, even though a code comment says it's "refreshed periodically via Cowork scheduled task." Whatever used to refresh this cache no longer exists. Needs a decision from Manish: (a) get/add a real GRANOLA_API_KEY to bypass the cache entirely and hit live data, or (b) recreate whatever process used to regenerate meetings-cache.json.

## [2026-08-12] (granola-removed-RESOLVED)
Manish's decision after the zoho-searchrecords-204-RESOLVED entry above: stop using Granola entirely for meeting prep/history, use whatever the AI Transcription (Live Captions) pipeline stores instead.
Implementation: added a client-side shim library in public/index.html (mnFetch/mnListMeetings/mnQuery/mnGetTranscript/mnGetMeetings) backed by GET /api/meeting-notes -- the durable kvStore-backed record of meetings actually captured via the Live Captions (Meet/Teams/Zoom) extension, already used by the Meeting Brief / auto-summarize pipeline. Replaced all 24 client call sites that referenced the old Granola MCP (list_meetings, query_granola_meetings, get_meeting_transcript, get_meetings) with the shim, keeping the same argument/return shapes so parseMeetings() and every downstream renderer needed zero changes. Added a matching server-side helper `_meetingNotesContext()` and swapped the one server-side Granola call inside `_generateMeetingBrief()` to use it. Set the `granola` auth-status flag to explicit `false`. Left `handleGranola()` itself in place as inert/unreachable code (lower risk than a large deletion; nothing calls it anymore).
Deployed as commit ca9406579de4 (server.js + public/index.html together). Verified live: reloaded the dashboard post-deploy, console now shows "Cached 2 meetings for calendar prep" (real data from our own captures) instead of "Cached 0 meetings" from the 3-months-stale Granola cache.
Note: the AI Transcription store only has data going forward from when captures actually run (it was near-empty until the meet-captions-extension install earlier today) -- prep quality will improve over the next few days as more meetings get captured with the extension now loaded in both Chrome and Edge.

## [2026-08-12] (copilot-advise-generic-response-RESOLVED)
Manish reported the Advise copilot button returned generic, unhelpful boilerplate: "Replaying: Discussion about deals and follow-ups with various contacts. Vorro reduces integration costs by 52% for 100+ enterprises. Say: Reviewing pricing and demos for potential clients. Ask: What specific integration challenges are they currently facing?" -- not tied to anything actually said.
Root cause: the Advise prompt (copilotAction, index.html) told the model to Replay "what they asked" and answer with KB metrics, with a soft fallback buried in the shared FORMAT instructions ("If there isn't enough in the live conversation yet, say so in a single bullet"). When the live transcript was thin (captures had just started today -- see granola-removed-RESOLVED above), the model didn't reliably follow that fallback; it filled the required 4-bullet structure with a plausible-sounding but generic answer and a canned KB stat (52% integration cost reduction) instead of admitting there wasn't enough to go on. Same weak-fallback pattern exists across all 6 copilot actions (explain/rebuttal/tone/advise/motivate/humor), not just Advise.
Fix: strengthened the shared `fmt` instruction (used by all 6 actions) to make the insufficient-context fallback CRITICAL/explicit -- exactly one bullet, stop there, never invent a generic answer/stat to fill space. Also strengthened the Advise task prompt specifically to require locating and quoting/paraphrasing the SPECIFIC thing that was said before answering, rather than generalizing into a vague category, and to explicitly use the fallback (not guess) when it can't. Deployed as commit a13c82840c8e (first push to 17bfeae2ba1f had a ref-verification false-negative in deploy_to_github.py -- the commit actually landed; re-ran the deploy for a clean confirmation, which correctly no-op'd the tree and just added a new commit). Verified live via curl.

## [2026-08-12] (copilot-laer-skill-grounded-RESOLVED)
Manish's follow-up to copilot-advise-generic-response-RESOLVED above: "using the sales skill, can you apply that skills logic to get better responses" -- wanted the copilot prompts grounded in the actual named frameworks (HEAR method, LAER, ARC anti-patterns, Signal Reading, status-quo equation, quantify pain) referenced in the 2026-08-06 sales-skills-integration code comments, not more ad-hoc prompt engineering.
Investigation: checked every currently-installed Cowork skill (sales:call-prep -- a pre-call briefing generator, not a live-coaching skill; b2b-marketing-engine -- the merged marketing/outbound OS whose SKILL.md provenance note credits a "Sales-Skills" source) for the 6 named frameworks. grep across all skill/plugin markdown found ZERO matches anywhere for "HEAR method", "signal reading", "status-quo equation", "quantify pain", or "ARC" anti-patterns. The ONLY real match: b2b-marketing-engine/references/reply-handling.md defines LAER (Listen, Acknowledge, Explore, Respond) under "Async LAER for Email/LinkedIn" -- written for async written replies, not live calls, and it's 1 of the 6 named frameworks, not all of them.
Conclusion: the other 5 framework names in the code comments were never actually sourced from an installed skill -- they're plausible-sounding general sales-coaching framings a prior session wrote into the comments, not literal skill excerpts. Reported this to Manish transparently rather than fabricating framework content for the other 5.
Fix (scoped to what's real): rewrote the `rebuttal` prompt (index.html) using the actual reply-handling.md LAER content. Two concrete corrections pulled from the skill: (1) true LAER order is Explore BEFORE Respond -- the old prompt had Manish's AI responding with data before exploring what's actually driving the objection, skipping past finding the real issue; (2) added "the stated objection is rarely the real one," a direct principle from the skill's async-LAER section. The `explain`/`tone`/`advise`/`motivate`/`humor` prompts were left untouched -- no legitimate skill-sourced content exists to improve them further beyond the copilot-advise-generic-response-RESOLVED fix already shipped; touching them further would mean inventing framework detail, which the b2b-marketing-engine skill's own rule 3 ("never fabricate") argues against doing.
Deployed as commit 701dbe1c8043 (public/index.html only). Verified live via sha256 match after Render's rollout completed (~100s after push).

## [2026-08-12] (copilot-stale-transcript-on-meeting-switch-RESOLVED)
Manish reported live, with a screenshot: selecting "Automating clinical data: UMAI X Vorro" from the meeting strip showed a completely different, already-ended meeting's transcript (Manish Agarwal / Kyle Bidwell / Nida Zahra discussing "backend reports" and "Wake Forly" -- names that don't match the selected meeting's attendees at all).
Root cause: pollMeetCaptions() runs on a 1.5s interval while Live Captions are active and unconditionally re-renders #copilotTranscript from the in-memory copilotTranscriptLines array -- it has no concept of "which meeting is currently selected." loadCopilotStripMeeting() (the manual click-a-meeting-card handler) called loadMeetTranscriptFromDrive() to show the newly selected meeting's real transcript, but never cleared copilotTranscriptLines or stopped/restarted the caption timer first. Within 1.5s, the next poll tick re-rendered the OLD meeting's stale buffered lines right back over whatever the Drive fetch had just shown. The automatic calendar-based meeting-switch path (_refreshCopilotCurrentMeetingImpl -> restartCaptionsForMeeting) already had this exact protection (clears the buffer, restarts captions with a fresh cursor via the freshMeeting flag on _startMeetCaptions) -- the manual strip-click path simply never got it.
Fix: loadCopilotStripMeeting() now clears copilotTranscriptLines and re-renders empty immediately on meeting switch, and if captions were actively running and the newly selected meeting isn't tagged "past", restarts them fresh (same _startMeetCaptions(true) call the automatic path already uses, so no old lines replay in).
Deployed as commit 654569861324. Verified live via sha256 match after Render's rollout.

## [2026-08-12] (copilot-real-research-fast-RESOLVED)
Manish: "rebuttal, explain, advise need real research before responding also, and they need to be very fast."
Investigation found two things already happening but not connected: (1) loadAttendeeContext() (runs once when a meeting loads) already does REAL research -- live Zoho CRM contact/lead lookups, active deals via COQL, and past-meeting history via the AI Transcription store -- and formats it into copilotMeetingContext. But copilotAction() never sent that string to the model; only a differently-shaped JSON blob (copilotAttendeeData) went out, mislabeled just "Attendees". (2) "Product facts to cite" always dumped the ENTIRE static brand KB (every objection handler for the brand, 5-9 of them) into every single prompt regardless of what was actually being discussed -- not researched, just everything at once.
Fix (both changes are LOCAL/in-memory only -- zero new network calls, so nothing gets slower):
1. Added copilotMeetingContext (the real CRM/deal/past-meeting research, already computed and sitting in memory since meeting load) as an explicitly labeled "Account & deal research" field in the data sent to the model.
2. Added getRelevantKnowledgeString() -- a fast local keyword match against the live transcript that only includes the objection handlers actually relevant to what's being discussed, instead of the whole brand KB. Smaller prompt = faster, and grounded instead of "pick something plausible from a long list."
3. Updated the explain/rebuttal/advise task prompts to explicitly instruct checking the account & deal research first, falling back to generic product facts only when nothing account-specific applies.
Scoped to explain/rebuttal/advise only, per what Manish asked for -- tone/motivate/humor are byte-for-byte unchanged.
Deployed as commit 654569861324 (same push as copilot-stale-transcript-on-meeting-switch-RESOLVED above). Verified live via sha256 match.

## [2026-08-12] (copilot-intent-signal-bolding-DEPLOYED)
Manish: "can you highlight intent signals in bold when translating? how much would this cost?"
Implementation: the shared FORMAT instruction (fmt, used by all 6 copilot actions) now allows ONE narrow markdown exception -- wrapping a genuine buying-intent/signal phrase (real interest, urgency, budget, timeline, approval/authority, a competitor name, a stated concern) in **double asterisks**, only when that exact phrase actually appears in what was said. Everything else about the strict bullet format is unchanged. The renderer (_cleanBullets) previously stripped ** markers entirely -- it now escapes the model's raw text first (untrusted input) and only then converts **text** into <strong>, so this can't be used to inject arbitrary HTML.
Cost: $0 marginal. This is NOT a new API call -- it rides the same single request copilotAction already makes. The primary provider is Groq (free tier) with Anthropic as a paid fallback only if Groq fails; the fmt addition is roughly 60-70 extra input tokens and the ** markers add a handful of output characters. Neither shows up as a measurable line item even on the paid-fallback path.
Deployed as commit 654569861324 (same push as the two entries above). Verified live via sha256 match.

## [2026-08-12] (main-width-not-shrinking-RESOLVED)
Manish: "this page doesnt not self size when the window is made smaller." Flagged this as a recurrence of something "fixed before... something about the width of the page" -- correctly: this is a second bug in the same area as css-main-maxwidth-overflow-RESOLVED above (2026-08-12, commit 6c6147ce790f), not a brand new issue.
Diagnosis: resize_window automation on Manish's actual (maximized, 3440px-monitor) desktop Chrome window did not reliably shrink window.innerWidth for live testing, so root-caused via direct in-page measurement (getBoundingClientRect/getComputedStyle) instead of visual screenshot comparison -- more reliable for this class of bug going forward. At a real 1710px client width, document.documentElement.scrollWidth measured 2414px (704px of forced horizontal overflow) -- and 2414 = 2200 (the MODERNIST LAYER's `.main { max-width: 2200px }` cap, set by the prior fix) + 214 (`.main`'s `margin-left: 214px` sidebar offset), an exact match.
Root cause: the prior fix (css-main-maxwidth-overflow-RESOLVED) correctly capped `.main`'s runaway growth on ultrawide monitors by raising max-width to 2200px, but left `width: auto` in place. `.app` is a `display:flex; flex-direction:column` container, and a flex item's `width:auto` combined with `margin-left:214px` doesn't force the box to actually fit inside the container after accounting for that margin -- it can render as wide as its content wants (up to the 2200px max-width ceiling) regardless of the actual available space, then the 214px margin pushes the whole oversized box further right, off the edge of the viewport. The original base `.main` rule (line 93, pre-MODERNIST-LAYER) had the same latent flaw (`width:100%` + separate `margin-left:224px`, which doesn't subtract the margin from the width either) -- it just wasn't very visible before because max-width was only 1600px and the responsive breakpoint at 900px caught most of the danger zone. Raising the cap to 2200px widened the broken range enough (roughly 900px-2414px) that a very common real-world window width -- 1710px, well within that broken range -- now hit it directly.
Fix: `.main`'s width is now `calc(100% - 214px)` (explicitly subtracts the sidebar margin instead of hoping auto-sizing works out) plus `min-width: 0` for defense in depth against any inner content trying to force extra width. Also added an explicit `width: 100%` to the `.main` override inside the `@media (max-width: 900px)` block, since that breakpoint zeroes margin-left back to 0 and needs the width formula to match (no offset to subtract there).
Deployed as commit f26364169543. Verified live via direct getBoundingClientRect measurement after Render's rollout: document.documentElement.scrollWidth now exactly equals clientWidth (1710 = 1710, was 2414 before) -- zero horizontal overflow -- and .main measures 1496px, exactly 1710 - 214 as intended.

## [2026-08-12] meeting-brief-no-fallback-RESOLVED
Symptom: Pre-Meeting Brief card showed "Pre-meeting brief unavailable: HTTP 503"
live in the app (user screenshot, "Busy" meeting selected).
Root cause: `_generateMeetingBrief()` / `/api/brief` in server.js hard-required
`ANTHROPIC_API_KEY` via a raw single-provider `fetch()` to the Anthropic API,
with zero fallback -- unlike `/api/ask` which already used a Groq -> Anthropic
-> Gemini fallback chain via the shared `askGroq`/`askAnthropic`/`askGemini`
helpers. Whenever ANTHROPIC_API_KEY wasn't set/valid, brief generation always
503'd even though the rest of the app's AI calls kept working fine via Groq.
Fix: rewired `_generateMeetingBrief()` to use the same Groq -> Anthropic ->
Gemini fallback chain as `/api/ask`, and updated the `/api/brief` route's
key-check guard to only 503 when ALL THREE provider keys are missing.
Commit: 1a8226c9e4ba.

## [2026-08-12] copilot-context-stale-on-meeting-switch-RESOLVED
Symptom: user reported "meetings information doesnt match meeting selected" /
"Meeting context not working" -- CRM/deal context cards and the pre-meeting
brief kept showing the PREVIOUS meeting's data after manually switching
meetings via the strip, even after the earlier transcript-staleness fix
(copilot-stale-transcript-on-meeting-switch-RESOLVED) was deployed.
Root cause: same staleness bug class as the transcript, but in two more
places `loadCopilotStripMeeting()` never touched: (1) `copilotAttendeeData`
and the `#copilotContextCards` DOM were never cleared on manual switch, and
`loadAttendeeContext()`'s early-return for no-attendee meetings left stale
cards from the prior meeting untouched; (2) `_maybeGeneratePreBrief()` was
only ever wired into the initial page-load path and the automatic
calendar-switch detector -- never into this manual strip-click handler -- so
manually selecting a different meeting never even attempted to regenerate its
brief; it just kept showing whatever brief (or error) the last meeting had.
Fix (public/index.html, `loadCopilotStripMeeting()`): clear
`copilotAttendeeData` and the `#copilotContextCards`/`#preMeetingBriefCard`
DOM immediately on every manual switch; show an explicit "No context data
found for attendees" empty-state when the newly selected meeting has no
attendees (instead of silently leaving old cards behind); call
`_maybeGeneratePreBrief(m,attendees)` unconditionally on manual switch so the
brief regenerates for the newly selected meeting.
Commit: 1a8226c9e4ba (same deploy as meeting-brief-no-fallback-RESOLVED above
-- the two bugs compounded: even once context/brief correctly reset per
meeting, the brief still needed the fallback fix to actually load instead of
503ing).

## [2026-08-12] ask-ai-moved-to-left-column (UX change, not a bug fix)
Per Manish's explicit request ("move Ask AI, to the left side of the
screen"), moved the Ask AI input block from the bottom of the right
(coaching) column to the top of the left (transcript) column, directly under
the meetCapBar pairing-code banner and above Live Transcript -- visible
without scrolling through the whole right-side column now.
Commit: 1a8226c9e4ba.

## [2026-08-12] (wsl-heredoc-backtick-strip)
Appending a PIPELINE_ERRORS.md entry via a bash heredoc (`cat >> file << 'EOF'`)
over run_wsl_bash silently stripped every backtick-quoted code identifier in
the content (backticks got interpreted as command substitution despite the
quoted 'EOF' delimiter, producing bash errors like "command not found" for
things like `_generateMeetingBrief` and leaving empty gaps in the appended
text) -- confirmed via windows-executor__read_file afterward. This is the
same class of issue as the previously-logged wsl-var-eating rule (WSL relay
mangles $vars/backticks in multi-line commands), just not previously hit for
file-append specifically. Fix applied here: write a small Python script via
write_file (no shell string interpolation) that reads/truncates/rewrites the
file directly, then run ONLY `python3 script.py` (no inline heredoc/backtick
content) via run_wsl_bash. Rule going forward: NEVER heredoc file content
containing backticks or code identifiers over run_wsl_bash -- always route
through a Python script file instead, matching the existing wsl-var-eating
rule.

## Session Log - 2026-08-12 (meeting-switch staleness pt.2 + Ask AI move)
**Accomplished:** Deployed the two fixes left staged from the prior round: (1)
`/api/brief` (Pre-Meeting Brief) now falls back Groq -> Anthropic -> Gemini
instead of hard-requiring ANTHROPIC_API_KEY -- fixes the live "HTTP 503"
error Manish screenshotted. (2) Meeting Context cards and the Pre-Meeting
Brief now clear and regenerate correctly on a manual meeting switch (same
staleness bug class as the transcript fix from earlier this session, just in
two places that fix didn't reach). (3) Moved the Ask AI box from the bottom
of the right coaching column to the top of the left column, per Manish's
explicit request. All three shipped together as commit 1a8226c9e4ba
(server.js + public/index.html), verified live via exact sha256 match on the
served index.html and HTTP 200 on / and /api/health.
**Pending:** (1) Manish asked about "the skill I asked for external
companies/vorro-vertical-pages" for generating meeting prep -- grepped the
entire codebase (public/index.html, server.js, PIPELINE_ERRORS.md) for
"vorro-vertical-pages"/"vorro_vertical" and found zero matches; this
integration doesn't exist anywhere yet. Asked Manish directly what he wants
built rather than guessing/fabricating an integration. (2) Explained to
Manish (in-chat, not yet a code change) that Playbook Coach and Suggested
Assets are architecturally live-caption-triggered only (surfaceAssets/
surfacePlaybooks fire exclusively from the 1.5s live-caption poll's
topic-keyword matching) -- they don't populate from a loaded past transcript
or on meeting selection, so being blank on a quiet/no-live-conversation
meeting is expected, not a defect. Open question for Manish: does he want
this extended to also scan a loaded past transcript retroactively?
**Decisions made:** Route ALL future file-append operations with backticks/
code identifiers through a Python script (write_file, no shell involved)
rather than a bash heredoc over run_wsl_bash -- see the
wsl-heredoc-backtick-strip entry above for why.
**New rules/learnings added:** meeting-brief-no-fallback-RESOLVED,
copilot-context-stale-on-meeting-switch-RESOLVED, ask-ai-moved-to-left-column,
wsl-heredoc-backtick-strip (all logged above).
**Handoff note:** Production is live on commit beedc77524cb (PIPELINE_ERRORS.md
log commit; app code is on 1a8226c9e4ba). Browser-based visual verification
via Claude-in-Chrome was attempted but blocked by repeated "script injection
timed out" errors on this page even after multiple reloads/waits -- fell back
to server-side verification (sha256 exact match + HTTP 200 health checks)
instead, which is solid evidence the code is live and correct, but a live
human click-through by Manish (switch meetings, confirm context cards/brief
update, confirm Ask AI is now top-left) is still worth doing to catch
anything a byte-level check can't. Next session should pick up: Manish's
answer on vorro-vertical-pages scope, and whether to extend Playbook
Coach/Suggested Assets to retroactive transcript scanning.

## [2026-08-12] vorro-page-links-added
Manish's follow-up to the earlier "prep isn't created using the vorro-vertical-pages
skill" report: identified the skill (already installed, enabled), scoped it to the
4 real Vorro accounts on his Aug 13-14 calendar (ICE, Koning Health, American Lung
Association, Global Nursing AI Alliance -- CV3 prospect and Trident Seafoods held
back since they're Cadient/CV3 accounts, not Vorro, and this skill is hard-wired
Vorro-only branding), ran the skill's single-company "bespoke partner page"
workflow for each via 4 parallel research agents, deployed all 4 to GitHub Pages
(smart0109/smart0109.github.io) at /p/<token>/, then wired the resulting URLs into
Second Brain's meeting prep.
Deployed pages (real research, no fabricated metrics -- see each agent's report for
what was confirmed vs. flagged as unconfirmed):
- ICE InsureTech: https://smart0109.github.io/p/37d0fc35bd9b/
- Koning Health: https://smart0109.github.io/p/c0d1970b317c/
- American Lung Association: https://smart0109.github.io/p/bc98cc97c199/
- Global Nursing AI Alliance: https://smart0109.github.io/p/a09efda4dc7a/ (NOTE:
  the org itself was confidently identified, but the specific pm.me contact
  Manish has been emailing could not be verified against GNAA's public team page
  -- worth a gut-check before the Aug 14 call)
Second Brain change: added VORRO_PAGE_LINKS_BY_DOMAIN / VORRO_PAGE_LINKS_BY_EMAIL
(public/index.html, near KNOWLEDGE_BASE) and a check inside loadAttendeeContext()
that surfaces a "Vorro Prospect Page" card with a link when a meeting's attendees
match a known account -- domain match for 3 of the 4, exact-email match for GNAA
since its only known contact is a personal pm.me address, not a company domain.
Commit: dee31db8ca23. Verified live via exact sha256 match on served index.html
after Render's rollout (~70s this time).
This mapping is manually maintained for now, not auto-generated -- the skill's
meeting-prep-second-brain.md reference describes a fuller auto-generate-on-demand
architecture (a Python module that detects any external attendee domain and
builds+deploys a page automatically) which is a materially bigger build than what
was asked for here. Worth revisiting if Manish wants this to scale beyond a
manually curated list.

## [2026-08-12] (vorro-page-wrong-cro-name-RESOLVED) -- URGENT, prospect-facing
Manish caught a serious error: the ICE InsureTech and Global Nursing AI Alliance
Vorro pages (built in the vorro-page-links-added entry above) had the CTA/signoff
attributed to the WRONG PERSON -- "Manish Chawla" on the ICE page and "Manish
Patel" on the GNAA page. Manish's real name is Manish Agarwal.
Root cause: when briefing the 4 parallel research agents for the vorro-vertical-pages
single-company workflow, the agent prompts referred to him only as "Manish (CRO at
Basis Vectors Capital...)" without ever stating his surname. The gen_partner_page.py
profile schema requires a full name for the "signoff"/"cta_who" fields, so two of
the four agents (ICE, GNAA) invented a plausible-sounding surname to fill the
field instead of leaving it as "Manish" only (which is what the other two agents,
ALA and Koning Health, correctly did -- they used "Manish" alone rather than
guessing a surname, which is why only 2 of 4 pages had this defect).
Fix: corrected "Manish Chawla" -> "Manish Agarwal" and "Manish Patel" -> "Manish
Agarwal" in both profile.json files and the rendered HTML (2 occurrences each:
signoff + cta_who), then re-deployed both pages to the SAME live GitHub Pages
tokens (overwrite, not new URLs) so the links already shared/wired into Second
Brain still work and now show the correct name. Verified live via direct curl:
both /p/37d0fc35bd9b/ (ICE) and /p/a09efda4dc7a/ (GNAA) now show only "Manish
Agarwal", zero remaining occurrences of the wrong names. Swept PIPELINE_ERRORS.md,
SECRETS.txt, and all deploy scripts in second-brain-app/ and social-selling-deploy/
for "Chawla" or "Manish Patel" -- none found, the error was contained to those
two generated pages only.
RULE GOING FORWARD: any agent brief (this skill or any other) that asks an agent
to generate CTA/signoff/attribution text referencing Manish MUST spell out his
full name explicitly ("Manish Agarwal, CRO, Basis Vectors Capital") in the prompt
-- never rely on the agent inferring or guessing a surname from partial context,
even when it seems obvious. This applies to every skill that produces
prospect-facing collateral (vorro-vertical-pages, vorro-sales-asset,
hiring-process-audit, and any future ones), not just this one.


### vorro-repo-wide-name-audit-RESOLVED (2026-08-12)
Full-repo sweep of smart0109.github.io (948 HTML files, all historical Vorro
collateral pages, not just this session's 4) for the same wrong-CRO-name
defect found on the ICE and GNAA pages (see vorro-page-wrong-cro-name-RESOLVED).

Method: shallow-cloned the entire repo into WSL-native /tmp (fast git grep,
no VirtioFS), ran case-insensitive `git grep` for "manish [a-z]+" (1039 raw
hits, 9 genuine "Manish Agarwal" -- all correct, rest were false-positive
word-boundary matches like "Manish booking") and separately for
"chawla|patel" (6 files hit, beyond the 2 already-fixed pages).

Findings on the 6 files:
- 014bf6ccb2be/index.html, cd53fa0d20ca/index.html (+ p/ duplicate + .txt
  sibling), dd074c048fe7/index.html: false positives -- "patel" appeared as
  a coincidental substring inside base64-encoded binary blobs (fonts/images),
  not text at all.
- 76cf2cbcdac3/index.html (+ p/ duplicate + .txt sibling): legitimate --
  "Manish, Chief Revenue Officer, Vorro | for Umesh Patel, President/Owner"
  -- Umesh Patel is a real prospect contact, not a Manish-name error.
- p/fe6150b48a7c/index.html: legitimate -- "Manish, Chief Revenue Officer,
  Vorro | for Kalpesh Patel, Co-COO, Meditab Software" -- real prospect
  contact.
- fc1bcdfc6e9e/index.html: legitimate -- "Attri AI... founded by CTO Ayush
  Patel" -- unrelated background fact about a different company, not
  Manish's name at all.

Also re-ran `git grep -ic chawla` across the full repo post-fix: zero
matches anywhere -- confirms the ICE page fix eliminated the only instance
and no other page ever had it.

Conclusion: the ICE and GNAA pages were the ONLY two pages across the
entire 948-file repo with the wrong-CRO-name defect. Both already fixed and
redeployed live (see vorro-page-wrong-cro-name-RESOLVED). No further action
needed. Root cause and preventive rule (always state "Manish Agarwal, CRO,
Basis Vectors Capital" explicitly in agent briefs, never leave the surname
to be inferred) already logged there and applies going forward.


### vorro-page-links-added (update, 2026-08-12): visibility fix
Manish's feedback: the "Vorro Prospect Page" card was invisible in practice --
it only rendered as one more card at the bottom of the scrollable Meeting
Context panel on the right, below Live Coaching Feed / Suggested Assets /
Playbook Coach, so it never appeared "on screen" without deliberate
scrolling. He asked for it (1) on the left side or as a button, and (2) in
the Meetings tab under the Prep button too.

Fix:
1. Added a persistent `#vorroPageBanner` element at the TOP of the left
   column (above Ask AI, so above Live Transcript too) in the AI
   Transcription tab -- always visible, no scrolling. Hidden by default;
   shown/populated by the new `renderVorroBanner(link)` helper.
2. Extracted the domain/email lookup that used to be inlined in
   loadAttendeeContext() into a shared `getVorroLink(emails)` function so
   both surfaces use one source of truth.
3. loadAttendeeContext() now calls `renderVorroBanner(_vorroLink)` as soon
   as the match is known (not gated behind the slower parallel CRM/deal
   fetch), and the manual-meeting-switch handler calls
   `renderVorroBanner(null)` up front so a switch to a non-matching meeting
   clears the banner instead of leaving the previous meeting's link showing.
4. Wired the same lookup into `expandMeeting()` (the function behind the
   Meetings tab's "Prep" button/pill) -- computed once near the top of the
   function (before its early-return branches for an existing Drive prep doc
   or Gmail prep draft) as `_vorroBannerHtml`, then prepended into all three
   of its render paths (Drive doc, Gmail draft, live-built fallback) so the
   link shows no matter which prep path fires for that meeting.

Verification: sha256-gated patch (8 edits, each asserted to match exactly 1
occurrence) applied cleanly to the live public/index.html
(06b9af37... -> fca029c0...). node was unavailable in WSL to --check syntax;
esprima was tried instead but doesn't support this codebase's optional-
chaining syntax at all (confirmed against a trivial `a?.b` snippet, unrelated
to this patch) so it wasn't a usable validator here -- relying on the
sha-gated exact-match patch mechanism plus a live in-browser check instead.


### granola-card-raw-json-RESOLVED (2026-08-12)
Manish flagged: the "Past Meetings (Granola)" card in the Meeting Context
panel (AI Transcription tab / loadAttendeeContext) showed raw JSON on
screen: `{"answer":"[8/4/2026] ICE Tech services x CV3 with ..."}` instead
of readable text.

Root cause: this file has ~6 near-identical call sites that unwrap a
Granola/mnQuery response before rendering it (expandMeeting's "Previous
Meeting History", the Intel tab's Granola card, etc.). Every one of them
extracts the answer text first: `x?.answer||x?.text||JSON.stringify(x)`.
This ONE card (loadAttendeeContext's Granola card) was copy-pasted without
that extraction step -- it just did
`typeof x==='string'?x:JSON.stringify(x)`, so a normal `{answer:"..."}`
response from the query tool rendered as its raw JSON wrapper instead of
the text inside it.

Fix: added the missing `.answer||.text||.content` extraction, matching the
other 5+ call sites, plus a guard that skips rendering the card entirely if
what's left still looks like raw JSON (starts with `{` and ends with `}`)
rather than showing a fallback dump.

Also, separately: Manish asked for "bullets or summary" formatting and to
check other pages for the same class of issue. The AI/Granola text in his
example was already numbered-list prose ("1. ... 2. ... 3. ..."), and
renderMarkdown() -- the ONE shared renderer used by ~20 different
cards/panels across the whole app (CRM records, deal notes, AI briefs,
action items, past meeting notes, Intel answers) -- already turned "- item"
bullet lines into a styled list but left "1. item" numbered lines as plain
prose. Added the same bullet-style treatment for numbered lines directly
inside renderMarkdown(), so the fix applies everywhere it's called instead
of needing 20 separate patches.

Verification: sha256-gated patch (2 edits, each asserted exactly 1
occurrence). Broader page-by-page visual sweep for other raw-dump /
unhelpful-content issues still in progress -- see follow-up log entry if
anything else turns up.


### granola-card-raw-json-RESOLVED (update, 2026-08-12): asterisk bullets
Continuing the page-by-page sweep Manish asked for: the Today dashboard's
"Weekly summary of all meetings and themes" card (Intelligence tab's Weekly
Summary output, reused on Today) showed literal "* " asterisk characters
instead of bullets, e.g. "* Key Meeting: ICE Tech services x CV3 on August
4, 2026...". Same root class of bug as the raw-JSON card, different shape.

Root cause: renderMarkdown() -- the single shared renderer used by ~20
different cards/panels app-wide -- only recognized "- item" (dash) as a
bullet marker. "* item" (asterisk) is the other extremely common markdown
bullet syntax, and it's the one this AI summary actually used, so it fell
through untouched and rendered as a literal asterisk instead of a bullet.

Fix: added the same bullet-style treatment for "* item" lines, placed right
after the existing "- item" rule and after the **bold** pass (so a real
**bold** span, which already got converted to <strong> two lines earlier,
is never mistaken for two single-asterisk bullets).

Swept the rest of the app for this + the raw-JSON class of issue: Today
dashboard (Blocking someone else / Prep for next / competitor news),
Meetings tab (calendar + Granola lists, Prep panel), CRM (deal board +
detail modal), ICP Finder, Follow-ups drafts, Productivity (Board +
Memory), Legal Assets, Artifacts, Intelligence tab (company KBs, playbooks,
Weekly Summary/Open Action Items/Deals Needing Follow-up) -- all read clean
after this fix. One separate, unrelated finding surfaced during the sweep:
Productivity > Memory > Key People still lists Gibran Crismatt as Vorro's
Technical Lead, which Manish's own CLAUDE.md roster note (2026-05-27) says
is stale (Gibran left, leads to Rashmi now) -- that's a memory-data staleness
issue, not a front-end rendering bug, so it wasn't touched here; flagged to
Manish to update via the memory-management tooling directly.

Verification: sha256-gated patch (1 edit, exactly 1 occurrence), then
re-verified live in-browser via Claude-in-Chrome across every page listed
above.


### key-people-stale-roster-RESOLVED (2026-08-12)
Manish flagged during the page-quality sweep: Productivity > Memory > Key
People listed "Gibran Crismatt -- Technical Lead @ Vorro (Weekly)". Per
Manish's own global CLAUDE.md roster note (2026-05-27): "Gibran left Vorro
(leads to Rashmi)" -- this was stale org data being shown as current fact.

Found the source: hardcoded in public/index.html's `people` array (the data
behind the Key People card), NOT in server.js and NOT in the mem0/company-
memory API (a separate, unrelated memory system). Confirmed the successor's
full name against social-selling-deploy/configs/team-config.json -- Rashmi
Kanjwani, rkanjwani@vorro.net.

Fix: swapped the name only (Gibran Crismatt -> Rashmi Kanjwani), kept
"Technical Lead @ Vorro (Weekly)" as-is -- team-config.json's "role" field
for both people is a generic CRM routing tag ("BDR"), not the descriptive
job-title convention this array uses elsewhere, and no replacement title was
given; "leads to Rashmi" reads as her inheriting the same responsibility.

Verification: sha256-gated patch (1 edit, exactly 1 occurrence), deployed
and confirmed live.


### meet-caption-meeting-pairing-RESOLVED (2026-08-14)
Live captions from the Meet extension rendered into whatever meeting was
selected in the AI Transcription tab, because the server-side caption buffer
is keyed per-USER (pairing code), not per-meeting. Selecting an old meeting
while a live call ran (or vice versa) cross-contaminated transcripts,
coaching, and notes.

Root cause: no meeting identity anywhere in the caption path. GET
/api/live-captions returned only lines; the client had no way to know which
meeting the stream belonged to.

Fix (server + extension + client): POST /api/live-captions stores
buf.meetUrl (extension now sends meetUrl:location.href); GET returns
{session, meetUrl}; pollMeetCaptions gates ALL rendering and side-effects on
_liveCapMatchesSelected() - a 3-tier match: (1) Meet code parsed from both
sides (authoritative when both parse), (2) session.meetingId ===
_meetingKey(selected), (3) time-window fallback only when no session exists.
On mismatch the cursor skips past foreign lines (_capGatedMismatch); the
first matched tick afterwards rewinds to session.startTs and replays only
THIS meeting's history. _meetCapSince now starts at Date.now() (kills the
since=0 stale replay), session self-heal re-registers the meeting-notes
session after server restarts, and auto-switch registers the session BEFORE
restarting captions.

Verification: node --check on all files; extracted-function tests (7 gate
scenarios inc. code-mismatch-overrides-session, in/out of time window) all
pass; live server QA on a staged boot (:3999) confirmed session+meetUrl
round-trip.


### meet-caption-latency-RESOLVED (2026-08-14)
Captions took ~10s to appear. Root cause: extension finalized a caption row
only after 2 stable scans of a 700ms scanner and flushed every 1500ms;
client polled every 1500ms; every stage waited for the previous.

Fix: extension emits interim captions immediately with a per-row cid
(finalize after 1 stable scan), scan 700->500ms, flush 1500->500ms; server
upserts buffered lines in-place by cid (recent-tail scan) so interim
revisions don't duplicate; client _pushTranscriptLine updates in-place by
cid and skips side-effects for revisions; poll 1500->750ms. Net latency now
~1-2s.

Verification: live QA on staged server - interim POST then same-cid final
POST keeps buffer count at 1 and GET returns the final text; function tests
confirm _pushTranscriptLine cid upsert + named-speaker upgrade behavior.
NOTE (manual step): the Chrome extension must be reloaded at
chrome://extensions before the new content.js takes effect.


### meeting-notes-literal-backslash-n-RESOLVED (2026-08-14)
Stored meeting transcripts rendered as one endless line containing literal
"\n" two-character sequences.

Root cause: _finalizeCapSession joined transcript lines with join('\\n')
(escaped backslash-n, i.e. the two characters backslash+n) instead of
join('\n'). Same bug in _summarizeMeetingEntry's prompt assembly.

Fix: both joins corrected to real newlines; GET /api/meeting-notes?full=1
normalizes legacy entries on read (replace literal \n with real newlines)
so previously-stored transcripts also parse into speaker lines. Also added
?meetingId= filter to GET /api/meeting-notes so the client can resolve a
meeting's transcript exactly instead of fuzzy-matching everything.

Verification: live QA - finalized a 2-line session on the staged server;
transcript contains real newlines, zero literal \n; meetingId filter
returns exactly the matching entry; _mnNormalizeTranscript unit tests pass.


### legal-asset-generator-dead-panel-RESOLVED (2026-08-14)
The Legal Asset Generator's "Search My Emails for Examples" appeared to do
nothing, and generated documents never rendered.

Root cause (4 stacked defects): (1) #legalExamplesPanel was nested INSIDE
the hidden #legalFormPanel, so results were invisible until a doc type was
picked; (2) all fetch errors were swallowed silently; (3) Gmail queries were
subject-only so real contracts (which live in attachments) never matched;
(4) generateLegalDoc wrote into #legalDocOutput which did not exist in the
DOM.

Fix: moved #legalExamplesPanel out to be a sibling of the form panel; added
#legalBasePanel (base-version library) and a real #legalDocOutput;
legalSearchExamples rewritten - attachment-first Gmail queries, sequential
execution, latest-first ordering, per-result import buttons, visible error
states. Server: collectAttachments() in formatGmailMessage, new
get_attachment Gmail op with optional mammoth/pdf-parse text extraction
(guarded try/require, degrades gracefully when not installed), and
/api/legal/bases GET/POST/DELETE persisted via kvStore. Base-version
library: legalTemplatize() abstracts imported contracts into
{{OUR_COMPANY}}/{{PROSPECT_NAME}}/{{PROSPECT_ADDRESS}}/{{DATE}} templates,
legalFillBase() re-fills them, pickLegalClient() re-fills on client change,
and generateLegalDoc() uses the active base as the drafting skeleton.

Verification: node --check all files; live QA on staged server -
/api/legal/bases CRUD (create/list/validate-400/delete) all pass; panel
structure confirmed sibling-level in the DOM.


## Session Log - 2026-08-14 (autonomous resume: Productivity Hub + Legal + QA + deploy)
**Accomplished:** Resumed the interrupted 2026-08-13 session from
_cowork_staging_20260814/PENDING_RESUME_COWORK_20260814.md. Found items 7
(Productivity Hub overhaul: brand filter, Sales Assets tab removed with
Drive links harvested into the new brand-grouped glossary, merged Review
tab with Sunday week-start fix, view-crmokrs OKR sub-tab with OKR_TARGETS +
QTD scoping, board move/edit/validation/localStorage persistence) and 8
(Legal Asset Generator rebuild, see entry above) ALREADY APPLIED in the
staged copies - the prior session finished implementation but died before
updating the handoff doc. This session verified every sub-feature by
inspection, then ran the full QA pass (item 9): strict UTF-8 + node --check
on server.js, content.js and both inline index.html script blocks; booted
the staged server on :3999 with stub env; 19/19 endpoint tests passed
(live-captions cid upsert + session/meetUrl, meeting-notes meetingId filter
+ newline normalization, legal/bases CRUD, auth 401s); 36/36
extracted-function tests passed (_liveCapMatchesSelected 7 scenarios,
_pushTranscriptLine, _cleanBullets, validProdDue, renderGlossary,
_mnEntryForMeeting resolution tiers, parseMeetTranscript,
_mnNormalizeTranscript). One QA harness bug found and fixed (test used
future timestamps; server was correct). Copied staged files over live with
.bak-20260814 backups after confirming zero live-file drift vs the recorded
mtimes.
**Pending:** (1) MANUAL - reload the meet-captions extension at
chrome://extensions (content.js changed). (2) Manish decisions - home page
blocking/follow-ups options (B1+B2/F1+F2 recommendation) and ICP Finder
hybrid-bridge rebuild (7 open questions) - see PENDING_RESUME doc item 11.
(3) TODO placeholders in the new glossary for Cadient/CV3/RevEngineer list
pricing - numbers intentionally NOT invented, Manish to fill.
**Decisions made:** Used 'legalBasePanel' / OKR_TARGETS as deploy
verification markers (already unique to the new build) instead of adding a
cosmetic marker string. Left items 11 (home page, ICP Finder) untouched per
handoff instructions.
**Handoff note:** Deployed via deploy_to_github.py (commit SHA in the
deploy output / GitHub main). Verify at second-brain-iida.onrender.com that
the served index.html contains 'legalBasePanel' after Render's auto-deploy
completes.

### qa-followup-fixes (update, 2026-08-14): two post-deploy QA fixes

**Context:** After the 2026-08-14 df9604ee deploy, a second independent QA pass
(cloud Cowork session, 143 assertions incl. live server boot + extracted-function
tests) found two bugs the first QA missed. Both fixed in public/index.html only;
server.js and content.js unchanged from df9604ee.

1. **legal-fillbase-placeholder-leak (RESOLVED):** `legalFillBase()` fell back to
   the literal placeholder string when a prospect address (or other field) was
   blank, so generated/previewed legal docs — and the base block injected into the
   AI prompt — contained raw `{{PROSPECT_ADDRESS}}`. Fix: final sweep
   `.replace(/\{\{[A-Z_]+\}\}/g,'________________')` converts any unresolved token
   into a visible fill-in blank (legal-doc convention).

2. **meetings-week-utc-day-bucketing (RESOLVED):** `loadMeetingsView()` bucketed
   events and day headers with `toISOString().slice(0,10)` (UTC), so a 10pm-ET
   meeting rendered under the NEXT day's header, and an evening event on day 7 of
   the rolling window vanished. Fix: `_localDayKey()` (local Y-M-D) used for both
   event keys and day headers; bare `YYYY-MM-DD` all-day dates passed through
   untouched (parsing them would shift a day in negative-UTC zones).

**Verification:** node --check on server.js/content.js + both extracted inline
script blocks OK; jsdom container checks OK; 143/143 QA assertions green after
fixes; repro cases (blank address → blanks not tokens; 22:00 ET event → correct
local day header) covered by the qa harness in the cloud session.


## [2026-08-14] (home-awaiting-reply-revenue-held): Item 11 part 1 (B1+B2+F1+F2,
approved by Manish). The home page's "awaiting your reply" banner was guesswork:
a hardcoded 7-address VIP list queried client-side with `older_than:5d`, so
non-VIP threads never surfaced and nothing was revenue-aware. Rebuilt server-side:
new GET /api/home/awaiting-reply pulls recent inbox threads via the existing
handleGmail search lane and keeps only threads whose LATEST non-draft message is
inbound (sender not in ALLOWED_EMAILS, not SENT-labeled, bulk/no-reply senders
filtered) - real B1 detection over the whole inbox. B2: the endpoint joins those
threads to open deals (Cadient Zoho COQL via handleZoho + Vorro India-DC COQL,
same query as /api/crm/vorro/deals) with a conservative matcher (sender domain
root vs Account/Deal name, contact-name match, account-in-subject) and returns
per-thread deal amounts plus a deduped totalHeld; the banner now shows "$ held"
overall and per-thread badges, and band1Sub gets the total. F1: new GET
/api/home/followups (starred threads + unsent drafts via existing search_threads
/ list_drafts ops, graceful per-lane errors) rendered as a "Follow-ups" card in
band 3. F2: follow-up items reuse the existing toggleThreadContext AI-draft lane;
fixed the long-standing threadId bug in createDraftFromThread - it sent only
replyToMessageId, which the server's create_draft ignores (it destructures
threadId), so "reply" drafts were created detached from their thread. One added
line passes threadId so drafts attach + get proper reply headers/quoting. F3 was
mentioned in the original investigation but never specified in surviving notes -
SKIPPED, explicitly out of scope this session.

## [2026-08-14] (icp-finder-hybrid-bridge): Item 11 part 2 (approved hybrid
rebuild). The ICP Finder's headline stats were hardcoded ('19,843' etc.) and the
page had no view of the actual scored prospect universe living in the Windows
pipeline's prospects.db. Built the hybrid bridge cloned from the social-bridge
pattern: server.js gains /api/icp/prospects POST (bridgeGuard: same
SOCIAL_BRIDGE_TOKEN x-bridge-token mechanism, no new secrets) storing a
normalized snapshot in kvStore key 'icp-prospects' (fields capped/trimmed,
max 2000), GET (requireAuth, optional ?brand= filter, score-sorted) and the same
refresh handshake social-bridge uses (POST /refresh requireAuth, GET /refresh +
POST /refresh/done bridgeGuard; a successful push auto-completes a pending
request). Frontend: ICP Finder view rebuilt around ranked signal cards
(name/title/company, score, tier, brand chip, and intent-signal chips: KOL/
competitor engagement, intent post w/ hover text, current ATS, open jobs,
hiring/new-role/open-to-work) with brand + tier filters and a Request-refresh
button; universe stats now come from the pushed snapshot's stats block; the old
score-form/CRM-find/personas sections were kept below the new hero section since
their endpoints still work. Windows side: social-selling-deploy/
push_icp_prospects.py (sb_social_bridge.py conventions: env-then-SECRETS.txt
config, x-bridge-token auth) reads master_records tier A/B joined to
enrichment_cache (one row per slug via MAX(rowid)) and pushes top-N per brand by
icp_score with a --dry-run mode and --if-pending handshake polling. Delegated
defaults applied: brands cadient/vorro/revengineer, snapshot top 500/brand
(~1.0MB payload, fits the existing express 2mb limit), manual refresh via the
push script + handshake, reuse SOCIAL_BRIDGE_TOKEN, NO Apollo integration,
outreach stays in the existing CC lane (cards only link out to LinkedIn/mailto),
ICP config stays on the Windows pipeline side.

## Session Log - 2026-08-14 (item 11: home page B1+B2+F1+F2 + ICP hybrid bridge)
**Accomplished:** Both approved item-11 features built, QA'd and deployed. Home
page: real server-side awaiting-reply detection with revenue-weighted $-held
deal join (B1+B2), follow-ups card fed by starred emails + unsent drafts (F1),
one-click AI draft-reply reusing the existing lane with the threadId attach fix
(F2). ICP Finder: hybrid bridge (POST/GET /api/icp/prospects + refresh handshake
cloned from social-bridge, kvStore snapshot), ranked signal-card UI with brand
filter, push_icp_prospects.py on the pipeline side (validated with --dry-run
against the real prospects.db: 500/500/500 prospects for cadient/vorro/
revengineer, universe stats 27,969 total / 5,359 A / 11,243 B / 11,367
discarded). QA: node --check on staged server.js + both extracted inline script
blocks; staged server booted on :3996 with stub env - 23/23 checks green (auth
401s on all new endpoints incl. wrong bridge token, push validation 400,
snapshot store/read/brand-filter/sort/stats/legacy-field normalization, full
refresh handshake incl. push auto-complete, home endpoints degrade gracefully
without Google creds, server stays alive). Test server killed, port freed.
**Pending:** (1) MANUAL - run the first real push:
`python push_icp_prospects.py` in social-selling-deploy (or --dry-run first);
until then the ICP Finder shows 'No snapshot pushed yet'. Optionally schedule
`--if-pending` polling next to the social-bridge poller. (2) F3 remains
unspecified/skipped - re-scope with Manish if it mattered. (3) Carry-overs from
the earlier 2026-08-14 session: reload the meet-captions extension; fill the
glossary pricing TODOs.
**Decisions made:** All delegated ICP defaults logged in the entry above. Kept
the legacy Score-a-Prospect/CRM sections under the new signal-cards hero rather
than deleting working features. /api/home/followups returns 200 with per-lane
error strings (graceful) rather than 500 when Google creds are absent. Mid-
session drift handled: a parallel cloud QA session shipped two index.html fixes
(legalFillBase placeholder sweep, _localDayKey meetings bucketing) at 07:42 -
re-staged from the new live file and re-applied patches (anchored, no overlap)
instead of overwriting their work; drift gate re-armed on the new sha.
**Handoff note:** Deployed via deploy_to_github.py (server.js, public/index.html,
PIPELINE_ERRORS.md). Verify second-brain-iida.onrender.com serves index.html
containing 'icpProspectCards' and 'loadHomeFollowUps'. Render env already has
SOCIAL_BRIDGE_TOKEN (shared with social bridge) - nothing new to configure.

### copilot-fallback-wrong-meeting-notes-RESOLVED (2026-08-14)

**Symptom:** Selecting a past meeting in Copilot could render OTHER meetings'
notes under the header `Meeting notes for "<selected title>"`.
**Root cause:** `_meetTranscriptFallback()` (public/index.html, ~7403) called
`mnQuery({query:'Meeting: '+m.summary+...})`, but `mnQuery()` (~1899) ignores
the title in the query entirely - it just returns the newest <=8 stored
meeting-notes entries from the last 30 days, unfiltered. Tiers 1-2 of
`resolveTranscriptForMeeting()` had already searched the same store with proper
matching (meetingId exact, title + +/-6h window), so anything this generic
fallback returned was by definition NOT the selected meeting's notes - yet it
rendered them attributed to that meeting.
**Fix (minimal, option b from the investigation):** removed the mnQuery call +
its render from `_meetTranscriptFallback`; the function now goes straight to
the honest 'No transcript found for "<title>"' empty state. Safety net on the
two other ungated mnQuery render paths that attribute results to the selected
meeting: loadCopilotMeetingFromFilter's granola fallback header relabeled from
`Granola Notes for "<title>"` to `Recent meeting notes (may not be from this
meeting)`; the meeting-prep granolaQueryR fallback now prepends the same
non-attribution notice above its content. ID-matched paths (mnGetTranscript /
get_meetings) and general Ask-AI/person-context mnQuery uses left untouched.
**Verification:** node --check on both extracted inline script blocks (2/2 OK);
tiers 1-4 of resolveTranscriptForMeeting + Drive relevance gate + empty state
confirmed intact; mnQuery call-site count 13 -> 12; index.html 870,813 ->
870,544 bytes. Backup: public/index.html.bak-20260814c. Deployed via
deploy_to_github.py in the same commit as this entry; verify Render serves an
index.html whose _meetTranscriptFallback contains no mnQuery call.
