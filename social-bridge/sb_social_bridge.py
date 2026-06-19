#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Second Brain  <->  Local LinkedIn poster bridge
================================================
Connects the "Social Media Posting" page in Second Brain (Render) to your local
machine so the page's Post button actually publishes to LinkedIn.

Two jobs (subcommands):

  push-targets : read the social-selling find_targets output (top viral posts to
                 engage with) and push them to Second Brain so the page can show
                 them. Run this each morning after the discovery pipeline.

  poll         : poll Second Brain for pending post jobs (created by the page's
                 Post button), claim each one, post it to LinkedIn via Selenium,
                 and report the result back. Run this on a short schedule (e.g.
                 every 5 min via Task Scheduler) while your machine is on.

Auth model: the bridge endpoints fall back to the server's own auth when no
SOCIAL_BRIDGE_TOKEN is set, so this works out of the box. If you set
SOCIAL_BRIDGE_TOKEN in SECRETS.txt AND in Render env, it is sent as a header.

LinkedIn session: uses a persistent Chrome profile (LINKEDIN_CHROME_PROFILE) that
you have logged into LinkedIn once. No password is stored. Optional
LINKEDIN_USERNAME / LINKEDIN_PASSWORD enable auto-login fallback.

Config (env first, then SECRETS.txt):
  SECOND_BRAIN_URL          default https://second-brain-iida.onrender.com
  SOCIAL_BRIDGE_TOKEN       optional shared secret (must match Render env)
  LINKEDIN_CHROME_PROFILE   default %LOCALAPPDATA%\\sb-linkedin-profile
  LINKEDIN_USERNAME / LINKEDIN_PASSWORD  optional auto-login fallback
  SOCIAL_TARGETS_FILE       default output/<client>/find_targets_queue.json

Usage:
  python sb_social_bridge.py push-targets --client cadient --top 8
  python sb_social_bridge.py poll
  python sb_social_bridge.py poll --once        # single pass then exit
