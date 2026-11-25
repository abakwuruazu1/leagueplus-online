// Sequence / transition specialist (Stage 6, Model C).
//
// The model learns the conditional per-match scoring level of the next round
// from the previous round's scoring level. It is deliberately low-dimensional:
// a round is a shared environment, and a high-dimensional sequence model would
// overfit quickly. The specialist is only allowed into production if the
// walk-forward evaluator finds incremental out-of-sample value.
const _coreS = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelS = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _LPModel_S = (typeof LPModel !== 'undefined') ? LPModel : _modelS;
const _LPParse_S = (typeof LPParse !== 'undefined') ? LPParse : _coreS.LPParse;

const LPSequence = (() => {
  const VERSION = 'stage6-sequence-v1';
  const CATS = ['low', 'mid', 'high'];
  function cat(totalPerMatch) {
    if (!Number.isFinite(totalPerMatch)) return null;
    return totalPerMatch <= 2.2 ? 'low' : totalPerMatch <= 3.2 ? 'mid' : 'high';
  }
  function prepare(matches, asOf) {
    const out = [];
    for (const m of (matches || [])) {
      if (!m || !Number.isFinite(+m.ts) || +m.ts >= asOf) continue;
      if (m.hg == null || m.ag == null || !Number.isFinite(+m.hg) || !Number.isFinite(+m.ag)) continue;
      if (m.quality && m.quality.status === 'invalid') continue;
      out.push(Object.assign({}, m, {
        hg: +m.hg, ag: +m.ag, total: +m.hg + +m.ag,
        roundKey: m.roundKey || (m.game != null ? m.game + ':' + m.roundId : m.comp + ':' + m.roundId)
      }));
    }
    out.sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
    return out;
  }
  function fit(matches, opts = {}) {
    const asOf = Number.isFinite(opts.asOf) ? opts.asOf : Date.now();
    const ms = prepare(matches, asOf);
    const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 20;
    const byComp = {};
    const global = { n: ms.length, total: 0, h: 0, a: 0 };
    for (const m of ms) { global.total += m.total; global.h += m.hg; global.a += m.ag; }
    const gMu = global.n ? global.total / global.n : 2.5;
    const gMuH = global.n ? global.h / global.n : 1.4;
    const gMuA = global.n ? global.a / global.n : 1.1;
    const groups = new Map();
    for (const m of ms) {
      const key = m.comp;
      if (!groups.has(key)) groups.set(key, new Map());
      const rmap = groups.get(key);
      if (!rmap.has(m.roundKey)) rmap.set(m.roundKey, { key: m.roundKey, roundId: m.roundId, ts: m.ts, matches: [] });
      const r = rmap.get(m.roundKey); r.matches.push(m); if (m.ts < r.ts) r.ts = m.ts;
    }
    for (const [comp, rmap] of groups) {
      const rounds = [...rmap.values()].sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
      const n = rounds.reduce((s, r) => s + r.matches.length, 0);
      let total = 0, h = 0, a = 0;
      for (const r of rounds) for (const m of r.matches) { total += m.total; h += m.hg; a += m.ag; }
      const mu = n ? total / n : gMu, muH = n ? h / n : gMuH, muA = n ? a / n : gMuA;
      const cells = {}; CATS.forEach(c => { cells[c] = { n: 0, sum: 0 }; });
      for (let i = 1; i < rounds.length; i++) {
        const prev = rounds[i - 1], cur = rounds[i];
        const pc = cat(prev.matches.length ? prev.matches.reduce((s, m) => s + m.total, 0) / prev.matches.length : null);
        if (!pc) continue;
        const c = cells[pc], nextAvg = cur.matches.length ? cur.matches.reduce((s, m) => s + m.total, 0) / cur.matches.length : null;
        if (!Number.isFinite(nextAvg)) continue;
        c.n++; c.sum += nextAvg;
      }
      const means = {};
      CATS.forEach(c => { means[c] = (cells[c].sum + alpha * mu) / (cells[c].n + alpha); });
      const last = rounds.length ? rounds[rounds.length - 1] : null;
      const lastAvg = last && last.matches.length ? last.matches.reduce((s, m) => s + m.total, 0) / last.matches.length : null;
      byComp[comp] = {
        comp, n, rounds: rounds.length, mu, muH, muA, cells, means,
        lastCat: cat(lastAvg), lastAvg, lastRound: last ? last.key : null,
        minCatN: Math.min.apply(null, CATS.map(c => cells[c].n))
      };
    }
    return { version: VERSION, asOf, n: ms.length, gMu, gMuH, gMuA, byComp, alpha };
  }
  function predict(state, fx, catObj, selStr) {
    if (!state || !fx) return { probs: null, reason: 'no state' };
    const c = state.byComp[fx.comp];
    if (!c) return { probs: null, reason: 'no competition state' };
    const lc = c.lastCat;
    const seqTotal = lc ? c.means[lc] : c.mu;
    const usable = !!(lc && c.cells[lc] && c.cells[lc].n >= 5);
    const scale = c.mu > 0 ? seqTotal / c.mu : 1;
    const lh = c.muH * scale, la = c.muA * scale;
    let probs = null;
    try {
      const om = _LPParse_S.oddsMap(fx.odds, selStr || '');
      if (om.size) probs = _LPModel_S.selProbs(catObj, [...om.keys()], lh, la);
    } catch (e) { }
    return {
      probs, lh, la, seqTotal, scale, lastCat: lc, lastAvg: c.lastAvg,
      cellN: lc && c.cells[lc] ? c.cells[lc].n : 0, usable,
      reason: usable ? 'conditional round state' : 'fallback league scoring level'
    };
  }
  return { VERSION, CATS, cat, fit, predict, prepare };
})();
if (typeof module !== 'undefined') module.exports = LPSequence;
