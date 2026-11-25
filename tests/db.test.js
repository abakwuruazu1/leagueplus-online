const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./fake-idb.js');
global.indexedDB = fake.indexedDB;
const { LPDB, LPBackup, LPUtil } = require('../lib/core.js');

async function fresh() {
  LPDB._resetForTests();
  fake.reset();
  await LPDB.open();
  await LPDB.clearAll();
}

test.beforeEach(fresh);

test('immutable writes: identical skipped, different kept and logged', async () => {
  const a = await LPDB.putImmutable('matches', { key: 'm1', contentHash: 'aaa', hg: 1 });
  assert.deepEqual(a, { added: 1, skipped: 0, conflicts: 0 });
  const b = await LPDB.putImmutable('matches', { key: 'm1', contentHash: 'aaa', hg: 1 });
  assert.deepEqual(b, { added: 0, skipped: 1, conflicts: 0 });
  const c = await LPDB.putImmutable('matches', { key: 'm1', contentHash: 'bbb', hg: 2 });
  assert.deepEqual(c, { added: 0, skipped: 0, conflicts: 1 });
  const m = await LPDB.get('matches', 'm1');
  assert.equal(m.contentHash, 'aaa');
  assert.equal(m.hg, 1);
  assert.equal(await LPDB.count('conflicts'), 1);
});

test('atomic round commit is idempotent and preserves conflicts', async () => {
  const payload = {
    rounds: [{ key: '3:100', game: 3, roundId: 100, status: 'open', capturedMatches: 2, expectedMatches: 2, createdAt: 1, lastSeenAt: 1 }],
    matches: [{ key: '100:9:0', contentHash: 'h1', hg: 2, ag: 0, ts: 10 }],
    snapshots: [{ key: 'f1:1:h', fixtureId: 'f1', hash: 'h', capturedAt: 1, lastSeenAt: 1, observations: 1 }],
    meta: [{ key: 'x', value: 1 }],
    qualityLog: [{ key: 'match|100:9:0|timeline_incomplete', code: 'timeline_incomplete', severity: 'warn', count: 1, lastTs: 1 }]
  };
  const r1 = await LPDB.commitRound(payload);
  assert.equal(r1.rounds, 1);
  assert.equal(r1.added, 1);
  assert.equal(r1.snapshotsAdded, 1);
  const r2 = await LPDB.commitRound(payload);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(r2.snapshotsAdded, 0);
  assert.equal(await LPDB.count('matches'), 1);
  assert.equal(await LPDB.count('rounds'), 1);
  assert.equal(await LPDB.count('snapshots'), 1);
  assert.equal(await LPDB.count('conflicts'), 0);
  const snap = await LPDB.get('snapshots', 'f1:1:h');
  assert.equal(snap.observations, 2);
  const q = await LPDB.get('qualityLog', 'match|100:9:0|timeline_incomplete');
  assert.equal(q.count, 2);

  await LPDB.commitRound({ matches: [{ key: '100:9:0', contentHash: 'h2', hg: 9, ag: 9 }] });
  assert.equal((await LPDB.get('matches', '100:9:0')).hg, 2);
  assert.equal(await LPDB.count('conflicts'), 1);
});

