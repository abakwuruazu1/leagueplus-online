const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPCat, LPParse, LPBackup } = require('../lib/core.js');
require('../lib/model.js');
require('../lib/stats.js');
require('../lib/modelEval.js');
require('../lib/calibration.js');
require('../lib/weights.js');
require('../lib/decision.js');
require('../lib/sequence.js');
require('../lib/patterns.js');
require('../lib/specialists.js');
require('../lib/learn.js');
require('../lib/performance.js');
const LPLedger = require('../lib/ledger.js');
const LPCloud = require('../lib/cloud.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });

async function reset() {
  LPDB._resetForTests(); fake.reset(); await LPDB.open(); await LPDB.clearAll();
  await LPDB.put('meta', Object.assign({ key: 'init' }, init));
  await LPDB.putMany('meta', Object.entries(up.selsets).map(([k, v]) => ({ key: k, value: v, at: 1 })));
  await LPDB.put('meta', { key: 'up:3', at: 1, fixtures: up.fixtures.slice(0, 2), roundId: up.fixtures[0].roundId, close: up.fixtures[0].close });
  await LPDB.putCatalogue({ version: 'cat-test', hash: 'h', builtAt: 1, markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], games: init.games });
  await LPDB.putMany('matches', up.fixtures.slice(0, 2).map(f => ({ key: f.key, fixtureId: f.fixtureId, ts: f.ts, comp: f.comp, hg: 1, ag: 0, quality: { status: 'ok' } })));
}

test.beforeEach(reset);

test('cloud snapshot is compact, read-only and includes fixtures/selsets', async () => {
  const active = {
    version: 'learn-test', createdAt: 1, status: 'candidate', calibration: { enabled: true, method: 'platt', calibrator: { a: 1 } },
    weights: { enabled: true, weights: { mkt: 1 } }, decision: { enabled: false }, training: { matchCount: 2 }, warnings: []
  };
  const snap = await LPCloud.buildSnapshot({ db: LPDB, active, now: up.fixtures[0].close - 60e3, ledgerLimit: 10 });
  assert.equal(snap.schema, 1);
  assert.equal(snap.source, 'leagueplus-extension');
  assert.ok(snap.catalogue.markets.length > 0);
  assert.ok(snap.fixtures.length > 0);
  assert.ok(Object.keys(snap.selsets).length > 0);
  assert.equal(snap.active.version, 'learn-test');
  assert.equal(snap.active.calibration.method, 'platt');
  assert.equal(snap.active.calibration.calibrator, undefined);
  assert.equal(snap.ledger.recentPredictions.length, 0);
  assert.ok(!JSON.stringify(snap).toLowerCase().includes('lp_write_token'));
});

test('cloud upload posts with token, stores status and throttles', async () => {
  const calls = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  try {
    await LPCloud.setConfig(LPDB, { enabled: true, endpoint: 'https://example.test/api/snapshot', token: 'secret', intervalMin: 60 });
    const backup = await LPBackup.exportAll();
    assert.ok(!backup.stores.meta.some(x => x.key === 'cloud:config'), 'backup must not contain the cloud write token');
    const snap = await LPCloud.buildSnapshot({ db: LPDB, now: up.fixtures[0].close - 60e3 });
    const r = await LPCloud.upload({ db: LPDB, snapshot: snap });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers['x-lp-token'], 'secret');
    const status = await LPCloud.getStatus(LPDB);
    assert.equal(status.ok, true);
    assert.ok(status.bytes > 0);
    const second = await LPCloud.maybeUpload({ db: LPDB });
    assert.equal(second.skipped, true);
    const forced = await LPCloud.maybeUpload({ db: LPDB, force: true });
    assert.equal(forced.ok, true);
    assert.equal(calls.length, 2);
  } finally { global.fetch = oldFetch; }
});
