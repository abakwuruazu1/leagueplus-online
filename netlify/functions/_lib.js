// Shared auth/storage helpers for the Netlify phone API.
const crypto = require('crypto');

const STORE = 'leagueplus';
const COOKIE = 'lp_session';
const SESSION_MS = 30 * 24 * 3600e3;

function store() {
  // Lazy require so the pure auth helpers can be tested without the Netlify
  // Blobs package installed locally.
  const { getStore } = require('@netlify/blobs');
  return getStore({ name: STORE, consistency: 'strong' });
}
function json(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, extra),
    body: JSON.stringify(body)
  };
}
function timingEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function pinMatches(pin) {
  const hash = process.env.LP_PIN_HASH;
  if (hash) return timingEqual(crypto.createHash('sha256').update(String(pin)).digest('hex'), hash);
  const raw = process.env.LP_PIN;
  return !!raw && timingEqual(String(pin), String(raw));
}
function writeTokenMatches(token) {
  const expected = process.env.LP_WRITE_TOKEN;
  return !!expected && timingEqual(String(token || ''), String(expected));
}
function secret() { return process.env.LP_SESSION_SECRET || ''; }
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const s = secret();
  if (!s) throw new Error('LP_SESSION_SECRET is not configured');
  return crypto.createHmac('sha256', s).update(payload).digest('base64url');
}
function createSession() {
  const payload = b64u(JSON.stringify({ exp: Date.now() + SESSION_MS }));
  return payload + '.' + sign(payload);
}
function verifySession(value) {
  if (!value || !value.includes('.')) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  try {
    const expected = sign(payload);
    if (!timingEqual(sig, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}
function parseCookies(event) {
  const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function sessionFrom(event) {
  const cookies = parseCookies(event);
  return verifySession(cookies[COOKIE]);
}
function sessionCookie(event, value, maxAgeSeconds) {
  const host = String((event && event.headers && event.headers.host) || '');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  return COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + (local ? '' : '; Secure');
}
function clearCookie(event) {
  return sessionCookie(event, '', 0);
}
function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || h['client-ip'] || 'unknown').split(',')[0].trim();
}
async function loginAttempt(ip, success) {
  try {
    const s = store();
    const key = 'auth:' + ip;
    const now = Date.now();
    let rec = await s.get(key, { type: 'json' });
    if (rec && rec.until && rec.until > now) return { blocked: true, until: rec.until };
    if (success) { await s.setJSON(key, { count: 0, until: 0, at: now }); return { blocked: false, remaining: 5 }; }
    const count = (rec && rec.count || 0) + 1;
    const until = count >= 5 ? now + 15 * 60e3 : 0;
    await s.setJSON(key, { count: until ? 0 : count, until, at: now });
    return { blocked: !!until, until, remaining: until ? 0 : Math.max(0, 5 - count) };
  } catch (e) {
    return { blocked: false, remaining: 5, storageError: e.message };
  }
}
function bodyOf(event) {
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  return body;
}
module.exports = {
  STORE, COOKIE, SESSION_MS, store, json, timingEqual, pinMatches, writeTokenMatches,
  createSession, verifySession, parseCookies, sessionFrom, sessionCookie, clearCookie,
  clientIp, loginAttempt, bodyOf
};