"""
import os
import re
import sys
import json
import time
import glob
import argparse
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SECRETS_FILE = os.path.join(BASE_DIR, "SECRETS.txt")
SOFT_TIMEOUT_S = 540  # exit cleanly before any 600s watcher kill


def _secret(key, default=""):
    if os.environ.get(key):
        return os.environ[key]
    try:
        with open(SECRETS_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "=") and not line.startswith("#"):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return default


SB_URL = _secret("SECOND_BRAIN_URL", "https://second-brain-iida.onrender.com").rstrip("/")
BRIDGE_TOKEN = _secret("SOCIAL_BRIDGE_TOKEN", "")


def api(method, path, body=None, timeout=60):
    url = SB_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if BRIDGE_TOKEN:
        headers["x-bridge-token"] = BRIDGE_TOKEN
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, json.loads(txt)
            except Exception:
                return r.status, {"raw": txt[:300]}
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8", errors="replace")[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


# ---------------------------------------------------------------------------
# push-targets
# ---------------------------------------------------------------------------
def _load_targets(client, top):
    """Load viral targets from find_targets output. Tries common file shapes."""
    explicit = _secret("SOCIAL_TARGETS_FILE", "")
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates += [
        os.path.join(BASE_DIR, "output", client, "find_targets_queue.json"),
        os.path.join(BASE_DIR, "output", client, "posting_queue.json"),
        os.path.join(BASE_DIR, "output", client, "targets.json"),
    ]
    candidates += sorted(glob.glob(os.path.join(BASE_DIR, "output", client, "*target*.json")), reverse=True)
    path = next((c for c in candidates if c and os.path.exists(c)), None)
    if not path:
        print(f"  No find_targets output found for client={client}. Looked in output/{client}/", flush=True)
        return []
    print(f"  Reading targets from: {path}", flush=True)
    try:
        raw = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        print(f"  Could not parse {path}: {e}", flush=True)
        return []
    rows = raw.get("targets") or raw.get("queue") or raw if isinstance(raw, list) else raw.get("targets", [])
    if isinstance(raw, dict) and isinstance(rows, dict):
        rows = list(rows.values())
    targets = []
    for r in (rows or []):
        if not isinstance(r, dict):
            continue
        eng = r.get("engagement") or {}
        targets.append({
            "platform": "linkedin",
            "url": r.get("url") or r.get("postUrl") or r.get("post_url"),
            "text": r.get("text") or r.get("postText") or r.get("post_text") or r.get("commentary") or "",
            "author": r.get("author") or r.get("authorName") or r.get("name") or "",
            "authorTitle": r.get("authorTitle") or r.get("headline") or r.get("title") or "",
            "score": r.get("target_score", r.get("score")),
            "topic": r.get("matched_template") or r.get("topic") or "",
        })
    # keep LinkedIn-ish ones, sort by score desc, take top
    targets = [t for t in targets if t["text"] or t["url"]]
    targets.sort(key=lambda t: (t["score"] or 0), reverse=True)
    return targets[:top]


def cmd_push_targets(args):
    targets = _load_targets(args.client, args.top)
    if not targets:
        print("Nothing to push.", flush=True)
        return 0
    code, body = api("POST", "/api/social/targets", {"targets": targets})
    print(f"Pushed {len(targets)} targets -> HTTP {code}: {json.dumps(body)[:200]}", flush=True)
    return 0 if code == 200 else 1


# ---------------------------------------------------------------------------
# poll + LinkedIn posting
# ---------------------------------------------------------------------------
def _make_driver():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    try:
        from webdriver_manager.chrome import ChromeDriverManager
        service = Service(ChromeDriverManager().install())
    except Exception:
        service = None
    profile = _secret("LINKEDIN_CHROME_PROFILE",
                      os.path.join(os.environ.get("LOCALAPPDATA", BASE_DIR), "sb-linkedin-profile"))
    os.makedirs(profile, exist_ok=True)
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile}")
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    if args_headless:
        opts.add_argument("--headless=new")
    return webdriver.Chrome(service=service, options=opts) if service else webdriver.Chrome(options=opts)


def _ensure_logged_in(driver):
    from selenium.webdriver.common.by import By
    driver.get("https://www.linkedin.com/feed/")
    time.sleep(4)
    if "/feed" in driver.current_url and "login" not in driver.current_url:
        return True
    user = _secret("LINKEDIN_USERNAME")
    pwd = _secret("LINKEDIN_PASSWORD")
    if not (user and pwd):
        raise RuntimeError("LinkedIn not logged in. Log into LinkedIn once in the "
                           "LINKEDIN_CHROME_PROFILE Chrome profile, or set LINKEDIN_USERNAME/PASSWORD.")
    driver.get("https://www.linkedin.com/login")
    time.sleep(3)
    driver.find_element(By.ID, "username").send_keys(user)
    driver.find_element(By.ID, "password").send_keys(pwd)
    driver.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    time.sleep(6)
    if "checkpoint" in driver.current_url or "login" in driver.current_url:
        raise RuntimeError("LinkedIn login needs manual verification (2FA/captcha). Log in once interactively.")
    return True


def _post_comment(driver, post_url, text):
    """Navigate to a post and submit a comment. Returns the post URL on success."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    driver.get(post_url)
    time.sleep(5)
    # open comment box
    try:
        btn = WebDriverWait(driver, 12).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[aria-label*='omment']")))
        btn.click()
        time.sleep(2)
    except Exception:
        pass
    box = WebDriverWait(driver, 12).until(
        EC.presence_of_element_located((By.CSS_SELECTOR, "div.ql-editor[contenteditable='true']")))
    box.click()
    time.sleep(1)
    for chunk in text.split("\n"):
        box.send_keys(chunk)
    time.sleep(1)
    # click the Post/submit button for the comment
    posted = False
    for sel in ["button.comments-comment-box__submit-button",
                "button[class*='comments-comment-box__submit']",
                "button.comments-comment-box__submit-button--cr"]:
        try:
            b = driver.find_element(By.CSS_SELECTOR, sel)
            if b.is_enabled():
                b.click(); posted = True; break
        except Exception:
            continue
    if not posted:
        # fallback: find a button whose text is 'Post'
        for b in driver.find_elements(By.TAG_NAME, "button"):
            if (b.text or "").strip().lower() == "post" and b.is_enabled():
                b.click(); posted = True; break
    if not posted:
        raise RuntimeError("Could not find the comment submit button (LinkedIn DOM may have changed)")
    time.sleep(4)
    return driver.current_url


