const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPSync } = require('../lib/core.js');
require('../lib/model.js');
const LPLedger = require('../lib/ledger.js');

const initBody = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8'));
const roundBody = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8'));
const initData = JSON.parse(JSON.stringify(initBody.data));
const roundData = JSON.parse(JSON.stringify(roundBody.data));
const now = Date.parse(roundData.round.startDate) + 30e3;

function response(data) { return { ok: true, status: 200, json: async () => ({ status: 1, data }) }; }
function makeFetch(r) {
  return async (url) => {
    if (url.endsWith('/game/init')) return response(initData);
    if (url.includes('/game/3/round')) return response(r);
    if (url.includes('/game/standings/')) return response({ standings: [] });
    throw new Error('unexpected URL ' + url);
  };
}
function fakeStorage() {
  const data = {};
  return { data, async get(k) { return data[k]; }, async set(o) { Object.assign(data, o); } };
}
function fakeAlarms() { return { created: [], create(name, opts) { this.created.push({ name, when: opts.when }); } }; }

async function reset() {
  LPDB._resetForTests();
  fake.reset();
  await LPDB.open();
  await LPDB.clearAll();
}

test.beforeEach(reset);

function configure(r, storage = fakeStorage(), alarms = fakeAlarms()) {
  LPSync.configure({ db: LPDB, fetch: makeFetch(r), storage, alarms, now: () => now, ledger: LPLedger });
  return { storage, alarms };
}

test('syncGame captures results, rounds and immutable snapshots idempotently', async () => {
  const { storage, alarms } = configure(roundData);
  const r1 = await LPSync.syncGame(3);
  assert.equal(r1.ok, true);
  assert.equal(r1.added, 22);
  assert.ok(r1.ledger && r1.ledger.recorded > 0);
  assert.equal(await LPDB.count('matches'), 22);
  assert.equal(await LPDB.count('rounds'), 2);
  assert.equal(await LPDB.count('snapshots'), 44);
  assert.equal(await LPDB.count('conflicts'), 0);
  assert.equal(await LPDB.count('catalogues'), 1);
  assert.ok((await LPDB.getAll('qualityLog')).length >= 1);
  assert.ok(storage.data.lpsched && storage.data.lpsched[3] && storage.data.lpsched[3].at > now);
  assert.ok(storage.data.lpstatus && storage.data.lpstatus.games[3].ok);
  assert.ok(alarms.created.some(a => a.name === 'lpG:3'));

  const r2 = await LPSync.syncGame(3);
  assert.equal(r2.ok, true);
  assert.equal(r2.added, 0);
  assert.ok(r2.ledger && r2.ledger.recorded === 0);
  assert.equal(await LPDB.count('matches'), 22);
  assert.equal(await LPDB.count('rounds'), 2);
  assert.equal(await LPDB.count('snapshots'), 44);
  assert.equal(await LPDB.count('conflicts'), 0);
});

test('a changed historical result is logged, never overwritten', async () => {
  configure(roundData);
  await LPSync.syncGame(3);
  const changed = JSON.parse(JSON.stringify(roundData));
  const parts = String(changed.roundResults.results[0]).split('|');
  parts[0] = '2:2';
  changed.roundResults.results[0] = parts.join('|');
  configure(changed);
  const r = await LPSync.syncGame(3);
  assert.equal(r.ok, true);
  assert.ok(r.conflicts >= 1);
  assert.equal(await LPDB.count('matches'), 22);
  const first = (await LPDB.getAll('matches')).find(m => m.idx === 0);
  assert.notEqual(first.hg + ':' + first.ag, '2:2');
});

test('a missing score produces a partial round and a quality issue', async () => {
  const broken = JSON.parse(JSON.stringify(roundData));
  const parts = String(broken.roundResults.results[0]).split('|');
  parts[0] = '';
  broken.roundResults.results[0] = parts.join('|');
  configure(broken);
  const r = await LPSync.syncGame(3);
  assert.equal(r.ok, true);
  assert.equal(await LPDB.count('matches'), 21);
  const ql = await LPDB.getAll('qualityLog');
  assert.ok(ql.some(q => q.code === 'partial_round'));
  assert.ok(ql.some(q => q.code === 'score_invalid'));
});

test('round gaps are detected from consecutive result round IDs', async () => {
  configure(roundData);
  await LPSync.syncGame(3);
  const jumped = JSON.parse(JSON.stringify(roundData));
  jumped.roundResults.roundId = +roundData.roundResults.roundId + 2;
  jumped.round.roundId = +roundData.round.roundId + 2;
  configure(jumped);
  await LPSync.syncGame(3);
  const ql = await LPDB.getAll('qualityLog');
  assert.ok(ql.some(q => q.code === 'round_gap'));
});

test('nextSyncAt always schedules in the future', () => {
  const next = LPSync.nextSyncAt(roundData, now);
  assert.ok(Number.isFinite(next));
  assert.ok(next >= now + 30e3);
  const noRound = LPSync.nextSyncAt({}, now);
  assert.equal(noRound, now + 120e3);
});
