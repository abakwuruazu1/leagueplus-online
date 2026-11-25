const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stats.js');
const R = require('../lib/research.js');

function poisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
function poisPmf(l, n = 10) {
  const a = [Math.exp(-l)];
  for (let k = 1; k <= n; k++) a[k] = a[k - 1] * l / k;
  return a;
}
function probs(lh, la) {
  const ph = poisPmf(lh), pa = poisPmf(la);
  let p1 = 0, px = 0, p2 = 0;
  for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) {
    const p = ph[h] * pa[a];
    if (h > a) p1 += p; else if (h === a) px += p; else p2 += p;
  }
  const s = p1 + px + p2;
  return [p1 / s, px / s, p2 / s];
}

function synthetic() {
  const rng = S.seeded(424242);
  const comps = [0, 1, 2, 3];
  const rounds = 60, teams = 16;
  const base = [1.0, 1.15, 1.35, 1.55];
  const attack = {}, defence = {};
  for (const c of comps) {
    attack[c] = Array.from({ length: teams }, () => 0.65 + rng() * 0.7);
    defence[c] = Array.from({ length: teams }, () => 0.8 + rng() * 0.4);
  }
  const out = [];
  for (const c of comps) {
    for (let r = 0; r < rounds; r++) {
      const serial = c === 0 ? (r % 2 ? 1.4 : 0.6) : 1;
      for (let j = 0; j < teams / 2; j++) {
        const h = (j * 2 + r) % teams, a = (h + 1) % teams;
        const lh = base[c] * serial * attack[c][h] * defence[c][a] * 1.05;
        const la = base[c] * serial * attack[c][a] * defence[c][h];
        const hg = poisson(lh, rng), ag = poisson(la, rng);
        const tp = probs(lh, la);
        const market = tp.map(p => Math.max(1e-6, p * (1 + (rng() * 2 - 1) * 0.03)));
        const ms = market[0] + market[1] + market[2];
        out.push({
          key: 'c' + c + ':r' + r + ':' + j, fixtureId: 'c' + c + ':r' + r + ':' + j,
          roundKey: 'c' + c + ':r' + r, roundId: r, game: c, comp: c, season: 1, week: r,
          home: 'C' + c + '_T' + h, away: 'C' + c + '_T' + a,
          hg, ag, goals: [], tlOk: true, ts: 1000000 + r * 1000 + c,
          market: market.map(p => p / ms), quality: { status: 'ok', flags: [] }
        });
      }
    }
  }
  return out;
}

test('synthetic data with known structure is detected and reported honestly', () => {
  const matches = synthetic();
  const r = R.analyze({ matches, options: { minMatches: 300, minRounds: 30, minTeams: 8, minPatternN: 20, permutations: 199, seed: 7 } });
  assert.equal(r.meta.matches, 1920);
  assert.equal(r.meta.competitions, 4);
  assert.equal(r.meta.options.minMatches, 300);
  assert.equal(r.information.all.matches, 1920);
  assert.notEqual(r.hypotheses.H1.status, 'insufficient');
  assert.ok(['supported', 'exploratory'].includes(r.hypotheses.H1.status));
  assert.notEqual(r.hypotheses.H2.status, 'insufficient');
  assert.ok(Math.abs(r.hypotheses.H2.effect) > 0.2);
  assert.notEqual(r.hypotheses.H3.status, 'insufficient');
  assert.ok(['supported', 'exploratory'].includes(r.hypotheses.H3.status));
  assert.notEqual(r.hypotheses.H6.status, 'insufficient');
  assert.ok(['supported', 'exploratory'].includes(r.hypotheses.H6.status));
  assert.ok(r.patterns.length > 0);
  assert.ok(r.tests.every(t => t.p == null || (t.q != null)));
});

test('a tiny sample is marked insufficient rather than significant', () => {
  const matches = synthetic().slice(0, 20);
  const r = R.analyze({ matches, options: { minMatches: 100, minRounds: 30, minTeams: 8, minPatternN: 30, permutations: 99, seed: 1 } });
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']) {
    assert.equal(r.hypotheses[id].status, 'insufficient');
  }
  assert.ok(r.meta.warnings.length >= 1);
});
