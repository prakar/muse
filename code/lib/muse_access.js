'use strict';
// Who may reach the Muse server, and who may change things on it. Standard library only.
//
// HOW THIS DESIGN CHANGED (read this before changing it again)
//   v1, closed to this machine:  muse_app.js listened on a hard-coded '127.0.0.1', and muse_server.js answered only requests whose Host header
//        was localhost or 127.0.0.1 (anything else got 421). Nothing but this machine could connect: a NAT written into the code. The Host
//        check also defended against DNS rebinding (a page on another site pointing its own hostname at this machine to reach a private server).
//   v2, open by design (this file):  the notes are curated public facts, so the server listens on MUSE_HOST, which defaults to '0.0.0.0'
//        (every network interface: the LAN, and the internet if the router forwards a port). What still needs protecting is the author's own
//        data and the machine: the Admin page (it starts jobs that spend money and can restore backups) and every call that writes (marks,
//        tray, events). From another machine those need a login. Reading stays open.
//   Requests from this machine itself (loopback address, no proxy headers) stay trusted, so local development needs no login.
//   Set MUSE_HOST=127.0.0.1 to get the v1 behaviour back, Host check included.
//
// THE LOGIN IS DELIBERATELY SIMPLE. One shared password, kept as plain text in the server's .env (git-ignored, chmod 600), set with
//   node code/muse_set_password.js
// That is proportionate: the notes are public, and what the login guards is the author's marks and a few maintenance jobs, not personal data.
// The hardened versions are written, tested and OFF. Flip them on with one setting each; no code to uncomment:
//   hashed password   set MUSE_ADMIN_PASSWORD_HASH (made by  node code/muse_hash_password.js ) and remove MUSE_ADMIN_PASSWORD. The server then
//                     compares against an scrypt hash, so the .env holds nothing that can be read back as the password. The hash wins if both are set.
//   lockout           set MUSE_LOGIN_LOCKOUT=on: five wrong passwords lock that address for five minutes.
//   https             set MUSE_TLS_KEY and MUSE_TLS_CERT (muse_app.js). Needed before the login crosses any network you do not own: Basic auth over
//                     plain http sends the password in every request.
//
// Settings (environment):
//   MUSE_HOST                   address to listen on. Default 0.0.0.0 (all interfaces). 127.0.0.1 = this machine only.
//   MUSE_ADMIN_USER             login name, default "admin"
//   MUSE_ADMIN_PASSWORD         the login password, plain text (active mode). Without any password set, protected calls from other machines
//                               answer 403 (locked, never open).
//   MUSE_ADMIN_PASSWORD_HASH    optional hardened mode, see above
//   MUSE_LOGIN_LOCKOUT          optional: "on" turns the lockout on
//   MUSE_ALLOWED_HOSTS          optional comma list of host names the server answers to (defence against DNS rebinding when it is open)
const crypto = require('crypto');

const OPEN_HOST = '0.0.0.0';                                                  // v2 default. v1 was the literal '127.0.0.1'.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;                                 // used only when MUSE_LOGIN_LOCKOUT=on

const resolveHost = env => String(env.MUSE_HOST || OPEN_HOST).trim();
const isLoopbackHost = h => LOOPBACK_HOSTS.has(String(h).toLowerCase());

// ---- Hardened mode (off unless MUSE_ADMIN_PASSWORD_HASH is set) ----
// A stored hash looks like  scrypt:16384:8:1:<salt>:<hash>  (base64url, so no character a shell or a systemd EnvironmentFile would treat specially).
function hashPassword(pw, { N = 16384, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16), h = crypto.scryptSync(String(pw), salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), h.toString('base64url')].join(':');
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, s, h] = String(stored || '').split(':');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64url');
  let got; try { got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), want.length, { N: +N, r: +r, p: +p }); } catch (e) { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// ---- Active mode: a plain-text comparison (both sides are digested first so the comparison takes the same time whatever matches) ----
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// isLocal is injectable so tests can pretend a request came from another machine.
function createAccess({ env = process.env, host, isLocal, now = Date.now } = {}) {
  host = host || resolveHost(env);
  const loopbackOnly = isLoopbackHost(host), user = env.MUSE_ADMIN_USER || 'admin', hash = env.MUSE_ADMIN_PASSWORD_HASH || '', plain = env.MUSE_ADMIN_PASSWORD || '';
  const mode = hash ? 'hashed' : plain ? 'plain' : 'none', lockout = String(env.MUSE_LOGIN_LOCKOUT || '').toLowerCase() === 'on';
  const checkPassword = pw => mode === 'hashed' ? verifyPassword(pw, hash) : sameText(pw, plain);
  const allowed = env.MUSE_ALLOWED_HOSTS ? env.MUSE_ALLOWED_HOSTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  // A proxy in front of Muse makes every request look local, so a request that carries proxy headers is treated as remote.
  const local = isLocal || (req => LOCAL_ADDRESSES.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded);
  const fails = new Map();                                                    // address -> { n, until }; used only with the lockout

  // v1 ran this check for every request. v2 runs it only when listening on loopback, or when MUSE_ALLOWED_HOSTS names the hosts.
  function hostAllowed(req) {
    const h = String(req.headers.host || '').toLowerCase();
    if (allowed) return allowed.includes(h.replace(/:\d+$/, ''));
    if (loopbackOnly) return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
    return true;
  }

  // For the calls that change things. Returns { ok:true } or { ok:false, status, message, challenge?, retryAfter? }.
  function authorize(req) {
    if (local(req)) return { ok: true, via: 'local' };
    if (mode === 'none') return { ok: false, status: 403, message: 'This is locked: the author has not set a login on this server (node code/muse_set_password.js).' };
    const ip = req.socket.remoteAddress || '?', t = now(), f = fails.get(ip);
    if (lockout && f && f.until > t) return { ok: false, status: 429, retryAfter: Math.ceil((f.until - t) / 1000), message: 'Too many wrong passwords. Try again in a few minutes.' };
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization || '');
    if (!m) return { ok: false, status: 401, challenge: true, message: 'Log in to do this. Only the author can.' };      // no credentials yet: not a failed attempt
    const raw = Buffer.from(m[1], 'base64').toString('utf8'), i = raw.indexOf(':');
    const userOk = sameText(i < 0 ? raw : raw.slice(0, i), user), pwOk = checkPassword(i < 0 ? '' : raw.slice(i + 1));   // both always run
    if (userOk && pwOk) { fails.delete(ip); return { ok: true, via: 'login' }; }
    if (lockout) {
      if (fails.size > 1000) fails.clear();
      const n = (f && !(f.until && f.until <= t) ? f.n : 0) + 1;              // an old finished lock starts the count again
      fails.set(ip, n >= MAX_FAILS ? { n: 0, until: t + LOCK_MS } : { n, until: 0 });
    }
    return { ok: false, status: 401, challenge: true, message: 'Wrong name or password.' };
  }

  return { host, loopbackOnly, user, mode, lockout, loginConfigured: mode !== 'none', allowedHosts: allowed, hostAllowed, authorize };
}

module.exports = { createAccess, hashPassword, verifyPassword, resolveHost, isLoopbackHost, OPEN_HOST };
