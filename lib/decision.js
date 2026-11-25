// Uncertainty-aware value and staking policy (Stage 9).
//
// A selection is only eligible when the *lower confidence bound* beats the
// market price by a market-specific threshold. Stakes are fractional Kelly on
// that lower bound, reduced for wide uncertainty and capped. The policy is
// disabled unless a chronological holdout simulation shows a positive return
// after the bookmaker margin.
const _statsD = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPStats_D = (typeof LPStats !== 'undefined') ? LPStats : _statsD;

const LPDecision = (() => {
  const VERSION = 'stage9-decision-v1';
  const MARKETS = ['1X2', 'OU2.5', 'BTTS'];
  const DEFAULT = {
    version: VERSION,
    enabled: false,
    minEdge: { '1X2': 0.03, 'OU2.5': 0.025, 'BTTS': 0.025, default: 0.04 },
    minPointEdge: 0,
    minProbability: 0.05,
    maxProbability: 0.95,
    minOdds: 1.2,
    maxOdds: 8,
    kellyFraction: 0.25,
    maxStakeUnits: 2,
    minStakeUnits: 0.01,
    uncertaintyMultiplier: { narrow: 1, moderate: 0.75, wide: 0.5 },
    blockWide: false,
    minSamples: 500,
    minTrainBets: 40,
    minBets: 100,
    minTestSamples: 100,
    trainFraction: 0.5,
    thresholds: [0, 0.01, 0.02, 0.03, 0.04, 0.05],
    permutations: 299,
    seed: 20261124
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function defaultPolicy() { const d = JSON.parse(JSON.stringify(DEFAULT)); d.__normalized = true; return d; }
  function normalizePolicy(p = {}) {
    if (p && p.__normalized) return p;
    const base = defaultPolicy();
    const out = Object.assign({}, base, p);
    out.minEdge = Object.assign({}, base.minEdge, p.minEdge || {});
    out.uncertaintyMultiplier = Object.assign({}, base.uncertaintyMultiplier, p.uncertaintyMultiplier || {});
    out.__normalized = true;
    out.enabled = !!out.enabled;
    out.kellyFraction = clamp(+out.kellyFraction || base.kellyFraction, 0, 1);
    out.maxStakeUnits = clamp(+out.maxStakeUnits || base.maxStakeUnits, 0.05, 100);
    out.minOdds = clamp(+out.minOdds || base.minOdds, 1.01, 1000);
    out.maxOdds = clamp(+out.maxOdds || base.maxOdds, out.minOdds, 10000);
    return out;
  }
  function marketForRow(row, cat) {
    if (row && row.market) return row.market;
    const c = cat && row ? cat[row.id] : null;
    if (!c) return 'OTHER';
    if (c.mId === 1) return '1X2';
    if (c.mId === 3) return 'BTTS';
    if (c.mId === 5 && String(c.sub) === '2.5') return 'OU2.5';
    return 'OTHER';
  }
  function thresholdFor(policy, market) {
    return policy.minEdge[market] != null ? policy.minEdge[market] : policy.minEdge.default;
  }
  function evaluateSelection(row, policyIn, cat) {
    const policy = normalizePolicy(policyIn);
    const p = +row.p;
    const pLow = row.pLow == null ? p : +row.pLow;
    const odds = +row.odds;
    const market = marketForRow(row, cat);
    const threshold = thresholdFor(policy, market);
    const uncertaintyClass = row.uncertaintyClass || 'moderate';
    const edgePoint = Number.isFinite(p * odds) ? p * odds - 1 : null;
    const edgeLow = Number.isFinite(pLow * odds) ? pLow * odds - 1 : null;
    const reasons = [];
    if (!Number.isFinite(p) || !Number.isFinite(pLow) || !Number.isFinite(odds)) reasons.push('invalid probability or odds');
    if (odds < policy.minOdds || odds > policy.maxOdds) reasons.push('odds outside policy range');
    if (p < policy.minProbability || p > policy.maxProbability) reasons.push('probability outside policy range');
    if (policy.blockWide && uncertaintyClass === 'wide') reasons.push('wide uncertainty blocked');
    if (edgeLow == null || edgeLow < threshold) reasons.push('lower-bound edge below ' + (threshold * 100).toFixed(1) + '%');
    if (edgePoint == null || edgePoint < policy.minPointEdge) reasons.push('point edge below minimum');
    const kelly = odds > 1 && edgeLow != null ? Math.max(0, (pLow * odds - 1) / (odds - 1)) : 0;
    const uncMul = policy.uncertaintyMultiplier[uncertaintyClass] != null ? policy.uncertaintyMultiplier[uncertaintyClass] : 0.5;
    let stakeUnits = clamp(policy.kellyFraction * kelly * uncMul, 0, policy.maxStakeUnits);
    if (stakeUnits < policy.minStakeUnits) reasons.push('stake below minimum unit');
    const out = {
      decision: reasons.length ? 'NO_BET' : 'BET', selectedId: row.id ?? null, market,
      p, pLow, pHigh: row.pHigh == null ? null : +row.pHigh, odds, fair: row.fair == null ? null : +row.fair,
      uncertaintyClass, edgePoint, edgeLow, edgeVsFair: row.fair == null ? null : p - +row.fair,
      threshold, kelly, stakeUnits, policyVersion: policy.version, reason: reasons.join('; ')
    };
    if (reasons.length) out.stakeUnits = 0;
    return out;
  }
  function evaluateFixture(evOrRows, policyIn, cat) {
    const policy = normalizePolicy(policyIn);
    const rows = Array.isArray(evOrRows) ? evOrRows : (evOrRows && evOrRows.rows) || [];
    const prepared = rows.map(r => ({
      id: r.id, odds: r.odds, fair: r.fair, market: r.market,
      p: r.calibrated != null ? r.calibrated : (r.ensemble != null ? r.ensemble : r.mkt),
      pLow: r.pLow, pHigh: r.pHigh,
      uncertaintyClass: r.uncertaintyClass
    }));
    const results = prepared.map(r => evaluateSelection(r, policy, cat));
    const bets = results.filter(x => x.decision === 'BET').sort((a, b) => (b.edgeLow - a.edgeLow) || (b.pLow - a.pLow));
    if (bets.length) return Object.assign({}, bets[0], { decision: 'BET', candidates: results.length, policy });
    const best = results.slice().sort((a, b) => (b.edgeLow || -9) - (a.edgeLow || -9))[0];
    return {
      decision: 'NO_BET', selectedId: null, market: best ? best.market : null,
      p: best ? best.p : null, pLow: best ? best.pLow : null, odds: best ? best.odds : null,
      edgePoint: best ? best.edgePoint : null, edgeLow: best ? best.edgeLow : null,
      threshold: best ? best.threshold : null, reason: best ? best.reason : 'no selections',
      candidates: results.length, policyVersion: policy.version, policy
    };
  }

  function sampleValue(s) {
    const p = +s.p;
    const pLow = s.pLow == null ? p : +s.pLow;
    const odds = +s.odds;
    if (!Number.isFinite(p) || !Number.isFinite(pLow) || !Number.isFinite(odds) || (+s.y !== 0 && +s.y !== 1)) return null;
    return { id: s.id, fixtureId: s.fixtureId, roundKey: s.roundKey, ts: s.ts, market: s.market, p, pLow, odds, y: +s.y, uncertaintyClass: s.uncertaintyClass, fair: s.fair };
  }
  function simulate(samples, policyIn) {
    const policy = normalizePolicy(policyIn);
    const rows = (samples || []).map(sampleValue).filter(Boolean);
    const groups = new Map();
    rows.forEach(s => {
      const key = s.fixtureId || (s.roundKey || '') + ':' + (s.id ?? Math.random());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    const perBet = [], perBetStaked = [];
    let wins = 0, profit = 0, staked = 0, profitStaked = 0, avgStake = 0;
    for (const list of groups.values()) {
      let best = null;
      for (const s of list) {
        const d = evaluateSelection(s, policy, null);
        if (d.decision === 'BET' && (!best || d.edgeLow > best.edgeLow)) best = d;
      }
      if (!best) continue;
      const s = list.find(x => x.id === best.selectedId) || list.find(x => x.odds === best.odds && x.p === best.p);
      if (!s) continue;
      const won = s.y === 1;
      const flat = won ? s.odds - 1 : -1;
      const st = won ? best.stakeUnits * (s.odds - 1) : -best.stakeUnits;
      perBet.push(flat); perBetStaked.push(st);
      wins += won ? 1 : 0; profit += flat; staked += best.stakeUnits; profitStaked += st; avgStake += best.stakeUnits;
    }
    const bets = perBet.length;
    let bank = 0, peak = 0, dd = 0;
    for (const p of perBet) { bank += p; peak = Math.max(peak, bank); dd = Math.max(dd, peak - bank); }
    return {
      bets, wins, profit, roi: bets ? profit / bets : null,
      staked, profitStaked, roiStaked: staked ? profitStaked / staked : null,
      avgStake: bets ? avgStake / bets : null, maxDrawdown: dd, perBet
    };
  }
  function bootstrapP(values, B = 299, seed = 1) {
    if (!values || values.length < 3) return null;
    const rng = _LPStats_D.seeded(seed);
    let le = 0;
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < values.length; i++) s += values[Math.floor(rng() * values.length)];
      if (s / values.length <= 0) le++;
    }
    return (le + 1) / (B + 1);
  }
  function groupsOf(samples) {
    const map = new Map();
    (samples || []).forEach((s, i) => {
      const key = s.roundKey || (s.ts != null ? 't' + s.ts : 'i' + i);
      if (!map.has(key)) map.set(key, { key, ts: s.ts == null ? i : s.ts, rows: [] });
      map.get(key).rows.push(s);
    });
    return [...map.values()].sort((a, b) => a.ts - b.ts);
  }

  function walkForward(samples, opts = {}) {
    const cfg = Object.assign({}, DEFAULT, opts);
    const warnings = [];
    const rows = (samples || []).map(sampleValue).filter(Boolean);
    if (rows.length < cfg.minSamples) {
      warnings.push('Decision sample is too small (' + rows.length + ' selections; need ' + cfg.minSamples + ').');
      return { version: VERSION, decision: { enabled: false, policy: normalizePolicy({ enabled: false }) }, variants: [], metrics: null, warnings };
    }
    const groups = groupsOf(rows);
    let cut = 0, trainN = 0;
    const target = Math.floor(groups.length * clamp(cfg.trainFraction, 0.2, 0.8));
    while (cut < groups.length && (cut < target || trainN < cfg.minSamples * 0.4)) { trainN += groups[cut].rows.length; cut++; }
    const train = groups.slice(0, cut).flatMap(g => g.rows);
    const test = groups.slice(cut).flatMap(g => g.rows);
    if (test.length < cfg.minTestSamples) {
      warnings.push('Decision holdout is too small (' + test.length + ' selections; need ' + cfg.minTestSamples + ').');
      return { version: VERSION, decision: { enabled: false, policy: normalizePolicy({ enabled: false }) }, variants: [], metrics: null, warnings };
    }
    const variants = [];
    for (const threshold of cfg.thresholds) {
      const policy = normalizePolicy({ enabled: true, minEdge: { '1X2': threshold, 'OU2.5': threshold * 0.9, 'BTTS': threshold * 0.9, default: threshold * 1.2 }, kellyFraction: cfg.kellyFraction, maxStakeUnits: cfg.maxStakeUnits });
      const tr = simulate(train, policy);
      const te = simulate(test, policy);
      const ci = te.perBet.length >= 3 ? _LPStats_D.bootstrapCI(te.perBet, _LPStats_D.mean, cfg.permutations, 0.05, cfg.seed + Math.round(threshold * 1000)) : { low: null, high: null };
      variants.push({ threshold, train: tr, test: te, ciLow: ci.low, ciHigh: ci.high, p: bootstrapP(te.perBet, cfg.permutations, cfg.seed + Math.round(threshold * 1000) + 7), policy });
    }
    const eligible = variants.filter(v => v.train.bets >= cfg.minTrainBets);
    const chosen = (eligible.length ? eligible : variants.slice()).sort((a, b) => (b.train.roi || -9) - (a.train.roi || -9))[0];
    const enabled = !!(chosen && chosen.test.bets >= cfg.minBets && chosen.test.roi > 0 && chosen.ciLow != null && chosen.ciLow > 0 && chosen.train.roi > 0);
    const policy = normalizePolicy(Object.assign({}, chosen ? chosen.policy : {}, { enabled }));
    policy.minEdge = Object.assign({}, chosen ? chosen.policy.minEdge : DEFAULT.minEdge);
    if (!enabled) warnings.push('No value policy survived the chronological holdout with a positive lower confidence bound; decisions remain NO_BET.');
    if (chosen && chosen.test.bets < cfg.minBets) warnings.push('Policy holdout produced only ' + chosen.test.bets + ' bets; need ' + cfg.minBets + '.');
    if (chosen && chosen.test.bets >= cfg.minBets && chosen.test.roi <= 0) warnings.push('Policy holdout return is not positive.');
    return {
      version: VERSION,
      decision: {
        enabled, policy,
        threshold: chosen ? chosen.threshold : null,
        train: chosen ? chosen.train : null,
        test: chosen ? chosen.test : null,
        ciLow: chosen ? chosen.ciLow : null, ciHigh: chosen ? chosen.ciHigh : null,
        p: chosen ? chosen.p : null,
        nTrain: train.length, nTest: test.length
      },
      variants, metrics: chosen ? { train: chosen.train, test: chosen.test } : null, warnings
    };
  }

  return { VERSION, MARKETS, DEFAULT, defaultPolicy, normalizePolicy, evaluateSelection, evaluateFixture, simulate, walkForward, marketForRow, thresholdFor, bootstrapP };
})();
if (typeof module !== 'undefined') module.exports = LPDecision;
