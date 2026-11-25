const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPCat, LPParse, LPSync } = require('../lib/core.js');
require('../lib/model.js');
require('../lib/stats.js');
require('../lib/modelEval.js');
require('../lib/calibration.js');
require('../lib/weights.js');
require('../lib/sequence.js');
require('../lib/patterns.js');
require('../lib/specialists.js');
const LPLearn = require('../lib/learn.js');
const LPLedger = require('../lib/ledger.js');
const { LPBackup } = require('../lib/core.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const base = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const now = Date.parse(round.round.startDate) + 30e3;

function response(data) { return { ok: true, status: 200, json: async () => ({ status: 1, data }) }; }
function makeFetch(r) {
  return async url => {
    if (url.endsWith('/game/init')) return response(init);
    if (url.includes('/game/3/round')) return response(r);
    if (url.includes('/game/standings/')) return response({ standings: [] });
    throw new Error('unexpected URL ' + url);
  };
}
function fakeStorage() { const data = {}; return { data, async get(k) { return data[k]; }, async set(o) { Object.assign(data, o); } }; }
function fakeAlarms() { return { created: [], create(name, opts) { this.created.push({ name, when: opts.when }); } }; }

async function reset() {
  LPDB._resetForTests(); fake.reset(); await LPDB.open(); await LPDB.clearAll();
}
async function seed(nRounds = 24) {
  await LPDB.putCatalogue({ version: 'cat-test', hash: 'h', builtAt: 1, markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], games: init.games });
  await LPDB.put('meta', Object.assign({ key: 'init' }, init));
  await LPDB.putMany('meta', Object.entries(base.selsets).map(([k, v]) => ({ key: k, value: v, at: 1 })));
  const matches = [];
  for (let r = 0; r < nRounds; r++) for (const m of base.matches) {
    matches.push(Object.assign({}, m, {
      key: r + ':' + m.comp + ':' + m.idx, fixtureId: '3:' + r + ':' + m.comp + ':' + m.idx,
      roundKey: '3:' + r, roundId: r, ts: 1000000 + r * 10000 + m.idx, week: r, season: 1,
      quality: { status: 'ok', flags: [] }
    }));
  }
  await LPDB.putMany('matches', matches);
}
function lowConfig(extra = {}) {
  return Object.assign({
    enabled: true, autoActivate: true, minNewMatches: 10, minIntervalH: 0, minSamples: 100,
    minTrainSamples: 50, minTestSamples: 50, minTrainRounds: 5, minCompMatches: 20,
    maxTestRounds: 6, permutations: 49, shrink: 0.5, reevaluateSpecialists: false
  }, extra);
}

test.beforeEach(reset);

test('learning config is bounded and auditable', async () => {
  const c = await LPLearn.setConfig(LPDB, { minNewMatches: -5, minSamples: 10, minIntervalH: 9999, shrink: 5 }, { by: 'test' });
  assert.equal(c.minNewMatches, 1);
  assert.equal(c.minSamples, 20);
  assert.equal(c.minIntervalH, 720);
  assert.equal(c.shrink, 1);
  const snap = await LPLearn.snapshot({ db: LPDB });
  assert.ok(snap.config && snap.log.some(x => x.type === 'config'));
  assert.equal(snap.active, null);
});

test('insufficient sample is stored as rejected and never activated', async () => {
  await seed(2);
  await LPLearn.setConfig(LPDB, lowConfig({ minSamples: 100000, minNewMatches: 1 }), { by: 'test' });
  const r = await LPLearn.refresh({ db: LPDB, force: true });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'insufficient samples');
  const snap = await LPLearn.snapshot({ db: LPDB });
  assert.ok(snap.states.length >= 1);
  assert.equal(snap.states[0].status, 'rejected');
  assert.equal(snap.active, null);
  assert.ok(snap.log.some(x => x.type === 'skip'));
});

