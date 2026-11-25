// Chronological model-evaluation harness (Stage 5).
//
// Expands the window with each test round; models see only information before
// that round. Compares historical frequencies, market fair odds, market-fitted
// Poisson, team ratings, Dixon-Coles, empirical/Bayesian and the equal ensemble.
const _coreE = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelE = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _statsE = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPModel_E = (typeof LPModel !== 'undefined') ? LPModel : _modelE;
const _LPStats_E = (typeof LPStats !== 'undefined') ? LPStats : _statsE;

const LPModelEval = (() => {
  const VERSION = 'stage5-eval-v1';
  const MODELS = ['base', 'market', 'mkt', 'team', 'dc', 'emp', 'blend', 'ensemble'];
  const LABELS = { base: 'historical base', market: 'market fair', mkt: 'market Poisson', team: 'team ratings', dc: 'Dixon-Coles', emp: 'empirical/Bayesian', blend: 'blend(team,mkt)', ensemble: 'equal ensemble' };

  function prep(matches) {
    const out = [];
    for (const m of (matches || [])) {
      if (!m || !Number.isFinite(+m.ts) || m.hg == null || m.ag == null || !Number.isFinite(+m.hg) || !Number.isFinite(+m.ag)) continue;
      if (m.quality && m.quality.status === 'invalid') continue;
      out.push(Object.assign({}, m, {
        hg: +m.hg, ag: +m.ag, total: +m.hg + +m.ag, outcome: +m.hg > +m.ag ? 0 : +m.hg < +m.ag ? 2 : 1,
        btts: +m.hg > 0 && +m.ag > 0 ? 1 : 0,
        roundKey: m.roundKey || (m.game != null ? m.game + ':' + m.roundId : m.comp + ':' + m.roundId)
      }));
    }
    out.sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
    const rmap = new Map();
    for (const m of out) {
      if (!rmap.has(m.roundKey)) rmap.set(m.roundKey, { key: m.roundKey, ts: m.ts, roundId: m.roundId, matches: [] });
      const r = rmap.get(m.roundKey);
      r.matches.push(m);
      if (m.ts < r.ts) r.ts = m.ts;
    }
    return { matches: out, rounds: [...rmap.values()].sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0)) };
  }
  function baseCounts(ms) {
    const hda = [1, 1, 1], ou = [1, 1], btts = [1, 1];
    for (const m of ms) {
      hda[m.outcome]++; if (m.total > 2.5) ou[0]++; else ou[1]++; if (m.btts) btts[0]++; else btts[1]++;
    }
    const norm = a => { const s = a.reduce((x, y) => x + y, 0); return a.map(x => x / s); };
    return { hda: norm(hda), ou: norm(ou), btts: norm(btts) };
  }
  function loss3(p, y) {
    if (!p || p.length !== 3 || !Number.isFinite(y)) return null;
    let b = 0; for (let i = 0; i < 3; i++) b += (p[i] - (i === y ? 1 : 0)) ** 2;
    return b;
  }
  function loss2(p, y) {
    if (!p || p.length !== 2 || !Number.isFinite(y)) return null;
    return (p[0] - (y === 0 ? 1 : 0)) ** 2 + (p[1] - (y === 1 ? 1 : 0)) ** 2;
  }
  function ll(probs, y) {
    if (!probs || !Number.isFinite(y) || !probs[y]) return null;
    return -Math.log(Math.max(1e-12, Math.min(1 - 1e-12, probs[y])));
  }

  function evaluate(opts = {}) {
    const cfg = (opts.options && typeof opts.options === 'object') ? Object.assign({}, opts, opts.options) : opts;
    const data = prep(opts.matches || cfg.matches || []);
    const cat = opts.cat || cfg.cat || {};
    const selsets = opts.selsets || cfg.selsets || {};
    const minTrainRounds = Number.isFinite(cfg.minTrainRounds) ? cfg.minTrainRounds : 10;
    const minCompMatches = Number.isFinite(cfg.minCompMatches) ? cfg.minCompMatches : 20;
    const maxTestRounds = Number.isFinite(cfg.maxTestRounds) ? cfg.maxTestRounds : 500;
    const halfLifeH = Number.isFinite(cfg.halfLifeH) ? cfg.halfLifeH : 6;
    const fairMethod = cfg.fairMethod || 'proportional';
    const B = Number.isFinite(cfg.permutations) ? cfg.permutations : 299;
    const seed = Number.isFinite(cfg.seed) ? cfg.seed : 20261124;
    const testRounds = data.rounds.slice(minTrainRounds, minTrainRounds + maxTestRounds);
    const byMarket = {}, byModel = {}, losses1x2 = {}, comparisons = [];
    const warnings = [], checks = [];
    let testMatches = 0, testRoundsUsed = 0, trainNTotal = 0;
    for (const round of testRounds) {
      const testStart = round.ts;
      const train = data.matches.filter(m => m.ts < testStart);
      if (train.length < 50) continue;
      const comps = [...new Set(round.matches.map(m => +m.comp).filter(Number.isFinite))];
      let usedRound = false;
      for (const comp of comps) {
        const hist = train.filter(m => +m.comp === comp);
        if (hist.length < minCompMatches) continue;
        const T = _LPModel_E.fitDC(hist, testStart, { halfLifeH, seasonMode: 'auto', empirical: true });
        const trainCutoff = hist.length ? Math.max.apply(null, hist.map(m => m.ts)) : null;
        checks.push({ round: round.key, comp, trainN: hist.length, testStart, trainCutoff, leakage: !(trainCutoff == null || trainCutoff < testStart) });
        if (trainCutoff != null && trainCutoff >= testStart) warnings.push('Training cutoff at/after test start in round ' + round.key + ' comp ' + comp);
        trainNTotal += hist.length;
        const base = baseCounts(hist);
        for (const m of round.matches.filter(x => +x.comp === comp)) {
          if (!m.odds || !m.sk || !selsets[m.sk]) continue;
          let ev;
          try { ev = _LPModel_E.evaluate(cat, m, selsets[m.sk], T, { fairMethod }); } catch (e) { continue; }
          const byId = new Map(ev.rows.map(r => [r.id, r]));
          const markets = [
            { name: '1X2', ids: [101, 102, 103], y: m.outcome, base: base.hda, kind: 3 },
            { name: 'OU2.5', ids: [109, 110], y: m.total > 2.5 ? 0 : 1, base: base.ou, kind: 2 },
            { name: 'BTTS', ids: [107, 108], y: m.btts ? 0 : 1, base: base.btts, kind: 2 }
          ];
          if (typeof cfg.onFixture === 'function') {
            try { cfg.onFixture({ round, comp, m, ev, base, byId, markets, T }); }
            catch (e) { warnings.push('onFixture callback failed: ' + e.message); }
          }
          const l1 = {};
          for (const mk of markets) {
            const rows = mk.ids.map(id => byId.get(id));
            if (rows.some(r => !r)) continue;
            const probs = {
              base: mk.base,
              market: rows.map(r => r.fair),
              mkt: rows.map(r => r.mkt),
              team: rows.map(r => r.team),
              dc: rows.map(r => r.dc),
              emp: rows.map(r => r.emp),
              blend: rows.map(r => r.blend),
              ensemble: rows.map(r => r.ensemble)
            };
            for (const model of MODELS) {
              const p = probs[model];
              if (!p || p.some(x => x == null || !Number.isFinite(x))) continue;
              const l = mk.kind === 3 ? loss3(p, mk.y) : loss2(p, mk.y);
              const lg = ll(p, mk.y);
              if (l == null || lg == null) continue;
              const bm = (byMarket[mk.name] = byMarket[mk.name] || {});
              const cell = (bm[model] = bm[model] || { n: 0, brier: 0, logLoss: 0 });
              cell.n++; cell.brier += l; cell.logLoss += lg;
              const bmo = (byModel[model] = byModel[model] || { n: 0, brier: 0, logLoss: 0 });
              bmo.n++; bmo.brier += l; bmo.logLoss += lg;
              if (mk.name === '1X2') l1[model] = lg;
            }
            usedRound = true;
          }
          for (const model of MODELS) (losses1x2[model] = losses1x2[model] || []).push(Number.isFinite(l1[model]) ? l1[model] : null);
          testMatches++;
        }
      }
      if (usedRound) testRoundsUsed++;
    }
    for (const mk of Object.values(byMarket)) for (const key of Object.keys(mk)) {
      const c = mk[key]; if (c.n) { c.brier /= c.n; c.logLoss /= c.n; c.avg = null; }
    }
    for (const key of Object.keys(byModel)) {
      const c = byModel[key];
      if (c.n) {
        c.brier /= c.n; c.logLoss /= c.n;
      }
    }
    const leaderboard = Object.entries(byModel).filter(([, v]) => v.n > 0)
      .map(([model, v]) => ({ model, n: v.n, brier: v.brier, logLoss: v.logLoss }))
      .sort((a, b) => a.logLoss - b.logLoss);
    // Paired comparison of the 1X2 log loss against market.
    const marketLoss = losses1x2.market || [];
    for (const model of MODELS) {
      if (model === 'market' || !losses1x2[model] || !marketLoss.length) continue;
      const pairs = losses1x2[model].map((x, i) => [x, marketLoss[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      if (pairs.length < 20) continue;
      const a = pairs.map(p => p[0]), b = pairs.map(p => p[1]);
      const d = _LPStats_E.pairedBootstrapDiff(a, b, _LPStats_E.mean, B, 0.05, seed + model.length);
      comparisons.push({ model, vs: 'market', n: a.length, diffLogLoss: d.diff, low: d.low, high: d.high, p: d.p, improves: d.diff < 0 });
    }
    const cp = comparisons.filter(c => Number.isFinite(c.p));
    const q = _LPStats_E.bh(cp.map(c => c.p));
    cp.forEach((c, i) => { c.q = q[i]; });
    if (!testRoundsUsed) warnings.push('No test rounds had enough training data; increase the recorded history or lower minTrainRounds.');
    if (!testMatches) warnings.push('No test matches had usable odds and selection sets.');
    if (testRoundsUsed > 0 && (testRoundsUsed < 20 || testMatches < 500)) warnings.push('Small evaluation sample (' + testRoundsUsed + ' test rounds, ' + testMatches + ' matches); treat model differences as provisional.');
    const leak = checks.filter(c => c.leakage);
    if (leak.length) warnings.push(leak.length + ' training-cutoff leakage check(s) failed.');
    return {
      meta: { version: VERSION, generatedAt: Date.now(), matches: data.matches.length, rounds: data.rounds.length, testRounds: testRoundsUsed, testMatches, trainNTotal, minTrainRounds, minCompMatches, fairMethod, permutations: B, seed, models: MODELS, labels: LABELS, warnings },
      byModel,
      byMarket,
      leaderboard,
      comparisons,
      checks,
      warnings
    };
  }

  return { VERSION, MODELS, LABELS, evaluate, prep };
})();
if (typeof module !== 'undefined') module.exports = LPModelEval;
