const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stats.js');

test('entropy and mutual information', () => {
  assert.ok(Math.abs(S.entropy([1, 1, 1, 1]) - 2) < 1e-9);
  assert.equal(S.entropy([3, 0, 0, 0]), 0);
  const pairs = Array.from({ length: 100 }, (_, i) => [i % 4, i % 4]);
  const mi = S.mutualInformation(pairs, false);
  assert.ok(mi > 1.9 && mi <= 2.0001);
  const perm = S.miPermutation(pairs, 99, 1);
  assert.ok(perm.p < 0.05);
});

test('normal / chi-square approximations', () => {
  assert.ok(Math.abs(S.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(S.normalCdf(1.96) - 0.975) < 5e-4);
  assert.ok(Math.abs(S.normalInv(0.975) - 1.96) < 0.01);
  assert.ok(Math.abs(S.chiSquareSurvival(3.841, 1) - 0.05) < 1e-3);
  assert.ok(Math.abs(S.chiSquareSurvival(5.991, 2) - 0.05) < 1e-3);
});

test('Wilson interval and proportions', () => {
  const [lo, hi] = S.wilson(50, 100);
  assert.ok(lo > 0.39 && lo < 0.41);
  assert.ok(hi > 0.59 && hi < 0.61);
  assert.deepEqual(S.wilson(0, 0), [null, null]);
});

test('autocorrelation, Ljung-Box and runs', () => {
  const alt = Array.from({ length: 80 }, (_, i) => i % 2 ? 1 : -1);
  const r1 = S.autocorrelation(alt, 1);
  assert.ok(r1 < -0.9);
  const lb = S.ljungBox(alt, 4);
  assert.ok(lb && lb.p < 0.001);
  const pac = S.pacf(alt, 3);
  assert.ok(pac && pac[0] < -0.8);
  assert.ok(Math.abs(pac[1]) < 0.3);
  const runs = S.runsTest(alt.map(x => x > 0 ? 1 : 0));
  assert.ok(runs && runs.p < 0.001);
});

test('rank and contingency tests', () => {
  const a = Array.from({ length: 40 }, (_, i) => i + 1);
  const b = Array.from({ length: 40 }, (_, i) => i + 20);
  const kw = S.kruskalWallis([a, b]);
  assert.ok(kw && kw.p < 0.001);
  const chi = S.chiSquare2D([[40, 10], [10, 40]]);
  assert.ok(chi && chi.p < 0.001);
  assert.ok(chi.cramersV > 0.5);
});

test('permutation, bootstrap and multiple testing', () => {
  const a = Array.from({ length: 50 }, (_, i) => 1 + (i % 2));
  const b = Array.from({ length: 50 }, (_, i) => 3 + (i % 2));
  const pd = S.permutationDiff(a, b, 199, 1);
  assert.ok(pd.p < 0.01);
  const bc = S.bootstrapCI(a, S.mean, 199, 0.05, 1);
  assert.ok(bc.low <= bc.value && bc.value <= bc.high);
  const q = S.bh([0.01, 0.04, 0.03, 0.2]);
  assert.equal(q.length, 4);
  assert.ok(q[0] <= q[1] && q[0] <= q[2]);
});

test('correlation and change point detection', () => {
  const x = Array.from({ length: 60 }, (_, i) => i + 1);
  const y = x.map(v => v * 2 + 1);
  assert.ok(S.pearson(x, y) > 0.999);
  const cp = S.corrPermutation(x, y, 99, 1);
  assert.ok(cp.p < 0.05);
  const series = Array.from({ length: 80 }, (_, i) => i < 40 ? 1 + (i % 2) : 6 + (i % 2));
  const c = S.cusumPermutation(series, 199, 1);
  assert.ok(c.p < 0.01);
  assert.ok(c.index >= 30 && c.index <= 45);
});

test('scoring functions', () => {
  assert.ok(Math.abs(S.brierMulticlass([1, 0, 0], 0)) < 1e-12);
  assert.ok(Math.abs(S.brierMulticlass([0.5, 0.5, 0], 0) - 0.5) < 1e-12);
  assert.ok(Math.abs(S.logLossMulticlass([1, 0, 0], 0)) < 1e-9);
  assert.ok(S.logLossMulticlass([0.5, 0.5, 0], 0) > 0.99);
});
