// Specialist walk-forward evaluator (Stage 6).
//
// Compares the sequence and pattern models against the Stage 5 equal ensemble
// and the market fair baseline. A specialist is enabled only when it improves
// paired out-of-sample loss after multiple-testing correction; otherwise it is
// explicitly disabled and never enters the ensemble or the live decision.
const _coreSp = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelSp = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _seqSp = (typeof module !== 'undefined' && module.exports) ? require('./sequence.js') : null;
const _patSp = (typeof module !== 'undefined' && module.exports) ? require('./patterns.js') : null;
const _statsSp = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _calSp = (typeof module !== 'undefined' && module.exports) ? require('./calibration.js') : null;
const _LPModel_Sp = (typeof LPModel !== 'undefined') ? LPModel : _modelSp;
const _LPSeq_Sp = (typeof LPSequence !== 'undefined') ? LPSequence : _seqSp;
const _LPPat_Sp = (typeof LPPatterns !== 'undefined') ? LPPatterns : _patSp;
const _LPStats_Sp = (typeof LPStats !== 'undefined') ? LPStats : _statsSp;
const _LPCal_Sp = (typeof LPCalibration !== 'undefined') ? LPCalibration : _calSp;

const LPSpecialists = (() => {
  const VERSION = 'stage6-specialists-v1';
  function prep(matches) {
    const ms = (matches || []).filter(m => m && Number.isFinite(+m.ts) && m.hg != null && m.ag != null && Number.isFinite(+m.hg) && Number.isFinite(+m.ag) && (!m.quality || m.quality.status !== 'invalid'))
      .map(m => Object.assign({}, m, { hg: +m.hg, ag: +m.ag, total: +m.hg + +m.ag, outcome: +m.hg > +m.ag ? 0 : +m.hg < +m.ag ? 2 : 1, btts: +m.hg > 0 && +m.ag > 0 ? 1 : 0, roundKey: m.roundKey || (m.game != null ? m.game + ':' + m.roundId : m.comp + ':' + m.roundId) }))
      .sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
    const rmap = new Map();
    for (const m of ms) {
      if (!rmap.has(m.roundKey)) rmap.set(m.roundKey, { key: m.roundKey, ts: m.ts, matches: [] });
      const r = rmap.get(m.roundKey); r.matches.push(m); if (m.ts < r.ts) r.ts = m.ts;
    }
    return { matches: ms, rounds: [...rmap.values()].sort((a, b) => a.ts - b.ts) };
  }
  function brier3(p, y) { if (!p || p.length !== 3) return null; let s = 0; for (let i = 0; i < 3; i++) s += (p[i] - (i === y ? 1 : 0)) ** 2; return s; }
  function brier2(p, y) { if (!p || p.length !== 2) return null; return (p[0] - (y === 0 ? 1 : 0)) ** 2 + (p[1] - (y === 1 ? 1 : 0)) ** 2; }
  function ll(p, y) { if (!p || !p[y]) return null; return -Math.log(Math.max(1e-12, Math.min(1 - 1e-12, p[y]))); }
  function add(map, model, market, brier, loss) {
    const m = map[model] = map[model] || { n: 0, brier: 0, logLoss: 0 };
    m.n++; m.brier += brier; m.logLoss += loss;
    const bm = map.byMarket || (map.byMarket = {});
    const mm = bm[market] = bm[market] || {};
    const c = mm[model] = mm[model] || { n: 0, brier: 0, logLoss: 0 };
    c.n++; c.brier += brier; c.logLoss += loss;
  }
  function probsFromMap(map, ids) {
    if (!map) return null;
    const p = ids.map(id => map.get(id));
    return p.every(x => x != null && Number.isFinite(x)) ? p : null;
  }
  function evaluate(opts = {}) {
    const cfg = (opts.options && typeof opts.options === 'object') ? Object.assign({}, opts, opts.options) : opts;
    const data = prep(opts.matches || cfg.matches || []);
    const cat = opts.cat || cfg.cat || {};
    const selsets = opts.selsets || cfg.selsets || {};
    const minTrainRounds = Number.isFinite(cfg.minTrainRounds) ? cfg.minTrainRounds : 8;
    const minCompMatches = Number.isFinite(cfg.minCompMatches) ? cfg.minCompMatches : 20;
    const maxTestRounds = Number.isFinite(cfg.maxTestRounds) ? cfg.maxTestRounds : 200;
    const minPatternSupport = Number.isFinite(cfg.minPatternSupport) ? cfg.minPatternSupport : 30;
    const B = Number.isFinite(cfg.permutations) ? cfg.permutations : 299;
    const seed = Number.isFinite(cfg.seed) ? cfg.seed : 20261124;
    const calSamples = Array.isArray(cfg.calibrationSamples) ? cfg.calibrationSamples : null;
    const calMethod = cfg.calibrationMethod || 'platt';
    const testRounds = data.rounds.slice(minTrainRounds, minTrainRounds + maxTestRounds);
    const byModel = { byMarket: {} };
    const losses = { stage5: [], market: [], sequence: [], pattern: [] };
    const warnings = [], checks = [];
    let testMatches = 0, sequenceUsable = 0, patternRules = 0, patternValidated = 0;
    let calibratedRounds = 0, calibrationPrior = 0;
    const topPatterns = [];
    // Pattern discovery is a single initial-training pass; its own OOS rule
    // split is used for validation. Refitting all rules every round would be
    // prohibitively expensive and is not necessary while no rules validate.
    const firstTest = data.rounds[minTrainRounds];
    const seedTrain = firstTest ? data.matches.filter(m => m.ts < firstTest.ts) : [];
    const patternSeed = seedTrain.length ? _LPPat_Sp.discover(seedTrain, { cat, selsets, asOf: firstTest.ts, minSupport: minPatternSupport }) : { rules: [], validated: [], candidates: [], ctx: null, base: null };
    patternRules = patternSeed.rules.length; patternValidated = patternSeed.validated.length;
    for (const p of patternSeed.candidates.slice(0, 30)) topPatterns.push(p);
    for (const round of testRounds) {
      const train = data.matches.filter(m => m.ts < round.ts);
      if (train.length < 50) continue;
      let roundCal = null;
      if (calSamples && calSamples.length) {
        const prior = calSamples.filter(s => s && Number.isFinite(+s.ts) && +s.ts < round.ts && Number.isFinite(+s.p) && (+s.y === 0 || +s.y === 1));
        calibrationPrior += prior.length;
        if (prior.length >= 200) { try { roundCal = _LPCal_Sp.fit(prior, { method: calMethod }); } catch (e) { roundCal = null; } }
        if (roundCal) calibratedRounds++;
      }
      const cv = v => roundCal ? _LPCal_Sp.applyVector(roundCal, v) : v;
      const seq = _LPSeq_Sp.fit(train, { asOf: round.ts });
      const pat = patternSeed;
      const comps = [...new Set(round.matches.map(m => +m.comp).filter(Number.isFinite))];
      for (const comp of comps) {
        const hist = train.filter(m => +m.comp === comp);
        if (hist.length < minCompMatches) continue;
        const T = _LPModel_Sp.fitDC(hist, round.ts, { seasonMode: 'auto', empirical: true });
        const trainCutoff = hist.length ? Math.max.apply(null, hist.map(m => m.ts)) : null;
        const leakage = !(trainCutoff == null || trainCutoff < round.ts);
        checks.push({ round: round.key, comp, trainN: hist.length, testStart: round.ts, trainCutoff, leakage });
        if (leakage) warnings.push('Training cutoff at/after test start in round ' + round.key + ' comp ' + comp);
        for (const m of round.matches.filter(x => +x.comp === comp)) {
          if (!m.odds || !m.sk || !selsets[m.sk]) continue;
          let ev; try { ev = _LPModel_Sp.evaluate(cat, m, selsets[m.sk], T); } catch (e) { continue; }
          const byId = new Map(ev.rows.map(r => [r.id, r]));
          const market1 = probsFromMap(new Map([[101, byId.get(101)?.fair], [102, byId.get(102)?.fair], [103, byId.get(103)?.fair]]), [101, 102, 103]);
          const stage1 = cv(probsFromMap(new Map([[101, byId.get(101)?.ensemble], [102, byId.get(102)?.ensemble], [103, byId.get(103)?.ensemble]]), [101, 102, 103]));
          const mkOU = byId.has(109) && byId.has(110) ? [byId.get(109).fair, byId.get(110).fair] : null;
          const stOU = cv(byId.has(109) && byId.has(110) ? [byId.get(109).ensemble, byId.get(110).ensemble] : null);
          const mkBT = byId.has(107) && byId.has(108) ? [byId.get(107).fair, byId.get(108).fair] : null;
          const stBT = cv(byId.has(107) && byId.has(108) ? [byId.get(107).ensemble, byId.get(108).ensemble] : null);
          const sq = _LPSeq_Sp.predict(seq, m, cat, selsets[m.sk]);
          if (sq && sq.usable) sequenceUsable++;
          const sq1 = cv(sq && sq.probs ? probsFromMap(sq.probs, [101, 102, 103]) : null);
          const sqOU = cv(sq && sq.probs ? probsFromMap(sq.probs, [109, 110]) : null);
          const sqBT = cv(sq && sq.probs ? probsFromMap(sq.probs, [107, 108]) : null);
          const patP = _LPPat_Sp.predict(pat, m, { oneX2: market1, ou: mkOU, btts: mkBT }, { market: market1 });
          const pt1 = cv(patP && patP.probs1x2), ptOU = cv(patP && patP.probsOU), ptBT = cv(patP && patP.probsBTTS);
          const y1 = m.outcome, you = m.total > 2.5 ? 0 : 1, yb = m.btts ? 0 : 1;
          const pairs = [
            { market: '1X2', y: y1, b3: true, vals: { stage5: stage1, market: market1, sequence: sq1, pattern: pt1 } },
            { market: 'OU2.5', y: you, b3: false, vals: { stage5: stOU, market: mkOU, sequence: sqOU, pattern: ptOU } },
            { market: 'BTTS', y: yb, b3: false, vals: { stage5: stBT, market: mkBT, sequence: sqBT, pattern: ptBT } }
          ];
          let l1 = {};
          for (const p of pairs) {
            for (const model of ['stage5', 'market', 'sequence', 'pattern']) {
              const probs = p.vals[model];
              if (!probs) continue;
              const br = p.b3 ? brier3(probs, p.y) : brier2(probs, p.y);
              const lo = ll(probs, p.y);
              if (br == null || lo == null) continue;
              add(byModel, model, p.market, br, lo);
              if (p.market === '1X2') l1[model] = lo;
            }
          }
          for (const model of ['stage5', 'market', 'sequence', 'pattern']) losses[model].push(Number.isFinite(l1[model]) ? l1[model] : null);
          testMatches++;
        }
      }
    }
    for (const model of Object.keys(byModel)) {
      if (model === 'byMarket') continue;
      const c = byModel[model]; if (c.n) { c.brier /= c.n; c.logLoss /= c.n; }
    }
    for (const market of Object.values(byModel.byMarket)) for (const c of Object.values(market)) if (c.n) { c.brier /= c.n; c.logLoss /= c.n; }
    const cmp = [];
    const vsLabel = calSamples && calibratedRounds ? 'calibrated stage5 ensemble' : 'stage5 ensemble';
    for (const model of ['sequence', 'pattern']) {
      const pairs = losses[model].map((x, i) => [x, losses.stage5[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (pairs.length >= 20) {
        const d = _LPStats_Sp.pairedBootstrapDiff(pairs.map(p => p[0]), pairs.map(p => p[1]), _LPStats_Sp.mean, B, 0.05, seed + (model === 'sequence' ? 1 : 2));
        cmp.push({ model, vs: vsLabel, n: pairs.length, diffLogLoss: d.diff, low: d.low, high: d.high, p: d.p, improves: d.diff < 0 });
      }
    }
    const cq = _LPStats_Sp.bh(cmp.filter(c => Number.isFinite(c.p)).map(c => c.p));
    cmp.filter(c => Number.isFinite(c.p)).forEach((c, i) => { c.q = cq[i]; });
    const seqCmp = cmp.find(c => c.model === 'sequence');
    const patCmp = cmp.find(c => c.model === 'pattern');
    const sequenceEnabled = !!(seqCmp && seqCmp.diffLogLoss < 0 && seqCmp.p < 0.05 && seqCmp.q < 0.1 && sequenceUsable >= 30);
    const patternsEnabled = !!(patternValidated > 0 && patCmp && patCmp.diffLogLoss < 0 && patCmp.p < 0.05 && patCmp.q < 0.1);
    if (!testMatches) warnings.push('No test matches were evaluable.');
    if (calSamples && !calibratedRounds) warnings.push('Calibration samples were supplied but no test round had at least 200 prior selections; specialists were evaluated against the raw ensemble.');
    if (testMatches && testMatches < 200) warnings.push('Small specialist sample (' + testMatches + ' matches); enable/disable decisions are provisional.');
    if (!sequenceEnabled) warnings.push('Sequence model disabled: it did not beat the Stage 5 ensemble after paired correction or had insufficient usable state.');
    if (!patternsEnabled) warnings.push('Pattern model disabled: no validated rules or no out-of-sample improvement over the Stage 5 ensemble.');
    return {
      meta: {
        version: VERSION, generatedAt: Date.now(), matches: data.matches.length, rounds: data.rounds.length, testMatches, testRounds: testRounds.length,
        minTrainRounds, minCompMatches, minPatternSupport, permutations: B, seed, sequenceUsable, patternRules, patternValidated, warnings,
        calibration: { requested: !!(calSamples && calSamples.length), method: calMethod, rounds: calibratedRounds, priorSelections: calibrationPrior, vs: vsLabel }
      },
      byModel, comparisons: cmp,
      sequence: { enabled: sequenceEnabled, comparison: seqCmp || null, usable: sequenceUsable },
      patterns: { enabled: patternsEnabled, comparison: patCmp || null, discovered: patternRules, validated: patternValidated, top: topPatterns },
      checks, warnings
    };
  }
  return { VERSION, evaluate, prep };
})();
if (typeof module !== 'undefined') module.exports = LPSpecialists;
