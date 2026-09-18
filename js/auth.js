/**
 * YUSH TOOLS — License Auth System
 * Single LICENSE key login only.
 * No email, no password, no signup, no Gmail/Google, no whitelist, no verification codes.
 * Cloudflare Turnstile remains (handled outside this file).
 * Admin master key: YUSH-BUFF
 */
(function () {
  'use strict';

  var ADMIN_KEY       = 'YUSH-BUFF';
  var KEYS_DB         = '__yush_keys_v1__';
  var SESSION_KEY     = '__yush_session_v3__';
  var REMEMBER_KEY    = '__yush_remembered_license__';
  var ATTACKS_KEY     = '__yush_attacks_v2__';
  var NOTIFS_KEY      = '__yush_notifs_v2__';
  var ANNOUNCE_KEY    = '__yush_announcements_v1__';
  var SESSION_MAX_MS  = 24 * 60 * 60 * 1000;

  /* ── storage helpers ── */
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function keysDB()       { return load(KEYS_DB, {}); }
  function saveKeys(db)   { save(KEYS_DB, db); }
  function attacksDB()    { return load(ATTACKS_KEY, []); }
  function saveAttacks(a) { save(ATTACKS_KEY, a); }
  function notifsDB()     { return load(NOTIFS_KEY, []); }
  function saveNotifs(a)  { save(NOTIFS_KEY, a); }
  function announceDB()   { return load(ANNOUNCE_KEY, []); }
  function saveAnnounce(a){ save(ANNOUNCE_KEY, a); }

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.key) return null;
      var loginAt = obj.loginAt || 0;
      var expiresAt = obj.expiresAt || (loginAt + SESSION_MAX_MS);
      if (Date.now() > expiresAt) { clearSession(); return null; }
      return obj;
    } catch (e) { return null; }
  }

  function setSession(obj) {
    try {
      if (obj && !obj.expiresAt) obj.expiresAt = (obj.loginAt || Date.now()) + SESSION_MAX_MS;
      localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e2) {}
    } catch (e) {}
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function randomKey(prefix) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function block(n) {
      var s = '';
      for (var i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
      return s;
    }
    prefix = prefix || 'YUSH';
    return prefix + '-' + block(4) + '-' + block(4) + '-' + block(4);
  }

  function isAdminKey(key) {
    return (key || '').trim().toUpperCase() === ADMIN_KEY;
  }

  /* ── public API ── */
  var Auth = {
    ADMIN_KEY: ADMIN_KEY,

    getSession: getSession,
    clearSession: clearSession,

    logout: function () {
      clearSession();
      try { localStorage.removeItem(REMEMBER_KEY); } catch (e) {}
      try { document.documentElement.classList.remove('yush-authed'); } catch (e2) {}
    },

    isLoggedIn: function () {
      return !!getSession();
    },

    isAdmin: function () {
      var s = getSession();
      return !!(s && (s.role === 'admin' || isAdminKey(s.key)));
    },

    isOwner: function (key) {
      return isAdminKey(key);
    },

    /* Apply successful server (Supabase) login response into session */
    loginFromServerData: function (license, data, remember) {
      license = (license || '').trim();
      data = data || {};
      var now = Date.now();
      var expiry = null;
      if (data.EXP) {
        var parts = String(data.EXP).split('-');
        if (parts.length === 3) {
          var d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10), 23, 59, 59);
          if (!isNaN(d.getTime())) expiry = d.getTime();
        }
      }
      var sess = {
        key: license,
        role: data.role || (isAdminKey(license) ? 'admin' : 'user'),
        status: 'active',
        name: data.name || ('User-' + license.slice(-4)),
        expiry: expiry,
        loginAt: now,
        expiresAt: now + SESSION_MAX_MS,
        key_type: data.key_type || 'standard',
        token: data.token || '',
        device_limit: data.device_limit,
        devices_used: data.devices_used
      };
      if (isAdminKey(license)) {
        sess.role = 'admin';
        sess.name = 'Admin';
        sess.expiry = null;
      }
      setSession(sess);
      if (remember) {
        try { localStorage.setItem(REMEMBER_KEY, license); } catch (e) {}
      } else {
        try { localStorage.removeItem(REMEMBER_KEY); } catch (e) {}
      }
      return { ok: true, user: sess };
    },

    /* Login with a single LICENSE key */
    login: function (license, remember) {
      license = (license || '').trim();
      if (!license) return { ok: false, error: 'License key is required.' };

      /* Master admin key — always works */
      if (isAdminKey(license)) {
        var now = Date.now();
        var ownerSess = {
          key: ADMIN_KEY,
          role: 'admin',
          status: 'active',
          name: 'Admin',
          expiry: null,
          loginAt: now,
          expiresAt: now + SESSION_MAX_MS
        };
        setSession(ownerSess);
        if (remember) {
          localStorage.setItem(REMEMBER_KEY, license);
        } else {
          localStorage.removeItem(REMEMBER_KEY);
        }
        return { ok: true, user: ownerSess };
      }

      var db = keysDB();
      var keyData = db[license];

      if (!keyData) {
        this._logAttack('unknown_key', license);
        return { ok: false, error: 'Invalid license key.' };
      }

      if (keyData.status === 'banned') {
        this._logAttack('banned_key', license);
        return { ok: false, error: 'This license has been banned.' };
      }

      if (keyData.status === 'revoked') {
        return { ok: false, error: 'This license has been revoked.' };
      }

      /* Expiry check */
      if (keyData.expiry && Date.now() > keyData.expiry) {
        keyData.status = 'expired';
        saveKeys(db);
        return { ok: false, error: 'Your license has expired. Contact the owner to renew.' };
      }

      if (keyData.status !== 'active') {
        return { ok: false, error: 'License is not active (status: ' + keyData.status + ').' };
      }

      /* Device limit (optional) */
      if (keyData.max_devices && keyData.devices_used >= keyData.max_devices) {
        return { ok: false, error: 'Device limit reached for this license (' + keyData.max_devices + ').' };
      }

      var now2 = Date.now();
      keyData.lastLoginAt = now2;
      keyData.devices_used = (keyData.devices_used || 0) + 1;
      saveKeys(db);

      var sess = {
        key: license,
        role: keyData.role || 'user',
        status: 'active',
        name: keyData.name || ('User-' + license.slice(-4)),
        expiry: keyData.expiry || null,
        loginAt: now2,
        expiresAt: now2 + SESSION_MAX_MS,
        key_type: keyData.key_type || 'standard'
      };
      setSession(sess);

      if (remember) {
        localStorage.setItem(REMEMBER_KEY, license);
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }

      return { ok: true, user: sess };
    },

    /* Generate a new license key (admin only) */
    generateKey: function (opts) {
      opts = opts || {};
      var prefix = opts.prefix || (opts.vip ? 'VIP' : 'YUSH');
      var key = randomKey(prefix);
      var db = keysDB();

      /* Ensure uniqueness */
      var tries = 0;
      while (db[key] && tries < 20) {
        key = randomKey(prefix);
        tries++;
      }

      var entry = {
        key: key,
        role: opts.role || 'user',
        status: 'active',
        name: opts.name || ('User-' + key.slice(-4)),
        key_type: opts.vip ? 'vip' : 'standard',
        createdAt: Date.now(),
        expiry: opts.expiry || null,
        max_devices: opts.max_devices || 1,
        devices_used: 0,
        lastLoginAt: null,
        note: opts.note || ''
      };

      db[key] = entry;
      saveKeys(db);
      return { ok: true, key: key, data: entry };
    },

    getKeys: function () {
      return keysDB();
    },

    getKey: function (license) {
      if (isAdminKey(license)) {
        return {
          key: ADMIN_KEY,
          role: 'admin',
          status: 'active',
          name: 'Admin',
          expiry: null,
          max_devices: 999,
          devices_used: 0
        };
      }
      return keysDB()[license] || null;
    },

    banKey: function (license) {
      if (isAdminKey(license)) return { ok: false, error: 'Cannot ban admin key.' };
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].status = 'banned';
      saveKeys(db);
      return { ok: true };
    },

    unbanKey: function (license) {
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].status = 'active';
      saveKeys(db);
      return { ok: true };
    },

    revokeKey: function (license) {
      if (isAdminKey(license)) return { ok: false, error: 'Cannot revoke admin key.' };
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].status = 'revoked';
      saveKeys(db);
      return { ok: true };
    },

    deleteKey: function (license) {
      if (isAdminKey(license)) return { ok: false, error: 'Cannot delete admin key.' };
      var db = keysDB();
      delete db[license];
      saveKeys(db);
      return { ok: true };
    },

    setKeyExpiry: function (license, ts) {
      if (isAdminKey(license)) return { ok: false, error: 'Cannot set expiry on admin key.' };
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].expiry = ts || null;
      if (db[license].status === 'expired' && ts && ts > Date.now()) {
        db[license].status = 'active';
      }
      saveKeys(db);
      return { ok: true };
    },

    setKeyDevices: function (license, max) {
      if (isAdminKey(license)) return { ok: false, error: 'Cannot change admin key.' };
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].max_devices = parseInt(max, 10) || 1;
      saveKeys(db);
      return { ok: true };
    },

    resetKeyDevices: function (license) {
      var db = keysDB();
      if (!db[license]) return { ok: false, error: 'Key not found.' };
      db[license].devices_used = 0;
      saveKeys(db);
      return { ok: true };
    },

    /* Compatibility shims so existing admin UI code doesn't explode */
    getUsers: function () {
      var keys = keysDB();
      var users = {};
      Object.keys(keys).forEach(function (k) {
        var d = keys[k];
        users[k] = {
          email: k,
          password: '***',
          role: d.role || 'user',
          status: d.status || 'active',
          name: d.name || k,
          createdAt: d.createdAt,
          expiry: d.expiry,
          lastLoginAt: d.lastLoginAt,
          updateCount: d.devices_used || 0,
          key_type: d.key_type
        };
      });
      users[ADMIN_KEY] = {
        email: ADMIN_KEY,
        role: 'admin',
        status: 'active',
        name: 'Admin',
        createdAt: 0,
        expiry: null,
        lastLoginAt: null,
        updateCount: 0
      };
      return users;
    },

    banUser: function (key) { return this.banKey(key); },
    unbanUser: function (key) { return this.unbanKey(key); },
    deleteUser: function (key) { return this.deleteKey(key); },
    promoteUser: function (key) {
      var db = keysDB();
      if (!db[key]) return { ok: false, error: 'Key not found.' };
      db[key].role = 'admin';
      saveKeys(db);
      return { ok: true };
    },
    demoteUser: function (key) {
      var db = keysDB();
      if (!db[key]) return { ok: false, error: 'Key not found.' };
      db[key].role = 'user';
      saveKeys(db);
      return { ok: true };
    },
    setExpiry: function (key, ts) { return this.setKeyExpiry(key, ts); },

    register: function () {
      return { ok: false, error: 'Registration is disabled. Use a license key.' };
    },
    loginOrRegisterGoogle: function () {
      return { ok: false, error: 'Google login is disabled.' };
    },
    addToWhitelist: function () {
      return { ok: false, error: 'Whitelist system removed.' };
    },
    removeFromWhitelist: function () {
      return { ok: false, error: 'Whitelist system removed.' };
    },
    getWhitelist: function () { return []; },

    getAttacks: function () { return attacksDB(); },
    getNotifs: function () { return notifsDB(); },
    saveNotifs: saveNotifs,
    getAnnouncements: function () { return announceDB(); },
    saveAnnouncements: saveAnnounce,

    getRememberedLicense: function () {
      try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch (e) { return ''; }
    },

    getExpiryCountdown: function (expiryTs) {
      if (!expiryTs) return 'Lifetime';
      var now = Date.now();
      if (now > expiryTs) return 'EXPIRED';
      var diff = Math.floor((expiryTs - now) / 1000);
      var days = Math.floor(diff / 86400);
      diff %= 86400;
      var hours = Math.floor(diff / 3600);
      diff %= 3600;
      var minutes = Math.floor(diff / 60);
      var seconds = diff % 60;
      return days + 'd ' + hours + 'h ' + minutes + 'm ' + seconds + 's';
    },


    /* Compatibility aliases used by main.js */
    getCurrentUser: function () {
      return getSession();
    },
    loadRemembered: function () {
      var k = '';
      try { k = localStorage.getItem(REMEMBER_KEY) || ''; } catch (e) {}
      return { email: k, password: '', license: k };
    },
    nameFromEmail: function (v) {
      if (!v) return 'User';
      if (isAdminKey(v)) return 'Admin';
      return String(v).slice(0, 12);
    },
    initialFromEmail: function (v) {
      if (!v) return 'U';
      if (isAdminKey(v)) return 'A';
      return String(v).charAt(0).toUpperCase();
    },
    OWNER_EMAIL: ADMIN_KEY,
    changePassword: function () {
      return { ok: false, error: 'Password login removed. Use license keys.' };
    },
    updateName: function (key, name) {
      var db = keysDB();
      if (isAdminKey(key)) return { ok: true };
      if (!db[key]) return { ok: false, error: 'Key not found.' };
      db[key].name = name || db[key].name;
      saveKeys(db);
      var s = getSession();
      if (s && s.key === key) {
        s.name = name;
        setSession(s);
      }
      return { ok: true };
    },
    _logAttack: function (type, key) {
      var list = attacksDB();
      list.unshift({
        type: type,
        key: (key || '').slice(0, 32),
        time: Date.now(),
        ip: 'client'
      });
      if (list.length > 200) list = list.slice(0, 200);
      saveAttacks(list);
    }
  };

  window.Auth = Auth;
})();
