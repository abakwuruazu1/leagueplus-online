// Accumulator optimisation with uncertainty and correlation penalties (Stage 9).
//
// The optimiser searches combinations of eligible legs for a target total odds
// and maximises the lower-bound joint probability. It defaults to one leg per
// fixture; when multiple legs from one fixture are allowed, a configurable
// penalty is applied because those selections are correlated. This is an
// approximation, not a joint score model.
const LPAccumulator = (() => {
  const VERSION = 'stage9-accumulator-v1';
  const DEFAULTS = {
    targetOdds: 3,
    maxLegs: 4,
    minJointP: 0.02,
    minEdge: 0,
    minOdds: 1.2,
    maxOdds: 8,
    beam: 200,
    correlationPenalty: 0.85,
    maxPerFixture: 1,
    maxTotalOdds: null,
    kellyFraction: 0.25,
    maxStakeUnits: 1,
    uncertaintyMultiplier: { narrow: 1, moderate: 0.75, wide: 0.5 }
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function normalizeLeg(leg) {
    const p = +leg.p, pLow = leg.pLow == null ? p : +leg.pLow, odds = +leg.odds;
    if (!Number.isFinite(p) || !Number.isFinite(pLow) || !Number.isFinite(odds) || odds <= 1) return null;
    return {
      fixtureId: leg.fixtureId || leg.key || leg.id, id: leg.id, market: leg.market || null,
      p, pLow, odds, edgeLow: pLow * odds - 1, uncertaintyClass: leg.uncertaintyClass || 'moderate',
      label: leg.label || null
    };
  }
  function optimise(legsIn, opts = {}) {
    const optsMerged = Object.assign({}, DEFAULTS, opts, { uncertaintyMultiplier: Object.assign({}, DEFAULTS.uncertaintyMultiplier, opts.uncertaintyMultiplier || {}) });
    const target = Math.max(1.01, +optsMerged.targetOdds || 3);
    const maxLegs = Math.max(1, Math.min(12, Math.floor(+optsMerged.maxLegs || 4)));
    const maxTotal = optsMerged.maxTotalOdds != null && Number.isFinite(+optsMerged.maxTotalOdds) ? +optsMerged.maxTotalOdds : target * 1.5;
    const legs = (legsIn || []).map(normalizeLeg).filter(l => l && l.odds >= optsMerged.minOdds && l.odds <= optsMerged.maxOdds && l.edgeLow >= optsMerged.minEdge);
    if (!legs.length) return { version: VERSION, decision: 'NO_BET', reason: 'no eligible legs', slip: null, candidates: 0 };
    let beam = [{ legs: [], odds: 1, joint: 1, fixtures: {} }];
    const completed = [];
    for (let depth = 0; depth < maxLegs; depth++) {
      const next = [];
      for (const state of beam) {
        for (const leg of legs) {
          if (state.legs.some(x => x.id === leg.id && x.fixtureId === leg.fixtureId)) continue;
          if (!leg.fixtureId) { /* allow unknown fixtures, but do not deduplicate by fixture */ }
          const same = leg.fixtureId ? (state.fixtures[leg.fixtureId] || 0) : 0;
          if (same >= optsMerged.maxPerFixture) continue;
          const odds = state.odds * leg.odds;
          if (odds > maxTotal + 1e-9) continue;
          const joint = state.joint * leg.pLow * (same ? optsMerged.correlationPenalty : 1);
          const fixtures = Object.assign({}, state.fixtures);
          if (leg.fixtureId) fixtures[leg.fixtureId] = same + 1;
          const st = { legs: state.legs.concat(leg), odds, joint, fixtures };
          next.push(st);
          if (odds >= target * 0.98 && odds <= maxTotal + 1e-9) completed.push(st);
        }
      }
      if (!next.length) break;
      next.sort((a, b) => (b.joint * Math.min(1.2, b.odds / target)) - (a.joint * Math.min(1.2, a.odds / target)));
      beam = next.slice(0, Math.max(20, Math.floor(optsMerged.beam)));
    }
    const pool = completed.length ? completed : beam;
    let best = null;
    for (const st of pool) {
      if (st.odds < target * 0.98) continue;
      if (!best || st.joint > best.joint || (st.joint === best.joint && st.odds < best.odds)) best = st;
    }
    if (!best) return { version: VERSION, decision: 'NO_BET', reason: 'no combination reached the target odds', slip: null, candidates: legs.length };
    const ev = best.joint * best.odds - 1;
    const unc = best.legs.map(l => optsMerged.uncertaintyMultiplier[l.uncertaintyClass] != null ? optsMerged.uncertaintyMultiplier[l.uncertaintyClass] : 0.5);
    const uncMul = unc.length ? unc.reduce((a, b) => a + b, 0) / unc.length : 0.5;
    const kelly = best.odds > 1 ? Math.max(0, (best.joint * best.odds - 1) / (best.odds - 1)) : 0;
    const stakeUnits = clamp(optsMerged.kellyFraction * kelly * uncMul, 0, optsMerged.maxStakeUnits);
    const slip = {
      legs: best.legs.map(l => ({ id: l.id, fixtureId: l.fixtureId, market: l.market, odds: l.odds, p: l.p, pLow: l.pLow, edgeLow: l.edgeLow, uncertaintyClass: l.uncertaintyClass, label: l.label })),
      totalOdds: best.odds, jointP: best.joint, ev, kelly, stakeUnits, targetOdds: target,
      correlationPenalty: optsMerged.correlationPenalty
    };
    const ok = best.joint >= optsMerged.minJointP && ev > 0 && stakeUnits > 0;
    return {
      version: VERSION, decision: ok ? 'BET' : 'NO_BET', slip,
      reason: ok ? 'positive lower-bound EV' : 'joint probability or EV below policy',
      candidates: legs.length
    };
  }
  return { VERSION, DEFAULTS, optimise, normalizeLeg };
})();
if (typeof module !== 'undefined') module.exports = LPAccumulator;