def _post_feed(driver, text):
    """Create a standalone feed post."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    driver.get("https://www.linkedin.com/feed/")
    time.sleep(4)
    start = WebDriverWait(driver, 12).until(
        EC.element_to_be_clickable((By.XPATH, "//button[contains(., 'Start a post')]")))
    start.click()
    time.sleep(3)
    box = WebDriverWait(driver, 12).until(
        EC.presence_of_element_located((By.CSS_SELECTOR, "div.ql-editor[contenteditable='true']")))
    box.click()
    for chunk in text.split("\n"):
        box.send_keys(chunk)
    time.sleep(1)
    btn = WebDriverWait(driver, 12).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "button.share-actions__primary-action")))
    btn.click()
    time.sleep(5)
    return driver.current_url


def cmd_poll(args):
    start = time.time()
    driver = None
    try:
        while True:
            code, body = api("GET", "/api/social/posts/pending")
            if code != 200:
                print(f"pending fetch failed HTTP {code}: {body}", flush=True)
                return 1
            jobs = body.get("jobs", [])
            print(f"[{time.strftime('%H:%M:%S')}] {len(jobs)} pending job(s)", flush=True)
            for job in jobs:
                # claim
                c, cb = api("POST", f"/api/social/posts/{job['id']}/claim")
                if c != 200:
                    print(f"  claim {job['id']} -> {c} {cb}", flush=True)
                    continue
                if driver is None:
                    print("  launching Chrome + LinkedIn session...", flush=True)
                    driver = _make_driver()
                    _ensure_logged_in(driver)
                try:
                    if job.get("mode") == "feed" or not job.get("targetUrl"):
                        result_url = _post_feed(driver, job["text"])
                    else:
                        result_url = _post_comment(driver, job["targetUrl"], job["text"])
                    api("POST", f"/api/social/posts/{job['id']}/result",
                        {"status": "posted", "resultUrl": result_url})
                    print(f"  POSTED {job['id']} -> {result_url}", flush=True)
                except Exception as e:
                    api("POST", f"/api/social/posts/{job['id']}/result",
                        {"status": "failed", "error": str(e)[:280]})
                    print(f"  FAILED {job['id']}: {e}", flush=True)
                time.sleep(8)  # spacing between posts
            if args.once:
                break
            if time.time() - start > SOFT_TIMEOUT_S:
                print("Soft timeout reached, exiting cleanly.", flush=True)
                break
            time.sleep(args.interval)
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
    return 0


def cmd_login(args):
    """One-time interactive LinkedIn login that saves the session to the
    persistent Chrome profile used by the poller."""
    global args_headless
    args_headless = False
    driver = _make_driver()
    try:
        driver.get("https://www.linkedin.com/login")
        print(f"Chrome opened. Log into LinkedIn in that window. Waiting up to {args.wait}s...", flush=True)
        start = time.time()
        while time.time() - start < args.wait:
            url = driver.current_url or ""
            if "/feed" in url:
                print(f"Login detected ({url[:60]}). Session saved to the profile.", flush=True)
                time.sleep(3)
                return 0
            print(f"  ...waiting for login ({int(time.time()-start)}s), current: {url[:60]}", flush=True)
            time.sleep(15)
        print("Timed out waiting for login. Re-run the login