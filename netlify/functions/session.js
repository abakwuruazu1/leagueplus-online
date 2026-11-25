const { json, sessionFrom } = require('./_lib');

exports.handler = async event => {
  const s = sessionFrom(event);
  if (!s) return json(401, { ok: false, error: 'PIN login required' });
  return json(200, { ok: true, expiresAt: s.exp });
};
