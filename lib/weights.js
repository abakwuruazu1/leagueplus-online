// Adaptive model weights (Stage 7).
//
// Fits non-negative weights for the available probability models (mkt, DC,
// empirical, team), shrinks them toward equal weights, and only reports them as
// usable when they beat the equal ensemble in a chronological walk-forward
// comparison with paired bootstrap uncertainty and BH correction.
const _statsW = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPStats_W = (typeof LPStats !== 'undefined') ? LPStats : _statsW;

const LPWeights = (() => {
  const VERSION = 'stage7-weights-v1';
  const MODELS = ['mkt', 'dc', 'emp', 'team'];
  const LABELS = { mkt: 'market Poisson', dc: 'Dixon-Coles', emp: 'empirical/Bayesian', team: 'team ratings' };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function valid(samples) {
    const out = [];
    for (const s of (samples || [])) {
      if (!s || (!s.models && !s.p) || (+s.y !== 0 && +s.y !== 1)) continue;
      const probs = s.models || s.p;
      let any = false;
      for (const m of MODELS) { const p = probs[m]; if (p != null && Number.isFinite(+p) && +p > 0 && +p < 1) any = true; }
      if (!any) continue;
      out.push({ y: +s.y, p: probs, ts: Number.isFinite(+s.ts) ? +s.ts : null, roundKey: s.roundKey || null, market: s.market || null });
    }
    return out;
  }
  function logLoss(p, y) { const q = clamp(p, 1e-12, 1 - 1e-12); return y ? -Math.log(q) : -Math.log(1 - q); }
  function equalWeights(models = MODELS) { const o = {}; models.forEach(m => { o[m] = 1 / models.length; }); return o; }
  function meanAvailable(pObj) {
    const vals = MODELS.map(m => pObj[m]).filter(x => x != null && Number.isFinite(+x) && +x >= 0 && +x <= 1).map(Number);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function apply(weights, pObj) {
    if (!weights || !pObj) return null;
    let sum = 0, z = 0;
    for (const m of MODELS) {
      const w = +weights[m], p = pObj[m];
      if (!(w > 0) || p == null || !Number.isFinite(+p)) continue;
      sum += w; z += w * +p;
    }
    return sum > 0 ? clamp(z / sum, 0, 1) : null;
  }

  function fit(samples, opts = {}) {
    const rows = valid(samples);
    const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 20;
    const counts = {}; MODELS.forEach(m => { counts[m] = rows.filter(s => s.p[m] != null && Number.isFinite(+s.p[m])).length; });
    const active = MODELS.filter(m => counts[m] >= minCount);
    if (rows.length < 20 || active.length < 2) {
      return { version: VERSION, insufficient: true, n: rows.length, counts, active, weights: equalWeights(active.length ? active : MODELS), reason: 'not enough active models or selections' };
    }
    const shrink = Number.isFinite(opts.shrink) ? clamp(opts.shrink, 0, 1) : 0.5;
    const lambda = Number.isFinite(opts.lambda) ? opts.lambda : 1e-3;
    const iterations = Number.isFinite(opts.iterations) ? opts.iterations : 400;
    const lr = Number.isFinite(opts.lr) ? opts.lr : 0.08;
    let a = active.map(() => 1);
    let best = Infinity, bestA = a.slice();
    const evalLoss = () => {
      let ll = 0, n = 0;
      for (const s of rows) {
        let sum = 0, z = 0;
        active.forEach((m, i) => { const p = s.p[m]; if (p != null && Number.isFinite(+p)) { sum += a[i]; z += a[i] * +p; } });
        if (sum > 0) { ll += logLoss(z / sum, s.y); n++; }
      }
      return n ? ll / n : Infinity;
    };
    for (let it = 0; it < iterations; it++) {
      const grad = active.map(() => 0);
      let used = 0;
      for (const s of rows) {
        let sum = 0, z = 0;
        const avail = [];
        active.forEach((m, i) => { const p = s.p[m]; if (p != null && Number.isFinite(+p)) { avail.push([i, +p]); sum += a[i]; z += a[i] * +p; } });
        if (avail.length < 2 || sum <= 0) continue;
        const q = clamp(z / sum, 1e-9, 1 - 1e-9);
        for (const [i, p] of avail) grad[i] += (q - s.y) * (p - q) / (sum * q * (1 - q));
        used++;
      }
      if (!used) break;
      active.forEach((m, i) => {
        const g = grad[i] / used + lambda * (a[i] - 1);
        a[i] = Math.max(0.01, a[i] - lr * clamp(g, -10, 10));
      });
      const total = a.reduce((x, y) => x + y, 0);
      a = a.map(x => x / total * active.length);
      const l = evalLoss();
      if (l <= best - 1e-10) { best = l; bestA = a.slice(); } else if (it > 50) break;
    }
    a = bestA;
    const total = a.reduce((x, y) => x + y, 0);
    const rawWeights = {}; active.forEach((m, i) => { rawWeights[m] = a[i] / total; });
    const weights = {}; active.forEach(m => { weights[m] = (1 - shrink) * rawWeights[m] + shrink / active.length; });
    const wsum = Object.values(weights).reduce((x, y) => x + y, 0);
    Object.keys(weights).forEach(m => { weights[m] /= wsum; });
    return {
      version: VERSION, method: 'projected-gradient-shrunk', n: rows.length, active, counts, shrink,
      weights, rawWeights, logLoss: evalLoss(), iterations
    };
  }

  function groupSamples(samples) {
    const map = new Map();
    samples.forEach((s, i) => {
      const key = s.roundKey || (s.ts != null ? 't' + s.ts : 'i' + i);
      if (!map.has(key)) map.set(key, { key, ts: s.ts == null ? i : s.ts, rows: [] });
      map.get(key).rows.push(s);
    });
    return [...map.values()].sort((a, b) => a.ts - b.ts || String(a.key).localeCompare(String(b.key)));
  }
  function chunks(groups, k) {
    const out = []; const size = Math.max(1, Math.ceil(groups.length / k));
    for (let i = 0; i < groups.length; i += size) out.push(groups.slice(i, i + size));
    return out;
  }
  function metricsFor(pairs) {
    let brier = 0, ll = 0;
    for (const [p, y] of pairs) { brier += (p - y) ** 2; ll += logLoss(p, y); }
    return { n: pairs.length, brier: pairs.length ? brier / pairs.length : null, logLoss: pairs.length ? ll / pairs.length : null };
  }

  function evaluate(samples, opts = {}) {
    const rows = valid(samples);
    const minTrainSamples = Number.isFinite(opts.minTrainSamples) ? opts.minTrainSamples : 200;
    const minTestSamples = Number.isFinite(opts.minTestSamples) ? opts.minTestSamples : 100;
    const folds = Number.isFinite(opts.folds) ? Math.max(1, Math.floor(opts.folds)) : 3;
    const shrink = Number.isFinite(opts.shrink) ? opts.shrink : 0.5;
    const B = Number.isFinite(opts.permutations) ? opts.permutations : 199;
    const seed = Number.isFinite(opts.seed) ? opts.seed : 20261124;
    const warnings = [];
    if (rows.length < minTrainSamples + minTestSamples) {
      warnings.push('Adaptive-weight sample is too small for a walk-forward decision (' + rows.length + ' selections; need ' + (minTrainSamples + minTestSamples) + ').');
      return { version: VERSION, meta: { n: rows.length, minTrainSamples, minTestSamples, folds, shrink, warnings }, decision: { enabled: false }, warnings };
    }
    const groups = groupSamples(rows);
    let cut = 0, trainN = 0;
    while (cut < groups.length && trainN < minTrainSamples) { trainN += groups[cut].rows.length; cut++; }
    const testGroups = groups.slice(cut);
    if (!testGroups.length) {
      warnings.push('No chronological test groups remained after the minimum training window.');
      return { version: VERSION, meta: { n: rows.length, minTrainSamples, minTestSamples, folds, shrink, warnings }, decision: { enabled: false }, warnings };
    }
    const blocks = chunks(testGroups, folds);
    const loss = { equal: [], market: [], global: [], perMarket: [] };
    const byMarket = {};
    const single = {}; MODELS.forEach(m => { single[m] = []; });
    let activeModels = null, insufficientFits = 0, fitBlocks = 0;
    for (const block of blocks) {
      const first = block[0], gi = groups.findIndex(g => g.key === first.key);
      const train = groups.slice(0, Math.max(0, gi)).flatMap(g => g.rows);
      const test = block.flatMap(g => g.rows);
      if (train.length < 50 || !test.length) continue;
      const g = fit(train, { shrink, permutations: B, seed });
      fitBlocks++; if (!activeModels) activeModels = g.active || [];
      if (g.insufficient) insufficientFits++;
      const per = {};
      for (const mk of ['1X2', 'OU2.5', 'BTTS']) per[mk] = fit(train.filter(s => s.market === mk), { shrink, permutations: B, seed });
      for (const s of test) {
        const eq = meanAvailable(s.p); if (eq == null) continue;
        const mk = s.market || 'ALL';
        const gw = g.insufficient ? eq : apply(g.weights, s.p);
        const pm = per[mk] && !per[mk].insufficient ? apply(per[mk].weights, s.p) : gw;
        const fair = Number.isFinite(+s.p.fair) ? +s.p.fair : eq;
        loss.equal.push([eq, s.y]); loss.market.push([fair, s.y]);
        loss.global.push([gw, s.y]); loss.perMarket.push([pm, s.y]);
        for (const m of MODELS) if (s.p[m] != null && Number.isFinite(+s.p[m]) && +s.p[m] > 0 && +s.p[m] < 1) single[m].push([+s.p[m], s.y]);
        byMarket[mk] = byMarket[mk] || { equal: [], global: [], perMarket: [], market: [] };
        byMarket[mk].equal.push([eq, s.y]); byMarket[mk].global.push([gw, s.y]); byMarket[mk].perMarket.push([pm, s.y]); byMarket[mk].market.push([fair, s.y]);
      }
    }
    if (!loss.equal.length) {
      warnings.push('No adaptive-weight test selections were evaluable.');
      return { version: VERSION, meta: { n: rows.length, minTrainSamples, minTestSamples, folds, shrink, warnings }, decision: { enabled: false }, warnings };
    }
    const met = {
      equal: metricsFor(loss.equal), market: metricsFor(loss.market),
      global: metricsFor(loss.global), perMarket: metricsFor(loss.perMarket),
      single: Object.fromEntries(Object.entries(single).map(([k, v]) => [k, metricsFor(v)]))
    };
    const comparisons = [];
    const pairsOf = (a, b) => a.map((x, i) => [x[0], b[i][0], x[1]]).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    for (const key of ['global', 'perMarket']) {
      const pairs = pairsOf(loss[key], loss.equal);
      if (pairs.length < 20) continue;
      const d = _LPStats_W.pairedBootstrapDiff(pairs.map(x => logLoss(x[0], x[2])), pairs.map(x => logLoss(x[1], x[2])), _LPStats_W.mean, B, 0.05, seed + (key === 'global' ? 1 : 2));
      comparisons.push({ model: key, n: pairs.length, diffLogLoss: d.diff, low: d.low, high: d.high, p: d.p });
    }
    const finite = comparisons.filter(c => Number.isFinite(c.p));
    const q = finite.length ? _LPStats_W.bh(finite.map(c => c.p)) : [];
    finite.forEach((c, i) => { c.q = q[i]; });
    const cmpGlobal = comparisons.find(c => c.model === 'global');
    const cmpPer = comparisons.find(c => c.model === 'perMarket');
    const minDecision = Math.max(200, minTestSamples);
    const enabled = !!(cmpGlobal && cmpGlobal.diffLogLoss < 0 && cmpGlobal.p < 0.05 && cmpGlobal.q < 0.1 && cmpGlobal.n >= minDecision && activeModels && activeModels.length >= 2);
    if (activeModels && activeModels.length < 2) warnings.push('Fewer than two component models were available in the weight-training windows; adaptive weights cannot differ from the available model.');
    if (insufficientFits === fitBlocks && fitBlocks > 0) warnings.push('Every adaptive-weight fit was insufficient; the equal ensemble remains in use.');
    const perMarket = [];
    for (const mk of Object.keys(byMarket)) {
      const pairs = byMarket[mk].global.map((x, i) => [logLoss(x[0], x[1]), logLoss(byMarket[mk].equal[i][0], byMarket[mk].equal[i][1]), x[1]]).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
      if (pairs.length < 20) { perMarket.push({ market: mk, n: pairs.length, enabled: false, reason: 'insufficient sample' }); continue; }
      const d = _LPStats_W.pairedBootstrapDiff(pairs.map(x => x[0]), pairs.map(x => x[1]), _LPStats_W.mean, B, 0.05, seed + mk.length);
      perMarket.push({ market: mk, n: pairs.length, diffLogLoss: d.diff, low: d.low, high: d.high, p: d.p });
    }
    const pf = perMarket.filter(x => Number.isFinite(x.p));
    const pq = pf.length ? _LPStats_W.bh(pf.map(x => x.p)) : [];
    pf.forEach((x, i) => { x.q = pq[i]; });
    perMarket.forEach(x => { x.enabled = !!(Number.isFinite(x.diffLogLoss) && x.diffLogLoss < 0 && x.p < 0.05 && x.q < 0.1 && x.n >= Math.max(100, Math.floor(minTestSamples / 2))); });
    for (const x of perMarket) {
      if (!x.enabled) continue;
      const f = fit(rows.filter(s => s.market === x.market), { shrink, minCount: 20 });
      if (!f || f.insufficient || !f.active || f.active.length < 2) x.enabled = false;
    }
    const finalWeights = enabled ? fit(rows, { shrink, minCount: 20 }) : null;
    const finalPerMarket = {};
    for (const mk of Object.keys(byMarket)) {
      const dm = perMarket.find(x => x.market === mk);
      if (dm && dm.enabled) finalPerMarket[mk] = fit(rows.filter(s => s.market === mk), { shrink, minCount: 20 });
    }
    if (!enabled) {
      const improved = cmpGlobal && cmpGlobal.diffLogLoss < 0 && cmpGlobal.p < 0.05 && cmpGlobal.q < 0.1;
      if (improved && cmpGlobal.n < minDecision) warnings.push('Adaptive weights improved but their test sample (' + cmpGlobal.n + ') is below the ' + minDecision + '-selection activation floor; adaptive weights are disabled.');
      else warnings.push('No adaptive weight vector beat the equal ensemble out-of-sample after paired correction; adaptive weights are disabled.');
    }
    if (loss.equal.length < 500) warnings.push('Adaptive-weight test sample is small (' + loss.equal.length + ' selections); the decision is provisional.');
    return {
      version: VERSION,
      meta: { n: rows.length, test: loss.equal.length, folds: blocks.length, minTrainSamples, minTestSamples, shrink, permutations: B, seed, warnings },
      metrics: met, comparisons, perMarket,
      decision: {
        enabled, weights: finalWeights && !finalWeights.insufficient ? finalWeights.weights : null,
        rawWeights: finalWeights && !finalWeights.insufficient ? finalWeights.rawWeights : null,
        shrink, fit: finalWeights, perMarket: finalPerMarket,
        diffLogLoss: cmpGlobal ? cmpGlobal.diffLogLoss : null, low: cmpGlobal ? cmpGlobal.low : null, high: cmpGlobal ? cmpGlobal.high : null,
        p: cmpGlobal ? cmpGlobal.p : null, q: cmpGlobal ? cmpGlobal.q : null, n: cmpGlobal ? cmpGlobal.n : 0
      },
      warnings
    };
  }

  return { VERSION, MODELS, LABELS, fit, apply, meanAvailable, equalWeights, evaluate, valid };
})();
if (typeof module !== 'undefined') module.exports = LPWeights;
