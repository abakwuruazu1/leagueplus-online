const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LPCat, LPParse } = require('../lib/core.js');
const M = require('../lib/model.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });
const res = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const asOf = Date.parse(round.round.startDate) + 30e3;

function cloneRounds(n) {
  const out = [];
  for (let r = 0; r < n; r++) for (const m of res.matches) {
    out.push(Object.assign({}, m, {
      key: r + ':' + m.comp + ':' + m.idx, fixtureId: '3:' + r + ':' + m.comp + ':' + m.idx,
      roundKey: '3:' + r, roundId: r, ts: 1000000 + r * 10000 + m.idx, week: r, season: 1,
      quality: { status: 'ok', flags: [] }
    }));
  }
  return out;
}

test('Dixon-Coles matrix and tau normalisation', () => {
  for (const rho of [0, -0.1, 0.1]) {
    const mat = M.matrix(1.5, 1.1, { rho });
    let s = 0; for (const row of mat) for (const v of row) s += v;
    assert.ok(Math.abs(s - 1) < 1e-12);
  }
  assert.ok(M.tau(0, 0, 1.5, 1.1, -0.1) > 1);
  assert.ok(M.tau(0, 0, 1.5, 1.1, 0.5) >= 1e-9);
});

test('margin methods preserve exclusive/pair totals', () => {
  const om = LPParse.oddsMap(up.fixtures[0].odds, up.selsets[up.fixtures[0].sk]);
  for (const method of ['proportional', 'power', 'additive']) {
    const fp = M.fair(cat, om, { method });
    const sum = pred => [...fp].filter(([id]) => pred(cat[id])).reduce((s, [, p]) => s + p, 0);
    assert.ok(Math.abs(sum(c => c.mId === 1) - 1) < 1e-8, method + ' 1X2');
    assert.ok(Math.abs(sum(c => c.mId === 2) - 2) < 1e-8, method + ' DC');
    for (const [, p] of fp) assert.ok(p >= 0 && p <= 1);
  }
});

test('empirical model is normalised and selects a window', () => {
  const E = M.fitEmpirical(res.matches, asOf, { seasonMode: 'auto', alpha: 20 });
  assert.ok(E.n > 0);
  assert.ok(E.window > 0);
  let s = 0; for (const row of E.matrix) for (const v of row) s += v;
  assert.ok(Math.abs(s - 1) < 1e-12);
});

test('Dixon-Coles fit exposes rho and uncertainty; empirical is attached', () => {
  const T = M.fitDC(res.matches, asOf, { seasonMode: 'auto', empirical: true });
  assert.ok(T.n > 0);
  assert.ok(Number.isFinite(T.rho));
  assert.ok(T.emp && T.emp.n > 0);
  assert.ok(Object.values(T.reliability).every(x => x >= 0 && x <= 1));
});

test('season filter limits observations when requested', () => {
  const rows = cloneRounds(3).map((m, i) => Object.assign({}, m, { season: i < 20 ? 1 : 2 }));
  const ref = Math.max(...rows.map(m => m.ts)) + 1;
  const all = M.fitTeams(rows, ref, { seasonMode: 'all' });
  const current = M.fitTeams(rows, ref, { seasonMode: 'current', season: 2 });
  assert.ok(all.n > current.n);
  assert.ok(current.n > 0);
});

test('evaluate exposes market, team, DC, empirical and ensemble', () => {
  const rows = cloneRounds(5);
  const T = M.fitDC(rows, Math.max(...rows.map(m => m.ts)) + 1, { seasonMode: 'auto', empirical: true });
  const fx = up.fixtures[0];
  const ev = M.evaluate(cat, fx, up.selsets[fx.sk], T);
  assert.ok(ev.rows.length > 0);
  assert.ok(ev.rows.every(r => r.ensemble != null && Number.isFinite(r.ensemble)));
  assert.ok(ev.rows.some(r => r.dc != null));
  assert.ok(ev.rows.some(r => r.emp != null));
  const ids = [101, 102, 103];
  const ps = ids.map(id => ev.rows.find(r => r.id === id));
  if (ps.every(Boolean)) assert.ok(Math.abs(ps.reduce((s, r) => s + r.ensemble, 0) - 1) < 1e-8);
});

test('weighted, calibrated and uncertainty fields are explicit', () => {
  const rows = cloneRounds(5);
  const T = M.fitDC(rows, Math.max(...rows.map(m => m.ts)) + 1, { seasonMode: 'auto', empirical: true });
  const fx = up.fixtures[0];
  const ev = M.evaluate(cat, fx, up.selsets[fx.sk], T, {
    weights: { mkt: 1, dc: 0, emp: 0, team: 0 },
    calibrate: p => Math.min(0.99, Math.max(0.01, p * 0.9)),
    calibrationVersion: 'test-cal'
  });
  assert.equal(ev.uncertaintyVersion, M.UNCERTAINTY_VERSION);
  assert.equal(ev.calibrationVersion, 'test-cal');
  assert.ok(ev.rows.every(r => Number.isFinite(r.weighted) && Number.isFinite(r.calibrated)));
  assert.ok(ev.rows.every(r => r.pLow <= r.calibrated + 1e-12 && r.pHigh >= r.calibrated - 1e-12));
  assert.ok(ev.rows.every(r => r.nEff >= 5 && r.nEff <= 1000));
  assert.ok(ev.rows.every(r => ['narrow', 'moderate', 'wide'].includes(r.uncertaintyClass)));
  assert.ok(ev.rows.every(r => r.modelLow <= r.modelHigh));
});
