const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LPCat, LPParse, LPQuality } = require('../lib/core.js');
const LPModel = require('../lib/model.js');

const init = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'init.json'), 'utf8')).data;
const round = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game3-round.json'), 'utf8')).data;
const cat = LPCat.buildMap(init);
const up = LPParse.upcoming(3, round.round, { catalogueVersion: 'cat-test', capturedAt: 1000 });
const res = LPParse.results(3, round.roundResults, { catalogueVersion: 'cat-test', capturedAt: 1000, betOpen: 0 });
const sel = (mId, name, sub) => Object.values(cat).find(c => c.mId === mId && String(c.name).trim() === name && (sub === undefined || c.sub === sub));

test('catalogue: complete definition set', () => {
  assert.equal(Object.keys(cat).length, 143);
  assert.equal(new Set(Object.values(cat).map(c => c.mId)).size, 15);
  const a = LPCat.audit(cat);
  assert.equal(a['1'].pattern, 'exclusive');
  assert.equal(a['2'].pattern, 'pair');
  assert.equal(a['3'].pattern, 'exclusive');
});

test('settlement: Goal Up high-score draw and incomplete timelines', () => {
  const x1 = sel(15, 'X - 1UP');
  const one1 = sel(15, '1 - 1UP');
  const two1 = sel(15, '2 - 1UP');
  assert.equal(LPCat.settle(x1, 4, 4, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(x1, 2, 2, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(x1, 3, 2, [], { tlOk: true }), false);
  assert.equal(LPCat.settle(one1, 2, 0, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(one1, 0, 2, [], { tlOk: true }), false);
  assert.equal(LPCat.settle(two1, 0, 2, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(one1, 2, 0, [[10, 'h']], { tlOk: false }), null);
});

test('settlement: correct score, over/under and unknown markets', () => {
  assert.equal(LPCat.settle(sel(4, '2-0'), 2, 0, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(sel(4, '2-0'), 2, 1, [], { tlOk: true }), false);
  assert.equal(LPCat.settle(sel(5, 'O4.5', '4.5'), 4, 3, [], { tlOk: true }), true);
  assert.equal(LPCat.settle(sel(5, 'U4.5', '4.5'), 4, 3, [], { tlOk: true }), false);
  const unknown = { id: 9999, mId: 99, market: 'Unknown', name: 'X', ws: new Set(), type: 1, aw: false };
  assert.equal(LPCat.settle(unknown, 1, 0, [], { tlOk: true }), null);
});

test('fair odds: normalisation, pair, overlap and singleton flags', () => {
  const fx = up.fixtures[0];
  const om = LPParse.oddsMap(fx.odds, up.selsets[fx.sk]);
  const fp = LPModel.fair(cat, om);
  const sumFor = pred => [...fp].filter(([id]) => pred(cat[id])).reduce((s, [, p]) => s + p, 0);
  assert.ok(Math.abs(sumFor(c => c.mId === 1) - 1) < 1e-9);
  assert.ok(Math.abs(sumFor(c => c.mId === 2) - 2) < 1e-9);
  assert.ok(Math.abs(sumFor(c => c.mId === 3) - 1) < 1e-9);
  assert.ok(Math.abs(sumFor(c => c.mId === 5 && c.sub === '2.5') - 1) < 1e-9);
  assert.ok(sumFor(c => c.mId === 15) > 1);
  assert.ok(sumFor(c => c.mId === 4) > 0.99 && sumFor(c => c.mId === 4) < 1.01);
  assert.ok(fp.flags.overlaps.includes('15'));
  assert.ok(fp.flags.incomplete.includes('4'));
  for (const [, p] of fp) assert.ok(p >= 0 && p <= 1);

  const single = LPModel.fair(cat, new Map([[101, 2.0]]));
  assert.equal(single.get(101), 0.5);
  assert.deepEqual(single.flags.singles, ['1']);
});

test('probability engines: normalised matrix and derived markets', () => {
  const M = LPModel.matrix(1.4, 1.1);
  let s = 0; for (const row of M) for (const v of row) s += v;
  assert.ok(Math.abs(s - 1) < 1e-12);
  const ids = Object.values(cat).filter(c => c.mId === 1).map(c => c.id);
  const p = LPModel.selProbs(cat, ids, 1.5, 1.1);
  assert.ok(Math.abs([...p.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const ou = Object.values(cat).filter(c => c.mId === 5 && c.sub === '2.5').map(c => c.id);
  const p2 = LPModel.selProbs(cat, ou, 1.5, 1.1);
  assert.ok(Math.abs([...p2.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
  for (const side of ['h', 'a']) { const l = LPModel.leadProb(1.5, 1.1, side); assert.ok(l >= 0 && l <= 1); }
});

test('market fit: reports quality and stays finite', () => {
  const fx = up.fixtures[0];
  const om = LPParse.oddsMap(fx.odds, up.selsets[fx.sk]);
  const fp = LPModel.fair(cat, om);
  const fit = LPModel.fitMarket(cat, fp);
  assert.ok(fit && Number.isFinite(fit.lh) && Number.isFinite(fit.la));
  assert.ok(['good', 'fair', 'poor'].includes(fit.quality));
  assert.ok(fit.lh > 0 && fit.la > 0);
});

test('parsing: counts, field provenance and timeline', () => {
  assert.equal(up.fixtures.length, 22);
  assert.equal(res.matches.length, 22);
  assert.equal(res.invalid.length, 0);
  const m = res.matches[0];
  assert.equal(m.game, 3);
  assert.equal(m.roundKey, '3:' + round.roundResults.roundId);
  assert.ok(m.fixtureId.startsWith('3:'));
  assert.ok(m.odds.length > 0);
  assert.ok(res.selsets[m.sk]);
  assert.equal(m.oddsProvenance, 'result');
  assert.ok(res.matches.every(x => x.betClose === Date.parse(round.roundResults.liveStartDate)));
  assert.ok(res.matches.filter(x => x.tlOk).length >= 15);
});

test('quality: match flags and round partial detection', () => {
  const m = res.matches.find(x => x.tlOk) || res.matches[0];
  const q = LPQuality.validateMatch(m, { cat, selStr: res.selsets[m.sk], round: { betClose: m.betClose } });
  assert.notEqual(q.status, 'invalid');
  assert.ok(Array.isArray(q.flags));
  const bad = LPQuality.validateMatch(Object.assign({}, m, { hg: -1 }), { cat, selStr: res.selsets[m.sk] });
  assert.equal(bad.status, 'invalid');
  assert.ok(bad.flags.includes('score_invalid'));
  const inc = LPQuality.validateMatch(Object.assign({}, m, { goals: [] }), { cat, selStr: res.selsets[m.sk] });
  assert.ok(inc.flags.includes('timeline_incomplete'));
  const r = { key: '3:1', game: 3, roundId: res.matches[0].roundId, expectedMatches: 22, capturedMatches: 10, betOpen: 1, betClose: 2, catalogueVersion: 'cat-test' };
  const rq = LPQuality.validateRound(r, res.matches.slice(0, 10));
  assert.equal(rq.status, 'warn');
  assert.ok(rq.flags.includes('partial_round'));
});

test('round specials are parsed without inventing selections', () => {
  const rs = LPParse.roundSpecials(round.roundResults);
  assert.ok(rs[1] && typeof rs[1].selections === 'string');
});
