const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LPCat, LPParse } = require('../lib/core.js');
const E = require('../lib/modelEval.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const base = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const matches = [];
for (let r = 0; r < 40; r++) for (const m of base.matches) {
  matches.push(Object.assign({}, m, {
    key: r + ':' + m.comp + ':' + m.idx, fixtureId: '3:' + r + ':' + m.comp + ':' + m.idx,
    roundKey: '3:' + r, roundId: r, ts: 1000000 + r * 10000 + m.idx, week: r, season: 1,
    quality: { status: 'ok', flags: [] }
  }));
}

test('walk-forward evaluation is chronological and exposes all models', () => {
  const r = E.evaluate({ matches, cat, selsets: base.selsets, options: { minTrainRounds: 10, maxTestRounds: 20, permutations: 99, seed: 1 } });
  assert.equal(r.meta.testRounds, 20);
  assert.ok(r.meta.testMatches > 0);
  assert.ok(r.leaderboard.length >= 4);
  const models = r.leaderboard.map(x => x.model);
  for (const m of ['base', 'market', 'mkt', 'dc', 'emp', 'ensemble']) assert.ok(models.includes(m), m);
  assert.ok(r.byMarket['1X2'].dc.n > 0);
  assert.ok(r.byMarket['1X2'].emp.n > 0);
  assert.ok(r.checks.length > 0);
  assert.equal(r.checks.filter(c => c.leakage).length, 0);
  for (const c of r.comparisons) assert.ok(Number.isFinite(c.p) && Number.isFinite(c.q));
});

test('a too-short history is reported, not evaluated as if valid', () => {
  const r = E.evaluate({ matches: matches.slice(0, 40), cat, selsets: base.selsets, options: { minTrainRounds: 10, permutations: 49 } });
  assert.equal(r.meta.testRounds, 0);
  assert.ok(r.warnings.length >= 1);
});