test('refresh activates a passing state and rollback is immediate', async () => {
  await seed(24);
  await LPLearn.setConfig(LPDB, lowConfig(), { by: 'test' });
  const r = await LPLearn.refresh({ db: LPDB, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'candidate');
  assert.equal(r.calibration.enabled, true);
  assert.equal(r.weights.enabled, true);
  assert.ok(r.activation && r.activation.activated);
  const active = await LPLearn.getActive(LPDB);
  assert.ok(active && active.version === r.state);
  assert.equal(active.status, 'candidate');
  const opts = await LPLearn.activeOpts({ db: LPDB });
  assert.equal(typeof opts.calibrate, 'function');
  assert.ok(opts.weights && Number.isFinite(opts.weights.mkt));
  assert.equal(opts.calibrationVersion, 'stage7-calibration-v1');
  const snap = await LPLearn.snapshot({ db: LPDB });
  assert.ok(snap.log.some(x => x.type === 'activate'));
  const skip = await LPLearn.refresh({ db: LPDB });
  assert.equal(skip.skipped, true);
  assert.match(skip.reason, /new matches|no new match data/);
  const rb = await LPLearn.rollback(LPDB, null);
  assert.equal(rb.ok, true);
  assert.equal(await LPLearn.getActive(LPDB), null);
  const snap2 = await LPLearn.snapshot({ db: LPDB });
  assert.ok(snap2.log.some(x => x.type === 'rollback'));
  assert.ok(snap2.states.some(s => s.version === r.state));
});

test('learning states and the audit log survive backup and restore', async () => {
  const state = {
    version: 'learn-backup', createdAt: 1, status: 'rejected', stage: LPLearn.VERSION,
    training: { matchCount: 1, lastTs: 1 }, warnings: ['test'], hash: 'backup-hash'
  };
  await LPDB.putImmutable('modelStates', state, { keyPath: 'version', hashField: 'hash' });
  await LPDB.add('learningLog', { ts: 1, type: 'activate', from: null, to: 'learn-backup', by: 'test' });
  const b = await LPBackup.exportAll();
  assert.ok(b.stores.modelStates.some(s => s.version === 'learn-backup'));
  assert.ok(b.stores.learningLog.some(x => x.type === 'activate'));
  await LPDB.clearAll();
  const r = await LPBackup.importAll(b);
  assert.ok(r.added + (r.stores.modelStates && r.stores.modelStates.added) >= 1);
  assert.ok(await LPDB.get('modelStates', 'learn-backup'));
  assert.ok((await LPDB.getAll('learningLog')).some(x => x.type === 'activate'));
});

test('the active learned state is applied by the sync ledger path', async () => {
  const state = {
    version: 'learn-test', createdAt: Date.now(), status: 'candidate', stage: LPLearn.VERSION,
    modelVersion: 'stage7-models-v1', calibrationVersion: 'stage7-calibration-v1', weightsVersion: 'stage7-weights-v1',
    training: { matchCount: 1, sampleCount: 10, testMatches: 1 },
    calibration: { enabled: true, method: 'platt', calibrator: { method: 'platt', a: 1, b: 0 }, warnings: [] },
    weights: { enabled: true, weights: { mkt: 0.7, dc: 0.1, emp: 0.1, team: 0.1 }, warnings: [] },
    decisionVersion: 'stage9-decision-v1',
    decision: { enabled: true, policy: { enabled: true, minEdge: { '1X2': -1, 'OU2.5': -1, BTTS: -1, default: -1 }, minPointEdge: -1, minOdds: 1.01, maxOdds: 100, minStakeUnits: 0, kellyFraction: 0.5, maxStakeUnits: 2, uncertaintyMultiplier: { narrow: 1, moderate: 1, wide: 1 } }, warnings: [] },
    warnings: [], hash: 'hash-test'
  };
  await LPDB.putImmutable('modelStates', state, { keyPath: 'version', hashField: 'hash' });
  await LPDB.put('meta', { key: 'learn:active', version: state.version, activatedAt: Date.now(), by: 'test' });
  const storage = fakeStorage(), alarms = fakeAlarms();
  LPSync.configure({ db: LPDB, fetch: makeFetch(round), storage, alarms, now: () => now, ledger: LPLedger, learning: LPLearn });
  const r = await LPSync.syncGame(3);
  assert.equal(r.ok, true);
  assert.ok(r.ledger && r.ledger.recorded > 0);
  const preds = await LPDB.getAll('predictions');
  assert.ok(preds.length > 0);
  assert.ok(preds.every(p => p.calibrationVersion === 'stage7-calibration-v1'));
  assert.ok(preds.every(p => p.weightedVersion === 'stage7-weights-v1'));
  assert.ok(preds.every(p => Array.isArray(p.calibrated) && p.calibrated.some(x => x != null)));
  assert.ok(preds.every(p => Array.isArray(p.weighted) && p.weighted.some(x => x != null)));
  assert.ok(preds.every(p => p.decision === 'BET' && p.selectedId != null && p.decisionPolicyVersion === 'stage9-decision-v1'));
});
