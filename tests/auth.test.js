const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const A = require('../netlify/functions/_lib.js');

test('PIN and write-token checks use the configured secrets', () => {
  const oldPin = process.env.LP_PIN, oldHash = process.env.LP_PIN_HASH, oldToken = process.env.LP_WRITE_TOKEN;
  process.env.LP_PIN = '246810';
  delete process.env.LP_PIN_HASH;
  process.env.LP_WRITE_TOKEN = 'write-secret';
  assert.equal(A.pinMatches('246810'), true);
  assert.equal(A.pinMatches('000000'), false);
  assert.equal(A.writeTokenMatches('write-secret'), true);
  assert.equal(A.writeTokenMatches('wrong'), false);
  process.env.LP_PIN_HASH = crypto.createHash('sha256').update('135790').digest('hex');
  delete process.env.LP_PIN;
  assert.equal(A.pinMatches('135790'), true);
  assert.equal(A.pinMatches('246810'), false);
  process.env.LP_PIN = oldPin; process.env.LP_PIN_HASH = oldHash; process.env.LP_WRITE_TOKEN = oldToken;
});

test('signed sessions verify, expire and reject tampering', () => {
  const old = process.env.LP_SESSION_SECRET;
  process.env.LP_SESSION_SECRET = 'session-secret';
  const value = A.createSession();
  const parsed = A.verifySession(value);
  assert.ok(parsed && parsed.exp > Date.now());
  assert.equal(A.verifySession(value + 'x'), null);
  const [payload] = value.split('.');
  assert.equal(A.verifySession(payload + '.bad'), null);
  process.env.LP_SESSION_SECRET = old;
});

test('cookies are HttpOnly and Secure outside localhost', () => {
  process.env.LP_SESSION_SECRET = 'session-secret';
  const local = A.sessionCookie({ headers: { host: 'localhost:8888' } }, 'abc', 60);
  const remote = A.sessionCookie({ headers: { host: 'example.netlify.app' } }, 'abc', 60);
  assert.match(local, /HttpOnly/);
  assert.doesNotMatch(local, /Secure/);
  assert.match(remote, /Secure/);
  assert.match(remote, /SameSite=Lax/);
  assert.match(A.clearCookie({ headers: { host: 'example.netlify.app' } }), /Max-Age=0/);
});
