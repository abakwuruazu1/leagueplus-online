const { json, pinMatches, createSession, sessionCookie, clientIp, loginAttempt, bodyOf, SESSION_MS } = require('./_lib');

exports.handler = async event => {
  if ((event.httpMethod || '').toUpperCase() !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!process.env.LP_PIN_HASH && !process.env.LP_PIN) return json(500, { ok: false, error: 'LP_PIN or LP_PIN_HASH is not configured' });
  if (!process.env.LP_SESSION_SECRET) return json(500, { ok: false, error: 'LP_SESSION_SECRET is not configured' });
  let pin = '';
  try { pin = String((JSON.parse(bodyOf(event)) || {}).pin || ''); } catch (e) { return json(400, { ok: false, error: 'Invalid request' }); }
  const ip = clientIp(event);
  const attempt = await loginAttempt(ip, false);
  if (attempt.blocked) return json(429, { ok: false, error: 'Too many attempts. Try again later.', retryAt: attempt.until });
  if (!pin || !pinMatches(pin)) return json(401, { ok: false, error: 'Invalid PIN', attemptsLeft: attempt.remaining });
  await loginAttempt(ip, true);
  const value = createSession();
  return json(200, { ok: true }, {
    'set-cookie': sessionCookie(event, value, Math.floor(SESSION_MS / 1000))
  });
};
