/*
 * YUSH TOOLS — client-side defensive layer (improved)
 *
 * Changes from original:
 *  + Multi-vector automation detection (was only navigator.webdriver)
 *  + iframe / clickjacking guard (belt-and-suspenders over X-Frame-Options)
 *  + Context menu protection on images
 *  + DevTools open detection (informational logging only)
 *  + Detect PhantomJS, NightmareJS, ChromeDriver, Playwright, Puppeteer
 *  + Screen anomaly + language array checks
 *
 * This is still a soft layer — determined attackers can bypass client JS.
 * Server-side checks in security.php are the authoritative gatekeepers.
 */
(function () {
  'use strict';

  // ── Client-side rate limit for expensive actions (e.g. update runs) ──────
  var ACTION_WINDOW_MS = 10000;
  var MAX_ACTIONS = 8;
  var timestamps = [];

  function allowed() {
    var now = Date.now();
    timestamps = timestamps.filter(function (t) { return now - t < ACTION_WINDOW_MS; });
    if (timestamps.length >= MAX_ACTIONS) return false;
    timestamps.push(now);
    return true;
  }
  window.__yushGuardAction = allowed;

  // ── Keyboard shortcut blocking ──────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    var key  = (e.key || '').toLowerCase();
    var ctrl = e.ctrlKey || e.metaKey;
    // Block Ctrl+S (save), Ctrl+U (view source), Ctrl+P (print)
    if (ctrl && (key === 's' || key === 'u' || key === 'p')) {
      e.preventDefault();
      return false;
    }
  }, true);

  // ── Drag-out protection on images ───────────────────────────────────────
  document.addEventListener('dragstart', function (e) {
    if (e.target && e.target.tagName === 'IMG') e.preventDefault();
  }, true);

  // ── Context menu on images ──────────────────────────────────────────────
  // Prevents casual "Save Image As" on assets. Text right-click is left alone.
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.tagName === 'IMG') {
      e.preventDefault();
      return false;
    }
  }, true);

  // ── iframe / clickjacking guard ─────────────────────────────────────────
  // X-Frame-Options: SAMEORIGIN is already set server-side; this catches
  // edge cases where headers were dropped or the page was cached incorrectly.
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = 'none';
      try { window.top.location = window.self.location; } catch (_) {
        // Cross-origin parent: we can't redirect it, just hide the page.
      }
    }
  } catch (e) {
    // Any error here means we're framed by a cross-origin parent.
    document.documentElement.style.display = 'none';
  }

  // ── Multi-vector automation detection ──────────────────────────────────
  // Each signal increments botSignals. Threshold of 2+ triggers a warning.
  // Higher thresholds reduce false positives on unusual but real browsers.
  var botSignals = 0;

  // 1. navigator.webdriver — set by Selenium, Playwright, Puppeteer (default)
  try { if (navigator.webdriver) botSignals++; } catch (_) {}

  // 2. PhantomJS artifacts
  try { if (window.callPhantom || window._phantom) botSignals += 2; } catch (_) {}

  // 3. NightmareJS
  try { if (window.__nightmare) botSignals += 2; } catch (_) {}

  // 4. ChromeDriver artifacts
  try { if (window.domAutomation || window.domAutomationController) botSignals += 2; } catch (_) {}

  // 5. Buffer — Electron/NW.js (not a browser)
  try { if (typeof Buffer !== 'undefined' && !window.Deno) botSignals++; } catch (_) {}

  // 6. Missing plugin list — headless Chrome typically has 0 plugins.
  // Note: modern Chrome may also have 0 plugins in some configurations, so
  // this only contributes 1 point rather than being a hard signal.
  try {
    if (typeof navigator.plugins !== 'undefined' && navigator.plugins.length === 0) botSignals++;
  } catch (_) {}

  // 7. Screen size anomalies — headless default is often 0x0 or tiny.
  try {
    if (typeof screen !== 'undefined' && (screen.width === 0 || screen.height === 0)) botSignals += 2;
    if (typeof screen !== 'undefined' && (screen.width < 100 || screen.height < 100)) botSignals++;
  } catch (_) {}

  // 8. navigator.languages missing or empty array.
  // Real browsers always have at least one language.
  try {
    if (!navigator.languages || navigator.languages.length === 0) botSignals++;
  } catch (_) {}

  // 9. Claims to be Chrome but window.chrome is absent.
  // Puppeteer without stealth mode and many scrapers forget to fake this.
  try {
    var ua = navigator.userAgent || '';
    if (ua.indexOf('Chrome') !== -1 && typeof window.chrome === 'undefined') botSignals++;
  } catch (_) {}

  // 10. Notification permission inconsistency (Playwright / headless Chrome tell).
  // In headless Chrome, Notification.permission is 'denied' but the permissions
  // API says 'prompt' — a real browser is always consistent.
  try {
    if (
      typeof Notification !== 'undefined' &&
      typeof navigator.permissions !== 'undefined' &&
      Notification.permission === 'denied'
    ) {
      navigator.permissions.query({ name: 'notifications' }).then(function (p) {
        if (p.state === 'prompt') {
          // Inconsistent: strongly suggests headless environment.
          botSignals++;
          if (botSignals >= 2) {
            console.warn('[YUSH] Automation signal detected (notifications inconsistency).');
          }
        }
      });
    }
  } catch (_) {}

  if (botSignals >= 2) {
    console.warn('[YUSH] Automated client suspected (' + botSignals + ' signal(s) detected). Activity may be restricted.');
    // Optional: report silently to server for logging / adaptive blocking.
    // Uncomment once the endpoint exists:
    // try {
    //   navigator.sendBeacon('/api/flag-bot', JSON.stringify({ signals: botSignals, ua: navigator.userAgent }));
    // } catch (_) {}
  }

  // ── DevTools detection ──────────────────────────────────────────────────
  // Informational only — logs to console, does not block the owner.
  // DevTools pops out a side panel that widens outerWidth vs innerWidth.
  (function () {
    var THRESHOLD   = 160;
    var devtoolsOpen = false;
    var check = function () {
      var widthDelta  = window.outerWidth  - window.innerWidth;
      var heightDelta = window.outerHeight - window.innerHeight;
      var open = widthDelta > THRESHOLD || heightDelta > THRESHOLD;
      if (open && !devtoolsOpen) {
        devtoolsOpen = true;
        console.info('[YUSH] DevTools appear open. If you are the site owner, that is fine!');
      } else if (!open && devtoolsOpen) {
        devtoolsOpen = false;
      }
    };
    // Poll every 2 s — infrequent enough not to waste CPU.
    setInterval(check, 2000);
  })();

})();
