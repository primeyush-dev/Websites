# YUSH TOOLS — Vercel (static, no PHP)

## Deploy
1. Push this folder to GitHub (or use Vercel CLI).
2. Vercel → New Project → Import → Framework: **Other** / static.
3. Output: project root (contains `index.html`).
4. Deploy.

Or CLI:
```bash
npm i -g vercel
vercel
```

## Login
- License key only (no email/password/signup).
- Admin master key: `YUSH-BUFF` (change in `js/auth.js` → `ADMIN_KEY`).
- Generate user keys in Admin panel (stored in **this browser** localStorage).

## Cloudflare Turnstile
- Widget runs client-side. Set your site key in `js/main.js` (`TURNSTILE_SITE_KEY`).
- Server-side token verify is **not** available on pure static hosting.

## Notes
- No PHP WAF / IP ban APIs on Vercel static.
- All auth is client-side localStorage — fine for a personal tools panel, not for high-security multi-tenant auth.
