const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LPCat, LPParse } = require('../lib/core.js');
const Seq = require('../lib/sequence.js');
const Pat = require('../lib/patterns.js');
const Spec = require('../lib/specialists.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });
const base = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });

function cloneRounds(n) {
  const out = [];
  for (let r = 0; r < n; r++) for (const m of base.matches) {
    out.push(Object.assign({}, m, {
      key: r + ':' + m.comp + ':' + m.idx, fixtureId: '3:' + r + ':' + m.comp + ':' + m.idx,
      roundKey: '3:' + r, roundId: r, ts: 1000000 + r * 10000 + m.idx, week: r, season: 1,
      quality: { status: 'ok', flags: [] }
    }));
  }
  return out;
}

test('sequence model learns conditional scoring and falls back cleanly', () => {
  const ms = [];
  for (let r = 0; r < 20; r++) for (let i = 0; i < 10; i++) {
    const hi = r % 2 === 0;
    ms.push({ ts: 1000 + r * 1000 + i, roundId: r, roundKey: '1:' + r, comp: 1, home: 'H' + (i % 4), away: 'A' + (i % 4), hg: hi ? 3 : 0, ag: hi ? 1 : 0, quality: { status: 'ok', flags: [] } });
  }
  const st = Seq.fit(ms, { asOf: 999999 });
  assert.ok(st.byComp[1].cells.low.n > 0 && st.byComp[1].cells.high.n > 0);
  assert.ok(st.byComp[1].means.low > st.byComp[1].means.high);
  const fx = up.fixtures.find(f => +f.comp === 1) || up.fixtures[0];
  if (+fx.comp === 1) {
    const p = Seq.predict(st, fx, cat, up.selsets[fx.sk]);
    assert.ok(p.probs && p.probs.size > 0);
    for (const [, v] of p.probs) assert.ok(v >= 0 && v <= 1);
  }
});

test('pattern discovery reports support/CI/q and does not claim validation without OOS', () => {
  const matches = cloneRounds(20);
  const st = Pat.discover(matches, { cat, selsets: base.selsets, minSupport: 20 });
  assert.ok(st.n > 0);
  assert.ok(st.rules.length > 0);
  for (const r of st.rules.slice(0, 50)) {
    assert.ok(r.n >= 20);
    assert.ok(r.observed >= 0 && r.observed <= 1);
    assert.ok(Array.isArray(r.ci));
    assert.ok(r.p == null || Number.isFinite(r.p));
    assert.ok(r.q == null || Number.isFinite(r.q));
  }
  const fx = up.fixtures[0];
  const pred = Pat.predict(st, base.matches[0], { oneX2: st.base.oneX2, ou: st.base.ou, btts: st.base.btts }, { market: st.base.oneX2 });
  assert.equal(pred.enabled, st.validated.length > 0);
});

test('specialist evaluator compares and disables on the available sample', () => {
  const matches = cloneRounds(24);
  const r = Spec.evaluate({ matches, cat, selsets: base.selsets, options: { minTrainRounds: 8, minCompMatches: 20, minPatternSupport: 30, permutations: 49, maxTestRounds: 12 } });
  assert.ok(r.meta.testMatches > 0);
  assert.ok(r.checks.length > 0);
  assert.equal(r.checks.filter(c => c.leakage).length, 0);
  assert.equal(typeof r.sequence.enabled, 'boolean');
  assert.equal(typeof r.patterns.enabled, 'boolean');
  assert.ok(r.patterns.discovered >= 0);
  assert.ok(r.warnings.length >= 1);
});

test('specialists use a chronological calibrator when calibration samples are supplied', () => {
  const matches = cloneRounds(16);
  const calibrationSamples = [];
  for (let i = 0; i < 320; i++) calibrationSamples.push({ ts: 1000 + i, p: 0.4 + (i % 3) * 0.1, y: i % 2, market: '1X2' });
  const r = Spec.evaluate({
    matches, cat, selsets: base.selsets,
    options: { minTrainRounds: 8, minCompMatches: 20, minPatternSupport: 30, permutations: 49, maxTestRounds: 4, calibrationSamples, calibrationMethod: 'platt' }
  });
  assert.equal(r.meta.calibration.requested, true);
  assert.ok(r.meta.calibration.rounds > 0);
  assert.equal(r.meta.calibration.vs, 'calibrated stage5 ensemble');
});
