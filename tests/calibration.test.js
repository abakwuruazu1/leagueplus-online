const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/calibration.js');
const W = require('../lib/weights.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function synthetic(n = 2000, seed = 7) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const z = (r() - 0.5) * 4;
    const p = 1 / (1 + Math.exp(-z));
    const q = 1 / (1 + Math.exp(-0.7 * z));
    out.push({ p, y: r() < q ? 1 : 0, ts: i, roundKey: 'r' + Math.floor(i / 20), market: i % 3 ? '1X2' : 'OU2.5' });
  }
  return out;
}

test('Platt scaling improves a miscalibrated synthetic sample', () => {
  const s = synthetic();
  const cal = C.fitPlatt(s);
  assert.ok(cal && cal.n === s.length);
  assert.ok(cal.logLoss < C.reliability(s).logLoss);
  assert.ok(cal.a > 0.3 && cal.a < 1.2);
  for (const p of [0.01, 0.3, 0.5, 0.9, 0.99]) {
    const q = C.apply(cal, p);
    assert.ok(q >= 0 && q <= 1);
  }
});

test('isotonic calibration is monotone and bounded', () => {
  const cal = C.fitIsotonic(synthetic(1200));
  assert.ok(cal && cal.knots.length > 0);
  for (let i = 1; i < cal.knots.length; i++) assert.ok(cal.knots[i].q >= cal.knots[i - 1].q);
  let prev = -1;
  for (const p of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
    const q = C.apply(cal, p);
    assert.ok(q >= 0 && q <= 1 && q >= prev - 1e-12);
    prev = q;
  }
});

test('reliability report exposes ECE, bins and Brier decomposition', () => {
  const r = C.reliability(synthetic(1000), { bins: 10 });
  assert.equal(r.n, 1000);
  assert.equal(r.bins.length, 10);
  assert.ok(r.ece >= 0 && r.mce >= r.ece);
  assert.ok(r.decomposition);
  assert.ok(Math.abs(r.decomposition.binnedBrier - r.brier) < 0.02);
  assert.ok(r.bins.reduce((a, b) => a + b.n, 0) === r.n);
});

test('walk-forward calibration refuses tiny samples and gates synthetic improvement', () => {
  const small = C.walkForward(synthetic(120), { minTrainSamples: 200, minTestSamples: 100 });
  assert.equal(small.decision.enabled, false);
  assert.ok(small.warnings.length >= 1);

  const big = C.walkForward(synthetic(2000), { minTrainSamples: 200, minTestSamples: 100, folds: 3, permutations: 99 });
  assert.equal(big.decision.enabled, true);
  assert.ok(['platt', 'isotonic'].includes(big.decision.method));
  assert.ok(big.decision.diffLogLoss < 0 && big.decision.p < 0.05 && big.decision.q < 0.1);
  assert.ok(big.reliability.raw.n > 0 && big.reliability.calibrated.n > 0);
});

test('Wilson intervals widen as effective evidence shrinks', () => {
  const wide = C.wilsonInterval(0.5, 10);
  const narrow = C.wilsonInterval(0.5, 1000);
  assert.ok(wide[1] - wide[0] > narrow[1] - narrow[0]);
  assert.ok(wide[0] < 0.5 && wide[1] > 0.5);
  assert.ok(narrow[0] < 0.5 && narrow[1] > 0.5);
  assert.ok(C.lowerBound(0.5, 10) < 0.5);
  assert.ok(C.wilsonInterval(0, 10)[0] === 0 && C.wilsonInterval(1, 10)[1] === 1);
});

test('adaptive weights favour the better model and shrink toward equal', () => {
  const r = rng(11), rows = [];
  for (let i = 0; i < 4000; i++) {
    const p = 0.2 + 0.6 * r();
    rows.push({ y: r() < p ? 1 : 0, market: i % 3 ? '1X2' : 'OU2.5', p: { mkt: p, dc: 0.5, emp: 0.5, team: 0.5 } });
  }
  const fit = W.fit(rows);
  assert.ok(fit.weights.mkt > fit.weights.dc);
  assert.ok(Math.abs(Object.values(fit.weights).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(fit.weights.mkt < fit.rawWeights.mkt);
  const eq = W.equalWeights();
  let eqLoss = 0;
  for (const s of rows) { const q = W.apply(eq, s.p); eqLoss -= s.y ? Math.log(q) : Math.log(1 - q); }
  assert.ok(fit.logLoss < eqLoss / rows.length);
});

test('adaptive-weight walk-forward is chronological and gated', () => {
  const r = rng(11), rows = [];
  for (let i = 0; i < 4000; i++) {
    const p = 0.2 + 0.6 * r();
    rows.push({ y: r() < p ? 1 : 0, ts: i, roundKey: 'r' + Math.floor(i / 20), market: i % 3 ? '1X2' : 'OU2.5', p: { mkt: p, dc: 0.5, emp: 0.5, team: 0.5 } });
  }
  const w = W.evaluate(rows, { minTrainSamples: 300, minTestSamples: 100, folds: 3, permutations: 99 });
  assert.equal(w.decision.enabled, true);
  assert.ok(w.metrics.equal.n > 0 && w.metrics.global.n > 0);
  assert.ok(w.decision.weights && w.decision.weights.mkt > 0);
  assert.ok(w.comparisons.every(c => Number.isFinite(c.p) && Number.isFinite(c.q)));
});
