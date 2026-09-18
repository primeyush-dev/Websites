/*
 * YUSH TOOLS — Anti-Analysis / Anti-RE Layer (Client Side)
 * Layer 2 — works alongside js/protection.js
 *
 * Targets:
 *  - Frida gadget injection (window hooks, native overrides)
 *  - IDA / Ghidra / x64dbg browser-side debugging signals
 *  - Linux headless environments (Kali, Parrot, BlackArch browser fingerprints)
 *  - Automated RE tools: mitmproxy, Burp Suite, OWASP ZAP browser extensions
 *  - Debugger traps (breakpoint timing, console override detection)
 *  - JS hook detection (Function.prototype.toString poisoning)
 *  - Source map / devtools protocol leaks
 *
 * Architecture:
 *  - Signals accumulate into reScore (RE score)
 *  - At threshold: silent beacon to /api/security-events + page poison
 *  - Does NOT alert the user — silent degradation only
 */
(function () {
  'use strict';

  var reScore = 0;
  var RE_THRESHOLD = 3;
  var _native = Function.prototype.toString;
  var _warned = false;

  // ── Utility ────────────────────────────────────────────────────────────────
  function score(n) { reScore += n; }

  function beacon(reason) {
    if (_warned) return;
    _warned = true;
    try {
      navigator.sendBeacon(
        '/api/security-events',
        JSON.stringify({
          type: 'anti_analysis',
          reason: reason,
          score: reScore,
          ua: navigator.userAgent || '',
          ts: Date.now()
        })
      );
    } catch (_) {}
  }

  function poison() {
    // Silent: corrupt key state so scraped data is garbage
    // Does NOT show any UI alert — attacker gets no confirmation
    try {
      // Overwrite sensitive DOM regions with decoy content
      var decoys = document.querySelectorAll('[data-sensitive]');
      for (var i = 0; i < decoys.length; i++) {
        decoys[i].textContent = '\u200b\u200c\u200d'; // zero-width junk
      }
    } catch (_) {}
  }

  function check() {
    if (reScore >= RE_THRESHOLD) {
      beacon('threshold_reached');
      poison();
    }
  }

  // ── 1. Frida Gadget Detection ──────────────────────────────────────────────
  // Frida injects into the process and patches native functions.
  // The tell: native functions no longer have "[native code]" in toString().
  (function () {
    var natives = [
      [XMLHttpRequest.prototype.open,   'XHR.open'],
      [XMLHttpRequest.prototype.send,   'XHR.send'],
      [fetch,                           'fetch'],
      [WebSocket,                       'WebSocket'],
      [JSON.stringify,                  'JSON.stringify'],
      [JSON.parse,                      'JSON.parse'],
      [document.createElement,          'createElement'],
      [window.eval,                     'eval'],
    ];
    for (var i = 0; i < natives.length; i++) {
      try {
        var fn = natives[i][0];
        if (typeof fn !== 'function') continue;
        var src = _native.call(fn);
        // Frida-hooked functions show custom source or empty body
        if (src.indexOf('[native code]') === -1) {
          score(3); // High signal — very likely Frida or Cydia Substrate
        }
      } catch (_) {
        // Error calling toString on a hooked fn is itself a signal
        score(2);
      }
    }
  })();

  // ── 2. Frida Window Object Artifacts ──────────────────────────────────────
  (function () {
    var fridaArtifacts = [
      '_frida',
      '__frida',
      'Frida',
      '_frida_gadget',
      '__FRIDA__',
      'fridaArgs',
      'ObjC',           // Frida ObjC bridge (iOS RE)
      'Java',           // Frida Java bridge (Android RE via desktop relay)
      'Module',         // Frida Module API leaked to window
      'Memory',         // Frida Memory API
      'Process',        // Frida Process API
      'Interceptor',    // Frida Interceptor
      'Stalker',        // Frida Stalker
      'NativeFunction', // Frida NativeFunction
      'NativePointer',  // Frida NativePointer
      'Script',         // Frida Script
    ];
    for (var i = 0; i < fridaArtifacts.length; i++) {
      try {
        if (typeof window[fridaArtifacts[i]] !== 'undefined') {
          score(4); // Direct Frida artifact — extremely high confidence
        }
      } catch (_) {}
    }
  })();

  // ── 3. Debugger / Breakpoint Timing Trap ──────────────────────────────────
  // IDA, x64dbg, Chrome DevTools Protocol — all slow execution when stepping.
  // Normal JS runs sub-millisecond. Debugger stepping takes 10ms+.
  (function () {
    var TRAP_ITERATIONS = 1000;
    var start = performance.now();
    for (var i = 0; i < TRAP_ITERATIONS; i++) { /* hot loop */ }
    var elapsed = performance.now() - start;
    // Normal: <2ms. Under debugger stepping: 50ms+
    if (elapsed > 50) {
      score(2);
    }
    // Second trap with debugger statement (won't fire in prod unless debugger open)
    var t1 = performance.now();
    /* eslint-disable no-debugger */
    debugger; // Pauses here ONLY if DevTools breakpoints are active
    /* eslint-enable no-debugger */
    var t2 = performance.now();
    if (t2 - t1 > 100) {
      score(3); // Debugger was attached and paused
    }
  })();

  // ── 4. Function.prototype.toString Poisoning Detection ────────────────────
  // Burp Suite, mitmproxy JS injection, and some Frida scripts patch toString
  // to hide their hooks. Detect the patch itself.
  (function () {
    try {
      var toStrSrc = _native.call(Function.prototype.toString);
      if (toStrSrc.indexOf('[native code]') === -1) {
        score(4); // toString itself is hooked — severe signal
      }
    } catch (_) {
      score(3);
    }
  })();

  // ── 5. Linux Headless / RE Environment Fingerprints ───────────────────────
  // Kali, Parrot OS, BlackArch running headless Chrome for recon.
  // These environments have tell-tale property gaps.
  (function () {
    // a. Missing speech synthesis (headless Chrome on Linux has it undefined)
    try {
      if (typeof window.speechSynthesis === 'undefined') score(1);
    } catch (_) {}

    // b. No touch support + no pointer events = likely desktop Linux scraper
    try {
      if (
        typeof window.ontouchstart === 'undefined' &&
        typeof window.onpointerdown === 'undefined' &&
        navigator.maxTouchPoints === 0
      ) {
        // Not a mobile device — combine with other signals, not a block alone
        score(0); // neutral — just logged
      }
    } catch (_) {}

    // c. Linux UA explicit pattern — real users on Linux are fine,
    //    but Linux + headless + other signals = RE environment
    try {
      var ua = navigator.userAgent || '';
      var isLinuxUA = /Linux(?! Android)/.test(ua) && !/Android/.test(ua);
      var isHeadless = /HeadlessChrome|PhantomJS|Electron/.test(ua);
      if (isLinuxUA && isHeadless) score(3);
      if (/curl|wget|httpx|gobuster|ffuf|sqlmap|nikto|hydra|nuclei/i.test(ua)) score(5);
    } catch (_) {}

    // d. No AudioContext — headless Chrome on Linux often lacks audio backend
    try {
      if (typeof window.AudioContext === 'undefined' &&
          typeof window.webkitAudioContext === 'undefined') {
        score(1);
      }
    } catch (_) {}

    // e. Canvas fingerprint blank — headless renders blank canvas
    try {
      var c = document.createElement('canvas');
      var ctx2d = c.getContext('2d');
      if (ctx2d) {
        ctx2d.fillStyle = '#f00';
        ctx2d.fillRect(0, 0, 1, 1);
        var px = ctx2d.getImageData(0, 0, 1, 1).data;
        // Headless Chrome on some Linux configs returns [0,0,0,0]
        if (px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] === 0) {
          score(2);
        }
      }
    } catch (_) {}
  })();

  // ── 6. Proxy / Interception Tool Detection ────────────────────────────────
  // Burp Suite and ZAP inject a proxy CA cert and sometimes add headers/JS.
  (function () {
    // Burp's built-in browser sets specific navigator properties
    try {
      if (navigator.userAgent && /BurpSuite|OWASP_ZAP/i.test(navigator.userAgent)) {
        score(5);
      }
    } catch (_) {}

    // Check for Burp's injected collaborator script tag
    try {
      var scripts = document.querySelectorAll('script[src*="burp"], script[src*="collaborator"]');
      if (scripts.length > 0) score(4);
    } catch (_) {}

    // mitmproxy injects a JS shim when in transparent mode
    try {
      if (typeof window.__mitmproxy !== 'undefined') score(5);
    } catch (_) {}

    // OWASP ZAP active scan artifact
    try {
      if (typeof window.zap !== 'undefined' || typeof window.zaproxy !== 'undefined') score(5);
    } catch (_) {}
  })();

  // ── 7. Source Map Leak Prevention ─────────────────────────────────────────
  // Remove any accidentally exposed source map comments at runtime
  (function () {
    try {
      var allScripts = document.querySelectorAll('script');
      for (var i = 0; i < allScripts.length; i++) {
        var s = allScripts[i];
        if (s.src && /\.map$/.test(s.src)) {
          s.parentNode.removeChild(s);
        }
      }
    } catch (_) {}
  })();

  // ── 8. RE Browser Extension Detection ─────────────────────────────────────
  // Some RE extensions (Wappalyzer, builtwith, etc.) inject globals or modify DOM.
  (function () {
    var reExtensionArtifacts = [
      '__wappalyzer',
      'wappalyzer',
      '__builtwith',
      'builtwith',
      '__retire',     // retire.js scanner
      'retirejs',
      '__webdriver_script_fn', // Selenium residue
      '__selenium_evaluate',
      '__selenium_unwrapped',
      '__webdriver_evaluate',
      '__fxdriver_evaluate',
      '__driver_evaluate',
    ];
    for (var i = 0; i < reExtensionArtifacts.length; i++) {
      try {
        if (typeof window[reExtensionArtifacts[i]] !== 'undefined') {
          score(2);
        }
      } catch (_) {}
    }
  })();

  // ── 9. WebGL RE Environment Signal ────────────────────────────────────────
  // IDA/Ghidra don't touch WebGL, but headless RE environments often have
  // either null renderer or a software renderer string
  (function () {
    try {
      var gl = document.createElement('canvas').getContext('webgl') ||
               document.createElement('canvas').getContext('experimental-webgl');
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          var renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
          var vendor   = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   || '';
          // Software renderers used in headless / VM RE environments
          if (/SwiftShader|llvmpipe|softpipe|Mesa|VirtualBox|VMware|QEMU/i.test(renderer + vendor)) {
            score(2);
          }
        }
      } else {
        // No WebGL at all = likely headless
        score(1);
      }
    } catch (_) {}
  })();

  // ── 10. Periodic Re-check ─────────────────────────────────────────────────
  // Frida and hooks can be injected AFTER page load (dynamic injection).
  // Re-run key checks every 5s.
  setInterval(function () {
    // Re-check native function integrity
    try {
      if (_native.call(fetch).indexOf('[native code]') === -1) score(2);
    } catch (_) { score(1); }

    // Re-check Frida artifacts
    var live = ['_frida', '__frida', 'Frida', 'NativeFunction', 'Interceptor'];
    for (var i = 0; i < live.length; i++) {
      try {
        if (typeof window[live[i]] !== 'undefined') score(3);
      } catch (_) {}
    }

    check();
  }, 5000);

  // ── Final gate ─────────────────────────────────────────────────────────────
  // Run at end of script execution
  window.addEventListener('load', function () {
    check();
  });

  // Also run immediately (catches synchronous injection before load)
  check();

})();
