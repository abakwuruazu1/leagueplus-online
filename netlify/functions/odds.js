// Netlify function: fetch the current Bet9ja League Plus round and return the
// upcoming fixtures, selection sets and raw catalogue definitions.
//
// The function is intentionally read-only and cacheable. It does not place
// bets and does not persist anything.
const { LPParse } = require('../../lib/core.js');

const API = 'https://stadium-tv-api.bet9ja.com';

async function api(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(API + path, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (LeaguePlusSlipBuilder/1.0)'
      }
    });
    if (!r.ok) throw new Error('Bet9ja returned HTTP ' + r.status);
    const j = await r.json();
    if (j && j.status !== undefined && j.status !== 1) throw new Error('Bet9ja status ' + j.status);
    return j.data;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async () => {
  try {
    const init = await api('/game/init');
    const fixtures = [], selsets = {}, warnings = [];
    const games = (init.games || []).filter(g => g && g.id != null);
    for (const game of games) {
      try {
        const d = await api('/game/' + game.id + '/round');
        if (!d || !d.round) continue;
        const u = LPParse.upcoming(game.id, d.round, { capturedAt: Date.now() });
        for (const f of u.fixtures) {
          f.gameName = game.name || ('Game ' + game.id);
          fixtures.push(f);
        }
        Object.assign(selsets, u.selsets);
      } catch (e) {
        warnings.push('Game ' + game.id + ': ' + e.message);
      }
    }
    const body = JSON.stringify({
      generatedAt: Date.now(),
      source: 'Bet9ja League Plus public round endpoint',
      catalogue: {
        markets: init.markets || [],
        roundSpecialMarkets: init.roundSpecialMarkets || [],
        extraMarkets: init.extraMarkets || []
      },
      games: init.games || [],
      fixtures,
      selsets,
      warnings
    });
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=30, s-maxage=30',
        'access-control-allow-origin': '*'
      },
      body
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: e.message || 'Could not load Bet9ja round' })
    };
  }
};
