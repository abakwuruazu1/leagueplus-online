// Probability calibration and uncertainty (Stage 7).
//
// The module only reports a calibration as usable when it improves
// out-of-sample log loss in a chronological walk-forward split, with a paired
// bootstrap interval and Benjamini-Hochberg correction. Fitting is deliberately
// small and dependency-free: Platt scaling and isotonic regression.
//
// It also provides the Wilson interval used by the ledger and dashboard. The
// interval is an approximation: the model probability is treated as a
// proportion with an effective sample size derived from the underlying team /
// market evidence. It is not a guarantee and it does not replace a properly
// calibrated forecast.
const _coreC = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _evalC = (typeof module !== 'undefined' && module.exports) ? require('./modelEval.js') : null;
const _statsC = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPModelEval_C = (typeof LPModelEval !== 'undefined') ? LPModelEval : _evalC;
const _LPStats_C = (typeof LPStats !== 'undefined') ? LPStats : _statsC;

const LPCalibration = (() => {
  const VERSION = 'stage7-calibration-v1';
  const METHODS = ['platt', 'isotonic'];

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const logit = p => Math.log(clamp(p, 1e-9, 1 - 1e-9) / (1 - clamp(p, 1e-9, 1 - 1e-9)));
  const sigmoid = z => 1 / (1 + Math.exp(-clamp(z, -40, 40)));
  function valid(samples) {
    const out = [];
    for (const s of (samples || [])) {
      if (!s) continue;
      const p = +s.p, y = +s.y;
      if (!Number.isFinite(p) || !Number.isFinite(y) || p < 0 || p > 1 || (y !== 0 && y !== 1)) continue;
      out.push({ p, y, ts: Number.isFinite(+s.ts) ? +s.ts : null, roundKey: s.roundKey || null, market: s.market || null, id: s.id, fixtureId: s.fixtureId, odds: s.odds });
    }
    return out;
  }
  function loss(p, y) {
    const q = clamp(p, 1e-12, 1 - 1e-12);
    return y ? -Math.log(q) : -Math.log(1 - q);
  }

  // Platt scaling: q = sigmoid(a * logit(p) + b). Regularised toward the
  // identity map so a small sample cannot produce an extreme recalibration.
  function fitPlatt(samples, opts = {}) {
    const rows = valid(samples);
    if (rows.length < 10) return null;
    const lambda = Number.isFinite(opts.lambda) ? opts.lambda : 1e-3;
    const iterations = Number.isFinite(opts.iterations) ? opts.iterations : 400;
    const lr = Number.isFinite(opts.lr) ? opts.lr : 0.15;
    let a = 1, b = 0, prev = Infinity;
    for (let it = 0; it < iterations; it++) {
      let ga = lambda * (a - 1), gb = lambda * b, l = 0;
      for (const s of rows) {
        const q = sigmoid(a * logit(s.p) + b);
        const d = q - s.y;
        ga += d * logit(s.p); gb += d; l += loss(q, s.y);
      }
      ga /= rows.length; gb /= rows.length; l /= rows.length;
      a = clamp(a - lr * ga, 0.05, 5);
      b = clamp(b - lr * gb, -3, 3);
      if (Math.abs(prev - l) < 1e-10) { prev = l; break; }
      prev = l;
    }
    let ll = 0, brier = 0;
    for (const s of rows) {
      const q = sigmoid(a * logit(s.p) + b);
      ll += loss(q, s.y); brier += (q - s.y) ** 2;
    }
    return { version: VERSION, method: 'platt', a, b, n: rows.length, logLoss: ll / rows.length, brier: brier / rows.length, lambda };
  }

  function fitIsotonic(samples, opts = {}) {
    const rows = valid(samples).filter(s => s.p > 0 && s.p < 1).sort((x, y) => x.p - y.p);
    if (rows.length < 10) return null;
    const minBin = Number.isFinite(opts.minBin) ? opts.minBin : 5;
    const blocks = [];
    for (const s of rows) {
      blocks.push({ sumY: s.y, n: 1, sumP: s.p, lo: s.p, hi: s.p });
      while (blocks.length > 1) {
        const cur = blocks[blocks.length - 1], prev = blocks[blocks.length - 2];
        if (prev.sumY / prev.n < cur.sumY / cur.n) break;
        blocks.pop(); blocks.pop();
        blocks.push({ sumY: prev.sumY + cur.sumY, n: prev.n + cur.n, sumP: prev.sumP + cur.sumP, lo: Math.min(prev.lo, cur.lo), hi: Math.max(prev.hi, cur.hi) });
      }
    }
    let knots = blocks.map(b => ({ p: b.sumP / b.n, q: b.sumY / b.n, n: b.n, lo: b.lo, hi: b.hi }));
    // Merge tiny end blocks into their neighbour so the map is not a step
    // function driven by one match.
    if (minBin > 1 && knots.length > 2) {
      const merged = [];
      for (const k of knots) {
        if (merged.length && (merged[merged.length - 1].n < minBin || k.n < minBin)) {
          const prev = merged.pop();
          const n = prev.n + k.n;
          merged.push({ p: (prev.p * prev.n + k.p * k.n) / n, q: (prev.q * prev.n + k.q * k.n) / n, n, lo: Math.min(prev.lo, k.lo), hi: Math.max(prev.hi, k.hi) });
        } else merged.push(k);
      }
      knots = merged;
    }
    for (let i = 1; i < knots.length; i++) if (knots[i].q < knots[i - 1].q) knots[i].q = knots[i - 1].q;
    let ll = 0, brier = 0;
    for (const s of rows) { const q = apply({ method: 'isotonic', knots }, s.p); ll += loss(q, s.y); brier += (q - s.y) ** 2; }
    return { version: VERSION, method: 'isotonic', knots, n: rows.length, logLoss: ll / rows.length, brier: brier / rows.length };
  }

  function fit(samples, opts = {}) {
    const method = opts.method || 'platt';
    return method === 'isotonic' ? fitIsotonic(samples, opts) : fitPlatt(samples, opts);
  }

  function apply(cal, p) {
    const x = clamp(+p, 0, 1);
    if (!cal || !Number.isFinite(x)) return x;
    if (cal.method === 'platt') return clamp(sigmoid(cal.a * logit(x) + cal.b), 0, 1);
    if (cal.method === 'isotonic') {
      const k = cal.knots || [];
      if (!k.length) return x;
      if (x <= k[0].p) return k[0].q;
      if (x >= k[k.length - 1].p) return k[k.length - 1].q;
      let i = 0; while (i + 1 < k.length && x > k[i + 1].p) i++;
      const a = k[i], b = k[Math.min(k.length - 1, i + 1)];
      if (!(b.p > a.p)) return a.q;
      return clamp(a.q + (b.q - a.q) * (x - a.p) / (b.p - a.p), 0, 1);
    }
    return x;
  }

  // Apply a calibrator to a 1X2 / O-U / BTTS probability vector and
  // renormalise within its exclusive market.
  function applyVector(cal, probs) {
    if (!Array.isArray(probs) || !probs.length) return null;
    const out = probs.map(p => apply(cal, p));
    const s = out.reduce((a, b) => a + Math.max(0, b), 0);
    return s > 0 ? out.map(x => Math.max(0, x) / s) : null;
  }

  function reliability(samples, opts = {}) {
    const rows = valid(samples);
    const bins = Number.isFinite(opts.bins) ? Math.max(2, Math.floor(opts.bins)) : 10;
    const out = Array.from({ length: bins }, (_, i) => ({ i, lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, sumY: 0 }));
    let brier = 0, ll = 0;
    for (const s of rows) {
      const bi = Math.min(bins - 1, Math.floor(s.p * bins));
      const b = out[bi]; b.n++; b.sumP += s.p; b.sumY += s.y;
      brier += (s.p - s.y) ** 2; ll += loss(s.p, s.y);
    }
    const n = rows.length;
    const base = n ? rows.reduce((a, s) => a + s.y, 0) / n : null;
    let ece = 0, mce = 0, rel = 0, res = 0;
    for (const b of out) {
      b.avgP = b.n ? b.sumP / b.n : null;
      b.obs = b.n ? b.sumY / b.n : null;
      b.gap = b.n ? b.avgP - b.obs : null;
      if (b.n) { const w = b.n / n; ece += w * Math.abs(b.gap); mce = Math.max(mce, Math.abs(b.gap)); rel += w * b.gap ** 2; res += w * (b.obs - base) ** 2; }
    }
    return {
      version: VERSION, n, bins: out, brier: n ? brier / n : null, logLoss: n ? ll / n : null,
      ece: n ? ece : null, mce: n ? mce : null, base,
      decomposition: n ? { uncertainty: base * (1 - base), reliability: rel, resolution: res, binnedBrier: rel - res + base * (1 - base) } : null
    };
  }

  // Wilson interval for a probability p with effective sample size n. Used as
  // an approximate uncertainty band, not as a substitute for calibration.
  function wilsonInterval(p, n, z = 1.96) {
    const x = clamp(+p, 0, 1);
    const N = Math.max(1, +n || 1);
    const denom = 1 + z * z / N;
    const centre = (x + z * z / (2 * N)) / denom;
    const half = z * Math.sqrt(Math.max(0, x * (1 - x) / N + z * z / (4 * N * N))) / denom;
    return [clamp(centre - half, 0, 1), clamp(centre + half, 0, 1)];
  }
  function lowerBound(p, n, z = 1.96) { return wilsonInterval(p, n, z)[0]; }

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
    const out = [];
    const size = Math.max(1, Math.ceil(groups.length / k));
    for (let i = 0; i < groups.length; i += size) out.push(groups.slice(i, i + size));
    return out;
  }
  function metricsFor(pairs) {
    let brier = 0, ll = 0;
    for (const [p, y] of pairs) { brier += (p - y) ** 2; ll += loss(p, y); }
    return { n: pairs.length, brier: pairs.length ? brier / pairs.length : null, logLoss: pairs.length ? ll / pairs.length : null };
  }

  function walkForward(samples, opts = {}) {
    const rows = valid(samples);
    const minTrainSamples = Number.isFinite(opts.minTrainSamples) ? opts.minTrainSamples : 200;
    const minTestSamples = Number.isFinite(opts.minTestSamples) ? opts.minTestSamples : 100;
    const folds = Number.isFinite(opts.folds) ? Math.max(1, Math.floor(opts.folds)) : 3;
    const bins = Number.isFinite(opts.bins) ? opts.bins : 10;
    const B = Number.isFinite(opts.permutations) ? opts.permutations : 199;
    const seed = Number.isFinite(opts.seed) ? opts.seed : 20261124;
    const warnings = [];
    if (rows.length < minTrainSamples + minTestSamples) {
      warnings.push('Calibration sample is too small for a walk-forward decision (' + rows.length + ' selections; need ' + (minTrainSamples + minTestSamples) + ').');
      return { version: VERSION, meta: { n: rows.length, minTrainSamples, minTestSamples, folds, methods: METHODS, warnings }, decision: { enabled: false, method: null }, reliability: { raw: reliability(rows, { bins }), calibrated: null }, warnings };
    }
    const groups = groupSamples(rows);
    let cut = 0, trainN = 0;
    while (cut < groups.length && trainN < minTrainSamples) { trainN += groups[cut].rows.length; cut++; }
    const testGroups = groups.slice(cut);
    if (!testGroups.length) {
      warnings.push('No chronological test groups remained after the minimum training window.');
      return { version: VERSION, meta: { n: rows.length, minTrainSamples, minTestSamples, folds, methods: METHODS, warnings }, decision: { enabled: false, method: null }, reliability: { raw: reliability(rows, { bins }), calibrated: null }, warnings };
    }
    const blocks = chunks(testGroups, folds);
    const rawPairs = [], methodPairs = {}, calPairs = {};
    for (const m of METHODS) { methodPairs[m] = []; calPairs[m] = []; }
    for (const block of blocks) {
      const first = block[0];
      const gi = groups.findIndex(g => g.key === first.key);
      const train = groups.slice(0, Math.max(0, gi)).flatMap(g => g.rows);
      const test = block.flatMap(g => g.rows);
      if (train.length < 20 || !test.length) continue;
      const cals = {};
      for (const m of METHODS) { try { cals[m] = fit(train, { method: m, iterations: opts.iterations, lambda: opts.lambda, minBin: opts.minBin }); } catch (e) { cals[m] = null; } }
      for (const s of test) {
        rawPairs.push([s.p, s.y]);
        for (const m of METHODS) if (cals[m]) { const q = apply(cals[m], s.p); methodPairs[m].push([q, s.y]); calPairs[m].push({ p: q, y: s.y }); }
      }
    }
    const raw = metricsFor(rawPairs);
    const methods = {};
    for (const m of METHODS) {
      const met = metricsFor(methodPairs[m]);
      if (!met.n) continue;
      const pairs = methodPairs[m].length === rawPairs.length ? methodPairs[m].map((x, i) => [x[0], x[1], rawPairs[i][0], rawPairs[i][1]]).filter(x => x[0] != null && x[2] != null) : [];
      const calLoss = pairs.map(x => loss(x[0], x[1]));
      const rawLoss = pairs.map(x => loss(x[2], x[3]));
      const d = calLoss.length >= 20 ? _LPStats_C.pairedBootstrapDiff(calLoss, rawLoss, _LPStats_C.mean, B, 0.05, seed + (m === 'platt' ? 1 : 2)) : { diff: null, low: null, high: null, p: null, n: calLoss.length };
      methods[m] = { ...met, diffLogLoss: d.diff, low: d.low, high: d.high, p: d.p, n: met.n };
    }
    const any = Object.values(methods).filter(x => Number.isFinite(x.p));
    const q = any.length ? _LPStats_C.bh(any.map(x => x.p)) : [];
    any.forEach((x, i) => { x.q = q[i]; });
    const best = Object.entries(methods).filter(([, x]) => Number.isFinite(x.diffLogLoss)).sort((a, b) => a[1].logLoss - b[1].logLoss)[0];
    let enabled = false, chosen = null;
    const minDecision = Math.max(200, minTestSamples);
    if (best && best[1].diffLogLoss < 0 && best[1].p < 0.05 && best[1].q < 0.1 && best[1].n >= minDecision) { enabled = true; chosen = best[0]; }
    const calibrator = enabled ? fit(rows, { method: chosen, iterations: opts.iterations, lambda: opts.lambda, minBin: opts.minBin }) : null;
    if (!enabled) {
      const improved = best && best[1].diffLogLoss < 0 && best[1].p < 0.05 && best[1].q < 0.1;
      if (improved && best[1].n < minDecision) warnings.push('Calibration improved but its test sample (' + best[1].n + ') is below the ' + minDecision + '-selection activation floor; calibration is disabled.');
      else warnings.push('No calibration method improved out-of-sample log loss after paired correction; calibration is disabled.');
    }
    if (raw.n < 500) warnings.push('Calibration test sample is small (' + raw.n + ' selections); the decision is provisional.');
    return {
      version: VERSION,
      meta: { n: rows.length, test: raw.n, folds: blocks.length, minTrainSamples, minTestSamples, methods: METHODS, permutations: B, seed, warnings },
      metrics: { raw, methods },
      decision: {
        enabled, method: chosen, calibrator,
        diffLogLoss: best ? best[1].diffLogLoss : null, low: best ? best[1].low : null, high: best ? best[1].high : null,
        p: best ? best[1].p : null, q: best ? best[1].q : null, n: best ? best[1].n : 0
      },
      reliability: {
        raw: reliability(rawPairs.map(([p, y]) => ({ p, y })), { bins }),
        calibrated: chosen ? reliability(calPairs[chosen], { bins }) : null
      },
      warnings
    };
  }

  // Collect out-of-sample model probabilities from the Stage 5 evaluation
  // harness. Each selection is a binary event, which is the natural unit for
  // calibration and for the adaptive-weight loss.
  function collect(opts = {}) {
    const samples = [];
    const cfg = Object.assign({}, opts, opts.options || {});
    cfg.onFixture = info => {
      const { m, byId, markets, round } = info;
      for (const mk of markets) {
        const rows = mk.ids.map(id => byId.get(id));
        if (rows.some(r => !r)) continue;
        rows.forEach((r, i) => {
          const y = i === mk.y ? 1 : 0;
          const models = { fair: r.fair, mkt: r.mkt, team: r.team, dc: r.dc, emp: r.emp, blend: r.blend, ensemble: r.ensemble };
          const p = models.ensemble ?? models.mkt ?? models.fair;
          samples.push({
            fixtureId: m.fixtureId, roundKey: round.key, ts: round.ts, comp: m.comp,
            market: mk.name, id: r.id, odds: r.odds, y, p, models,
            pLow: r.pLow, pHigh: r.pHigh, nEff: r.nEff, uncertaintyClass: r.uncertaintyClass, fair: r.fair
          });
        });
      }
    };
    const result = _LPModelEval_C.evaluate(cfg);
    return { version: VERSION, samples, meta: result.meta, warnings: result.warnings, checks: result.checks, eval: result };
  }

  return { VERSION, METHODS, logit, sigmoid, fit, fitPlatt, fitIsotonic, apply, applyVector, reliability, walkForward, wilsonInterval, lowerBound, collect, valid };
})();
if (typeof module !== 'undefined') module.exports = LPCalibration;
