const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPCat, LPParse, LPUtil } = require('../lib/core.js');
require('../lib/model.js');
const LPLedger = require('../lib/ledger.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });
const res = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const betOpen = Date.parse(round.round.startDate);
const betClose = Date.parse(round.round.noBetDate || round.round.endDate);
const asOfOpen = betOpen + 30e3;
const asOfPre = betClose - 60e3;
const expected = up.fixtures.filter(f => f.odds).length;

async function reset() {
  LPDB._resetForTests();
  fake.reset();
  await LPDB.open();
  await LPDB.clearAll();
  await LPDB.putCatalogue({ version: 'cat-test', hash: 'test-hash', builtAt: 1, markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], games: init.games });
  await LPDB.putMany('matches', res.matches.map(m => Object.assign({}, m, { quality: m.quality || { status: 'ok', flags: [] }, contentHash: LPUtil.contentHash({ key: m.key, hg: m.hg, ag: m.ag, goals: m.goals, odds: m.odds, sk: m.sk }) })));
  await LPDB.putMany('meta', Object.entries(up.selsets).map(([k, v]) => ({ key: k, value: v, at: 1 })));
}

test.beforeEach(reset);

test('records an immutable open ledger row before the outcome', async () => {
  const r = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  assert.equal(r.modelVersion, LPLedger.VERSION);
  assert.equal(r.recorded, expected);
  assert.equal(await LPDB.count('predictions'), expected);
  const rows = await LPDB.getAllBy('predictions', 'fixtureId', up.fixtures[0].fixtureId);
  assert.equal(rows.length, 1);
  const p = rows[0];
  assert.equal(p.checkpoint, 'open');
  assert.equal(p.decision, 'NO_BET');
  assert.equal(p.selectedId, null);
  assert.equal(p.pCalibrated, null);
  assert.equal(p.calibrationVersion, null);
  assert.equal(p.confidenceClass, 'uncalibrated');
  assert.equal(p.modelVersion, LPLedger.VERSION);
  assert.equal(p.catalogueVersion, 'cat-test');
  assert.ok(p.ids.length > 0);
  assert.equal(p.ids.length, p.odds.length);
  assert.equal(p.ids.length, p.ensemble.length);
  assert.equal(p.ids.length, p.weighted.length);
  assert.equal(p.ids.length, p.calibrated.length);
  assert.equal(p.ids.length, p.plow.length);
  assert.equal(p.ids.length, p.pLow.length);
  assert.equal(p.ids.length, p.pHigh.length);
  assert.equal(p.ids.length, p.nEff.length);
  assert.equal(p.ids.length, p.uncertainty.length);
  assert.ok(p.weighted.every(x => x == null));
  assert.ok(p.calibrated.every(x => x == null));
  assert.ok(p.pLow.every((x, i) => x >= 0 && x <= p.ensemble[i] + 1e-12));
  assert.ok(p.pHigh.every((x, i) => x >= p.ensemble[i] - 1e-12 && x <= 1));
  assert.ok(p.nEff.every(x => x >= 5 && x <= 1000));
  assert.ok(p.uncertainty.every(x => ['narrow', 'moderate', 'wide'].includes(x)));
  assert.equal(p.ciMethod, LPLedger.CI_METHOD);
  assert.ok(p.odds.every(o => o > 1));
  assert.ok(p.trainingCutoff == null || p.trainingCutoff < p.asOf);
  assert.ok(p.trainN > 0);
  assert.equal(p.settlementStatus, 'pending');
  assert.ok(p.contentHash);
  assert.match(p.predictionId, /:open:/);
});

test('records weighted and calibrated series only when supplied', async () => {
  const r = await LPLedger.recordFixtures({
    fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test',
    weights: { mkt: 1, dc: 0, emp: 0, team: 0 },
    calibrate: p => Math.min(0.99, Math.max(0.01, p * 0.9)),
    calibrationVersion: 'test-cal'
  });
  assert.equal(r.recorded, expected);
  assert.equal(r.calibrationVersion, 'test-cal');
  assert.equal(r.weightsVersion, LPLedger.WEIGHTED_VERSION);
  const rows = await LPDB.getAllBy('predictions', 'fixtureId', up.fixtures[0].fixtureId);
  const p = rows[0];
  assert.ok(p.weighted.every(x => x != null && x >= 0 && x <= 1));
  assert.ok(p.calibrated.every(x => x != null && x >= 0 && x <= 1));
  assert.ok(Array.isArray(p.pCalibrated) && p.pCalibrated.length === p.ids.length);
  assert.ok(p.pLow.every((x, i) => x >= 0 && x <= p.calibrated[i] + 1e-12));
  assert.equal(p.calibrationVersion, 'test-cal');
  assert.equal(p.weightedVersion, LPLedger.WEIGHTED_VERSION);
  assert.notEqual(p.confidenceClass, 'uncalibrated');
});

