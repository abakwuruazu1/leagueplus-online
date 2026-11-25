const { json, store, sessionFrom, writeTokenMatches, bodyOf } = require('./_lib');

const MAX_BYTES = 4 * 1024 * 1024;

exports.handler = async event => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-lp-token'
      },
      body: ''
    };
  }
  try {
    if (method === 'POST') {
      if (!writeTokenMatches(event.headers['x-lp-token'] || event.headers['X-Lp-Token'])) {
        return json(401, { ok: false, error: 'Invalid write token' }, { 'access-control-allow-origin': '*' });
      }
      const body = bodyOf(event);
      if (!body || body.length > MAX_BYTES) return json(413, { ok: false, error: 'Snapshot missing or too large' }, { 'access-control-allow-origin': '*' });
      let snapshot;
      try { snapshot = JSON.parse(body); } catch (e) { return json(400, { ok: false, error: 'Invalid JSON' }, { 'access-control-allow-origin': '*' }); }
      if (!snapshot || snapshot.schema !== 1 || !Array.isArray(snapshot.fixtures) || snapshot.source !== 'leagueplus-extension') {
        return json(400, { ok: false, error: 'Unsupported snapshot shape' }, { 'access-control-allow-origin': '*' });
      }
      const s = store();
      await s.set('latest', body);
      await s.setJSON('meta', {
        generatedAt: snapshot.generatedAt || null,
        uploadedAt: Date.now(),
        fixtures: snapshot.fixtures.length,
        bytes: body.length,
        version: snapshot.version || null
      });
      return json(200, { ok: true, bytes: body.length, generatedAt: snapshot.generatedAt || null }, { 'access-control-allow-origin': '*' });
    }

    if (method === 'GET') {
      if (!sessionFrom(event)) return json(401, { ok: false, error: 'PIN login required' });
      const s = store();
      const latest = await s.get('latest', { type: 'text' });
      if (!latest) return json(404, { ok: false, error: 'No snapshot uploaded yet' });
      return {
        statusCode: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*'
        },
        body: typeof latest === 'string' ? latest : JSON.stringify(latest)
      };
    }
    return json(405, { ok: false, error: 'Method not allowed' });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
