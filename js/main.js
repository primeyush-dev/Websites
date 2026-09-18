/**
 * YUSH TOOLS — Main Application Logic
 */
(function () {
  'use strict';

  function yushAdminHeaders(extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var tok = (window.YUSH_ADMIN_TOKEN || localStorage.getItem('__yush_admin_token__') || '').trim();
    if (tok) h['X-Admin-Token'] = tok;
    return h;
  }
  if (typeof window.Auth === 'undefined' && typeof window.YushAuth !== 'undefined') {
    window.Auth = window.YushAuth;
  }
  if (typeof window.Auth === 'undefined') {
    console.error('YUSH TOOLS: Auth module failed to load — check js/auth.js path');
  }
  var Auth = window.Auth || window.YushAuth || null;

  /* Prefixes every api/*.php call with window.YUSH_API_BASE (set near the
     top of index.html). Needed because Netlify (and similar static-only
     hosts) can't execute PHP — pointing this at a real PHP host is the
     fix for "Bad server response (HTTP 404)" on the upload/admin calls. */
  function yushApi(path) {
    var base = (window.YUSH_API_BASE || '').replace(/\/+$/, '');
    return base ? (base + '/' + String(path).replace(/^\/+/, '')) : path;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var currentTab = 'updater';
  var S = { old: null, 'new': null, tgt: null, sources: [] };
  var JOBS_KEY = '__yush_jobs_v1__';
  var R = { all: [], updated: [], failed: [], ignored: [], same: [] };
  var _worker = null;
  var _updatedText = null;
  var _lastRunAt = 0;
  var RUN_COOLDOWN_MS = 1500;
  var SETTINGS_KEY = 'yushUpdaterSettings';
  var DEFAULT_SETTINGS = { autoDownload: false, copyEnabled: true };
  var SETTINGS = Object.assign({}, DEFAULT_SETTINGS);

  /* ════════════════════════════════════════
     BOOT
     ════════════════════════════════════════ */
  function formatPHTime(ts) {
    if (!ts) return 'Not uploaded yet';
    try {
      var d = new Date(ts);
      return d.toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        month: 'numeric', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
        hour12: true
      });
    } catch (e) {
      try { return new Date(ts).toLocaleString(); } catch (e2) { return '—'; }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    try { loadSettings(); } catch (e) { console.warn(e); }
    try { bindAuthUI(); } catch (e) { console.error('bindAuthUI', e); }
    try { bindAppUI(); } catch (e) { console.warn('bindAppUI', e); }
    try { bindUpdater(); } catch (e) { console.warn('bindUpdater', e); }
    try { bindFinder(); } catch (e) { console.warn('bindFinder', e); }
    try { if (window.YushHookBuilder) window.YushHookBuilder.bind(); } catch (e) { console.warn('bindHookBuilder', e); }
    try { bindSettings(); } catch (e) { console.warn('bindSettings', e); }
    try { if (window.YushFormatting && window.YushFormatting.init) window.YushFormatting.init(); } catch (e) { console.warn('YushFormatting', e); }
    try { bindLegalModal(); } catch (e) { console.warn('bindLegalModal', e); }
    try { bindDummyDetector(); } catch (e) { console.warn('bindDummyDetector', e); }
    try { if (Auth) tryAutoLogin(); } catch (e) { console.warn('tryAutoLogin', e); }
    try { renderLoginTurnstile(); } catch (e) {}
  });

  // Also expose immediately for early inline clicks
  window.doLogin = function () { console.warn('App still loading…'); };
  window.doRegister = function () { console.warn('App still loading…'); };
  window.doSendCode = function () { console.warn('App still loading…'); };

  function tryAutoLogin() {
    var session = Auth.getCurrentUser();
    if (session) {
      document.documentElement.classList.add('yush-authed');
      showApp(session);
      return;
    }
    document.documentElement.classList.remove('yush-authed');
    // Pre-fill remember-me
    var rem = Auth.loadRemembered();
    if (rem.license || rem.email) {
      var le = document.getElementById('loginLicense');
      var rm = document.getElementById('rememberMe');
      if (le) le.value = rem.license || rem.email || '';
      if (rm) rm.checked = true;
    }
  }

  /* ════════════════════════════════════════
     AUTH UI
     ════════════════════════════════════════ */
  function bindAuthUI() {
    function on(id, evt, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(evt, fn);
    }
    on('btnLogin', 'click', doLogin);
    /* Register removed */
    on('gotoRegister', 'click', function () { showAuthView('register'); });
    on('gotoLogin', 'click', function () { showAuthView('login'); });

    document.querySelectorAll('[data-auth-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showAuthView(btn.getAttribute('data-auth-tab') || 'login');
      });
    });
    /* Google login removed */

    on('loginLicense', 'keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    on('regPassword2', 'keydown', function (e) { if (e.key === 'Enter') doRegister(); });
    /* Verification code removed */

    /* Password strength bar on register */
    (function() {
      var pwInp = document.getElementById('regPassword');
      var barWrap = document.getElementById('regPwStrengthBar');
      if (!pwInp) return;
      /* inject bar below the password field if not already there */
      if (!barWrap) {
        barWrap = document.createElement('div');
        barWrap.id = 'regPwStrengthBar';
        barWrap.style.cssText = 'margin-top:6px;display:none';
        barWrap.innerHTML =
          '<div style="height:4px;border-radius:2px;background:var(--border);overflow:hidden">' +
            '<div id="regPwStrengthFill" style="height:100%;width:0%;border-radius:2px;transition:width .25s,background .25s"></div>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;margin-top:4px">' +
            '<span id="regPwStrengthLabel" style="font-size:10px;font-weight:600"></span>' +
            '<span style="font-size:10px;color:var(--text3)">Password strength</span>' +
          '</div>';
        pwInp.parentNode.insertBefore(barWrap, pwInp.nextSibling);
      }
      pwInp.addEventListener('input', function() {
        var v = pwInp.value;
        if (!v) { barWrap.style.display = 'none'; return; }
        barWrap.style.display = '';
        var str = pwStrength(v);
        var fill = document.getElementById('regPwStrengthFill');
        var lbl  = document.getElementById('regPwStrengthLabel');
        if (fill) { fill.style.width = str.pct + '%'; fill.style.background = str.color; }
        if (lbl)  { lbl.textContent = str.label; lbl.style.color = str.color; }
      });
    })();

    document.querySelectorAll('.auth-eye').forEach(function (btn) {
      // Guard: skip if this button already has a bound listener (prevents double-toggle)
      if (btn.dataset.eyeBound) return;
      btn.dataset.eyeBound = '1';
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-target');
        if (window.togglePwd) window.togglePwd(id, btn);
        else {
          var inp = document.getElementById(id);
          if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
        }
      });
    });

    // Expose to window for inline handlers
    window.doLogin = doLogin;
    window.doRegister = doRegister;
    window.doSendCode = doSendCode;
    window.showAuthView = showAuthView;
  }

  function showAuthView(name) {
    var a = document.getElementById('authLoginView');
    var b = document.getElementById('authRegisterView');
    if (a) a.style.display = name === 'login' ? '' : 'none';
    if (b) b.style.display = name === 'register' ? '' : 'none';
    var t1 = document.getElementById('tabSignIn');
    var t2 = document.getElementById('tabSignUp');
    if (t1) {
      t1.classList.toggle('active', name === 'login');
      t1.setAttribute('aria-selected', name === 'login' ? 'true' : 'false');
    }
    if (t2) {
      t2.classList.toggle('active', name === 'register');
      t2.setAttribute('aria-selected', name === 'register' ? 'true' : 'false');
    }
    var h = document.getElementById('authHeading');
    var d = document.getElementById('authDesc');
    if (name === 'login') {
      if (h) h.textContent = 'Welcome back';
      if (d) d.textContent = 'Sign in to access your tools.';
      setTimeout(renderLoginTurnstile, 50);
    } else {
      if (h) h.textContent = 'Create your account';
      if (d) d.textContent = 'Join YUSH TOOLS to get started.';
    }
    var e1 = document.getElementById('loginError'); if (e1) e1.textContent = '';
    var e2 = document.getElementById('regError'); if (e2) e2.textContent = '';
    window.__yushAuthTab = name;
  }


  var TURNSTILE_SITE_KEY = '0x4AAAAAAEvFlouUrYi5Y6Tj';
  var TURNSTILE_VERIFY_ENDPOINT = yushApi('#');
  var _loginTurnstileWidgetId = null;

  function renderLoginTurnstile(attempt) {
    attempt = attempt || 0;
    var mount = document.getElementById('loginTurnstile');
    if (!mount) return;
    if (!window.turnstile) {
      if (attempt > 40) return;
      setTimeout(function () { renderLoginTurnstile(attempt + 1); }, 250);
      return;
    }
    try {
      if (_loginTurnstileWidgetId !== null) {
        window.turnstile.remove(_loginTurnstileWidgetId);
        _loginTurnstileWidgetId = null;
      }
    } catch (e) {}
    mount.innerHTML = '';
    _loginTurnstileWidgetId = window.turnstile.render(mount, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: document.body.classList.contains('light') ? 'light' : 'dark',
      size: 'flexible',
      callback: function () {
        var err = document.getElementById('loginError');
        if (err) err.textContent = '';
      },
      'expired-callback': function () {
        var err = document.getElementById('loginError');
        if (err) err.textContent = 'Verification expired — check the box again.';
      },
      'error-callback': function () {
        var err = document.getElementById('loginError');
        if (err) err.textContent = 'Verification failed to load. Refresh and try again.';
      }
    });
  }

  function getTurnstileToken() {
    try {
      if (window.turnstile && _loginTurnstileWidgetId !== null) {
        return window.turnstile.getResponse(_loginTurnstileWidgetId) || '';
      }
    } catch (e) {}
    var inp = document.querySelector('#loginTurnstile [name="cf-turnstile-response"], [name="cf-turnstile-response"]');
    return inp ? (inp.value || '') : '';
  }

  function resetTurnstile() {
    try {
      if (window.turnstile && _loginTurnstileWidgetId !== null) {
        window.turnstile.reset(_loginTurnstileWidgetId);
      }
    } catch (e) {}
  }

  function verifyTurnstileToken(token, cb) {
    // Static / Vercel: no PHP endpoint — accept widget token presence
    if (typeof cb === 'function') cb(!!token);
  }

  
  /* Google Identity — set your OAuth Web Client ID below */
  var GOOGLE_CLIENT_ID = (window.YUSH_GOOGLE_CLIENT_ID || '1014722402497-nhdrn7vghs36dpnop4tebsooja0rhjpa.apps.googleusercontent.com').trim();

  function parseJwtPayload(token) {
    try {
      var part = token.split('.')[1];
      var json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  function doGoogleAuth() {
    if (!Auth) { alert('Auth failed to load.'); return; }
    var mode = window.__yushAuthTab === 'register' ? 'register' : 'login';
    var errId = mode === 'register' ? 'regError' : 'loginError';
    var errEl = document.getElementById(errId);
    if (errEl) { errEl.style.color = ''; errEl.textContent = ''; }

    // Cloudflare captcha must be completed before Google login
    var captcha = '';
    try { captcha = getTurnstileToken() || ''; } catch (e) { captcha = ''; }
    if (!captcha) {
      // Ensure login tab (where Turnstile lives) is visible so user can complete it
      if (mode !== 'login') {
        showAuthView('login');
        errEl = document.getElementById('loginError');
      }
      if (errEl) errEl.textContent = 'Complete the security check (Cloudflare) first, then try Continue with Google.';
      try { renderLoginTurnstile(); } catch (e) {}
      return;
    }

    function finish(email, name) {
      var res = Auth.loginOrRegisterGoogle(email, name, mode);
      if (!res.ok) {
        if (errEl) errEl.textContent = res.error;
        return;
      }
      showApp(res.user);
    }

    if (!GOOGLE_CLIENT_ID) {
      if (errEl) errEl.textContent = 'Google Client ID missing. Contact the owner.';
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      if (errEl) errEl.textContent = 'Google script still loading. Wait a second and try again.';
      return;
    }

    // Direct OAuth popup — no One Tap "Continue as …" card on the page
    try {
      var client = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'openid email profile',
        prompt: 'select_account',
        callback: function (tokenResponse) {
          if (!tokenResponse || !tokenResponse.access_token) {
            if (errEl) errEl.textContent = 'Google sign-in cancelled or failed.';
            return;
          }
          fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + tokenResponse.access_token }
          }).then(function (r) {
            if (!r.ok) throw new Error('profile ' + r.status);
            return r.json();
          }).then(function (profile) {
            if (!profile || !profile.email) {
              if (errEl) errEl.textContent = 'Google did not return an email.';
              return;
            }
            finish(profile.email, profile.name || '');
          }).catch(function (e) {
            console.warn(e);
            if (errEl) errEl.textContent = 'Failed to read Google profile.';
          });
        },
        error_callback: function (err) {
          if (err && err.type === 'popup_closed') return;
          if (errEl) errEl.textContent = (err && err.message) || 'Google sign-in failed.';
        }
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch (e) {
      console.warn(e);
      if (errEl) errEl.textContent = 'Google sign-in failed to start.';
    }
  }

  function doLogin() {
    if (!Auth) { alert('Auth failed to load. Re-upload js/auth.js'); return; }
    var keyEl = document.getElementById('loginLicense');
    var remEl = document.getElementById('rememberMe');
    var errEl = document.getElementById('loginError');
    var btn = document.getElementById('btnLogin');
    if (!keyEl) return;
    var license = (keyEl.value || '').trim();
    var remember = remEl ? remEl.checked : false;
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }

    if (!license) {
      if (errEl) errEl.textContent = 'Please enter your license key.';
      return;
    }

    // Cloudflare Turnstile (client-side). No PHP verify on Vercel.
    var token = '';
    try { token = getTurnstileToken() || ''; } catch (e) { token = ''; }
    if (!token) {
      if (errEl) errEl.textContent = 'Please complete the Cloudflare verification.';
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    var res = Auth.login(license, remember);
    if (!res.ok) {
      if (errEl) errEl.textContent = res.error || 'Invalid license key.';
      try { resetTurnstile(); } catch (e) {}
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    showApp(res.user);
  }


  var _pendingCode = null;
  var _codeCooldownTimer = null;
  var EMAILJS_PUBLIC_KEY  = 'ZAhhQvlMpNMCivJhn';
  var EMAILJS_SERVICE_ID  = 'service_1sf8dfm';
  var EMAILJS_TEMPLATE_ID = 'template_68iwuwd';
  var CODE_TTL_MS = 5 * 60 * 1000;
  var TURNSTILE_VERIFY_ENDPOINT = yushApi('#');
  var _emailjsReady = false;

  function ensureEmailJS(cb, onErr) {
    if (_emailjsReady && window.emailjs) { cb(); return; }
    function init() {
      try {
        window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
        _emailjsReady = true;
        cb();
      } catch (e) {
        if (onErr) onErr(e);
      }
    }
    if (window.emailjs) { init(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
    s.onload = init;
    s.onerror = function () { if (onErr) onErr(new Error('Failed to load EmailJS')); };
    document.head.appendChild(s);
  }

  function sendVerificationEmail(email, code, onSuccess, onError) {
    ensureEmailJS(function () {
      window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
        to_email: email,
        email: email,
        user_email: email,
        code: code
      }).then(function () {
        if (onSuccess) onSuccess();
      }).catch(function (err) {
        if (onError) onError(err);
      });
    }, onError);
  }

  function startCodeCooldown(btn) {
    btn.disabled = true;
    var left = 60;
    btn.textContent = left + 's';
    if (_codeCooldownTimer) clearInterval(_codeCooldownTimer);
    _codeCooldownTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        clearInterval(_codeCooldownTimer);
        btn.disabled = false;
        btn.textContent = 'Send code';
      } else {
        btn.textContent = left + 's';
      }
    }, 1000);
  }

  var _sendCodeLock = false;
  function doSendCode() {
    var emailEl = document.getElementById('regEmail');
    var statusEl = document.getElementById('codeStatus');
    var btn = document.getElementById('sendCodeBtn');
    var errEl = document.getElementById('regError');
    if (!emailEl || !btn) return;
    if (errEl) errEl.textContent = '';
    var email = (emailEl.value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (errEl) errEl.textContent = 'Enter a valid email first.';
      return;
    }
    if (btn.disabled || _sendCodeLock) return;
    _sendCodeLock = true;
    btn.disabled = true;
    if (statusEl) {
      statusEl.className = 'auth-code-status checking show';
      statusEl.textContent = 'Sending verification code…';
    }
    var code = String(Math.floor(100000 + Math.random() * 900000));
    sendVerificationEmail(email, code, function () {
      _pendingCode = { email: email, code: code, expiresAt: Date.now() + CODE_TTL_MS };
      _sendCodeLock = false;
      if (statusEl) {
        statusEl.className = 'auth-code-status ok show';
        statusEl.textContent = 'Code sent! Check your inbox for the 6-digit code.';
      }
      startCodeCooldown(btn);
    }, function (err) {
      _sendCodeLock = false;
      if (statusEl) {
        statusEl.className = 'auth-code-status fail show';
        statusEl.textContent = 'Failed to send code. Try again later.';
      }
      console.warn('EmailJS error', err);
      btn.disabled = false;
      btn.textContent = 'Send code';
    });
  }

  function doRegister() {
    if (!Auth) { alert('Auth failed to load. Re-upload js/auth.js'); return; }
    var email = (document.getElementById('regEmail') || {}).value || '';
    var pass = (document.getElementById('regPassword') || {}).value || '';
    var pass2 = (document.getElementById('regPassword2') || {}).value || '';
    var code = ((document.getElementById('regCode') || {}).value || '').trim();
    var errEl = document.getElementById('regError');
    if (errEl) errEl.textContent = '';
    if (pass !== pass2) {
      if (errEl) errEl.textContent = 'Passwords do not match.';
      return;
    }
    if (!_pendingCode || _pendingCode.email !== (email || '').toLowerCase().trim()) {
      if (errEl) errEl.textContent = 'Please send and enter the verification code first.';
      return;
    }
    if (Date.now() > _pendingCode.expiresAt) {
      if (errEl) errEl.textContent = 'Verification code expired. Request a new one.';
      return;
    }
    if (code !== _pendingCode.code) {
      if (errEl) errEl.textContent = 'Invalid verification code.';
      return;
    }
    var btn = document.getElementById('btnRegister');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    var res = Auth.register(email, pass);
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    if (!res.ok) {
      if (errEl) errEl.textContent = res.error;
      return;
    }
    _pendingCode = null;
    showAuthView('login');
    var le = document.getElementById('loginError');
    if (le) {
      le.style.color = '#22c55e';
      le.textContent = 'Account created! You can now sign in.';
    }
    var emailIn = document.getElementById('loginEmail');
    if (emailIn) emailIn.value = (email || '').toLowerCase().trim();
  }

  function showApp(user) {
    document.documentElement.classList.add('yush-authed');
    var ao = document.getElementById('authOverlay');
    var ma = document.getElementById('mainApp');
    if (ao) ao.style.display = 'none';
    if (ma) ma.style.display = '';
    updateProfileUI(user);
    // Show admin tab only for owner / admin role
    var isAdmin = user.role === 'admin' || Auth.isOwner(user.key || user.email);
    document.querySelectorAll('.admin-only').forEach(function (el) {
      el.style.display = isAdmin ? '' : 'none';
    });
    updateNotifBadge();
    switchTab('dashboard');
    refreshDashboard();
  }

  function updateProfileUI(user) {
    var displayKey = user.key || user.email || '';
    var name = user.name || Auth.nameFromEmail(displayKey);
    var initial = Auth.initialFromEmail(displayKey);
    document.getElementById('btnProfile').textContent = initial;
    document.getElementById('popoverAvatar').textContent = initial;
    document.getElementById('popoverName').textContent = name;
    document.getElementById('popoverHandle').textContent = displayKey;
    document.getElementById('popoverRole').textContent = user.role === 'admin' ? 'Admin' : 'User';
    document.getElementById('popoverStatus').textContent = user.status === 'active' ? 'Active' : user.status;
    document.getElementById('popoverExpiry').textContent = user.expiry
      ? 'Expires ' + new Date(user.expiry).toLocaleDateString()
      : 'Never';
    document.getElementById('settingsEmailDisplay').textContent = user.key || user.email || '—';
    try {
      var lic = user.key || user.email || '';
      var elLic = document.getElementById('settingsLicenseDisplay');
      if (elLic) elLic.value = lic;
      var elType = document.getElementById('settingsKeyType');
      if (elType) elType.value = (user.key_type || (user.role === 'admin' ? 'admin' : 'standard')).toUpperCase();
      var elExp = document.getElementById('settingsExpiry');
      if (elExp) {
        if (user.expiry) {
          elExp.value = Auth.getExpiryCountdown ? Auth.getExpiryCountdown(user.expiry) : new Date(user.expiry).toLocaleString();
        } else {
          elExp.value = 'Lifetime / Lifetime';
        }
      }
      var elSess = document.getElementById('settingsSession');
      if (elSess) {
        var left = (user.expiresAt || 0) - Date.now();
        if (left > 0) {
          var h = Math.floor(left / 3600000);
          var m = Math.floor((left % 3600000) / 60000);
          elSess.value = h + 'h ' + m + 'm remaining';
        } else {
          elSess.value = 'Active';
        }
      }
      var elName = document.getElementById('setDisplayName');
      if (elName) elName.value = user.name || '';
    } catch (e) {}
    var ef = document.getElementById('setEmailField'); if (ef) ef.value = '';
  }

  /* ════════════════════════════════════════
     APP UI — drawer, tabs, theme, profile
     ════════════════════════════════════════ */
  function bindAppUI() {
    var burger = document.getElementById('btnBurger');
    var drawer = document.getElementById('drawer');
    var overlay = document.getElementById('drawerOverlay');
    var closeBtn = document.getElementById('btnDrawerClose');

    function openDrawer() {
      if (drawer) drawer.classList.add('open');
      if (overlay) overlay.classList.add('open');
    }
    function closeDrawer() {
      if (drawer) drawer.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
    }

    if (burger) burger.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (overlay) overlay.addEventListener('click', closeDrawer);

    document.querySelectorAll('.drawer-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var tab = item.getAttribute('data-tab');
        if (!tab) return;
        try { switchTab(tab); } catch (err) { console.error('switchTab', err); }
        closeDrawer();
      });
    });

    document.getElementById('btnLogout').addEventListener('click', function () {
      try {
        if (Auth && Auth.logout) Auth.logout();
        else if (Auth && Auth.clearSession) Auth.clearSession();
      } catch (e) {}
      try { localStorage.removeItem('__yush_session_v3__'); } catch (e2) {}
      try { localStorage.removeItem('__yush_session_v2__'); } catch (e3) {}
      try { localStorage.removeItem('__yush_remembered_license__'); } catch (e4) {}
      try { document.documentElement.classList.remove('yush-authed'); } catch (e5) {}
      var ao = document.getElementById('authOverlay');
      var ma = document.getElementById('mainApp');
      if (ao) ao.style.display = '';
      if (ma) ma.style.display = 'none';
      if (window.showLogin) window.showLogin();
      /* Hard reload → back to clean login screen */
      setTimeout(function () {
        location.replace(location.pathname + location.search + (location.search ? '&' : '?') + '_logout=' + Date.now());
      }, 30);
    });

    // Profile popover
    var profileBtn = document.getElementById('btnProfile');
    var popover = document.getElementById('profilePopover');
    profileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var visible = popover.style.display !== 'none';
      closeAllPopups();
      popover.style.display = visible ? 'none' : '';
    });
    document.getElementById('btnManageAccount').addEventListener('click', function () {
      closeAllPopups();
      switchTab('settings');
    });

    // Notifications
    var notifBtn = document.getElementById('btnNotif');
    var notifDrop = document.getElementById('notifDropdown');
    notifBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var visible = notifDrop.style.display !== 'none';
      closeAllPopups();
      if (!visible) {
        renderNotifs();
        notifDrop.style.display = '';
        updateNotifBadge();
      }
    });

    // Mark all read
    var markAllBtn = document.getElementById('btnMarkNotifsRead');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        // Clear = delete all notifications
        if (Auth && Auth.clearNotifs) Auth.clearNotifs();
        else if (Auth && Auth.markNotifsRead) Auth.markNotifsRead();
        updateNotifBadge();
        renderNotifs();
      });
    }

    // Open dashboard from notif panel
    var openDashBtn = document.getElementById('btnNotifOpenDash');
    if (openDashBtn) {
      openDashBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeAllPopups();
        switchTab('dashboard');
      });
    }

    // Theme toggle
    document.getElementById('btnTheme').addEventListener('click', toggleTheme);
    // Restore theme
    if (localStorage.getItem('__yush_theme__') === 'light') {
      document.body.classList.add('light');
      updateThemeIcons(true);
    }

    // Close popups on outside click
    document.addEventListener('click', function () {
      closeAllPopups();
    });
    popover.addEventListener('click', function (e) { e.stopPropagation(); });
    notifDrop.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function closeAllPopups() {
    document.getElementById('profilePopover').style.display = 'none';
    document.getElementById('notifDropdown').style.display = 'none';
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    document.querySelectorAll('.drawer-item').forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-tab') === tab);
    });
    var titles = {
      dashboard: 'Dashboard',
      updater: 'Offset Updater',
      finder: 'Offset Finder',
      hook: 'Hook Builder',
      dummy: 'Dummy Detector',
      converter: 'Bypass Formatting',
      developer: 'Developer',
      terms: 'Terms of Service',
      privacy: 'Privacy Policy',
      settings: 'Settings',
      admin: 'Admin Panel'
    };
    document.getElementById('topbarTitle').textContent = titles[tab] || tab;
    if (tab === 'admin') renderAdminPanel();
    if (tab === 'dashboard') refreshDashboard();
    if (tab === 'finder') { try { updateFinderSummary(finderResults); setFindStatus(finderParsed.length ? 'ready' : 'ready'); } catch (e) {} }
  }

  function toggleTheme() {
    var isLight = document.body.classList.toggle('light');
    localStorage.setItem('__yush_theme__', isLight ? 'light' : 'dark');
    updateThemeIcons(isLight);
    // Update turnstile theme if present
    var tw = document.querySelector('.cf-turnstile');
    if (tw) tw.setAttribute('data-theme', isLight ? 'light' : 'dark');
  }
  function updateThemeIcons(isLight) {
    document.querySelector('.theme-icon-dark').style.display = isLight ? 'none' : '';
    document.querySelector('.theme-icon-light').style.display = isLight ? '' : 'none';
  }

  function updateNotifBadge() {
    var notifs = Auth.getNotifications() || [];
    // Permanently drop registration-request noise
    var cleaned = notifs.filter(function (n) {
      var m = String(n.message || n.title || '');
      return !/registration request/i.test(m) && !/^New registration/i.test(m);
    });
    if (cleaned.length !== notifs.length && Auth && Auth.clearNotifs) {
      try {
        // rewrite without those entries
        if (Auth.deleteNotification) {
          notifs.forEach(function (n) {
            var m = String(n.message || n.title || '');
            if (/registration request/i.test(m) || /^New registration/i.test(m)) {
              Auth.deleteNotification(n.id);
            }
          });
        }
      } catch (e) {}
      notifs = cleaned;
    }
    var unread = notifs.filter(function (n) { return !n.read; }).length;
    var badge = document.getElementById('notifBadge');
    if (unread > 0) {
      badge.textContent = unread > 9 ? '9+' : unread;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderNotifs() {
    var list = document.getElementById('notifList');
    var notifs = (Auth.getNotifications() || []).filter(function (n) {
      var m = String(n.message || n.title || '');
      // Hide registration-request spam
      if (/registration request/i.test(m)) return false;
      if (/^New registration/i.test(m)) return false;
      return true;
    });
    var unreadCount = notifs.filter(function(n){ return !n.read; }).length;
    var pill = document.getElementById('notifCountPill');
    if (pill) pill.textContent = String(unreadCount);

    if (!notifs.length) {
      list.innerHTML = '<div class="notif-empty"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg><div>No Notification</div></div>';
      return;
    }

    var typeColors = { info:'#3b82f6', warning:'#f59e0b', success:'#22c55e', danger:'#ef4444', announcement:'#8b5cf6', expiry:'#f59e0b', approved:'#22c55e' };

    list.innerHTML = notifs.slice(0, 30).map(function (n) {
      var t = formatPHTime(n.time);
      var color = typeColors[n.annType || n.type] || '#8b5cf6';
      var dot = !n.read ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#8b5cf6;margin-left:4px;vertical-align:middle"></span>' : '';
      return '<div class="notif-item" data-notif-id="' + n.id + '" style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);background:' + (!n.read ? 'rgba(139,92,246,0.06)' : 'transparent') + '">' +
        '<div style="width:3px;min-height:32px;border-radius:2px;background:' + color + ';flex-shrink:0;margin-top:2px"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;color:var(--text1);line-height:1.4;word-break:break-word">' + esc(n.message) + dot + '</div>' +
          '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + t + '</div>' +
        '</div>' +
        (!n.read ? '<button data-mark-one="' + n.id + '" title="Mark as read" style="flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--text3);padding:2px 4px;font-size:10px;border-radius:4px">&#10003;</button>' : '') +
      '</div>';
    }).join('');

    list.querySelectorAll('[data-mark-one]').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-mark-one');
        if (Auth && Auth.markNotifRead) Auth.markNotifRead(id);
        updateNotifBadge();
        renderNotifs();
      };
    });
  }

  /* ════════════════════════════════════════
     OFFSET UPDATER
     ════════════════════════════════════════ */

  function fmtSz(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }





  function bindUpdater() {
    function fmtSz(b) {
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      return (b / 1048576).toFixed(2) + ' MB';
    }
    function fileType(name) {
      var dot = name.lastIndexOf('.');
      var ext = dot > -1 ? name.slice(dot + 1).toLowerCase() : '';
      var map = { cs:'C# Source', cpp:'C++ Source', h:'C++ Header', hpp:'C++ Header', lua:'Lua Script', txt:'Text File' };
      return map[ext] || 'Source File';
    }
    function onFile(id, inp) {
      var f = inp.files && inp.files[0];
      if (!f) return;
      S[id] = f;
      if (id === 'tgt') S.sources = [f];
      var fd = document.getElementById('fd-' + id);
      var txt = document.getElementById('fd-' + id + '-txt');
      if (txt) txt.textContent = f.name;
      if (fd) fd.classList.add('has-file');
      var fp = document.getElementById('fp-' + id);
      var fpn = document.getElementById('fpn-' + id);
      var fpm = document.getElementById('fpm-' + id);
      if (fpn) fpn.textContent = f.name;
      if (fpm) fpm.textContent = fmtSz(f.size) + ' · ' + fileType(f.name);
      if (fp) { fp.classList.add('show'); fp.classList.add('has-file'); }
      checkReady();
    }
    window.yushPick = function (id) {
      var el = document.getElementById('f-' + id);
      if (el) el.click();
    };
    ['old', 'new', 'tgt'].forEach(function (id) {
      var el = document.getElementById('f-' + id);
      if (el) el.addEventListener('change', function () { onFile(id, el); });
    });
    var exec = document.getElementById('btnExec');
    if (exec) exec.addEventListener('click', runPipeline);
    var dl = document.getElementById('btnDownload');
    if (dl) dl.addEventListener('click', doDownload);
    var go = document.getElementById('btnDashGoUpdater');
    if (go) go.addEventListener('click', function () { switchTab('updater'); });
    checkReady();
  }

  function renderSourceList() {
    var list = document.getElementById('sourceFileList');
    var info = document.getElementById('runFileName');
    if (!S.sources || !S.sources.length) {
      if (list) list.innerHTML = '';
      if (info) info.textContent = 'No file selected';
      return;
    }
    if (list) {
      list.innerHTML = S.sources.map(function (f) {
        var ext = (f.name.split('.').pop() || '').toLowerCase();
        var colorCls = 'src-ext-default';
        if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') colorCls = 'src-ext-cpp';
        else if (ext === 'h' || ext === 'hpp' || ext === 'hh') colorCls = 'src-ext-h';
        else if (ext === 'c') colorCls = 'src-ext-c';
        else if (ext === 'cs') colorCls = 'src-ext-cs';
        else if (ext === 'lua') colorCls = 'src-ext-lua';
        return '<div class="source-file-item ' + colorCls + '"><span class="src-ready">' + fmtSz(f.size) + ' is ready</span></div>';
      }).join('');
    }
    if (info) {
      var f = S.sources[0];
      info.textContent = f.name + (S.sources.length > 1 ? ' (+' + (S.sources.length - 1) + ' more)' : '');
    }
  }

  function checkReady() {
    var ready = !!(S.old && S['new'] && S.tgt);
    var btn = document.getElementById('btnExec');
    if (btn) btn.disabled = !ready;
  }

  function setPill(state) {
    document.querySelectorAll('.pill').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-pill') === state);
    });
  }



  function setProgress(pct) {
    var fill = document.getElementById('progressFill');
    if (fill) fill.style.width = pct + '%';
    /* show/hide is now fully controlled by progressWrap.classList — don't auto-hide here */
  }

  function readAB(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function (e) { res(e.target.result); };
      r.onerror = function () { rej(r.error); };
      r.readAsArrayBuffer(f);
    });
  }

  function updateStats() {
    var el;
    el = document.getElementById('sok'); if (el) el.textContent = R.updated.length;
    el = document.getElementById('sfail'); if (el) el.textContent = R.failed.length;
    el = document.getElementById('sign'); if (el) el.textContent = R.ignored.length;
    el = document.getElementById('ssame'); if (el) el.textContent = R.same.length;
    el = document.getElementById('stotal'); if (el) el.textContent = R.all.length;
  }

  function recordJob(ok) {
    try {
      var jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]');
      jobs.push({ t: Date.now(), ok: !!ok, updated: R.updated.length, total: R.all.length });
      if (jobs.length > 200) jobs = jobs.slice(-200);
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
    } catch (e) {}
  }

  function refreshDashboard() {
    var user = Auth.getCurrentUser();
    var welcome = document.getElementById('dashWelcome');
    if (welcome && user) welcome.textContent = 'Welcome back, ' + (user.name || Auth.nameFromEmail(user.key || user.email));
    var users = Auth.getUsers();
    var accounts = Object.keys(users).length + 1; // + owner
    var jobs = [];
    try { jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch (e) {}
    var completed = jobs.filter(function (j) { return j.ok; }).length;
    var review = jobs.filter(function (j) { return !j.ok; }).length;
    var totalOff = jobs.reduce(function (s, j) { return s + (j.total || 0); }, 0);
    var updatedOff = jobs.reduce(function (s, j) { return s + (j.updated || 0); }, 0);
    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    set('dashAccounts', accounts);
    set('dashCompleted', completed);
    set('dashReview', review);
    set('dashJobsOk', completed);
    set('dashJobsRev', review);
    set('dashJobsTotal', jobs.length);
    set('dashTracked', totalOff || updatedOff || 0);
    set('dashRva', Math.round((totalOff || 0) * 0.55));
    set('dashField', Math.round((totalOff || 0) * 0.45));
    var success = jobs.length ? Math.round((completed / jobs.length) * 100) : 0;
    set('dashSuccess', success + '%');
    set('dashReadyPct', success + '%');
    set('dashActiveUsers', accounts);
    set('dashPulseCount', completed + ' completed updates');
    var fill = document.querySelector('.dash-bar-fill');
    if (fill) fill.style.width = success + '%';

    // My account section
    if (user) {
      set('dashMyEmail', user.key || user.email || '—');
      set('dashMyRole', user.role === 'admin' ? 'Admin' : 'User');
      var myStatus = String(user.status || 'active');
      var myStatusEl = document.getElementById('dashMyStatus');
      if (myStatusEl) {
        myStatusEl.textContent = myStatus.charAt(0).toUpperCase() + myStatus.slice(1);
        myStatusEl.style.color = myStatus === 'active' ? 'var(--green)' : myStatus === 'banned' ? 'var(--red)' : 'var(--yellow)';
      }
      set('dashMyExpiry', user.expiry ? new Date(user.expiry).toLocaleDateString() : 'Never');
      set('dashMyJobs', jobs.length);
    }

    // All users overview list
    var userListEl = document.getElementById('dashUserList');
    if (userListEl) {
      var userKeys = Object.keys(users);
      if (userKeys.length === 0) {
        userListEl.innerHTML = '<div class="admin-empty" style="padding:20px;text-align:center;color:var(--text3);font-size:13px">No registered users yet.</div>';
      } else {
        var html = userKeys.map(function (email) {
          var u = users[email] || {};
          var st = String(u.status || u.role || 'pending').toLowerCase();
          var isActive = st === 'active' || st === 'approved';
          var isBanned = st === 'banned' || st === 'blocked' || u.banned === true;
          var isPending = st === 'pending';
          var isAdmin = st === 'admin' || u.role === 'admin';
          var statusColor = isActive ? 'var(--green)' : isBanned ? 'var(--red)' : isPending ? 'var(--yellow)' : 'var(--cyan)';
          var statusLabel = isAdmin ? 'Admin' : isActive ? 'Active' : isBanned ? 'Banned' : isPending ? 'Pending' : (st.charAt(0).toUpperCase() + st.slice(1));
          var initial = email.charAt(0).toUpperCase();
          var name = u.name || email.split('@')[0];
          return '<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;' +
            'border:1px solid var(--border);margin-bottom:6px;background:var(--bg-input);">' +
            '<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#6d28d9);' +
            'display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;flex-shrink:0">' + initial + '</div>' +
            '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(name) + '</div>' +
            '<div style="font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(email) + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">' +
            '<span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;background:rgba(139,92,246,0.12);color:var(--primary)">' +
            (u.role === 'admin' ? 'ADMIN' : 'USER') + '</span>' +
            '<span style="font-size:10px;font-weight:700;color:' + statusColor + '">' + statusLabel + '</span>' +
            '</div></div>';
        }).join('');
        userListEl.innerHTML = html;
      }
    }

    // Banned: users (status/role banned) + blocked IPs + banned emails
    var bannedUsers = 0;
    try {
      Object.keys(users).forEach(function (email) {
        var u = users[email] || {};
        var st = String(u.status || u.role || '').toLowerCase();
        if (st === 'banned' || st === 'blocked' || u.banned === true) bannedUsers++;
      });
    } catch (e) {}
    fetch(yushApi('api/security-events.json'), { headers: yushAdminHeaders(), credentials: 'same-origin' }).catch(function(){ return { ok:false, json: function(){ return Promise.resolve({ok:false, events:[]}); } }; })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var ips = (data && data.blockedIps) ? data.blockedIps.length : 0;
        var total = bannedUsers + ips;
        set('dashBanned', total);
        set('dashBanned2', total);
      })
      .catch(function () {
        set('dashBanned', bannedUsers);
        set('dashBanned2', bannedUsers);
      });
  }

  function makeCard(r) {
    var bt = r.status === 'updated' ? 'UPDATED' : r.status === 'failed' ? 'FAILED' : r.status === 'ignored' ? 'IGNORED' : 'LATEST';
    var copyAttr = SETTINGS.copyEnabled ? ' onclick="window._copyHex(this)"' : '';
    var copyCls = SETTINGS.copyEnabled ? ' copy-hex' : '';
    var className = r.cls || '';
    var methodName = r.name || r.oldVal || '—';
    var typeBadge = (r.entryType === 'field' || /field/i.test(r.entryType || '')) ? 'FIELD' : (r.entryType === 'rva' ? 'METHOD' : (r.status === 'ignored' ? 'BARE HEX' : 'METHOD'));

    var icoFolder = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
    var icoBox = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    var icoPin = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>';

    var topHtml = '<div class="yush-r-top">' +
      '<span class="yush-r-badge b-' + r.status + '">' + bt + '</span>' +
      '<span class="yush-r-type">' + typeBadge + '</span>' +
    '</div>';

    // Class / method rows (only when we have class info)
    var metaHtml = '';
    if (className) {
      metaHtml +=
        '<div class="yush-r-ns-row"><span class="yush-r-ico">' + icoFolder + '</span><span class="yush-r-row-label">Class:</span> <span class="yush-r-cls-val">' + esc(className) + '</span></div>' +
        '<div class="yush-r-cls-row"><span class="yush-r-ico">' + icoBox + '</span><span class="yush-r-row-label">Method:</span> <span class="yush-r-ns-val">' + esc(methodName) + '</span></div>';
    }

    // NO signature line (FQN removed)

    // Signature-style line removed per request

    // Offset / hex block
    var offHtml = '';
    if (r.status === 'updated') {
      offHtml =
        '<div class="yush-r-hex-row">' +
          '<div class="yush-r-hex-side old"><span class="yush-r-hex-lbl">OLD</span><span class="yush-r-hex-val old' + copyCls + '" data-hex="' + esc(r.oldVal) + '"' + copyAttr + '>' + esc(r.oldVal) + '</span></div>' +
          '<div class="yush-r-hex-arrow">→</div>' +
          '<div class="yush-r-hex-side new"><span class="yush-r-hex-lbl">NEW</span><span class="yush-r-hex-val new' + copyCls + '" data-hex="' + esc(r.newVal) + '"' + copyAttr + '>' + esc(r.newVal) + '</span></div>' +
        '</div>';
    } else {
      var offColor = r.status === 'failed' ? 'failed' : r.status === 'ignored' ? 'ignored' : '';
      offHtml =
        '<div class="yush-r-bottom">' +
          '<div class="yush-r-off-line">' +
            '<span class="yush-r-ico">' + icoPin + '</span>' +
            '<span class="yush-r-row-label">Offset:</span> <span class="yush-r-off-single ' + offColor + copyCls + '" data-hex="' + esc(r.oldVal) + '"' + copyAttr + '>' + esc(r.oldVal) + '</span>' +
          '</div>' +
        '</div>';
    }

    var reasonHtml = (r.status === 'failed' && r.reason)
      ? '<div class="yush-r-reason">' + esc(r.reason) + '</div>' : '';

    return '<div class="yush-r-card c-' + r.status + '">' +
      topHtml +
      metaHtml +
      offHtml +
      reasonHtml +
    '</div>';
  }

  window._copyHex = function (el) {
    var val = el.getAttribute('data-hex') || el.textContent;
    var mark = function () {
      el.classList.add('copied');
      setTimeout(function () { el.classList.remove('copied'); }, 900);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(mark, function () { fallbackCopy(val, mark); });
    } else {
      fallbackCopy(val, mark);
    }
  };

  function fallbackCopy(text, cb) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (cb) cb();
  }

  function renderResults() {
    // Only show the updated group in the output cards
    var sec = document.getElementById('sec-updated');
    var cont = document.getElementById('cards-updated');
    var ctr = document.getElementById('sc-updated');
    ['sec-same','sec-failed','sec-ignored'].forEach(function(id){
      var el = document.getElementById(id); if(el) el.style.display='none';
    });
    if (!sec) return;
    if (!R.updated || !R.updated.length) { sec.style.display = 'none'; return; }
    if (ctr) ctr.textContent = R.updated.length + ' offset' + (R.updated.length !== 1 ? 's' : '');
    var html = '';
    R.updated.forEach(function (r) { html += makeCard(r); });
    if (cont) cont.innerHTML = html;
    sec.style.display = 'block';
    document.getElementById('resultsWrap').style.display = '';
  }


  /* Animated progress: smoothly ticks toward a target at ~0.1%/100ms */
  var _progTarget = 0;
  var _progCurrent = 0;
  var _progTimer = null;
  function startProgressAnimation() {
    if (_progTimer) return;
    _progTimer = setInterval(function () {
      if (_progCurrent < _progTarget) {
        /* Close gap by 8% each tick — feels snappy, never outpaces real work */
        var gap = _progTarget - _progCurrent;
        _progCurrent = Math.min(_progCurrent + Math.max(gap * 0.18, 0.8), _progTarget);
        setProgress(_progCurrent);
      }
    }, 60);
  }
  function stopProgressAnimation() {
    if (_progTimer) { clearInterval(_progTimer); _progTimer = null; }
  }
  function setProgressTarget(pct) {
    /* Progress only moves forward — never jump backward while updating */
    if (pct > _progTarget) _progTarget = pct;
    /* Cap at 99 until done so the bar reaches 100 only on finish */
    if (_progTarget > 99) _progTarget = 99;
  }
  function snapProgress(pct) {
    _progTarget = pct; _progCurrent = pct; setProgress(pct);
  }

  async function runPipeline() {
    if (!S.old || !S['new'] || !S.tgt) return;
    var now = Date.now();
    if (now - _lastRunAt < RUN_COOLDOWN_MS) return;
    _lastRunAt = now;

    document.getElementById('btnExec').disabled = true;
    document.getElementById('btnLabel').textContent = 'Processing…';
    var pw = document.getElementById('progressWrap');
    if (pw) pw.classList.add('show');
    var dlWrap = document.getElementById('dlWrap');
    if (dlWrap) dlWrap.style.display = 'none';
    var rw = document.getElementById('resultsWrap');
    if (rw) rw.style.display = 'none';
    setPill('processing');
    snapProgress(0);
    startProgressAnimation();
    setProgressTarget(5);

    var oldBuf, newBuf, tgtBuf;
    try {
      oldBuf = await readAB(S.old);
      newBuf = await readAB(S['new']);
      tgtBuf = await readAB(S.tgt);
      setProgressTarget(20);
    } catch (err) {
      setPill('error');
      alert('Failed to read files: ' + (err.message || err));
      resetExecBtn();
      return;
    }

    if (_worker) { _worker.terminate(); _worker = null; }
    _worker = new Worker('js/updater.js?v=local');

    _worker.onmessage = function (e) {
      var d = e.data;
      if (d.type === 'progress') {
        setProgressTarget(20 + (d.pct || 0) * 0.75);
        return;
      }
      if (d.type === 'result' || d.type === 'done') {
        _worker.terminate(); _worker = null;
        var raw = d.results || {};
        R = {
          updated: raw.updated || [],
          failed: raw.failed || [],
          ignored: raw.ignored || [],
          same: raw.same || [],
          all: []
        };
        R.all = R.updated.concat(R.failed, R.ignored, R.same);
        _updatedText = d.updatedText || null;
        stopProgressAnimation();
        snapProgress(100);
        updateStats();
        setPill('completed');
        renderResults();
        recordJob(true);
        try { refreshDashboard(); } catch (e2) {}
        if (R.updated.length) {
          if (dlWrap) dlWrap.style.display = '';
          if (SETTINGS.autoDownload) doDownload();
        }
        resetExecBtn();
        return;
      }
      if (d.type === 'error') {
        _worker.terminate(); _worker = null;
        stopProgressAnimation();
        setPill('error');
        recordJob(false);
        alert('Error: ' + (d.message || 'Unknown'));
        resetExecBtn();
      }
    };
    _worker.onerror = function (err) {
      if (_worker) { _worker.terminate(); _worker = null; }
      stopProgressAnimation();
      setPill('error');
      recordJob(false);
      alert('Worker error: ' + (err.message || 'Unknown'));
      resetExecBtn();
    };
    _worker.postMessage({ oldBuf: oldBuf, newBuf: newBuf, tgtBuf: tgtBuf }, [oldBuf, newBuf, tgtBuf]);
  }

  function resetExecBtn() {
    document.getElementById('btnExec').disabled = false;
    document.getElementById('btnLabel').textContent = 'Start Update';
    /* Hide progress bar after a short delay so 100% is visible */
    setTimeout(function() {
      var pw = document.getElementById('progressWrap');
      if (pw) pw.classList.remove('show');
      /* reset bar back to 0 silently for next run */
      setTimeout(function() { snapProgress(0); }, 300);
    }, 600);
  }

  function _crc32(bytes) {
    var table = window.__crcTable;
    if (!table) {
      table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
      }
      window.__crcTable = table;
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function _u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function _u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function _joinBytes(parts) {
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  function makeZip(entries) {
    var enc = new TextEncoder(), local = [], central = [], offset = 0;
    entries.forEach(function (entry) {
      var name = enc.encode(entry.name);
      var data = entry.data;
      var crc = _crc32(data);
      var localHeader = _joinBytes([
        _u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0),
        _u32(crc), _u32(data.length), _u32(data.length), _u16(name.length), _u16(0), name
      ]);
      local.push(localHeader, data);
      var centralHeader = _joinBytes([
        _u32(0x02014b50), _u16(20), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0),
        _u32(crc), _u32(data.length), _u32(data.length), _u16(name.length), _u16(0),
        _u16(0), _u16(0), _u16(0), _u32(0), _u32(offset), name
      ]);
      central.push(centralHeader);
      offset += localHeader.length + data.length;
    });
    var centralSize = 0;
    central.forEach(function (c) { centralSize += c.length; });
    var end = _joinBytes([
      _u32(0x06054b50), _u16(0), _u16(0), _u16(entries.length), _u16(entries.length),
      _u32(centralSize), _u32(offset), _u16(0)
    ]);
    return _joinBytes(local.concat(central).concat([end]));
  }

  function doDownload() {
    if (!_updatedText || !S.tgt) return;
    var targetName = S.tgt.name || 'updated_file.txt';
    var logsText = buildUpdateLogs();

    if (typeof JSZip === 'undefined') {
      // Fallback: plain file download if JSZip not loaded
      var blob = new Blob([_updatedText], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = targetName;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 15000);
      return;
    }

    var zip = new JSZip();
    zip.file(targetName, _updatedText);
    zip.file('Logs.txt', logsText);

    zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      .then(function (zipBlob) {
        var zipName = targetName.replace(/\.[^.]+$/, '') + '_updated.zip';
        var a = document.createElement('a');
        a.href = URL.createObjectURL(zipBlob);
        a.download = zipName;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 15000);
      });
  }

  function buildUpdateLogs() {
    var lines = [];
    lines.push('YUSH TOOLS — Update Log');
    lines.push('Target: ' + (S.tgt ? S.tgt.name : 'unknown'));
    lines.push('Total offsets: ' + R.all.length);
    lines.push('Updated: ' + R.updated.length);
    lines.push('Failed: ' + R.failed.length);
    lines.push('Ignored: ' + R.ignored.length);
    lines.push('Same: ' + R.same.length);
    lines.push('');
    R.all.forEach(function (r) {
      lines.push('[' + r.status.toUpperCase() + '] ' + (r.cls || '') + ' :: ' + (r.name || '') + '  ' + (r.oldVal || '') + (r.newVal ? ' → ' + r.newVal : ''));
    });
    return lines.join('\n');
  }

  /* ════════════════════════════════════════
     OFFSET FINDER
     ════════════════════════════════════════ */
  var finderParsed = [];
  var finderResults = [];
  var finderFilter = 'all';

  var MODS = new Set(['public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'abstract', 'sealed', 'new', 'extern', 'unsafe', 'readonly']);

  function extractOffset(line) {
    var mOff = line.match(/Offset:\s*(0x[0-9A-Fa-f]+)/i);
    if (mOff) return mOff[1];
    var mRva = line.match(/RVA:\s*(0x[0-9A-Fa-f]+)/i);
    if (mRva) return mRva[1];
    var mAny = line.match(/0x[0-9A-Fa-f]{5,}/);
    return mAny ? mAny[0] : null;
  }

  function extractRva(line) {
    var m = line.match(/RVA:\s*(0x[0-9A-Fa-f]+)/i);
    return m ? m[1] : null;
  }

  function extractTypeDefIndex(line) {
    var m = line.match(/TypeDefIndex:\s*(\d+)/i);
    return m ? m[1] : null;
  }

  function extractMethodName(sig) {
    var m = sig.match(/([A-Za-z_][\w]*)\s*\(/);
    return m ? m[1] : '';
  }

  function extractFieldName(sig) {
    var cleaned = sig.replace(/\/\/.*$/, '').trim();
    var m = cleaned.match(/([A-Za-z_][\w]*)\s*[;=]/);
    return m ? m[1] : '';
  }

  function newSS() { return { stack: [], depth: 0, namespace: '', pending: null, typeDefIndex: null }; }

  function updScope(s, line) {
    var ns = line.match(/^\s*\/\/\s*[Nn]amespace:\s*(.+?)\s*$/);
    if (ns) { s.namespace = ns[1].trim(); return; }
    var tdi = extractTypeDefIndex(line);
    if (tdi) { s.typeDefIndex = tdi; }
    if (!s.pending) {
      var dm = line.match(/(?:^|\s|[^\w])(?:class|struct|interface|enum)\s+([\w<>.]+)/);
      if (dm) s.pending = dm[1];
    }
    if (line.indexOf('{') === -1 && line.indexOf('}') === -1) return;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '{') {
        s.depth++;
        if (s.pending) {
          s.stack.push({ name: s.pending, baseDepth: s.depth, typeDefIndex: s.typeDefIndex || null });
          s.pending = null;
        }
      } else if (ch === '}') {
        var top = s.stack[s.stack.length - 1];
        if (top && s.depth === top.baseDepth) s.stack.pop();
        s.depth = Math.max(0, s.depth - 1);
      }
    }
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    var k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function fLog(msg, color) {
    // legacy no-op (console removed)
  }

  function setFindStatus(st) {
    var row = document.getElementById('findStatusRow');
    if (!row) return;
    row.querySelectorAll('.pill').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-st') === st);
    });
  }

  function updateFinderSummary(base) {
    var card = document.getElementById('finderSummaryCard');
    if (card) card.style.display = '';
    var methods = (base || []).filter(function (r) { return r.type === 'method'; }).length;
    var fields = (base || []).filter(function (r) { return r.type === 'field'; }).length;
    var el;
    el = document.getElementById('finderStatFound'); if (el) el.textContent = (base || []).length;
    el = document.getElementById('finderStatMethods'); if (el) el.textContent = methods;
    el = document.getElementById('finderStatFields'); if (el) el.textContent = fields;
    el = document.getElementById('finderStatIndexed'); if (el) el.textContent = finderParsed.length;
    el = document.getElementById('finderSummaryTotal'); if (el) el.textContent = finderParsed.length;
    el = null;
    if (el) el.textContent = (document.getElementById('finderSearch') || {}).value || '—';
  }

  function renderFinderCards(base) {
    var wrap = document.getElementById('finderResultsWrap');
    var empty = document.getElementById('finderEmptyHint');
    var cont = document.getElementById('finderResultCards');
    var ctr = document.getElementById('finderResultCount');
    if (!base || !base.length) {
      if (wrap) wrap.style.display = 'none';
      if (empty) {
        empty.style.display = '';
        if (!finderParsed.length) empty.textContent = 'Load a dump.cs and search to see results here.';
        else empty.textContent = 'No results for this query.';
      }
      if (ctr) ctr.textContent = '';
      if (cont) cont.innerHTML = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (wrap) wrap.style.display = '';
    if (ctr) ctr.textContent = base.length + ' found';
    var slice = base.slice(0, 100);
    var html = '';
    slice.forEach(function (r) {
      var off = esc(r.offset || r.rva || '—');
      var ns = r.namespace ? esc(r.namespace) : 'Not Found';
      var cls = r.className ? esc(r.className) : 'Not Found';
      var nsCls = r.namespace ? '' : ' miss';
      var clsCls = r.className ? '' : ' miss';
      var tdi = r.typeDefIndex ? esc(String(r.typeDefIndex)) : '—';
      var rawSig = (r.signature || r.name || '').replace(/\s*\/\/\s*0x[0-9a-fA-F]+\s*$/, '').trim();
      var sig = esc(rawSig);
      var line = esc(String(r.lineNumber || '—'));
      var icoFolder = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';
      var icoBox = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
      var icoPin = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>';
      html += '<div class="finder-card">' +
        '<div class="finder-row ns' + nsCls + '">' +
          '<span class="finder-ico">' + icoFolder + '</span>' +
          '<span class="finder-k">Namespace:</span> <span class="finder-v">' + ns + '</span>' +
        '</div>' +
        '<div class="finder-row cls' + clsCls + '">' +
          '<span class="finder-ico">' + icoBox + '</span>' +
          '<span class="finder-k">Class:</span> <span class="finder-v">' + cls + '</span>' +
        '</div>' +
        '<div class="finder-tdi">TypeDefIndex: ' + tdi + '</div>' +
        '<div class="finder-sig">' + sig + '</div>' +
        '<div class="finder-line">Line: ' + line + '</div>' +
        '<div class="finder-bottom">' +
          '<div class="finder-off-line">' +
            '<span class="finder-ico">' + icoPin + '</span>' +
            '<span class="finder-k">Offset:</span> <span class="finder-off">' + off + '</span>' +
          '</div>' +
          '<button type="button" class="btn-copy-offset" data-hex="' + off + '">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
            'Copy' +
          '</button>' +
        '</div>' +
      '</div>';
    });
    if (base.length > 100) {
      html += '<div class="finder-empty">Showing first 100 of ' + base.length + '. Refine your search.</div>';
    }
    if (cont) cont.innerHTML = html;
    if (cont) {
      cont.querySelectorAll('.btn-copy-offset').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var hex = btn.getAttribute('data-hex') || '';
          if (!hex || hex === '—') return;
          navigator.clipboard.writeText(hex).then(function () {
            btn.classList.add('copied');
            var prev = btn.innerHTML;
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied';
            setTimeout(function () {
              btn.classList.remove('copied');
              btn.innerHTML = prev.indexOf('Copy') !== -1 && prev.indexOf('Copied') === -1
                ? prev
                : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
            }, 1400);
          }).catch(function () {});
        });
      });
    }
  }

  function loadFinderDumpFromFile(f) {
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result || '';
      var pathEl = document.getElementById('finderPathDisplay');
      if (pathEl) pathEl.textContent = f.name + ' · ' + formatFileSize(f.size);
      var state = newSS();
      var lines = text.split(/\r?\n/);
      var pendingMeta = null;
      var pendingFieldOff = null;
      finderParsed = [];
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        updScope(state, raw);
        var tr = raw.trim();
        if (!tr) continue;

        var fo = tr.match(/\[FieldOffset\(\s*"?(0x[0-9A-Fa-f]+)"?\s*\)\]/i);
        if (fo) {
          pendingFieldOff = fo[1];
          pendingMeta = null;
          continue;
        }

        if (tr.indexOf('//') === 0) {
          var off = extractOffset(tr);
          var rva = extractRva(tr);
          if (off || rva) {
            pendingMeta = {
              offset: off || rva,
              rva: rva || off,
              comment: tr,
              line: i + 1
            };
            pendingFieldOff = null;
          }
          continue;
        }

        var cls = state.stack.length ? state.stack[state.stack.length - 1].name : null;
        var tdi = null;
        if (state.stack.length && state.stack[state.stack.length - 1].typeDefIndex) {
          tdi = state.stack[state.stack.length - 1].typeDefIndex;
        } else {
          tdi = state.typeDefIndex;
        }

        if (pendingMeta) {
          var isM = tr.indexOf('(') !== -1 && tr.indexOf(')') !== -1;
          var name = isM ? extractMethodName(tr) : extractFieldName(tr);
          finderParsed.push({
            namespace: state.namespace || null,
            className: cls,
            signature: tr.replace(/\s*\{\s*\}\s*$/, '').trim(),
            name: name,
            lineNumber: i + 1,
            offset: pendingMeta.offset,
            rva: pendingMeta.rva,
            typeDefIndex: tdi || null,
            type: isM ? 'method' : 'field'
          });
          pendingMeta = null;
          continue;
        }

        if (pendingFieldOff) {
          var fname = extractFieldName(tr) || (tr.match(/(\w+)\s*[;=\[]/) || [])[1];
          if (fname) {
            finderParsed.push({
              namespace: state.namespace || null,
              className: cls,
              signature: tr.replace(/\s*\{\s*\}\s*$/, '').trim(),
              name: fname,
              lineNumber: i + 1,
              offset: pendingFieldOff,
              rva: pendingFieldOff,
              typeDefIndex: tdi || null,
              type: 'field'
            });
            pendingFieldOff = null;
          }
          continue;
        }

        // Inline: Type name; // 0x..
        var inline = tr.match(/^[^\(]+\s+(\w+)\s*;\s*\/\/\s*(0x[0-9A-Fa-f]+)/i);
        if (inline) {
          finderParsed.push({
            namespace: state.namespace || null,
            className: cls,
            signature: tr,
            name: inline[1],
            lineNumber: i + 1,
            offset: inline[2],
            rva: inline[2],
            typeDefIndex: tdi || null,
            type: 'field'
          });
        }
      }
      updateFinderSummary([]);
      setFindStatus('ready');
      var empty = document.getElementById('finderEmptyHint');
      if (empty) {
        empty.style.display = '';
        empty.textContent = 'Indexed ' + finderParsed.length + ' entries. Enter a method, field, class, or 0x offset.';
      }
      var wrap = document.getElementById('finderResultsWrap');
      if (wrap) wrap.style.display = 'none';
      var inp = document.getElementById('finderInput');
      if (inp) inp.value = '';
    };
    reader.readAsText(f, 'UTF-8');
  }

  function normalizeQuery(q) {
    q = String(q || '').trim();
    q = q.replace(/\{[\s\S]*\}$/, '').trim();
    // Prefer identifier right before '(' (method name)
    var m = q.match(/([A-Za-z_][\w]*)\s*\(/);
    if (m) {
      return {
        raw: q,
        key: m[1],
        full: q.toLowerCase().replace(/\s+/g, ' ').trim()
      };
    }
    // Bare identifier / offset / typedefindex
    return {
      raw: q,
      key: q.replace(/\s+/g, ''),
      full: q.toLowerCase().replace(/\s+/g, ' ').trim()
    };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function doFind() {
    var qEl = document.getElementById('finderSearch');
    var q = qEl ? qEl.value.trim() : '';
    if (!finderParsed.length) {
      setFindStatus('empty');
      updateFinderSummary([]);
      var empty = document.getElementById('finderEmptyHint');
      if (empty) { empty.style.display = ''; empty.textContent = 'Load a dump.cs file first.'; }
      renderFinderCards([]);
      return;
    }
    if (!q) {
      setFindStatus('empty');
      updateFinderSummary([]);
      var empty2 = document.getElementById('finderEmptyHint');
      if (empty2) { empty2.style.display = ''; empty2.textContent = 'Enter a method/field name or full signature.'; }
      renderFinderCards([]);
      return;
    }

    setFindStatus('searching');
    var nq = normalizeQuery(q);
    var key = (nq.key || '').toLowerCase();
    var full = nq.full || '';
    var isOffset = /^0x[0-9a-f]+$/i.test(key);
    var isTdi = /^\d+$/.test(key);
    var nameRe = null;
    try { nameRe = new RegExp('\\b' + escapeRe(key) + '\\b', 'i'); } catch (e) { nameRe = null; }

    var base = finderParsed.filter(function (r) {
      var name = (r.name || '').toLowerCase();
      var sig = (r.signature || '').toLowerCase().replace(/\s+/g, ' ').trim();
      var cls = (r.className || '').toLowerCase();
      var ns = (r.namespace || '').toLowerCase();
      var off = (r.offset || '').toLowerCase();
      var rva = (r.rva || '').toLowerCase();
      var tdi = String(r.typeDefIndex || '');

      // Offset / RVA search
      if (isOffset) {
        return off === key || rva === key || off.indexOf(key) !== -1 || rva.indexOf(key) !== -1;
      }
      // TypeDefIndex search
      if (isTdi) return tdi === key;

      // Exact method/field name (best)
      if (name && name === key) return true;

      // Whole-identifier match inside signature (not loose substring)
      if (nameRe && name && nameRe.test(name)) return true;
      if (nameRe && sig && nameRe.test(sig)) return true;

      // Full signature paste (normalized)
      if (full.length > 10 && sig) {
        var sigNoMods = sig.replace(/^(public|private|protected|internal|static|virtual|override|abstract|sealed|new|extern|unsafe|readonly)\s+/g, '');
        if (sig === full || sig.indexOf(full) !== -1 || full.indexOf(sig) !== -1) return true;
        if (sigNoMods === full || full.indexOf(sigNoMods) !== -1) return true;
      }

      // Class / namespace only when query looks like a type name (no parentheses in original)
      if (q.indexOf('(') === -1 && !isOffset && key.length > 2) {
        if (cls === key || ns === key) return true;
      }
      return false;
    });

    // Rank: exact name first, then same signature shape
    base.sort(function (a, b) {
      var an = (a.name || '').toLowerCase();
      var bn = (b.name || '').toLowerCase();
      var ar = an === key ? 0 : 1;
      var br = bn === key ? 0 : 1;
      if (ar !== br) return ar - br;
      return (a.lineNumber || 0) - (b.lineNumber || 0);
    });

    // All = methods + fields; Methods = methods only; Fields = fields only
    if (finderFilter === 'methods') base = base.filter(function (r) { return r.type === 'method'; });
    else if (finderFilter === 'fields') base = base.filter(function (r) { return r.type === 'field'; });
    // finderFilter === 'all' → keep both

    finderResults = base;
    updateFinderSummary(base);
    setFindStatus(base.length ? 'done' : 'empty');
    renderFinderCards(base);
  }

  function bindFinder() {
    var input = document.getElementById('finderInput');
    if (input) {
      input.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) loadFinderDumpFromFile(f);
      });
    }
    var btn = document.getElementById('btnFind');
    if (btn) btn.addEventListener('click', doFind);
    var search = document.getElementById('finderSearch');
    if (search) {
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doFind();
      });
    }
    document.querySelectorAll('.filter-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        finderFilter = chip.getAttribute('data-filter') || 'all';
        if (finderResults.length || finderParsed.length) doFind();
      });
    });
  }

  window._copyHex = function (el) {
    var hex = (el && (el.getAttribute('data-hex') || el.textContent)) || '';
    if (!hex) return;
    navigator.clipboard.writeText(hex).catch(function () {});
  };

  /* ════════════════════════════════════════
     SETTINGS
     ════════════════════════════════════════ */
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      SETTINGS = Object.assign({}, DEFAULT_SETTINGS, s);
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
  }

  function bindSettings() {
    var autoDl = document.getElementById('setAutoDownload');
    var copyEn = document.getElementById('setCopyEnabled');
    if (autoDl) autoDl.checked = !!SETTINGS.autoDownload;
    if (copyEn) copyEn.checked = SETTINGS.copyEnabled !== false;

    if (autoDl) autoDl.addEventListener('change', function () {
      SETTINGS.autoDownload = autoDl.checked;
      saveSettings();
    });
    if (copyEn) copyEn.addEventListener('change', function () {
      SETTINGS.copyEnabled = copyEn.checked;
      saveSettings();
    });

    /* Password / email change removed — license system only */
    var btnUpd = document.getElementById('btnUpdateAccount');
    if (btnUpd) btnUpd.addEventListener('click', function () {
      var user = Auth.getCurrentUser();
      if (!user) return;
      var nameVal = (document.getElementById('setDisplayName') && document.getElementById('setDisplayName').value || '').trim();
      var err = document.getElementById('accountError');
      if (!nameVal) {
        if (err) err.textContent = 'Enter a display name.';
        return;
      }
      var key = user.key || user.email;
      var res = Auth.updateName(key, nameVal);
      if (err) {
        err.style.color = 'var(--green)';
        err.textContent = res.ok ? 'Display name saved.' : (res.error || 'Failed');
      }
      if (res.ok) {
        user.name = nameVal;
        updateProfileUI(user);
        setTimeout(function () { if (err) { err.textContent = ''; err.style.color = ''; } }, 2500);
      }
    });
  }

  /* ════════════════════════════════════════
     LEGAL — TERMS OF SERVICE / PRIVACY POLICY
     ════════════════════════════════════════ */

  function fillLegalBodies() {
    var terms = document.getElementById('termsBody');
    var privacy = document.getElementById('privacyBody');
    if (terms && LEGAL_CONTENT.terms) terms.innerHTML = LEGAL_CONTENT.terms.html;
    if (privacy && LEGAL_CONTENT.privacy) privacy.innerHTML = LEGAL_CONTENT.privacy.html;
  }

  var LEGAL_UPDATED = 'September 13, 2026';

  var LEGAL_CONTENT = {
    terms: {
      title: 'Terms of Service',
      html:
        '<p class="legal-updated">Last updated: ' + LEGAL_UPDATED + '</p>' +
        '<p>These Terms of Service ("Terms") govern your access to and use of YUSH TOOLS ' +
        '(the "Service"), including the Offset Updater, Offset Finder, Dashboard, Admin Panel, ' +
        'and any related websites, APIs, or features operated under the yushtools domain. By ' +
        'creating an account, signing in, uploading files, or otherwise using the Service, you ' +
        'acknowledge that you have read, understood, and agree to be bound by these Terms. If you ' +
        'do not agree, you must not access or use the Service.</p>' +

        '<h4>1. Eligibility and Accounts</h4>' +
        '<p>You must be legally able to form a binding contract in your country of residence to ' +
        'use the Service. Account registration may require a valid email address and completion of ' +
        'security checks (including CAPTCHA or similar verification). You are responsible for ' +
        'keeping your login credentials confidential and for all activity under your account. ' +
        'Notify the operator immediately if you suspect unauthorized access. Accounts may remain ' +
        'subject to the operator access controls. The operator may refuse, suspend, or terminate ' +
        'accounts that violate these Terms or that pose a security risk.</p>' +

        '<h4>2. Description of the Service</h4>' +
        '<p>YUSH TOOLS provides client-side oriented utilities for working with game dump files ' +
        '(.cs and related source files), including searching methods/fields/offsets and synchronizing ' +
        'offsets between dump versions. Certain dump packages may be hosted on the server solely so ' +
        'authorized users can select a version without uploading large files themselves. Processing of ' +
        'your personal source files is designed to occur primarily in your browser. The Service is ' +
        'provided for legitimate reverse-engineering, learning, and development workflows consistent ' +
        'with applicable law.</p>' +

        '<h4>3. Acceptable Use</h4>' +
        '<p>You agree not to: (a) attempt to disrupt, overload, or interfere with the Service, ' +
        'including DDoS, scraping, or automated abuse; (b) reverse engineer, copy, clone, mirror, or ' +
        'redistribute the Service interface, branding, or server assets without permission; (c) upload ' +
        'malware, illegal content, or material you do not have rights to process; (d) bypass authentication, ' +
        'approval, rate limits, or security controls; (e) use another person\'s account without authorization; ' +
        '(f) use the Service in violation of game publisher terms, local law, or third-party rights. ' +
        'Violation may result in immediate suspension or permanent ban, and may be reported where required by law.</p>' +

        '<h4>4. Files, Dumps, and Intellectual Property</h4>' +
        '<p>You retain ownership of files you upload or process. By using the Service you grant only the ' +
        'limited technical permission needed to transmit, temporarily store (where applicable), and process ' +
        'those files to provide the requested feature. Dump packages published by administrators remain ' +
        'under the operator\'s control and may be replaced or removed at any time. YUSH TOOLS branding, ' +
        'UI design, scripts, and documentation are protected. You may not claim the Service as your own product.</p>' +

        '<h4>5. No Warranty</h4>' +
        '<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR ' +
        'IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. We do not ' +
        'guarantee uninterrupted uptime, perfect offset accuracy for every dump, or compatibility with every ' +
        'file format. Results depend on dump quality and your inputs. You use outputs at your own risk.</p>' +

        '<h4>6. Limitation of Liability</h4>' +
        '<p>To the maximum extent permitted by law, the operator and affiliates shall not be liable for any ' +
        'indirect, incidental, special, consequential, or punitive damages, or any loss of data, profits, or ' +
        'business arising from your use of the Service. Aggregate liability for any claim relating to the ' +
        'Service shall not exceed the amount you paid (if any) for access in the twelve months before the claim.</p>' +

        '<h4>7. Account Approval, Roles, and Termination</h4>' +
        '<p>Administrators may ban or delete ' +
        'accounts. You may stop using the Service at any time. We may suspend or terminate access for ' +
        'Terms violations, security incidents, inactivity, or operational reasons, with or without prior notice.</p>' +

        '<h4>8. Changes to the Service and Terms</h4>' +
        '<p>We may modify features, dump catalogs, or these Terms. Material changes may be indicated by ' +
        'updating the "Last updated" date. Continued use after changes constitutes acceptance of the revised Terms.</p>' +

        '<h4>9. Contact</h4>' +
        '<p>For account, legal, or security questions related to YUSH TOOLS, contact the developer through ' +
        'the official channels listed on the Developer page (including Telegram @PrimeYush where available).</p>'
    },
    privacy: {
      title: 'Privacy Policy',
      html:
        '<p class="legal-updated">Last updated: ' + LEGAL_UPDATED + '</p>' +
        '<p>This Privacy Policy explains how YUSH TOOLS ("we", "the Service") handles information when you ' +
        'use the website and tools. We aim to collect only what is needed to operate authentication, security, ' +
        'and core features.</p>' +

        '<h4>1. Information We Process</h4>' +
        '<p><b>Account data:</b> email address, password hash (not plaintext password), optional display name ' +
        'derived from email, role (for example free user or admin), and basic activity markers ' +
        'such as last login time or login count stored for account management.</p>' +
        '<p><b>Security data:</b> CAPTCHA/Turnstile tokens, approximate IP address for rate limiting and abuse ' +
        'prevention, browser user-agent, and similar request metadata used to detect bots, scrapers, and attacks.</p>' +
        '<p><b>Files you choose:</b> source files and dumps you select for Offset Updater or Offset Finder are ' +
        'primarily processed in your browser. Server-hosted dump packages uploaded by administrators are stored ' +
        'so users can select a version. We do not sell your personal source files.</p>' +
        '<p><b>Local device storage:</b> the Service may use browser localStorage or similar for session state, ' +
        '"remember me", UI preferences (theme), and client-side settings.</p>' +

        '<h4>2. How We Use Information</h4>' +
        '<p>We use information to: authenticate users; manage accounts; provide updater/finder features; ' +
        'protect the Service against DDoS, credential stuffing, scraping, cloning, and unauthorized access; diagnose ' +
        'errors; and communicate important service notices when necessary.</p>' +

        '<h4>3. Cookies and Similar Technologies</h4>' +
        '<p>Essential storage may be used for login sessions and preferences. Security widgets (such as Cloudflare ' +
        'Turnstile) may set their own cookies or tokens according to their policies. We do not use third-party ' +
        'advertising trackers as part of the core tool experience.</p>' +

        '<h4>4. Sharing</h4>' +
        '<p>We do not sell personal account data. Limited sharing may occur with infrastructure providers (hosting, ' +
        'CDN/WAF, email delivery for verification codes) solely to run the Service. We may disclose information if ' +
        'required by law or to protect the Service, users, or public safety.</p>' +

        '<h4>5. Retention</h4>' +
        '<p>Account records are retained while your account remains active and as needed for security logs. ' +
        'Administrator-uploaded dump packages remain until replaced or removed. Client-side local data remains on ' +
        'your device until you clear site data. Temporary upload chunks on the server are intended to be cleaned ' +
        'after assembly of a dump package.</p>' +

        '<h4>6. Security</h4>' +
        '<p>We implement reasonable technical measures such as HTTPS where configured, password hashing on the ' +
        'client account store model, CAPTCHA on login, rate limiting, bot filtering, and restricted direct access ' +
        'to dump storage. No method of transmission or storage is 100% secure; you use the Service at your own risk.</p>' +

        '<h4>7. Your Choices</h4>' +
        '<p>You may request account deletion by contacting the operator through official Developer channels. ' +
        'You can clear browser storage at any time. If email verification is enabled, providing an email is required ' +
        'to complete registration.</p>' +

        '<h4>8. Children</h4>' +
        '<p>The Service is not directed to children under 13 (or the minimum age required in your jurisdiction). ' +
        'We do not knowingly collect personal information from children.</p>' +

        '<h4>9. International Users</h4>' +
        '<p>The Service may be hosted in jurisdictions different from your own. By using the Service you understand ' +
        'that information may be processed in the country where the servers are located.</p>' +

        '<h4>10. Changes and Contact</h4>' +
        '<p>We may update this Privacy Policy by changing the "Last updated" date. For privacy questions, contact ' +
        'the developer via the channels listed on the Developer page.</p>'
    }
  };

  function openLegalModal(kind) {
    var entry = LEGAL_CONTENT[kind];
    if (!entry) return;
    var overlay = document.getElementById('legalModalOverlay');
    var titleEl = document.getElementById('legalModalTitle');
    var bodyEl = document.getElementById('legalModalBody');
    if (!overlay || !titleEl || !bodyEl) return;
    titleEl.textContent = entry.title;
    bodyEl.innerHTML = entry.html;
    bodyEl.scrollTop = 0;
    overlay.classList.add('open');
    document.body.classList.add('modal-open');
  }

  function closeLegalModal() {
    var overlay = document.getElementById('legalModalOverlay');
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('modal-open');
  }

  function bindLegalModal() {
    var btnTerms = document.getElementById('btnTerms');
    var btnPrivacy = document.getElementById('btnPrivacy');
    var overlay = document.getElementById('legalModalOverlay');
    var closeBtn = document.getElementById('legalModalClose');
    var box = document.getElementById('legalModalBox');
    if (btnTerms) btnTerms.addEventListener('click', function () { fillLegalBodies(); switchTab('terms'); });
    var exitT = document.getElementById('btnExitTerms');
    var exitP = document.getElementById('btnExitPrivacy');
    if (exitT) exitT.addEventListener('click', function () { switchTab('developer'); });
    if (exitP) exitP.addEventListener('click', function () { switchTab('developer'); });
    if (btnPrivacy) btnPrivacy.addEventListener('click', function () { fillLegalBodies(); switchTab('privacy'); });
    if (closeBtn) closeBtn.addEventListener('click', closeLegalModal);
    if (overlay) overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeLegalModal();
    });
    if (box) box.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLegalModal();
    });
  }

  /* ════════════════════════════════════════
     ADMIN PANEL
     ════════════════════════════════════════ */
  /* Dump links - permanent (stored in dumps/{old|new}/index.json) */




  // Bypass Formatting lives in js/formatting.js (window.YushFormatting)

  function fmtWhen(v) {
    try {
      var d = new Date(v);
      if (isNaN(d.getTime())) return String(v || '—');
      return d.toLocaleString();
    } catch (e) { return String(v || '—'); }
  }

  function postIpBlock(action, ip, reason) {
    fetch(yushApi('api/security-ip-block.json'), {
      headers: yushAdminHeaders(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, ip: ip, reason: reason || '' })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.ok) { alert((data && data.error) || 'Could not update the ban list.'); return; }
      loadSecurityEvents();
    }).catch(function () { alert('Network error while updating the ban list.'); });
  }

  /* ════════════════════════════════════════
     SUSPICIOUS ACTIVITY DASHBOARD (Krawl-style)
     ════════════════════════════════════════ */
  var CAT_META = {
    honeypot:   { label: 'Honeypot',  color: '#ef4444' },
    bot:        { label: 'Scripted bot', color: '#eab308' },
    payload:    { label: 'Attack payload', color: '#f97316' },
    'blocked-ip': { label: 'Blocked IP', color: '#ef4444' },
    flood:      { label: 'Flood', color: '#a78bfa' },
    other:      { label: 'Other', color: '#5a6a78' }
  };
  var _secEventsCache = [];
  var _secMap = null;
  var _secMarkers = {};
  var GEO_CACHE_KEY = '__yush_geoip_cache_v1__';
  var GEO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

  function catMeta(cat) { return CAT_META[cat] || CAT_META.other; }

  function readGeoCache() {
    try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeGeoCache(cache) {
    try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  /** Resolves an array of IPs to {lat,lon,country} via ipwho.is, with a
   *  localStorage cache so a repeat visit doesn't re-hit the API for IPs
   *  we've already placed on the map. Runs with limited concurrency so a
   *  burst of new attacker IPs doesn't fire dozens of requests at once. */
  function geolocateIps(ips, onEach) {
    var cache = readGeoCache();
    var now = Date.now();
    var queue = [];
    ips.forEach(function (ip) {
      var cached = cache[ip];
      if (cached && (now - (cached._at || 0)) < GEO_CACHE_TTL) {
        if (cached.ok) onEach(ip, cached);
        return;
      }
      queue.push(ip);
    });
    var CONCURRENCY = 4;
    var i = 0;
    function next() {
      if (i >= queue.length) return;
      var ip = queue[i++];
      fetch('https://ipwho.is/' + encodeURIComponent(ip))
        .then(function (r) { return r.json(); })
        .then(function (g) {
          var rec = g && g.success !== false
            ? { ok: true, lat: g.latitude, lon: g.longitude, country: g.country, city: g.city, _at: Date.now() }
            : { ok: false, _at: Date.now() };
          cache[ip] = rec;
          writeGeoCache(cache);
          if (rec.ok) onEach(ip, rec);
        })
        .catch(function () { cache[ip] = { ok: false, _at: Date.now() }; })
        .then(next);
    }
    for (var c = 0; c < CONCURRENCY; c++) next();
  }

  function ensureSecMap() {
    if (_secMap || typeof L === 'undefined') return _secMap;
    var el = document.getElementById('secMap');
    if (!el) return null;
    _secMap = L.map(el, { worldCopyJump: true, minZoom: 1 }).setView([15, 10], 1);
    // Free dark basemap that does not require an API key (Carto CDN).
    // The previous {r}@2x form sometimes rendered a "KEY REQUIRED" watermark
    // on certain hosts / mobile browsers; plain PNG path is reliable.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(_secMap);
    return _secMap;
  }

  /** Groups events by IP, geolocates each unique IP, and drops a colored
   *  circle marker (color = most severe category seen from that IP,
   *  radius = how many events came from it) onto the honeypot map. */
  function renderSecMap(events) {
    var map = ensureSecMap();
    if (!map) return; // Leaflet script hasn't loaded (e.g. offline / CDN blocked)

    var severity = ['honeypot', 'payload', 'bot', 'blocked-ip', 'flood', 'other'];
    var byIp = {};
    events.forEach(function (e) {
      if (!e.ip) return;
      if (!byIp[e.ip]) byIp[e.ip] = { count: 0, cat: 'other' };
      byIp[e.ip].count++;
      if (severity.indexOf(e.category) < severity.indexOf(byIp[e.ip].cat)) byIp[e.ip].cat = e.category;
    });

    Object.keys(_secMarkers).forEach(function (ip) {
      if (!byIp[ip]) { map.removeLayer(_secMarkers[ip]); delete _secMarkers[ip]; }
    });

    geolocateIps(Object.keys(byIp), function (ip, geo) {
      var info = byIp[ip];
      var meta = catMeta(info.cat);
      var radius = Math.min(6 + info.count * 1.5, 22);
      if (_secMarkers[ip]) {
        _secMarkers[ip].setLatLng([geo.lat, geo.lon]).setRadius(radius)
          .setStyle({ color: meta.color, fillColor: meta.color });
      } else {
        _secMarkers[ip] = L.circleMarker([geo.lat, geo.lon], {
          radius: radius, color: meta.color, fillColor: meta.color,
          fillOpacity: 0.55, weight: 2, className: 'sec-map-marker'
        }).addTo(map);
      }
      _secMarkers[ip].bindPopup(
        '<b>' + esc(ip) + '</b><br>' + esc(geo.city ? geo.city + ', ' : '') + esc(geo.country || '') +
        '<br>' + info.count + ' event(s) · ' + esc(meta.label)
      );
    });
  }

  function renderSecList(events, filterText) {
    var listEl = document.getElementById('securityEventList');
    if (!listEl) return;
    var f = (filterText || '').toLowerCase().trim();
    var filtered = f ? events.filter(function (e) {
      return (e.ip || '').toLowerCase().indexOf(f) >= 0 ||
        (e.path || '').toLowerCase().indexOf(f) >= 0 ||
        (e.ua || '').toLowerCase().indexOf(f) >= 0;
    }) : events;

    if (!filtered.length) {
      listEl.innerHTML = '<div class="admin-empty">' + (f ? 'No matching activity' : 'No suspicious activity logged yet') + '</div>';
      return;
    }
    listEl.innerHTML = filtered.slice(0, 80).map(function (e) {
      var meta = catMeta(e.category);
      return '<div class="sec-event-row">' +
        '<span class="sec-event-cat" style="background:' + meta.color + '"></span>' +
        '<div class="sec-event-body">' +
          '<div class="sec-event-top">' +
            '<span class="sec-event-ip">' + esc(e.ip || '—') + '</span>' +
            '<span class="sec-event-tag">' + esc(meta.label) + '</span>' +
            '<span class="sec-event-tag">' + esc(e.reason || e.event || 'blocked') + '</span>' +
          '</div>' +
          '<div class="sec-event-path">' + esc(e.method || '—') + ' ' + esc(e.path || '—') + '</div>' +
          (e.ua ? '<div class="sec-event-ua">' + esc(e.ua) + '</div>' : '') +
          '<div class="sec-event-time">' + esc(fmtWhen(e.ts)) + '</div>' +
          (e.ip ? '<button class="admin-btn ban" data-ban-ip="' + esc(e.ip) + '">Block IP</button>' : '') +
        '</div></div>';
    }).join('');
    listEl.querySelectorAll('[data-ban-ip]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        postIpBlock('add', btn.getAttribute('data-ban-ip'), 'flagged from suspicious activity');
      });
    });
  }

  function loadSecurityEvents() {
    if (!document.getElementById('attackingIpList') && !document.getElementById('banIpList')) return;
    var listEl = document.getElementById('securityEventList');
    var banListEl = document.getElementById('banIpList');
    if (!listEl || !banListEl) return;

    fetch(yushApi('api/security-events.json'), { headers: yushAdminHeaders(), credentials: 'same-origin' }).catch(function(){ return { ok:false, json: function(){ return Promise.resolve({ok:false, events:[]}); } }; }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.ok) return;

      var s = data.summary || {};
      var setNum = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v || 0; };
      setNum('secStatTotal', s.total);
      setNum('secStat24h', s.last24h);
      setNum('secStatIps', s.uniqueIps);
      setNum('secStatPaths', s.uniquePaths);
      setNum('secStatHoneypot', s.honeypotCaught);
      setNum('secStatBots', s.scriptedBots);

      var events = data.events || [];
      _secEventsCache = events;
      renderAttackingIps(events, data.blockedIps || []);

      var manual = data.blockedIps || [];
      var countEl = document.getElementById('banIpCount');
      if (countEl) countEl.textContent = manual.length;
      if (!manual.length) {
        banListEl.innerHTML = '<div class="admin-empty">No manually blocked IPs</div>';
      } else {
        banListEl.innerHTML = manual.map(function (row) {
          return '<div class="admin-user-row">' +
            '<div class="admin-user-info">' +
              '<div class="admin-user-email">' + esc(row.ip) + '</div>' +
              '<div class="admin-user-meta">' + esc(row.reason || 'manual') + ' · ' + esc(fmtWhen((row.addedAt || 0) * 1000)) + '</div>' +
            '</div>' +
            '<div class="admin-user-actions">' +
              '<button class="admin-btn approve" data-unban-ip="' + esc(row.ip) + '">Unlock</button>' +
            '</div></div>';
        }).join('');
        banListEl.querySelectorAll('[data-unban-ip]').forEach(function (btn) {
          btn.addEventListener('click', function () { postIpBlock('remove', btn.getAttribute('data-unban-ip'), ''); });
        });
      }
    }).catch(function () {});
  }

  /** Detect client / tool fingerprints from UA + path + reason. */
  function detectAttackMethod(ua, path, reason, category) {
    var s = ((ua || '') + ' ' + (path || '') + ' ' + (reason || '') + ' ' + (category || '')).toLowerCase();
    var tags = [];
    if (/termux|android.*curl|dalvik/i.test(s)) tags.push('Termux / Android');
    if (/python-requests|python-urllib|aiohttp|scrapy|httpx\//i.test(s)) tags.push('Python script');
    if (/\bcurl\//i.test(s) || /wget\//i.test(s)) tags.push('curl / wget');
    if (/go-http-client|golang/i.test(s)) tags.push('Go client');
    if (/java\/|apache-httpclient|okhttp/i.test(s)) tags.push('Java / OkHttp');
    if (/libwww-perl|lwp::|perl/i.test(s)) tags.push('Perl');
    if (/php\//i.test(s) || /wordpress/i.test(s)) tags.push('PHP client');
    if (/nikto|sqlmap|nmap|masscan|zgrab|nuclei|dirbuster|gobuster|wfuzz|hydra/i.test(s)) tags.push('Scanner tool');
    if (/ida|ghidra|radare|x64dbg|cheat.?engine|frida|objection/i.test(s)) tags.push('RE / debugger');
    if (/linux|ubuntu|debian|kali|parrot/i.test(s) && !/android/i.test(s)) tags.push('Linux');
    if (/windows|msie|win64|win32/i.test(s)) tags.push('Windows');
    if (/bot|spider|crawler|scrapy|headless|phantom|selenium|puppeteer|playwright/i.test(s)) tags.push('Bot / automation');
    if (/honeypot/i.test(s)) tags.push('Honeypot trap');
    if (/payload|injection|xss|traversal|\.\.\//i.test(s)) tags.push('Attack payload');
    if (/flood|rate|burst/i.test(s)) tags.push('Flood / rate-limit');
    if (!tags.length) {
      if (/mozilla|chrome|safari|firefox/i.test(s)) tags.push('Browser-like');
      else tags.push('Unknown client');
    }
    return tags;
  }

  /** Attackers Information — full detail cards with method tags + Block. */
  function renderAttackingIps(events, blockedList) {
    var el = document.getElementById('attackingIpList');
    if (!el) return;
    var blockedSet = {};
    (blockedList || []).forEach(function (row) {
      if (row && row.ip) blockedSet[row.ip] = true;
    });
    var byIp = {};
    (events || []).forEach(function (e) {
      if (!e || !e.ip) return;
      if (!byIp[e.ip]) {
        byIp[e.ip] = {
          ip: e.ip,
          count: 0,
          lastCat: e.category || 'other',
          lastPath: e.path || '',
          lastAt: e.ts || 0,
          ua: e.ua || e.userAgent || '',
          reason: e.reason || '',
          method: e.method || '',
          paths: {},
          cats: {}
        };
      }
      var row = byIp[e.ip];
      row.count++;
      if (e.path) row.paths[e.path] = (row.paths[e.path] || 0) + 1;
      if (e.category) row.cats[e.category] = (row.cats[e.category] || 0) + 1;
      if ((e.ts || 0) >= (row.lastAt || 0)) {
        row.lastCat = e.category || row.lastCat;
        row.lastPath = e.path || row.lastPath;
        row.lastAt = e.ts || row.lastAt;
        if (e.ua || e.userAgent) row.ua = e.ua || e.userAgent;
        if (e.reason) row.reason = e.reason;
        if (e.method) row.method = e.method;
      }
    });
    var rows = Object.keys(byIp).map(function (k) { return byIp[k]; });
    rows.sort(function (a, b) { return b.count - a.count; });
    if (!rows.length) {
      el.innerHTML = '<div class="admin-empty">No attackers detected yet</div>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var isBlocked = !!blockedSet[r.ip];
      var meta = catMeta(r.lastCat);
      var tags = detectAttackMethod(r.ua, r.lastPath, r.reason, r.lastCat);
      var topPaths = Object.keys(r.paths).sort(function (a, b) { return r.paths[b] - r.paths[a]; }).slice(0, 3);
      var when = r.lastAt ? fmtWhen(typeof r.lastAt === 'number' && r.lastAt < 1e12 ? r.lastAt * 1000 : r.lastAt) : '';
      return '<div class="attacker-card">' +
        '<div class="attacker-top">' +
          '<div class="attacker-ip">' + esc(r.ip) +
            (isBlocked ? ' <span class="attacker-blocked">BLOCKED</span>' : '') +
          '</div>' +
          '<div class="attacker-actions">' +
            (isBlocked
              ? '<button class="admin-btn approve" data-unban-ip="' + esc(r.ip) + '">Unlock</button>'
              : '<button class="admin-btn reject" data-ban-ip="' + esc(r.ip) + '">Block</button>') +
          '</div>' +
        '</div>' +
        '<div class="attacker-tags">' + tags.map(function (t) {
          return '<span class="attacker-tag">' + esc(t) + '</span>';
        }).join('') + '</div>' +
        '<div class="attacker-meta">' +
          '<div><b>Category</b> ' + esc(meta.label) + '</div>' +
          '<div><b>Hits</b> ' + r.count + '</div>' +
          (r.method ? '<div><b>HTTP</b> ' + esc(r.method) + '</div>' : '') +
          (when ? '<div><b>Last seen</b> ' + esc(when) + '</div>' : '') +
        '</div>' +
        (r.lastPath ? '<div class="attacker-path"><b>Path</b> ' + esc(String(r.lastPath).slice(0, 120)) + '</div>' : '') +
        (topPaths.length > 1 ? '<div class="attacker-path"><b>Other paths</b> ' + esc(topPaths.slice(1).join(', ').slice(0, 100)) + '</div>' : '') +
        (r.ua ? '<div class="attacker-ua"><b>User-Agent</b> ' + esc(String(r.ua).slice(0, 160)) + '</div>' : '') +
        (r.reason ? '<div class="attacker-ua"><b>Reason</b> ' + esc(String(r.reason).slice(0, 100)) + '</div>' : '') +
      '</div>';
    }).join('');
    el.querySelectorAll('[data-ban-ip]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var ip = btn.getAttribute('data-ban-ip');
        var reason = prompt('Block reason (optional) for ' + ip + ':', 'suspicious activity');
        if (reason === null) return;
        postIpBlock('add', ip, reason || 'suspicious activity');
      });
    });
    el.querySelectorAll('[data-unban-ip]').forEach(function (btn) {
      btn.addEventListener('click', function () { postIpBlock('remove', btn.getAttribute('data-unban-ip'), ''); });
    });
  }

  function bindSecurityPanel() {
    var refreshBtn = document.getElementById('btnRefreshSecurity');
    if (refreshBtn && !refreshBtn._yushBound) {
      refreshBtn._yushBound = true;
      refreshBtn.addEventListener('click', loadSecurityEvents);
    }
    var banBtn = document.getElementById('btnBanIp');
    if (banBtn && !banBtn._yushBound) {
      banBtn._yushBound = true;
      banBtn.addEventListener('click', function () {
        var ipEl = document.getElementById('banIpInput');
        var reasonEl = document.getElementById('banIpReason');
        var errEl = document.getElementById('banIpErr');
        var ip = String((ipEl && ipEl.value) || '').trim();
        if (errEl) errEl.textContent = '';
        if (!ip) { if (errEl) errEl.textContent = 'Enter an IP address.'; return; }
        postIpBlock('add', ip, (reasonEl && reasonEl.value) || '');
        if (ipEl) ipEl.value = '';
        if (reasonEl) reasonEl.value = '';
      });
    }
  }

  /* ── Confirm modal helper ── */
  function yushConfirm(title, body, proceedColor, cb) {
    var modal      = document.getElementById('yushConfirmModal');
    var titleEl    = document.getElementById('yushConfirmTitle');
    var bodyEl     = document.getElementById('yushConfirmBody');
    var cancelBtn  = document.getElementById('yushConfirmCancel');
    var proceedBtn = document.getElementById('yushConfirmProceed');
    if (!modal) { cb(); return; }
    titleEl.textContent = title;
    bodyEl.textContent  = body;
    proceedBtn.style.background = proceedColor || '#ef4444';
    modal.style.display = 'flex';
    function close() {
      modal.style.display = 'none';
      cancelBtn.onclick  = null;
      proceedBtn.onclick = null;
    }
    cancelBtn.onclick  = function () { close(); };
    proceedBtn.onclick = function () { close(); cb(); };
  }

  var TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

  /* helpers local to admin */
  function adminFmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' }); }
    catch(e) { return new Date(ts).toLocaleDateString(); }
  }
  function adminCountdown(ts) {
    if (!ts) return null;
    var diff = ts - Date.now();
    if (diff <= 0) return 'Expired';
    var d = Math.floor(diff / 86400000);
    var h = Math.floor((diff % 86400000) / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    if (d > 0) return d + 'd ' + h + 'h left';
    if (h > 0) return h + 'h ' + m + 'm left';
    return m + 'm left';
  }
  function pwStrength(pw) {
    if (!pw) return { score: 0, label: '—', color: 'var(--text3)' };
    var score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    var labels = ['Very Weak','Weak','Fair','Good','Strong','Very Strong'];
    var colors = ['#ef4444','#f97316','#f59e0b','#eab308','#22c55e','#16a34a'];
    return { score: score, label: labels[score] || 'Strong', color: colors[score] || '#22c55e', pct: Math.round((score/5)*100) };
  }

  function buildUserCard(email, u, opts) {
    opts = opts || {};
    var init       = (email.charAt(0) || 'U').toUpperCase();
    var roleColor  = u.role === 'admin' ? '#8b5cf6' : '#22c55e';
    var isExpired  = u.expiry && u.expiry < Date.now();
    var isBanned   = u.status === 'banned';
    var statusTxt  = isExpired ? 'Expired' : (isBanned ? 'Banned' : 'Active');
    var statusClr  = (isExpired || isBanned) ? '#ef4444' : '#22c55e';
    var cd         = adminCountdown(u.expiry);
    var expiryClr  = isExpired ? '#ef4444' : '#f59e0b';
    var plainPw    = (u.password != null && u.password !== '') ? String(u.password) : '—';

    var actionBtns =
      (isBanned || isExpired
        ? '<button class="admin-btn approve" data-action="unban" data-email="' + esc(email) + '">Unban</button>'
        : '<button class="admin-btn ban" data-action="ban" data-email="' + esc(email) + '">Ban</button>') +
      (u.role === 'admin'
        ? '<button class="admin-btn" data-action="demote" data-email="' + esc(email) + '">Demote</button>'
        : '<button class="admin-btn promote" data-action="promote" data-email="' + esc(email) + '">Promote</button>') +
      '<button class="admin-btn delete" data-action="delete" data-email="' + esc(email) + '">Delete</button>';

    if (opts.showWlRemove) {
      actionBtns += '<button class="admin-btn delete" data-action="removewhitelist" data-email="' + esc(email) + '" title="Remove from whitelist" style="display:inline-flex;align-items:center;justify-content:center;padding:6px 8px">' + TRASH_ICON + '</button>';
    }

    return '<div class="admin-user-row" style="flex-direction:column;align-items:stretch;gap:10px;padding:14px">' +
      /* header row — buttons stay on one line / wrap cleanly */
      '<div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">' +
        '<div class="admin-avatar-sm" style="background:linear-gradient(135deg,' + roleColor + ',' + (u.role==='admin'?'#6d28d9':'#15803d') + ');font-size:15px;font-weight:700;flex-shrink:0">' + esc(init) + '</div>' +
        '<div style="flex:1;min-width:120px">' +
          '<div class="admin-user-email" style="font-weight:700">' + esc(email) + '</div>' +
          '<div style="font-size:11px;margin-top:2px">' +
            '<span style="color:' + statusClr + ';font-weight:700">● ' + esc(statusTxt) + '</span>' +
            ' · <span style="color:' + roleColor + ';font-weight:600">' + esc(u.role || 'user') + '</span>' +
            (u.name && u.name !== email.split('@')[0] ? ' · ' + esc(u.name) : '') +
          '</div>' +
        '</div>' +
        '<div class="admin-user-actions" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end;margin-left:auto">' + actionBtns + '</div>' +
      '</div>' +
      /* info grid */
      '<div style="background:var(--input-bg);border-radius:10px;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;font-size:11px">' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Full Name</div><div style="color:var(--text1);font-weight:600">' + esc(u.name || '—') + '</div></div>' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">IP Address</div><div style="color:var(--text1);font-weight:600;word-break:break-all">' + esc(u.lastIp || '—') + '</div></div>' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Password</div>' +
          '<div style="color:var(--text1);font-weight:600;word-break:break-all">' + esc(plainPw) + '</div>' +
        '</div>' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Updates</div><div style="color:var(--text1);font-weight:600">' + esc(String(u.updateCount || 0)) + '</div></div>' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Joined</div><div style="color:var(--text1)">' + adminFmtDate(u.createdAt) + '</div></div>' +
        '<div><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Last Login</div><div style="color:var(--text1)">' + adminFmtDate(u.lastLoginAt) + '</div></div>' +
        '<div style="grid-column:1/-1"><div style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Expiry ' + (cd ? '· <span style="color:' + expiryClr + ';font-weight:700">' + esc(cd) + '</span>' : '') + '</div>' +
          (u.expiry
            ? '<div style="color:' + expiryClr + ';font-weight:600">' + adminFmtDate(u.expiry) + '</div>'
            : '<div style="color:var(--text3)">No expiry set</div>') +
        '</div>' +
      '</div>' +
      /* expiry setter — days input, not calendar */
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<input type="number" min="1" max="3650" placeholder="Days (e.g. 3)" class="admin-expiry-input" data-expiry-email="' + esc(email) + '" style="flex:1;min-width:100px;background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--text1)">' +
        '<button class="admin-btn approve" data-action="setexpiry" data-email="' + esc(email) + '">Set Expiry</button>' +
        '<button class="admin-btn delete" data-action="clearexpiry" data-email="' + esc(email) + '">Clear</button>' +
      '</div>' +
    '</div>';
  }

  function renderSpreadList() {
    var list = document.getElementById('spreadList');
    if (!list || !Auth) return;
    var items = [];
    try { items = Auth.getAnnouncements ? Auth.getAnnouncements() : []; } catch (e) { items = []; }
    if (!items.length) {
      list.innerHTML = '<div class="admin-empty">No spread notifications yet</div>';
      return;
    }
    list.innerHTML = items.map(function (a) {
      return '<div class="admin-user-row" style="align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:13px;color:var(--text)">' + esc(a.title || 'Untitled') + '</div>' +
          '<div style="font-size:12px;color:var(--text3);margin-top:4px;word-break:break-word">' + esc(a.body || '') + '</div>' +
          '<div style="font-size:10px;color:var(--text3);margin-top:4px">' + formatPHTime(a.time) + '</div>' +
        '</div>' +
        '<button type="button" class="admin-btn" data-del-spread="' + a.id + '" style="flex-shrink:0;color:#ef4444;border-color:rgba(239,68,68,.35)">Delete</button>' +
      '</div>';
    }).join('');
    list.querySelectorAll('[data-del-spread]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-del-spread');
        if (!confirm('Delete this notification for everyone?')) return;
        if (Auth.deleteAnnouncement) Auth.deleteAnnouncement(Number(id) || id);
        if (Auth.deleteNotification) Auth.deleteNotification(id);
        updateNotifBadge();
        renderSpreadList();
      });
    });
  }

  function bindSpreadNotification() {
    var btn = document.getElementById('btnSpreadSend');
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', function () {
      var title = (document.getElementById('spreadTitle') || {}).value || '';
      var msg = (document.getElementById('spreadMessage') || {}).value || '';
      var err = document.getElementById('spreadErr');
      if (err) err.textContent = '';
      if (!title.trim() && !msg.trim()) {
        if (err) err.textContent = 'Enter a title or message.';
        return;
      }
      if (!Auth || !Auth.postAnnouncement) {
        if (err) err.textContent = 'Auth module unavailable.';
        return;
      }
      var res = Auth.postAnnouncement(title.trim(), msg.trim(), 'announcement');
      if (res && res.ok) {
        if (document.getElementById('spreadTitle')) document.getElementById('spreadTitle').value = '';
        if (document.getElementById('spreadMessage')) document.getElementById('spreadMessage').value = '';
        updateNotifBadge();
        renderSpreadList();
      } else {
        if (err) err.textContent = (res && res.error) || 'Failed to send.';
      }
    });
  }

  function renderAdminPanel() {
    try { bindSpreadNotification(); renderSpreadList(); } catch (e) {}
    if (!Auth) return;
    bindSecurityPanel();
    loadSecurityEvents();

    var users = Auth.getUsers();

    /* ── Announcements ── */
    var anns = Auth.getAnnouncements ? Auth.getAnnouncements() : [];
    var annCountEl = document.getElementById('announceCount');
    if (annCountEl) annCountEl.textContent = anns.length;
    var annList = document.getElementById('announceList');
    if (annList) {
      if (!anns.length) {
        annList.innerHTML = '<div class="admin-empty">No announcements yet</div>';
      } else {
        var annColors = { info:'#3b82f6', warning:'#f59e0b', success:'#22c55e', danger:'#ef4444' };
        annList.innerHTML = anns.map(function(a) {
          var c = annColors[a.type] || '#8b5cf6';
          return '<div class="admin-user-row" style="border-left:3px solid ' + c + ';padding-left:10px;flex-direction:column;gap:4px">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
              '<div style="color:' + c + ';font-weight:700;font-size:13px">' + esc(a.title || '(no title)') + ' <span style="font-size:10px;opacity:.7">[' + esc(a.type || 'info') + ']</span></div>' +
              '<button class="admin-btn delete" data-ann-del="' + a.id + '" style="flex-shrink:0">' + TRASH_ICON + '</button>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text2);line-height:1.4">' + esc(a.body) + '</div>' +
            '<div style="font-size:10px;color:var(--text3)">' + formatPHTime(a.time) + '</div>' +
          '</div>';
        }).join('');
        annList.querySelectorAll('[data-ann-del]').forEach(function(btn) {
          btn.onclick = function() {
            if (Auth.deleteAnnouncement) Auth.deleteAnnouncement(Number(btn.getAttribute('data-ann-del')));
            renderAdminPanel();
            updateNotifBadge();
          };
        });
      }
    }

    /* post announcement button */
    var postBtn = document.getElementById('btnPostAnnounce');
    if (postBtn) {
      postBtn.onclick = function() {
        var title = (document.getElementById('annTitle') && document.getElementById('annTitle').value || '').trim();
        var body  = (document.getElementById('annBody')  && document.getElementById('annBody').value  || '').trim();
        var type  = (document.getElementById('annType')  && document.getElementById('annType').value  || 'info');
        var errEl = document.getElementById('annErr');
        if (!body) { if (errEl) errEl.textContent = 'Message cannot be empty.'; return; }
        if (errEl) errEl.textContent = '';
        if (Auth.postAnnouncement) Auth.postAnnouncement(title, body, type);
        if (document.getElementById('annTitle')) document.getElementById('annTitle').value = '';
        if (document.getElementById('annBody'))  document.getElementById('annBody').value  = '';
        updateNotifBadge();
        renderAdminPanel();
      };
    }

    /* ── Whitelist ── */
    var wlRaw = Auth.getWhitelist();
    var wlCountEl = document.getElementById('allowedCount');
    if (wlCountEl) wlCountEl.textContent = wlRaw.length;
    var wlList = document.getElementById('allowedList');
    if (wlList) {
      if (!wlRaw.length) {
        wlList.innerHTML = '<div class="admin-empty">No allowed emails yet</div>';
      } else {
        wlList.innerHTML = wlRaw.map(function (entry) {
          var email   = typeof entry === 'string' ? entry : entry.email;
          var addedAt = typeof entry === 'object' ? entry.addedAt : null;
          var init    = (email.charAt(0) || 'E').toUpperCase();
          var u       = users[email];
          var statusNote = u
            ? ('Registered · ' + (u.role || 'user'))
            : ('Not yet registered' + (addedAt ? ' · Added ' + adminFmtDate(addedAt) : ''));

          /* Whitelist = email only. Full info lives under Registered Users. */
          return '<div class="admin-user-row" style="gap:10px;align-items:center">' +
            '<div class="admin-avatar-sm" style="background:linear-gradient(135deg,#6366f1,#4f46e5);flex-shrink:0">' + esc(init) + '</div>' +
            '<div class="admin-user-info" style="flex:1;min-width:0">' +
              '<div class="admin-user-email">' + esc(email) + '</div>' +
              '<div style="font-size:11px;color:var(--text3)">' + esc(statusNote) + '</div>' +
            '</div>' +
            '<div class="admin-user-actions" style="flex-shrink:0">' +
              '<button class="admin-btn delete" data-action="removewhitelist" data-email="' + esc(email) + '" title="Remove" style="display:inline-flex;align-items:center;justify-content:center;padding:6px 8px">' + TRASH_ICON + '</button>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }

    /* Add email button */
    var addBtn = document.getElementById('btnAddAllowed');
    if (addBtn) {
      addBtn.onclick = function () {
        var inp   = document.getElementById('allowedEmailInput');
        var errEl = document.getElementById('allowedEmailErr');
        var val   = inp ? inp.value.trim() : '';
        if (errEl) errEl.textContent = '';
        var res = Auth.addToWhitelist(val);
        if (!res.ok) { if (errEl) errEl.textContent = res.error; return; }
        if (inp) inp.value = '';
        renderAdminPanel();
      };
    }

    /* ── Registered Users ── */
    var userKeys = Object.keys(users);
    var ucEl = document.getElementById('userCount');
    if (ucEl) ucEl.textContent = userKeys.length;

    /* stats */
    var statTotal   = userKeys.length;
    var statActive  = userKeys.filter(function(e){ return users[e].status === 'active' && !(users[e].expiry && users[e].expiry < Date.now()); }).length;
    var statExpired = userKeys.filter(function(e){ return users[e].expiry && users[e].expiry < Date.now(); }).length;
    var statBanned  = userKeys.filter(function(e){ return users[e].status === 'banned'; }).length;
    function setStat(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; }
    setStat('adminStatUsers', statTotal);
    setStat('adminStatActive', statActive);
    setStat('adminStatExpired', statExpired);
    setStat('adminStatBanned', statBanned);

    var userList = document.getElementById('userList');
    if (userList) {
      if (!userKeys.length) {
        userList.innerHTML = '<div class="admin-empty">No users yet</div>';
      } else {
        userList.innerHTML = userKeys.map(function(email) {
          return buildUserCard(email, users[email], { showWlRemove: false });
        }).join('');
      }
    }


    /* ── Bind all [data-action] buttons ── */
    document.querySelectorAll('#tab-admin [data-action]').forEach(function (btn) {
      btn.onclick = function () {
        var action = btn.getAttribute('data-action');
        var email  = btn.getAttribute('data-email');

        function doAction() {
          var res;
          if (action === 'removewhitelist') res = Auth.removeFromWhitelist(email);
          else if (action === 'ban')         res = Auth.banUser(email);
          else if (action === 'unban')       res = Auth.unbanUser(email);
          else if (action === 'delete')      res = Auth.deleteUser(email);
          else if (action === 'promote')     res = Auth.promoteUser(email);
          else if (action === 'demote')      res = Auth.demoteUser(email);
          else if (action === 'setexpiry') {
            var inp = document.querySelector('[data-expiry-email="' + email + '"]');
            var days = inp ? parseInt(inp.value, 10) : 0;
            if (!days || days < 1) { alert('Enter number of days (e.g. 3).'); return; }
            var ts = Date.now() + (days * 86400000);
            if (Auth.setExpiry) res = Auth.setExpiry(email, ts);
            if (res && res.ok) {
              var nb = JSON.parse(localStorage.getItem('__yush_notifs_v2__') || '[]');
              nb.unshift({ id: Date.now(), type:'expiry', message:'Expiry set for ' + email + ' — ' + days + ' day(s) (until ' + new Date(ts).toLocaleDateString() + ')', time: Date.now(), read: false });
              localStorage.setItem('__yush_notifs_v2__', JSON.stringify(nb));
            }
          }
          else if (action === 'clearexpiry') {
            if (Auth.setExpiry) res = Auth.setExpiry(email, null);
          }
          else if (action === 'banip') {
            var ip = btn.getAttribute('data-ip');
            if (ip && ip !== 'unknown') {
              postIpBlock('add', ip, 'Banned from admin: ' + email);
              /* approval removed */
              res = { ok: true };
            }
          }
          if (res && !res.ok) alert(res.error || 'Error');
          updateNotifBadge();
          renderAdminPanel();
        }

        var confirmMap = {
          removewhitelist: { title:'Remove from whitelist?', body:'Remove ' + email + ' from allowed emails? They cannot register anymore.', color:'#ef4444' },
          delete:          { title:'Delete user?',           body:'Permanently delete ' + email + '? They must re-register.',               color:'#ef4444' },
          ban:             { title:'Ban user?',              body:'Ban ' + email + '? They lose access immediately.',                        color:'#ef4444' },
          unban:           { title:'Unban user?',            body:'Restore access for ' + email + '?',                                       color:'#22c55e' },
          promote:         { title:'Promote to admin?',      body:'Grant admin privileges to ' + email + '?',                               color:'#8b5cf6' },
          demote:          { title:'Demote to user?',        body:'Remove admin privileges from ' + email + '?',                            color:'#f59e0b' }
        };
        if (confirmMap[action]) {
          var cm = confirmMap[action];
          yushConfirm(cm.title, cm.body, cm.color, doAction);
        } else {
          doAction();
        }
      };
    });
  }


  /* ════════════════════════════════════════
     DUMMY DETECTOR
     ════════════════════════════════════════ */
  function bindDummyDetector() {
    var ddContent = null;
    var ddLines = [];
    var ddRealOffsets = [];
    var ddDummyOffsets = [];

    var browseBtn = document.getElementById('ddBrowseBtn');
    var fileInput = document.getElementById('ddFileInput');
    var detectBtn = document.getElementById('ddDetectBtn');

    if (!browseBtn || !fileInput || !detectBtn) return;

    browseBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        ddContent = ev.target.result;
        ddLines = ddContent.split('\n');
        document.getElementById('ddFilePath').textContent = file.name;
        document.getElementById('ddFileStatus').textContent =
          'Loaded · ' + (file.size > 1024 * 1024
            ? (file.size / 1048576).toFixed(1) + ' MB'
            : Math.round(file.size / 1024) + ' KB');
      };
      reader.readAsText(file);
    });

    function checkOffset(offset) {
      var hexUp = offset.toString(16).toUpperCase();
      var subName = 'sub_' + hexUp;
      for (var i = 0; i < ddLines.length; i++) {
        var line = ddLines[i];
        if (line.indexOf(subName + '(') !== -1) {
          var isDef = /void|__int64|int |char |bool |float|double|__fastcall|__cdecl/.test(line);
          if (isDef) {
            return line.indexOf('__noreturn') !== -1 ? 'DUMMY' : 'REAL';
          }
        }
      }
      return 'DUMMY';
    }

    /* Extract the full function body for a given offset hex string */
    /* IDA separator: //----- (0000000000204218) ----... */
    var RE_SEP = /^\/\/-{4,}\s*\(\s*[0-9A-Fa-f]+\s*\)\s*-{4,}/;

    function extractFunction(hexStr) {
      var hexUp = hexStr.replace(/^0x/i, '').toUpperCase();

      /* 1. Find the IDA separator line for this exact offset */
      var sepLine = -1;
      for (var i = 0; i < ddLines.length; i++) {
        if (RE_SEP.test(ddLines[i])) {
          var m = ddLines[i].match(/\(\s*([0-9A-Fa-f]+)\s*\)/);
          if (m) {
            var lineHex = m[1].toUpperCase().replace(/^0+/, '') || '0';
            var wantHex = hexUp.replace(/^0+/, '') || '0';
            if (lineHex === wantHex) { sepLine = i; break; }
          }
        }
      }

      /* 2. Fallback: find the function definition line if no separator */
      var from = sepLine;
      if (from === -1) {
        var subName2 = 'sub_' + hexUp;
        for (var si = 0; si < ddLines.length; si++) {
          if (ddLines[si].indexOf(subName2 + '(') !== -1 &&
              /void|__int64|int |char |bool |float|double|__fastcall|__cdecl/.test(ddLines[si])) {
            from = Math.max(0, si - 1); break;
          }
        }
      }
      if (from === -1) return null;

      /* 3. Walk forward: track braces, STOP when we hit the NEXT separator.
            Skip the separator line itself (from) when collecting — it's the
            //----- (HEX) ---- line we do NOT want to show. */
      var depth = 0, started = false, end = from;
      for (var j = from + 1; j < Math.min(ddLines.length, from + 8000); j++) {
        if (RE_SEP.test(ddLines[j])) { break; }
        var ln = ddLines[j];
        for (var k = 0; k < ln.length; k++) {
          var ch = ln[k];
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') {
            depth--;
            if (started && depth === 0) { end = j; }
          }
        }
      }

      /* 4. Sweep trailing // comment lines after the closing brace */
      var tail = end + 1;
      while (tail < ddLines.length && !RE_SEP.test(ddLines[tail])) {
        if (/^\s*\/\//.test(ddLines[tail])) { end = tail; tail++; }
        else if (/^\s*$/.test(ddLines[tail])) { tail++; }
        else break;
      }

      /* Start from from+1 to SKIP the //----- (HEX) ---- separator line */
      return ddLines.slice(from + 1, end + 1).join('\n');
    }

    /* ── Syntax highlighter ──────────────────────────────────────────
       Works token-by-token on each line so HTML tags never get re-processed.
       Strategy: scan each character, accumulate tokens, classify and wrap. */
    var KW_SET = {
      'void':1,'int':1,'char':1,'bool':1,'float':1,'double':1,'return':1,
      'if':1,'else':1,'while':1,'for':1,'do':1,'break':1,'continue':1,
      'goto':1,'switch':1,'case':1,'default':1,'struct':1,'union':1,'enum':1,
      'typedef':1,'unsigned':1,'signed':1,'long':1,'short':1,'const':1,
      'static':1,'extern':1,'register':1,'volatile':1,'inline':1,'auto':1,
      'NULL':1,'true':1,'false':1,
      '__int64':1,'__int32':1,'__int16':1,'__int8':1,
      '_DWORD':1,'_QWORD':1,'_WORD':1,'_BYTE':1,'_BOOL1':1,'_BOOL4':1,
      '__fastcall':1,'__cdecl':1,'__stdcall':1,'__noreturn':1,'__asm':1,
      'BOOL':1,'BYTE':1,'WORD':1,'DWORD':1,'QWORD':1,'INT':1,'UINT':1,
      'LPSTR':1,'LPVOID':1,'HANDLE':1,'HRESULT':1
    };

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function span(cls, txt) { return '<span class="' + cls + '">' + txt + '</span>'; }

    function hlLine(raw) {
      /* Comments: everything from // to end of line → one colour, done */
      var ci = raw.indexOf('//');
      if (ci !== -1) {
        var before = raw.slice(0, ci);
        var comment = raw.slice(ci);
        return hlTokens(before) + span('dd-cm', escHtml(comment));
      }
      return hlTokens(raw);
    }

    function hlTokens(src) {
      var out = '';
      var i = 0;
      while (i < src.length) {
        var c = src[i];

        /* String literal */
        if (c === '"') {
          var j = i + 1;
          while (j < src.length && src[j] !== '"') {
            if (src[j] === '\\') j++;
            j++;
          }
          out += span('dd-str', escHtml(src.slice(i, j + 1)));
          i = j + 1;
          continue;
        }

        /* Identifier or keyword */
        if (/[A-Za-z_]/.test(c)) {
          var start = i;
          while (i < src.length && /[\w]/.test(src[i])) i++;
          var word = src.slice(start, i);
          if (/^sub_[0-9A-Fa-f]+$/.test(word)) {
            out += span('dd-fn', escHtml(word));
          } else if (KW_SET[word]) {
            out += span('dd-kw', escHtml(word));
          } else {
            out += escHtml(word);
          }
          continue;
        }

        /* Hex number: 0x... */
        if (c === '0' && src[i+1] === 'x') {
          var hs = i;
          i += 2;
          while (i < src.length && /[0-9A-Fa-f]/.test(src[i])) i++;
          /* optional suffix */
          while (i < src.length && /[uUlL]/.test(src[i])) i++;
          out += span('dd-nu', escHtml(src.slice(hs, i)));
          continue;
        }

        /* Decimal number */
        if (/[0-9]/.test(c)) {
          var ds = i;
          while (i < src.length && /[0-9.]/.test(src[i])) i++;
          while (i < src.length && /[uUlLfF]/.test(src[i])) i++;
          out += span('dd-nu', escHtml(src.slice(ds, i)));
          continue;
        }

        /* Everything else: operators, punctuation, spaces */
        out += escHtml(c);
        i++;
      }
      return out;
    }

    function hlC(code) {
      return code.split('\n').map(hlLine).join('\n');
    }

    /* Toggle expand/collapse on a card */
    function toggleCard(card) {
      var isOpen = card.classList.toggle('open');
      if (!isOpen) return;
      var panel = card.querySelector('.dd-fn-panel');
      if (panel.dataset.loaded) return;
      panel.dataset.loaded = '1';
      var hexStr = card.dataset.hex;
      var fnCode = extractFunction(hexStr);
      var codeEl = panel.querySelector('.dd-fn-code');
      if (!fnCode) {
        panel.innerHTML = '<div class="dd-fn-empty">No function body found for ' + hexStr + '</div>';
        return;
      }
      if (codeEl) {
        codeEl.innerHTML = hlC(fnCode);
      }
    }

    /* Wire up all toggle triggers in a container */
    function bindCardToggles(container) {
      container.querySelectorAll('.dd-offset-trigger').forEach(function (trigger) {
        trigger.addEventListener('click', function () {
          var card = trigger.closest('.dd-offset-card');
          if (card) toggleCard(card);
        });
      });
    }

    function makeCopyAllBtn() {
      return '<button class="dd-fn-copy-all" type="button">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
        'Copy All</button>';
    }

    /* Build expandable offset card HTML */
    function makeOffsetCard(hexStr, type) {
      var cls = type === 'REAL' ? 'real' : 'dummy';
      var chevronSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
      return '<div class="dd-offset-card ' + cls + '" data-hex="' + hexStr + '">' +
        '<div class="dd-offset-trigger">' +
          '<span class="dd-offset-hex">' + hexStr + '</span>' +
          '<div class="dd-chevron">' + chevronSvg + '</div>' +
        '</div>' +
        '<div class="dd-fn-panel">' +
          '<div class="dd-fn-header">' +
            '<span class="dd-fn-label">Function</span>' +
            makeCopyAllBtn() +
          '</div>' +
          '<pre class="dd-fn-code"></pre>' +
        '</div>' +
      '</div>';
    }

    /* Wire Copy All inside function panels (event delegation) */
    function bindFnCopyAll(container) {
      container.addEventListener('click', function (e) {
        var btn = e.target.closest('.dd-fn-copy-all');
        if (!btn) return;
        var card = btn.closest('.dd-offset-card');
        var pre = card && card.querySelector('.dd-fn-code');
        if (!pre) return;
        var text = pre.textContent || '';
        navigator.clipboard && navigator.clipboard.writeText(text);
        var prev = btn.innerHTML;
        btn.textContent = '✓ Copied!';
        setTimeout(function () { btn.innerHTML = prev; }, 1400);
      });
    }

    detectBtn.addEventListener('click', function () {
      if (!ddContent) {
        alert('Please browse and load a libanogs.so.c file first.');
        return;
      }
      var raw = (document.getElementById('ddOffsetInput').value || '').trim();
      if (!raw) {
        alert('Please paste at least one offset.');
        return;
      }

      ddRealOffsets = [];
      ddDummyOffsets = [];
      var inputLines = raw.split(/[\r\n]+/);

      inputLines.forEach(function (line) {
        var m = line.match(/0[xX]([0-9a-fA-F]+)/) || line.match(/^\s*([0-9a-fA-F]+)\s*$/);
        if (!m) return;
        var offset = parseInt(m[1], 16);
        if (isNaN(offset)) return;
        var hexStr = '0x' + offset.toString(16).toUpperCase();
        var result = checkOffset(offset);
        if (result === 'REAL') ddRealOffsets.push(hexStr);
        else ddDummyOffsets.push(hexStr);
      });

      var total = ddRealOffsets.length + ddDummyOffsets.length;
      if (total === 0) {
        alert('No valid offsets found. Use 0x... format.');
        return;
      }

      // Update always-visible stats
      document.getElementById('ddStatReal').textContent = ddRealOffsets.length;
      document.getElementById('ddStatDummy').textContent = ddDummyOffsets.length;
      document.getElementById('ddStatTotal').textContent = total;

      // Render real
      var realWrap = document.getElementById('ddResultReal');
      var realList = document.getElementById('ddRealList');
      document.getElementById('ddRealCount').textContent = ddRealOffsets.length;
      if (ddRealOffsets.length > 0) {
        realList.innerHTML = ddRealOffsets.map(function (h) { return makeOffsetCard(h, 'REAL'); }).join('');
        bindCardToggles(realList);
        bindFnCopyAll(realList);
        realWrap.style.display = '';
      } else {
        realWrap.style.display = 'none';
      }

      // Render dummy
      var dummyWrap = document.getElementById('ddResultDummy');
      var dummyList = document.getElementById('ddDummyList');
      document.getElementById('ddDummyCount').textContent = ddDummyOffsets.length;
      if (ddDummyOffsets.length > 0) {
        dummyList.innerHTML = ddDummyOffsets.map(function (h) { return makeOffsetCard(h, 'DUMMY'); }).join('');
        bindCardToggles(dummyList);
        bindFnCopyAll(dummyList);
        dummyWrap.style.display = '';
      } else {
        dummyWrap.style.display = 'none';
      }

      // Scroll to results
      document.getElementById('ddStatsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

})();