test('is idempotent and records a separate pre-close checkpoint', async () => {
  const r1 = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  const r2 = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  assert.equal(r1.recorded, expected);
  assert.equal(r2.recorded, 0);
  assert.equal(r2.conflicts, 0);
  assert.equal(await LPDB.count('predictions'), expected);

  const r3 = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfPre, halfLifeH: 6, catalogueVersion: 'cat-test' });
  assert.equal(r3.recorded, expected);
  assert.equal(await LPDB.count('predictions'), expected * 2);
  const pre = await LPDB.getAllBy('predictions', 'fixtureId', up.fixtures[0].fixtureId);
  assert.ok(pre.some(p => p.checkpoint === 'preclose'));

  const r4 = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: betClose + 10e3, halfLifeH: 6, catalogueVersion: 'cat-test' });
  assert.equal(r4.recorded, 0);
  assert.equal(await LPDB.count('predictions'), expected * 2);
});

test('does not settle before the result exists', async () => {
  await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  const s = await LPLedger.settleAll({ db: LPDB });
  assert.equal(s.settled, 0);
  assert.equal(await LPDB.count('settlements'), 0);
});

test('settles the round in separate immutable rows with metrics', async () => {
  await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfPre, halfLifeH: 6, catalogueVersion: 'cat-test' });
  const results = up.fixtures.map((fx, i) => {
    const hg = i % 3, ag = (i * 2) % 3, goals = [];
    for (let k = 0; k < hg; k++) goals.push([10 + k, 'h']);
    for (let k = 0; k < ag; k++) goals.push([30 + k, 'a']);
    return Object.assign({}, fx, {
      key: fx.key, fixtureId: fx.fixtureId, roundKey: fx.roundKey, hg, ag, goals, tlOk: true,
      quality: { status: 'ok', flags: [] },
      contentHash: LPUtil.contentHash({ key: fx.key, hg, ag, goals, odds: fx.odds, sk: fx.sk })
    });
  });
  await LPDB.putMany('matches', results);
  const roundId = up.fixtures[0].roundId;
  const s1 = await LPLedger.settleRound({ db: LPDB, game: 3, roundId });
  assert.equal(s1.settled, expected * 2);
  assert.equal(await LPDB.count('settlements'), expected * 2);
  const preds = await LPDB.getAllBy('predictions', 'fixtureId', up.fixtures[0].fixtureId);
  const settled = await LPDB.get('settlements', preds[0].predictionId);
  assert.ok(settled);
  assert.equal(settled.settlementStatus, 'settled');
  assert.equal(settled.outcomes.length, preds[0].ids.length);
  assert.ok(settled.metrics.ensemble.n > 0);
  assert.ok(Number.isFinite(settled.metrics.ensemble.brier));
  assert.ok(Number.isFinite(settled.metrics.ensemble.logLoss));
  assert.equal(settled.metrics.weighted.n, 0);
  assert.equal(settled.metrics.calibrated.n, 0);
  assert.equal(settled.modelVersion, LPLedger.VERSION);
  assert.ok(settled.contentHash);

  const s2 = await LPLedger.settleAll({ db: LPDB });
  assert.equal(s2.settled, 0);
  assert.equal(await LPDB.count('settlements'), expected * 2);
});

test('stats report ledger coverage and model version', async () => {
  await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  const s = await LPLedger.stats({ db: LPDB });
  assert.equal(s.modelVersion, LPLedger.VERSION);
  assert.equal(s.predictions, expected);
  assert.equal(s.settlements, 0);
  assert.ok(s.recentTotal >= expected);
  assert.ok(s.recentOpen >= expected);
});

test('training cutoff never includes a future or invalid result', async () => {
  const future = Object.assign({}, res.matches[0], {
    key: 'future:9:0', fixtureId: '3:future:9:0', roundId: 999999,
    ts: asOfOpen + 3600e3, hg: 9, ag: 9, goals: [], tlOk: false,
    quality: { status: 'ok', flags: [] }
  });
  await LPDB.put('matches', future);
  const invalid = Object.assign({}, res.matches[0], {
    key: 'invalid:9:0', fixtureId: '3:invalid:9:0', roundId: 888888,
    ts: asOfOpen - 1000, hg: 9, ag: 9, goals: [], tlOk: false,
    quality: { status: 'invalid', flags: ['score_invalid'] }
  });
  await LPDB.put('matches', invalid);
  const r = await LPLedger.recordFixtures({ fixtures: up.fixtures, selsets: up.selsets, cat, db: LPDB, asOf: asOfOpen, halfLifeH: 6, catalogueVersion: 'cat-test' });
  assert.equal(r.recorded, expected);
  const rows = await LPDB.getAllBy('predictions', 'fixtureId', up.fixtures[0].fixtureId);
  assert.ok(rows[0].trainingCutoff == null || rows[0].trainingCutoff < rows[0].asOf);
  const validPrior = res.matches.filter(m => +m.comp === +up.fixtures[0].comp).length;
  assert.equal(rows[0].trainN, validPrior);
});
