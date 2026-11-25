const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPCat, LPParse, LPUtil } = require('../lib/core.js');
require('../lib/model.js');
const D = require('../lib/decision.js');
const A = require('../lib/accumulator.js');
const LPLedger = require('../lib/ledger.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });
const res = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const betOpen = Date.parse(round.round.startDate);
const betClose = Date.parse(round.round.noBetDate || round.round.endDate);
const asOfOpen = betOpen + 30e3;

function policy(extra = {}) {
  return D.normalizePolicy(Object.assign({
    enabled: true,
    minEdge: { '1X2': -1, 'OU2.5': -1, BTTS: -1, default: -1 },
    minPointEdge: -1, minOdds: 1.01, maxOdds: 100,
    minStakeUnits: 0, kellyFraction: 0.5, maxStakeUnits: 2,
    uncertaintyMultiplier: { narrow: 1, moderate: 1, wide: 1 }
  }, extra));
}
async function reset() {
  LPDB._resetForTests(); fake.reset(); await LPDB.open(); await LPDB.clearAll();
}

test('selection gating uses the lower bound, odds range and stake cap', () => {
  const p = policy();
  const good = D.evaluateSelection({ id: 101, market: '1X2', p: 0.55, pLow: 0.5, odds: 2.2, uncertaintyClass: 'narrow' }, p);
  assert.equal(good.decision, 'BET');
  assert.ok(good.edgeLow > 0 && good.stakeUnits > 0 && good.stakeUnits <= 2);
  const strict = D.defaultPolicy(); strict.enabled = true;
  const low = D.evaluateSelection({ id: 102, market: '1X2', p: 0.5, pLow: 0.3, odds: 2.2, uncertaintyClass: 'wide' }, strict);
  assert.equal(low.decision, 'NO_BET');
  assert.match(low.reason, /lower-bound edge/);
  const wide = D.evaluateSelection({ id: 103, market: '1X2', p: 0.8, pLow: 0.7, odds: 1.5, uncertaintyClass: 'wide' }, policy({ blockWide: true }));
  assert.equal(wide.decision, 'NO_BET');
  assert.match(wide.reason, /wide uncertainty/);
});

test('fixture selection prefers the best eligible lower-bound edge', () => {
  const ev = { rows: [
    { id: 101, market: '1X2', calibrated: 0.55, pLow: 0.5, odds: 2.2, uncertaintyClass: 'narrow' },
    { id: 102, market: '1X2', calibrated: 0.7, pLow: 0.6, odds: 1.9, uncertaintyClass: 'moderate' }
  ] };
  const r = D.evaluateFixture(ev, policy());
  assert.equal(r.decision, 'BET');
  assert.equal(r.selectedId, 102);
});

test('accumulator reaches target odds and rejects same-fixture correlation by default', () => {
  const legs = [
    { fixtureId: 'a', id: 1, market: '1X2', p: 0.55, pLow: 0.5, odds: 2.2, uncertaintyClass: 'narrow' },
    { fixtureId: 'b', id: 2, market: '1X2', p: 0.55, pLow: 0.5, odds: 2.2, uncertaintyClass: 'narrow' },
    { fixtureId: 'c', id: 3, market: '1X2', p: 0.6, pLow: 0.55, odds: 2.1, uncertaintyClass: 'moderate' }
  ];
  const r = A.optimise(legs, { targetOdds: 4, maxLegs: 3, minJointP: 0.01 });
  assert.equal(r.decision, 'BET');
  assert.ok(r.slip.totalOdds >= 3.92 && r.slip.jointP > 0 && r.slip.ev > 0);
  assert.equal(new Set(r.slip.legs.map(l => l.fixtureId)).size, r.slip.legs.length);
  const same = A.optimise([
    { fixtureId: 'a', id: 1, market: '1X2', p: 0.6, pLow: 0.55, odds: 2.2, uncertaintyClass: 'narrow' },
    { fixtureId: 'a', id: 2, market: 'BTTS', p: 0.6, pLow: 0.55, odds: 2.2, uncertaintyClass: 'narrow' }
  ], { targetOdds: 4, maxLegs: 2 });
  assert.equal(same.decision, 'NO_BET');
});

test('walk-forward decision policy activates only with a positive holdout lower bound', () => {
  const r = (() => { let x = 9; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; })();
  const samples = [];
  for (let i = 0; i < 900; i++) {
    samples.push({ fixtureId: 'f' + i, roundKey: 'r' + Math.floor(i / 20), ts: i, id: 101, market: '1X2', p: 0.5, pLow: 0.48, odds: 2.2, y: r() < 0.55 ? 1 : 0, uncertaintyClass: 'narrow' });
  }
  const w = D.walkForward(samples, { minSamples: 200, minTestSamples: 100, minBets: 80, minTrainBets: 40, permutations: 99 });
  assert.equal(w.decision.enabled, true);
  assert.ok(w.decision.test.bets >= 80 && w.decision.test.roi > 0);
  assert.ok(w.decision.ciLow > 0);
  assert.ok(w.decision.policy.enabled);
  const small = D.walkForward(samples.slice(0, 120), { minSamples: 500 });
  assert.equal(small.decision.enabled, false);
});

test('ledger records and settles a policy decision', async () => {
  await reset();
  await LPDB.putCatalogue({ version: 'cat-test', hash: 'test-hash', builtAt: 1, markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], games: init.games });
  await LPDB.putMany('matches', res.matches.map(m => Object.assign({}, m, { quality: m.quality || { status: 'ok', flags: [] }, contentHash: LPUtil.contentHash({ key: m.key, hg: m.hg, ag: m.ag, goals: m.goals, odds: m.odds, sk: m.sk }) })));
  await LPDB.putMany('meta', Object.entries(up.selsets).map(([k, v]) => ({ key: k, value: v, at: 1 })));
  const expected = up.fixtures.filter(f => f.odds).length;
  const rec = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test', policy: policy() });
  assert.equal(rec.recorded, expected);
  const preds = await LPDB.getAll('predictions');
  assert.ok(preds.every(p => p.decision === 'BET' && p.selectedId != null && p.decisionPolicyVersion === D.VERSION));
  assert.ok(preds.every(p => Number.isFinite(p.stakeUnits)));
  const results = up.fixtures.map((fx, i) => {
    const hg = i % 3, ag = (i * 2) % 3, goals = [];
    for (let k = 0; k < hg; k++) goals.push([10 + k, 'h']);
    for (let k = 0; k < ag; k++) goals.push([30 + k, 'a']);
    return Object.assign({}, fx, { key: fx.key, fixtureId: fx.fixtureId, roundKey: fx.roundKey, hg, ag, goals, tlOk: true, quality: { status: 'ok', flags: [] }, contentHash: LPUtil.contentHash({ key: fx.key, hg, ag, goals, odds: fx.odds, sk: fx.sk }) });
  });
  await LPDB.putMany('matches', results);
  const s = await LPLedger.settleRound({ db: LPDB, game: 3, roundId: up.fixtures[0].roundId });
  assert.ok(s.settled > 0);
  const settled = await LPDB.get('settlements', preds[0].predictionId);
  assert.ok(settled.bet);
  assert.ok(Number.isFinite(settled.bet.profitUnits));
  assert.equal(typeof settled.bet.won, 'boolean');
});
