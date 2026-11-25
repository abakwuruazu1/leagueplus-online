// Consolidated performance reporting (Stage 10).
//
// Aggregates the immutable ledger into decision, bankroll, exposure and
// closing-line-value views. It is deliberately descriptive: a positive ROI on a
// small ledger is not evidence of an edge, and the report says so explicitly.
const _statsPerf = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _calPerf = (typeof module !== 'undefined' && module.exports) ? require('./calibration.js') : null;
const _LPStats_Pf = (typeof LPStats !== 'undefined') ? LPStats : _statsPerf;
const _LPCal_Pf = (typeof LPCalibration !== 'undefined') ? LPCalibration : _calPerf;

const LPPerformance = (() => {
  const VERSION = 'stage10-performance-v1';
  const MODELS = ['fair', 'mkt', 'team', 'blend', 'ensemble', 'dc', 'emp', 'weighted', 'calibrated'];
  function num(x) { return Number.isFinite(+x) ? +x : null; }
  function pct(x) { return x == null || !Number.isFinite(+x) ? null : +x; }
  function addBy(map, key, get, put) {
    if (!key) return;
    if (!map[key]) map[key] = { bets: 0, wins: 0, stake: 0, profit: 0, flatProfit: 0 };
    put(map[key], get());
  }

  function modelLeaderboard(settlements) {
    const agg = {};
    for (const s of settlements || []) {
      for (const m of MODELS) {
        const x = s && s.metrics && s.metrics[m];
        if (!x || !x.n) continue;
        const a = agg[m] = agg[m] || { n: 0, brier: 0, logLoss: 0, wins: 0 };
        a.n += x.n; a.brier += x.brier * x.n; a.logLoss += x.logLoss * x.n; a.wins += x.wins || 0;
      }
    }
    return Object.entries(agg).map(([model, a]) => ({
      model, n: a.n, brier: a.n ? a.brier / a.n : null, logLoss: a.n ? a.logLoss / a.n : null,
      winRate: a.n ? a.wins / a.n : null
    })).sort((x, y) => (x.logLoss == null ? 9 : x.logLoss) - (y.logLoss == null ? 9 : y.logLoss));
  }

  function calibrationByModel(predictions, settlementsById) {
    const out = {};
    for (const m of MODELS) {
      const samples = [];
      for (const p of predictions || []) {
        const s = settlementsById.get(p.predictionId);
        if (!s || !Array.isArray(p[m]) || !Array.isArray(s.outcomes)) continue;
        for (let i = 0; i < p[m].length; i++) {
          const pr = p[m][i], y = s.outcomes[i];
          if (pr == null || y == null) continue;
          samples.push({ p: +pr, y: +y });
        }
      }
      if (samples.length >= 20) {
        try { out[m] = _LPCal_Pf.reliability(samples, { bins: 10 }); } catch (e) { }
      }
    }
    return out;
  }

  function closingLineValue(predictions) {
    const byFixture = new Map();
    for (const p of predictions || []) {
      if (!p || !p.fixtureId || !Array.isArray(p.ids)) continue;
      if (!byFixture.has(p.fixtureId)) byFixture.set(p.fixtureId, []);
      byFixture.get(p.fixtureId).push(p);
    }
    const rows = [];
    for (const [, list] of byFixture) {
      const close = list.find(x => x.checkpoint === 'preclose') || list.slice().sort((a, b) => (b.asOf || 0) - (a.asOf || 0))[0];
      if (!close) continue;
      for (const p of list) {
        if (p === close || !Array.isArray(p.odds)) continue;
        const id = p.selectedId != null ? p.selectedId : p.candidateId;
        if (id == null) continue;
        const oi = p.ids.indexOf(id), ci = close.ids.indexOf(id);
        if (oi < 0 || ci < 0) continue;
        const openOdds = num(p.odds[oi]), closeOdds = num(close.odds[ci]);
        if (openOdds == null || closeOdds == null || openOdds <= 1 || closeOdds <= 1) continue;
        const priceClv = openOdds / closeOdds - 1;
        const probClv = 1 / closeOdds - 1 / openOdds;
        rows.push({ fixtureId: p.fixtureId, id, openOdds, closeOdds, priceClv, probClv, decision: p.decision === 'BET' ? 'BET' : 'NO_BET' });
      }
    }
    const n = rows.length;
    const avg = n ? rows.reduce((a, b) => a + b.priceClv, 0) / n : null;
    const positive = n ? rows.filter(x => x.priceClv > 0).length / n : null;
    const bets = rows.filter(x => x.decision === 'BET');
    return {
      n, avgPriceClv: avg, positiveShare: positive,
      betN: bets.length,
      betAvgPriceClv: bets.length ? bets.reduce((a, b) => a + b.priceClv, 0) / bets.length : null,
      rows: rows.slice(0, 100)
    };
  }

  function aggregate(opts = {}) {
    const predictions = (opts.predictions || []).slice().sort((a, b) => (a.asOf || 0) - (b.asOf || 0));
    const settlements = opts.settlements || [];
    const byId = new Map(settlements.map(s => [s.predictionId, s]));
    const startBankroll = num(opts.startBankroll) != null ? +opts.startBankroll : 1000;
    const unitValue = num(opts.unitValue) != null ? +opts.unitValue : 10;
    const bets = [];
    let noBets = 0, pending = 0, settled = 0;
    for (const p of predictions) {
      const s = byId.get(p.predictionId);
      if (!s) { pending++; continue; }
      settled++;
      if (p.decision !== 'BET' || !s.bet) { noBets++; continue; }
      const b = s.bet;
      const flat = b.won ? (+b.odds - 1) : -1;
      bets.push({
        predictionId: p.predictionId, fixtureId: p.fixtureId, comp: p.comp, home: p.home, away: p.away,
        asOf: p.asOf, checkpoint: p.checkpoint, market: b.market || p.selectedMarket || 'OTHER',
        policyVersion: b.policyVersion || p.decisionPolicyVersion || null,
        odds: +b.odds, stake: +b.stake || 0, won: !!b.won, profitUnits: +b.profitUnits || 0,
        flatProfit: flat, edgeLow: b.edgeLow == null ? null : +b.edgeLow
      });
    }
    let bankroll = startBankroll, peak = startBankroll, maxDrawdown = 0, maxDrawdownPct = 0;
    const equity = [];
    let staked = 0, profit = 0, flatProfit = 0, wins = 0;
    const byMarket = {}, byComp = {}, byPolicy = {}, byCheckpoint = {};
    for (const b of bets) {
      staked += b.stake; profit += b.profitUnits; flatProfit += b.flatProfit; wins += b.won ? 1 : 0;
      bankroll += b.profitUnits * unitValue;
      peak = Math.max(peak, bankroll);
      const dd = peak - bankroll;
      if (dd > maxDrawdown) { maxDrawdown = dd; maxDrawdownPct = peak > 0 ? dd / peak : 0; }
      equity.push({ asOf: b.asOf, bankroll });
      const put = (o, k) => {
        if (!k) return;
        const x = o[k] = o[k] || { bets: 0, wins: 0, stake: 0, profit: 0, flatProfit: 0 };
        x.bets++; x.wins += b.won ? 1 : 0; x.stake += b.stake; x.profit += b.profitUnits; x.flatProfit += b.flatProfit;
      };
      put(byMarket, b.market); put(byComp, b.comp); put(byPolicy, b.policyVersion); put(byCheckpoint, b.checkpoint);
    }
    for (const o of [byMarket, byComp, byPolicy, byCheckpoint]) for (const k of Object.keys(o)) {
      const x = o[k]; x.roi = x.stake ? x.profit / x.stake : null; x.flatRoi = x.bets ? x.flatProfit / x.bets : null;
    }
    const nBets = bets.length;
    return {
      version: VERSION,
      counts: { predictions: predictions.length, settlements: settled, pending, noBets, bets: nBets },
      settlementCoverage: predictions.length ? settled / predictions.length : null,
      modelLeaderboard: modelLeaderboard(settlements),
      calibration: calibrationByModel(predictions, byId),
      bets: {
        n: nBets, wins, losses: nBets - wins,
        winRate: nBets ? wins / nBets : null,
        staked, profit, roi: staked ? profit / staked : null,
        flatProfit, flatRoi: nBets ? flatProfit / nBets : null,
        avgStake: nBets ? staked / nBets : null,
        maxStake: nBets ? Math.max.apply(null, bets.map(b => b.stake)) : null,
        maxDrawdown, maxDrawdownPct,
        byMarket, byComp, byPolicy, byCheckpoint,
        rows: bets.slice(-200)
      },
      bankroll: {
        start: startBankroll, end: bankroll, unitValue,
        change: bankroll - startBankroll,
        changePct: startBankroll ? (bankroll - startBankroll) / startBankroll : null,
        maxDrawdown, maxDrawdownPct,
        curve: equity.slice(-300)
      },
      clv: closingLineValue(predictions),
      data: opts.data || null,
      warnings: [
        ...(nBets === 0 ? ['No settled BET rows yet; decision performance is not evaluable.'] : []),
        ...(nBets > 0 && nBets < 100 ? ['Only ' + nBets + ' settled bets; ROI and drawdown are provisional.'] : []),
        ...(predictions.length > 0 && settled / predictions.length < 0.8 ? ['Settlement coverage is below 80%.'] : [])
      ]
    };
  }

  return { VERSION, MODELS, aggregate, modelLeaderboard, closingLineValue, calibrationByModel };
})();
if (typeof module !== 'undefined') module.exports = LPPerformance;