test('migration backfills v1 fields without changing scores', async () => {
  await LPDB.put('meta', { key: 'init', games: [{ id: 3, leagues: [{ id: 9, enabled: 1 }] }] });
  await LPDB.put('meta', { key: 'cat:current', version: 'cat-x' });
  await LPDB.put('meta', { key: 'sel:abc', value: '101-102-103' });
  await LPDB.put('matches', { key: '100:9:0', comp: 9, roundId: 100, idx: 0, home: 'A', away: 'B', hg: 1, ag: 0, goals: [[1, 'h']], tlOk: true, odds: '2.0-3.0-4.0', sk: 'sel:abc', ts: 1000 });
  const r = await LPDB.migrate();
  assert.equal(r.done, true);
  const m = await LPDB.get('matches', '100:9:0');
  assert.equal(m.hg, 1);
  assert.equal(m.game, 3);
  assert.equal(m.fixtureId, '3:100:9:0');
  assert.equal(m.roundKey, '3:100');
  assert.ok(m.contentHash);
  assert.ok(m.quality);
  assert.equal(await LPDB.count('rounds'), 1);
  const again = await LPDB.migrate();
  assert.equal(again.done, true);
  await LPDB.put('matches', { key: '101:9:0', comp: 9, roundId: 101, idx: 0, home: 'C', away: 'D', hg: 0, ag: 0, goals: [], tlOk: true, odds: '2.0-3.0-4.0', sk: 'sel:abc', ts: 2000 });
  const forced = await LPDB.migrate(true);
  assert.equal(forced.done, true);
  assert.equal((await LPDB.get('matches', '101:9:0')).fixtureId, '3:101:9:0');
});

test('backup export/import merges immutably', async () => {
  await LPDB.putImmutable('matches', { key: 'm1', contentHash: 'aaa', hg: 1 }, { keyPath: 'key', hashField: 'contentHash' });
  await LPDB.put('meta', { key: 'x', v: 5 });
  await LPDB.mergeQuality([{ key: 'q|1', code: 'c', severity: 'warn', count: 1, lastTs: 1 }]);
  const backup = await LPBackup.exportAll();
  assert.equal(backup.app, 'leagueplus-engine');
  assert.equal(backup.schema, 3);
  assert.equal(backup.stores.matches.length, 1);
  await LPDB.clearAll();
  const r1 = await LPBackup.importAll(backup);
  assert.equal(r1.added, 1);
  assert.equal(await LPDB.count('matches'), 1);
  const r2 = await LPBackup.importAll(backup);
  assert.equal(r2.skipped, 1);
  assert.equal(await LPDB.count('matches'), 1);
});

test('backup excludes transient metadata and does not overwrite a newer catalogue pointer', async () => {
  await LPDB.put('meta', { key: 'up:3', at: 1, fixtures: [{ key: 'x' }] });
  await LPDB.put('meta', { key: 'cat:current', version: 'old', hash: 'old', at: 1 });
  await LPDB.put('meta', { key: 'sel:abc', value: '101-102-103', at: 1 });
  const b = await LPBackup.exportAll();
  assert.ok(!b.stores.meta.some(x => x.key === 'up:3'));
  await LPDB.clearAll();
  await LPDB.put('meta', { key: 'cat:current', version: 'new', hash: 'new', at: 2 });
  await LPBackup.importAll(b);
  assert.equal((await LPDB.get('meta', 'cat:current')).version, 'new');
  assert.equal((await LPDB.get('meta', 'sel:abc')).value, '101-102-103');
});

test('imports the v1 backup shape', async () => {
  const r = await LPBackup.importAll({
    v: 1,
    matches: [{ key: '100:9:0', comp: 9, roundId: 100, idx: 0, home: 'A', away: 'B', hg: 1, ag: 0, goals: [[1, 'h']], tlOk: true, odds: '2.0-3.0-4.0', sk: 'sel:abc', ts: 1000 }],
    meta: [{ key: 'init', at: 1, games: [{ id: 3, leagues: [{ id: 9, enabled: 1 }] }], markets: [] }]
  });
  assert.equal(r.added, 1);
  assert.equal(await LPDB.count('matches'), 1);
  await LPDB.migrate();
  const m = await LPDB.get('matches', '100:9:0');
  assert.equal(m.fixtureId, '3:100:9:0');
});

test('stats exposes all stores', async () => {
  const s = await LPDB.stats();
  assert.equal(s.schema, 3);
  for (const k of ['matches', 'rounds', 'catalogues', 'snapshots', 'conflicts', 'qualityLog']) assert.equal(typeof s[k], 'number');
});
