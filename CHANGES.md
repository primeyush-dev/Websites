# YushTools Security Improvements

Drop these three files into your project, replacing the originals.
No other files need to change.

---

## protection/config.php

### 🔑 Turnstile secrets → env vars (HIGH PRIORITY)
Your secret key was hardcoded. If your repo ever leaks or someone reads
your config.php from a backup, your Turnstile token is compromised.

**Fix:** Keys now read from `getenv()` with your hardcoded values as fallback.
Set them in `.htaccess` (Apache/cPanel):
```
SetEnv TURNSTILE_SITE_KEY   0x4AAA...
SetEnv TURNSTILE_SECRET_KEY 0x4AAA...
```
Then remove the fallback values from config.php entirely.

### 🌐 trusted_proxies — now supports CIDR + Cloudflare ranges
Your proxy list was empty, which means if you're behind Cloudflare,
`yush_ip()` was reading the wrong IP header. The fix adds:
- CIDR notation support (e.g. `'104.16.0.0/13'`)
- All Cloudflare IPv4 ranges as comments — just uncomment them

### ⚙️ Tightened limits
| Setting | Before | After |
|---|---|---|
| `login` rate limit | 12/5min | 8/5min |
| `burst` rate limit | 25/5s | 18/5s |
| `crawl_guard` path limit | 35 paths/30s | 25 paths/30s |
| `abuse.block_after` | 4 hits | 3 hits |
| `abuse.block_seconds` | 900s (15min) | 1800s (30min) |
| `bot_detection.score_block` | 16 | 13 |

### 🤖 More blocked bot signatures
Added: newer AI crawlers (perplexitybot, cohere-ai, iaskspider), more
HTTP clients (httpx, httpie, pycurl), vulnerability scanners (nuclei,
acunetix, nessus), and SEO crawlers that slip through older lists.

### 💉 More attack signatures
Added: `waitfor delay` (SQL), `<iframe`, `vbscript:`, `document.write`,
`/etc/shadow`, `/proc/self/environ`, XXE probes (`<!entity`, SSRF
probes (AWS metadata IP `169.254.169.254`, `gopher://`).

### ⏱️ Tarpit
New `tarpit_ms: 2000` setting. Repeat offenders (strikes ≥ 2) get a
2-second sleep before receiving the block response. This wastes scraper
connections and slows automated flood attacks without any cost to
legitimate users (who only ever hit it once).

---

## protection/security.php

### 🌐 CIDR support in `yush_ip()` (new `yush_ip_in_cidr()`)
`trusted_proxies` now supports CIDR ranges, not just exact IPs. This is
required to correctly trust Cloudflare's forwarded headers, since CF
gives you ranges, not individual IPs.

### 🕵️ `yush_headless_spoof_detected()` — new function
Detects requests that claim to be modern Chrome (UA says `Chrome/90+`)
but are missing `Sec-Fetch-Site`, `Sec-Fetch-Mode`, and `Sec-CH-UA`
headers that every real Chromium-based browser sends automatically.

Catches: Puppeteer/Playwright without stealth mode, most commercial
scrapers faking a Chrome UA, and curl/Python scripts adding a fake UA.

Controlled by `bot_detection.block_headless_browser_spoofing: true` in config.

### 🤖 Improved `yush_bot_score()`
New signals:
- `Accept-Encoding` missing → +2 (real browsers always send gzip)
- UA shorter than 20 chars → +3
- UA matches `LibName/version` pattern → +4 (classic scripted client)
- More scripted client markers in the deny list

### 📣 Improved `yush_security_headers()`
- Added `X-Robots-Tag: noindex, noarchive, nosnippet, noimageindex`
  — tells search engines, AI crawlers, and Wayback Machine not to
  index or cache your pages
- HSTS upgraded to `max-age=63072000; includeSubDomains` (2 years, was 1)
- Added `interest-cohort=()` to Permissions-Policy (disables FLoC)

### ⏱️ Tarpit in `yush_block()`
Reads `tarpit_ms` from config. If the offending IP has ≥ 2 strikes,
sleeps up to 5 seconds before sending the block response.

### 🚨 `headless-spoof` added to Telegram alert reasons
New block reason `headless-spoof` fires a Telegram notification like
other attack types.

---

## js/protection.js

### 🤖 Multi-vector automation detection (was: only `navigator.webdriver`)
Now checks 10 signals:
1. `navigator.webdriver` (Selenium / Playwright default)
2. `window.callPhantom` / `window._phantom` (PhantomJS)
3. `window.__nightmare` (NightmareJS)
4. `window.domAutomation` / `domAutomationController` (ChromeDriver)
5. `Buffer` global (Electron / NW.js)
6. Zero plugins (`navigator.plugins.length === 0`)
7. Screen size 0 or tiny (headless default viewport)
8. `navigator.languages` empty array
9. Chrome UA but `window.chrome` absent (Puppeteer without stealth)
10. Notification permission inconsistency (headless Chrome tell)

Fires a `console.warn` when score ≥ 2. Ready to `sendBeacon` to a
server endpoint for adaptive blocking — just uncomment those lines.

### 🖼️ iframe / clickjacking guard
Belt-and-suspenders over the server's `X-Frame-Options` header.
Hides the page and attempts a redirect if loaded inside a frame.

### 🖱️ Context menu on images
Right-click "Save Image As" is blocked on `<img>` elements.
Text and UI elements are unaffected (right-click still works normally).

### 🔍 DevTools detection
Polls every 2 seconds for the outerWidth/innerWidth gap that DevTools
creates. Informational only — logs to console, does not block owners.

---

## What these changes do NOT fix

- **Volumetric DDoS**: PHP only sees requests that reach your host.
  For real floods, use Cloudflare's DDoS protection or your host's WAF.
  The `trusted_proxies` fix at least ensures IP detection is correct when
  behind CF so the rate limiter blocks the right IPs.

- **Content copying**: Public HTML/CSS/JS can always be copied by a
  determined person. The client-side blocks slow down casual attempts.

- **Client auth security**: The security-policy.txt already notes that
  localStorage auth is not a hardened system. If you add server-side
  sessions later, use `yush_start_secure_session()` in session-baseline.php.

---

## 2026-09-16 Admin + Updater fixes

### Admin Panel
- **Allowed Emails (whitelist)**: email only — no full user card. Full details stay under Registered Users.
- **Registered Users buttons**: aligned, wrap cleanly, no overflow.
- **Password**: shows plaintext password (as stored). Strength bar (Low/Good) removed.
- **IP Address**: captures real public IP on login via ipify (stored as `lastIp`).
- **Expiry**: no more calendar picker. Enter days (e.g. `3` = 3 days from now). Countdown runs off timestamp so it ticks even when the site is closed.

### Offset Updater
- Progress bar only moves forward; finishes at 100% when done (no more jumping back).
- `//` comments are never updated (e.g. `// #define ... 0x...` and `// UPDATED 0xA > 0xB` stay untouched).
- Already Latest = offset value identical in old dump and new dump (already up to date).
