/* Second Brain — Google Meet live caption reader (no bot).
 * Reads Meet's own captions (which include the speaker name), and streams
 * finalized lines to the Second Brain app via a pairing code.
 * Parsing rules are fetched from the app server so they can be fixed centrally
 * (self-heal) without re-installing the extension. */
(() => {
  const DEFAULTS = {
    regionSelectors: ['div[role="region"][aria-label*="aption" i]', 'div[aria-live="polite"]', '.a4cQT'],
    rowSelectors: ['.nMcdL', '.TBMuR', 'div[class*="caption"]'],
    speakerSelectors: ['.NWpY1d', '.zs7s8d', 'span[class*="name" i]'],
    textSelectors: ['.bh44bd', '.iTTPOb', 'div[class*="text" i]'],
    captionsButtonSelectors: ['button[aria-label*="aption" i]', 'button[jsname][data-tooltip*="aption" i]'],
    toggleKey: 'c',
  };
  let cfg = DEFAULTS, appUrl = '', code = '';
  let queue = [];
  const sent = new Set();          // speaker|text already shipped (dedupe)
  const rowState = new WeakMap();  // caption row -> { text, stable }

  function log(...a) { try { console.log('[SB captions]', ...a); } catch (e) {} }
  function pick(root, sels) { for (const s of sels) { const el = (root || document).querySelector(s); if (el) return el; } return null; }
  function textOf(row, sels) { for (const s of sels) { const el = row.querySelector(s); if (el && el.textContent.trim()) return el.textContent.trim(); } return ''; }

  async function loadConfig() {
    try {
      const r = await fetch(appUrl + '/api/meet-caption-config', { mode: 'cors' });
      if (r.ok) { const c = await r.json(); if (c && c.rowSelectors) cfg = Object.assign({}, DEFAULTS, c); log('config v' + (cfg.version || '?')); }
    } catch (e) { log('config fetch failed, using defaults'); }
  }

  function enableCaptions() {
    // Try the CC button first, then the keyboard shortcut.
    const btn = pick(document, cfg.captionsButtonSelectors);
    if (btn) { const lbl = (btn.getAttribute('aria-label') || '').toLowerCase(); if (!/turn off|stop/.test(lbl)) { try { btn.click(); log('clicked captions button'); return; } catch (e) {} } }
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: cfg.toggleKey, code: 'Key' + cfg.toggleKey.toUpperCase(), bubbles: true }));
      log('sent captions shortcut');
    } catch (e) {}
  }

  function emit(speaker, text) {
    text = (text || '').trim(); if (text.length < 2) return;
    const key = (speaker || '') + '|' + text;
    if (sent.has(key)) return;
    sent.add(key);
    if (sent.size > 5000) sent.clear();
    queue.push({ speaker: speaker || '', text, ts: Date.now() });
  }

  function scan() {
    const region = pick(document, cfg.regionSelectors);
    if (!region) return;
    const rows = region.querySelectorAll(cfg.rowSelectors.join(','));
    rows.forEach((row) => {
      const speaker = textOf(row, cfg.speakerSelectors);
      const text = textOf(row, cfg.textSelectors) || (row.innerText || '').replace(speaker, '').trim();
      const prev = rowState.get(row) || { text: '', stable: 0 };
      if (text && text === prev.text) {
        prev.stable++;
        if (prev.stable === 2 && !prev.emitted) { emit(speaker, text); prev.emitted = true; } // stable for ~2 cycles -> final
      } else if (text) {
        prev.text = text; prev.stable = 0; prev.emitted = false;
      }
      rowState.set(row, prev);
    });
  }

  async function flush() {
    if (!queue.length || !code || !appUrl) return;
    const batch = queue.splice(0, queue.length);
    try {
      await fetch(appUrl + '/api/live-captions?code=' + encodeURIComponent(code), {
        method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: batch }),
      });
    } catch (e) { queue = batch.concat(queue); log('flush failed, will retry'); }
  }

  async function start() {
    const d = await chrome.storage.local.get(['appUrl', 'code']);
    appUrl = (d.appUrl || '').replace(/\/+$/, ''); code = (d.code || '').toUpperCase();
    if (!appUrl || !code) { log('not configured — set app URL + pairing code in the extension popup'); return; }
    await loadConfig();
    // Capture removed caption rows as final lines too.
    const mo = new MutationObserver((muts) => {
      muts.forEach((m) => m.removedNodes && m.removedNodes.forEach((n) => {
        if (n.querySelector) {
          const sp = textOf(n, cfg.speakerSelectors);
          const tx = textOf(n, cfg.textSelectors);
          if (tx) emit(sp, tx);
        }
      }));
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(enableCaptions, 2500);
    setInterval(scan, 700);
    setInterval(flush, 1500);
    log('started; appUrl=' + appUrl + ' code=' + code);
  }

  // Wait for Meet UI to settle.
  if (document.readyState === 'complete') setTimeout(start, 1500);
  else window.addEventListener('load', () => setTimeout(start, 1500));
})();
