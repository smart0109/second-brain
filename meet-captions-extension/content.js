/* Second Brain — live caption reader for Google Meet, Microsoft Teams (web) and
 * Zoom (web). No bot joins the call — it reads the platform's OWN on-screen
 * captions (which include the speaker name) and streams finalized lines to the
 * Second Brain app via a stable pairing code. Parsing rules per platform are
 * fetched from the app server so they can be fixed centrally (self-heal). */
(() => {
  const PLATFORMS = {
    meet: {
      regionSelectors: ['div[role="region"][aria-label*="aption" i]', 'div[aria-live="polite"]', '.a4cQT'],
      rowSelectors: ['.nMcdL', '.TBMuR', 'div[class*="caption"]'],
      speakerSelectors: ['.NWpY1d', '.zs7s8d', 'span[class*="name" i]'],
      textSelectors: ['.bh44bd', '.iTTPOb', 'div[class*="text" i]'],
      captionsButtonSelectors: ['button[aria-label*="aption" i]', 'button[jsname][data-tooltip*="aption" i]'],
      toggleKey: 'c',
    },
    teams: {
      regionSelectors: ['[data-tid="closed-captions-renderer"]', '[aria-label*="aptions" i]', '[class*="closed-caption" i]'],
      rowSelectors: ['[data-tid="closed-caption-message"]', '.ui-chat__item', '[class*="caption" i][class*="message" i]', 'div[class*="caption" i]'],
      speakerSelectors: ['[data-tid="author"]', '[class*="author" i]', '[class*="name" i]'],
      textSelectors: ['[data-tid="caption-text"]', '[class*="caption-text" i]', '[class*="text" i]'],
      captionsButtonSelectors: ['button[aria-label*="aption" i]'],
      toggleKey: null,
    },
    zoom: {
      regionSelectors: ['[aria-label*="aptions" i]', '.live-transcription-subtitle', '[class*="transcription" i]', '[class*="caption" i]'],
      rowSelectors: ['.live-transcription-subtitle__item', '[class*="subtitle__item" i]', '[class*="caption-item" i]', 'div[class*="caption" i]'],
      speakerSelectors: ['.live-transcription-subtitle__item-name', '[class*="item-name" i]', '[class*="name" i]'],
      textSelectors: ['.live-transcription-subtitle__item-text', '[class*="item-text" i]', '[class*="text" i]'],
      captionsButtonSelectors: ['button[aria-label*="aption" i]', 'button[aria-label*="ranscript" i]'],
      toggleKey: null,
    },
  };
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('meet.google.com')) return 'meet';
    if (h.includes('teams.')) return 'teams';
    if (h.includes('zoom.us')) return 'zoom';
    return 'meet';
  }
  const platform = detectPlatform();
  let cfg = PLATFORMS[platform], appUrl = '', code = '';
  let queue = [];
  const sent = new Set();
  const rowState = new WeakMap();

  function log(...a) { try { console.log('[SB captions:' + platform + ']', ...a); } catch (e) {} }
  function pick(root, sels) { for (const s of sels) { try { const el = (root || document).querySelector(s); if (el) return el; } catch (e) {} } return null; }
  function textOf(row, sels) { for (const s of sels) { try { const el = row.querySelector(s); if (el && el.textContent.trim()) return el.textContent.trim(); } catch (e) {} } return ''; }

  async function loadConfig() {
    try {
      const r = await fetch(appUrl + '/api/meet-caption-config', { mode: 'cors' });
      if (r.ok) { const c = await r.json(); if (c && c.platforms && c.platforms[platform]) cfg = Object.assign({}, PLATFORMS[platform], c.platforms[platform]); log('config v' + (c.version || '?')); }
    } catch (e) { log('config fetch failed, using built-in selectors'); }
  }

  function captionsOn() { const region = pick(document, cfg.regionSelectors); return !!(region && region.querySelector((cfg.rowSelectors || []).join(','))); }
  function enableCaptions() {
    if (captionsOn()) return;
    const btn = pick(document, cfg.captionsButtonSelectors || []);
    if (btn) { const lbl = (btn.getAttribute('aria-label') || '').toLowerCase(); if (!/turn off|stop|disable|hide/.test(lbl)) { try { btn.click(); log('clicked captions button'); return; } catch (e) {} } }
    if (cfg.toggleKey) { try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: cfg.toggleKey, code: 'Key' + cfg.toggleKey.toUpperCase(), bubbles: true })); } catch (e) {} }
  }

  function emit(speaker, text) {
    text = (text || '').trim(); if (text.length < 2) return;
    const key = (speaker || '') + '|' + text;
    if (sent.has(key)) return;
    sent.add(key); if (sent.size > 6000) sent.clear();
    queue.push({ speaker: speaker || '', text, ts: Date.now() });
  }
  function scan() {
    const region = pick(document, cfg.regionSelectors); if (!region) return;
    let rows = []; try { rows = region.querySelectorAll((cfg.rowSelectors || []).join(',')); } catch (e) {}
    rows.forEach((row) => {
      const speaker = textOf(row, cfg.speakerSelectors || []);
      let text = textOf(row, cfg.textSelectors || []);
      if (!text) { text = (row.innerText || '').trim(); if (speaker) text = text.replace(speaker, '').trim(); }
      const prev = rowState.get(row) || { text: '', stable: 0 };
      if (text && text === prev.text) { prev.stable++; if (prev.stable === 2 && !prev.emitted) { emit(speaker, text); prev.emitted = true; } }
      else if (text) { prev.text = text; prev.stable = 0; prev.emitted = false; }
      rowState.set(row, prev);
    });
  }
  async function flush() {
    if (!queue.length || !code || !appUrl) return;
    const batch = queue.splice(0, queue.length);
    try { await fetch(appUrl + '/api/live-captions?code=' + encodeURIComponent(code), { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: batch }) }); }
    catch (e) { queue = batch.concat(queue); }
  }

  function showBanner() {
    if (document.getElementById('sb-cap-banner')) return;
    const b = document.createElement('div');
    b.id = 'sb-cap-banner';
    b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#0f172a;color:#fff;font:500 12px system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;gap:8px;max-width:300px';
    b.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block"></span><span>Second Brain is capturing this ' + platform + ' meeting (with speaker names). Open AI Transcription for live rebuttals.</span><span id="sb-cap-x" style="cursor:pointer;opacity:.6;margin-left:4px">×</span>';
    (document.body || document.documentElement).appendChild(b);
    const x = b.querySelector('#sb-cap-x'); if (x) x.onclick = () => b.remove();
  }
  function notifyOnce() {
    try {
      if (!('Notification' in window)) return;
      const msg = 'Capturing this ' + platform + ' meeting — names + live rebuttals in your dashboard.';
      if (Notification.permission === 'granted') new Notification('Second Brain', { body: msg });
      else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') new Notification('Second Brain', { body: msg }); });
    } catch (e) {}
  }

  async function start() {
    const d = await chrome.storage.local.get(['appUrl', 'code']);
    appUrl = (d.appUrl || '').replace(/\/+$/, ''); code = (d.code || '').toUpperCase();
    if (!appUrl || !code) { log('not configured — set app URL + pairing code in the extension popup'); return; }
    await loadConfig();
    const mo = new MutationObserver((muts) => muts.forEach((m) => m.removedNodes && m.removedNodes.forEach((n) => {
      if (n.querySelector) { const sp = textOf(n, cfg.speakerSelectors || []); const tx = textOf(n, cfg.textSelectors || []); if (tx) emit(sp, tx); }
    })));
    mo.observe(document.body, { childList: true, subtree: true });
    let tries = 0; const t = setInterval(() => { enableCaptions(); if (++tries >= 8) clearInterval(t); }, 2500);
    setInterval(scan, 700);
    setInterval(flush, 1500);
    showBanner(); notifyOnce();
    log('started; appUrl=' + appUrl + ' code=' + code);
  }
  if (document.readyState === 'complete') setTimeout(start, 1500);
  else window.addEventListener('load', () => setTimeout(start, 1500));
})();
