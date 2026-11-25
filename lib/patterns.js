// Pattern specialist (Stage 6, Model D).
//
// Discovers interpretable association rules from pre-match features, reports
// support/baseline/observed/CI/p/q and an out-of-sample direction, and only
// exposes a probability adjustment when at least one rule is validated.
// A rule that does not survive the temporal split remains exploratory and is
// disabled for prediction.
const _coreP = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelP = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _statsP = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPModel_P = (typeof LPModel !== 'undefined') ? LPModel : _modelP;
const _LPParse_P = (typeof LPParse !== 'undefined') ? LPParse : _coreP.LPParse;
const _LPStats_P = (typeof LPStats !== 'undefined') ? LPStats : _statsP;

const LPPatterns = (() => {
  const VERSION = 'stage6-patterns-v1';
  const KEYS = ['comp', 'fav', 'prevTotal', 'homeForm', 'awayForm', 'homeOver', 'awayOver'];
  const TARGETS = {
    oneX2: { label: '1X2', classes: [0, 1, 2], names: ['H', 'D', 'A'] },
    ou: { label: 'O/U2.5', classes: [0, 1], names: ['O', 'U'] },
    btts: { label: 'BTTS', classes: [0, 1], names: ['GG', 'NG'] }
  };
  function marketFor(m, cat, selsets) {
    if (Array.isArray(m.market) && m.market.length === 3) return m.market;
    if (!m.odds || !m.sk || !cat) return null;
    const sel = (selsets || {})[m.sk] || m.selStr || '';
    if (!sel) return null;
    try {
      const om = _LPParse_P.oddsMap(m.odds, sel);
      if (!om.size) return null;
      const fp = _LPModel_P.fair(cat, om);
      const p = [fp.get(101), fp.get(102), fp.get(103)];
      if (p.every(x => x != null && Number.isFinite(x) && x >= 0)) {
        const s = p[0] + p[1] + p[2];
        if (s > 0) return p.map(x => x / s);
      }
    } catch (e) { }
    return null;
  }
  function favBucket(p) {
    if (!p) return 'unknown';
    const max = Math.max.apply(null, p), i = p.indexOf(max);
    const side = i === 0 ? 'home' : i === 2 ? 'away' : 'draw';
    return max >= 0.55 ? side + 'Strong' : max >= 0.45 ? side : 'close';
  }
  function formBucket(arr) {
    if (!arr || !arr.length) return 'none';
    const pts = arr.slice(-5).reduce((s, x) => s + x.pts, 0);
    return pts <= 4 ? 'low' : pts <= 9 ? 'mid' : 'high';
  }
  function overBucket(arr) {
    if (!arr || !arr.length) return 'none';
    const a = arr.slice(-5), rate = a.reduce((s, x) => s + x.over, 0) / a.length;
    return rate < 0.34 ? 'low' : rate < 0.67 ? 'mid' : 'high';
  }
  function totalCat(avg) {
    if (!Number.isFinite(avg)) return 'none';
    return avg <= 2.2 ? 'low' : avg <= 3.2 ? 'mid' : 'high';
  }
  function context() { return { form: new Map(), prev: new Map() }; }
  function featuresFor(m, ctx, market) {
    return {
      comp: 'c' + m.comp,
      fav: favBucket(market),
      prevTotal: ctx.prev.get(m.comp) || 'none',
      homeForm: formBucket(ctx.form.get(m.home)),
      awayForm: formBucket(ctx.form.get(m.away)),
      homeOver: overBucket(ctx.form.get(m.home)),
      awayOver: overBucket(ctx.form.get(m.away))
    };
  }
  function updateContext(ctx, ms) {
    const byComp = new Map();
    for (const m of ms) {
      const push = (team, pts, over) => {
        const a = ctx.form.get(team) || []; a.push({ pts, over }); if (a.length > 8) a.shift(); ctx.form.set(team, a);
      };
      const hp = m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0, ap = m.ag > m.hg ? 3 : m.ag === m.hg ? 1 : 0;
      push(m.home, hp, m.total > 2.5 ? 1 : 0);
      push(m.away, ap, m.total > 2.5 ? 1 : 0);
      if (!byComp.has(m.comp)) byComp.set(m.comp, []);
      byComp.get(m.comp).push(m);
    }
    for (const [comp, list] of byComp) ctx.prev.set(comp, totalCat(list.reduce((s, m) => s + m.total, 0) / (list.length || 1)));
  }
  function buildRows(matches, opts = {}) {
    const asOf = Number.isFinite(opts.asOf) ? opts.asOf : Date.now();
    const cat = opts.cat || {};
    const selsets = opts.selsets || {};
    const valid = (matches || []).filter(m => m && Number.isFinite(+m.ts) && +m.ts < asOf && m.hg != null && m.ag != null && Number.isFinite(+m.hg) && Number.isFinite(+m.ag) && (!m.quality || m.quality.status !== 'invalid'))
      .map(m => Object.assign({}, m, { hg: +m.hg, ag: +m.ag, total: +m.hg + +m.ag, outcome: +m.hg > +m.ag ? 0 : +m.hg < +m.ag ? 2 : 1, btts: +m.hg > 0 && +m.ag > 0 ? 1 : 0, roundKey: m.roundKey || (m.game != null ? m.game + ':' + m.roundId : m.comp + ':' + m.roundId) }))
      .sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
    const rounds = new Map();
    for (const m of valid) {
      if (!rounds.has(m.roundKey)) rounds.set(m.roundKey, { ts: m.ts, matches: [] });
      const r = rounds.get(m.roundKey); r.matches.push(m); if (m.ts < r.ts) r.ts = m.ts;
    }
    const ctx = context(), rows = [];
    for (const r of [...rounds.values()].sort((a, b) => a.ts - b.ts)) {
      const current = r.matches.map(m => {
        const market = marketFor(m, cat, selsets);
        const f = featuresFor(m, ctx, market);
        return { m, market, f, y1x2: m.outcome, you: m.total > 2.5 ? 0 : 1, ybtts: m.btts ? 0 : 1, ts: m.ts };
      });
      rows.push(...current);
      updateContext(ctx, r.matches);
    }
    return { rows, ctx, n: rows.length };
  }
  function matchCondition(f, cond) {
    for (const k in cond) if (f[k] !== cond[k]) return false;
    return true;
  }
  function discover(matches, opts = {}) {
    const built = buildRows(matches, opts);
    const rows = built.rows;
    const minSupport = Number.isFinite(opts.minSupport) ? opts.minSupport : 30;
    const cut = Math.max(1, Math.floor(rows.length * 0.6));
    const rules = [];
    const base = {};
    base.oneX2 = [0, 1, 2].map(c => rows.filter(r => r.y1x2 === c).length / Math.max(1, rows.length));
    base.ou = [0, 1].map(c => rows.filter(r => r.you === c).length / Math.max(1, rows.length));
    base.btts = [0, 1].map(c => rows.filter(r => r.ybtts === c).length / Math.max(1, rows.length));
    const combos = [];
    for (const k of KEYS) combos.push([k]);
    for (let i = 0; i < KEYS.length; i++) for (let j = i + 1; j < KEYS.length; j++) combos.push([KEYS[i], KEYS[j]]);
    for (const tkey of Object.keys(TARGETS)) {
      const tdef = TARGETS[tkey];
      const ykey = tkey === 'oneX2' ? 'y1x2' : tkey === 'ou' ? 'you' : 'ybtts';
      for (const keys of combos) {
        const groups = new Map();
        for (const r of rows) {
          const vals = keys.map(k => r.f[k]);
          if (vals.some(v => v == null)) continue;
          const ck = vals.join('|');
          if (!groups.has(ck)) groups.set(ck, { cond: Object.fromEntries(keys.map((k, i) => [k, vals[i]])), rows: [] });
          groups.get(ck).rows.push(r);
        }
        for (const g of groups.values()) {
          const n = g.rows.length;
          if (n < minSupport) continue;
          for (const cls of tdef.classes) {
            const k = g.rows.filter(r => r[ykey] === cls).length, obs = k / n, b = base[tkey][cls];
            if (!(b > 0 && b < 1)) continue;
            const se = Math.sqrt(b * (1 - b) / n), z = (obs - b) / se, p = _LPStats_P.zTwoSided(z);
            const ci = _LPStats_P.wilson(k, n);
            const tr = g.rows.filter((_, i) => i < cut), te = g.rows.filter((_, i) => i >= cut);
            const trObs = tr.length ? tr.filter(r => r[ykey] === cls).length / tr.length : null;
            const teObs = te.length ? te.filter(r => r[ykey] === cls).length / te.length : null;
            const same = trObs != null && teObs != null ? (trObs - b) * (teObs - b) > 0 : null;
            rules.push({
              id: tkey + ':' + cls + ':' + Object.entries(g.cond).map(([a, b2]) => a + '=' + b2).join('&'),
              target: tkey, targetLabel: tdef.label, class: cls, className: tdef.names[cls],
              condition: g.cond, description: Object.entries(g.cond).map(([a, b2]) => a + '=' + b2).join(' & ') + ' → ' + tdef.label + '=' + tdef.names[cls],
              n, baseline: b, observed: obs, diff: obs - b, lift: b ? obs / b : null, ci,
              p, q: null, oos: { n: te.length, observed: teObs, baseline: b, sameDirection: same },
              status: 'exploratory'
            });
          }
        }
      }
    }
    const finite = rules.filter(r => Number.isFinite(r.p));
    const q = _LPStats_P.bh(finite.map(r => r.p));
    finite.forEach((r, i) => { r.q = q[i]; });
    for (const r of rules) {
      if (!Number.isFinite(r.p) || r.n < minSupport) r.status = 'insufficient';
      else if (r.p < 0.05 && r.q != null && r.q < 0.1 && Math.abs(r.diff) >= 0.05 && r.oos.sameDirection === true && r.oos.n >= Math.max(10, Math.floor(minSupport / 2)) && r.n >= minSupport * 2) r.status = 'validated';
      else if (r.p < 0.05) r.status = 'exploratory';
      else r.status = 'not_supported';
    }
    rules.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    return {
      version: VERSION, n: rows.length, minSupport, base, ctx: built.ctx, rules,
      validated: rules.filter(r => r.status === 'validated'),
      exploratory: rules.filter(r => r.status === 'exploratory'),
      candidates: rules.slice(0, 200)
    };
  }
  function predict(state, m, baseProbs, opts = {}) {
    if (!state || !state.validated || !state.validated.length) return { enabled: false, reason: 'no validated rules', probs1x2: null, probsOU: null, probsBTTS: null };
    const market = opts.market || baseProbs.oneX2 || null;
    const f = featuresFor(m, state.ctx, market);
    const out = {};
    const used = [];
    const apply = (target, base, key) => {
      if (!base) return null;
      const rules = state.validated.filter(r => r.target === target && matchCondition(f, r.condition));
      if (!rules.length) return null;
      const p = base.slice();
      for (const r of rules) {
        const w = Math.min(0.3, r.n / (r.n + 50)) * Math.min(1, Math.abs(r.diff) / 0.1);
        p[r.class] += w * r.diff;
        used.push(r.id);
      }
      const s = p.reduce((a, b) => a + Math.max(0, b), 0);
      return s > 0 ? p.map(x => Math.max(0, x) / s) : null;
    };
    const p1 = apply('oneX2', baseProbs.oneX2, 'probs1x2');
    const pou = apply('ou', baseProbs.ou, 'probsOU');
    const pb = apply('btts', baseProbs.btts, 'probsBTTS');
    return { enabled: !!(p1 || pou || pb), probs1x2: p1, probsOU: pou, probsBTTS: pb, usedRules: used, features: f };
  }
  return { VERSION, KEYS, TARGETS, buildRows, discover, predict, featuresFor, context, updateContext };
})();
if (typeof module !== 'undefined') module.exports = LPPatterns;
