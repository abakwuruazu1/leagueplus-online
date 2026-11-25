const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/performance.js');

function pred(id, opts = {}) {
  return Object.assign({
    predictionId: id, fixtureId: opts.fixtureId || id, asOf: opts.asOf || 1, comp: 1,
    home: 'A', away: 'B', checkpoint: opts.checkpoint || 'open',
    ids: [101, 102], odds: opts.odds || [2, 3], selectedId: opts.selectedId === undefined ? 101 : opts.selectedId,
    candidateId: 101, decision: opts.decision || 'BET', selectedMarket: '1X2', stakeUnits: 1,
    ensemble: [0.55, 0.25], fair: [0.5, 0.3]
  }, opts);
}
function settle(id, opts = {}) {
  return Object.assign({
    predictionId: id, outcomes: opts.outcomes || [1, 0],
    metrics: {
      ensemble: { n: 2, brier: 0.2, logLoss: 0.4, wins: 1 },
      mkt: { n: 2, brier: 0.25, logLoss: 0.5, wins: 1 }
    },
    bet: opts.bet === undefined ? { selectedId: 101, market: '1X2', odds: 2, stake: 1, won: true, profitUnits: 1, policyVersion: 'p1' } : opts.bet
  }, opts);
}

test('aggregates bets, ROI, bankroll, drawdown and exposure', () => {
  const predictions = [
    pred('p1', { asOf: 1 }),
    pred('p2', { asOf: 2 }),
    pred('p3', { asOf: 3, decision: 'NO_BET', selectedId: null })
  ];
  const settlements = [
    settle('p1'),
    settle('p2', { bet: { selectedId: 101, market: '1X2', odds: 2, stake: 1, won: false, profitUnits: -1, policyVersion: 'p1' } }),
    settle('p3', { bet: null })
  ];
  const r = P.aggregate({ predictions, settlements, startBankroll: 100, unitValue: 10 });
  assert.equal(r.counts.bets, 2);
  assert.equal(r.counts.noBets, 1);
  assert.equal(r.bets.wins, 1);
  assert.equal(r.bets.roi, 0);
  assert.equal(r.bets.staked, 2);
  assert.equal(r.bankroll.start, 100);
  assert.equal(r.bankroll.end, 100);
  assert.equal(r.bankroll.maxDrawdown, 10);
  assert.ok(r.bets.byMarket['1X2'].bets === 2);
  assert.ok(r.modelLeaderboard.some(x => x.model === 'ensemble'));
  assert.ok(r.warnings.some(w => /Only 2 settled bets/.test(w)));
});

test('closing-line value uses open versus pre-close price for the chosen selection', () => {
  const open = pred('open', { fixtureId: 'f1', asOf: 1, odds: [2, 3] });
  const close = pred('close', { fixtureId: 'f1', asOf: 2, checkpoint: 'preclose', odds: [1.8, 3.2], decision: 'NO_BET', selectedId: null });
  const clv = P.closingLineValue([open, close]);
  assert.equal(clv.n, 1);
  assert.ok(clv.avgPriceClv > 0.1);
  assert.equal(clv.positiveShare, 1);
});

test('no settled bets produces an explicit unevaluable warning', () => {
  const r = P.aggregate({ predictions: [pred('p1')], settlements: [], data: { matches: 10 } });
  assert.equal(r.counts.bets, 0);
  assert.equal(r.bets.roi, null);
  assert.equal(r.bankroll.end, r.bankroll.start);
  assert.ok(r.warnings.some(w => /not evaluable/.test(w)));
});
