// Immutable prediction ledger for League Plus.
//
// Stage 3 records a pre-match probability snapshot for every upcoming fixture
// before its betting window closes, then settles it in a separate immutable
// row once the result exists. The model version is explicit; calibration and
// the final decision engine arrive in later stages, so every Stage 3 decision
// is deliberately NO BET.
const _coreL = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelL = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _decisionL = (typeof module !== 'undefined' && module.exports) ? require('./decision.js') : null;
const _LPDB_L = (typeof LPDB !== 'undefined') ? LPDB : _coreL.LPDB;
const _LPCat_L = (typeof LPCat !== 'undefined') ? LPCat : _coreL.LPCat;
const _LPUtil_L = (typeof LPUtil !== 'undefined') ? LPUtil : _coreL.LPUtil;
const _LPModel_L = (typeof LPModel !== 'undefined') ? LPModel : _modelL;
const _LPDecision_L = (typeof LPDecision !== 'undefined') ? LPDecision : _decisionL;

const LPLedger = (() => {
  const VERSION = 'stage7-calibrated-v1';
  const ENSEMBLE_VERSION = 'equal-mkt-dc-emp-team-v1';
  const WEIGHTED_VERSION = 'adaptive-shrunk-v1';
  const CI_METHOD = 'wilson-effective-n-approx-v1';
  const MODELS = ['fair', 'mkt', 'team', 'blend', 'ensemble', 'dc', 'emp', 'weighted', 'calibrated'];

  async function priorByComp(fixtures, db, asOf) {
    const comps = [...new Set((fixtures || []).map(f => +f.comp).filter(Number.isFinite))];
    const out = new Map();
    for (const comp of comps) {
      let rows = [];
      try { rows = await db.getAllBy('matches', 'comp', comp); }
      catch (e) { try { rows = (await db.getAll('matches')).filter(m => +m.comp === comp); } catch (e2) { rows = []; } }
      rows = rows.filter(m => Number.isFinite(m.ts) && m.ts < asOf && Number.isFinite(m.hg) && Number.isFinite(m.ag) && m.hg >= 0 && m.ag >= 0 && (!m.quality || m.quality.status !== 'invalid'))
        .sort((a, b) => a.ts - b.ts);
      out.set(comp, rows);
    }
    return out;
  }

  // Record at most one row per fixture/checkpoint/model/odds hash. `open` and
  // `mid` are alternatives; `preclose` is recorded separately when the
  // pre-close capture succeeds.
  async function recordFixtures(opts = {}) {
    const db = opts.db || _LPDB_L;
    const asOf = Number.isFinite(opts.asOf) ? opts.asOf : Date.now();
    const halfLifeH = Number.isFinite(opts.halfLifeH) ? opts.halfLifeH : 6;
    const selsets = opts.selsets || {};
    const cat = opts.cat || {};
    const calibration = opts.calibration || null;
    const weights = opts.weights || null;
    const policy = opts.policy || null;
    const calibrate = typeof opts.calibrate === 'function' ? opts.calibrate
      : (calibration && typeof LPCalibration !== 'undefined' ? p => LPCalibration.apply(calibration, p) : null);
    const calibrationVersion = calibrate ? (opts.calibrationVersion || (calibration && calibration.version) || 'stage7-calibration-v1') : null;
    const weightsVersion = weights ? (opts.weightsVersion || WEIGHTED_VERSION) : null;
    const out = {
      recorded: 0, skipped: 0, conflicts: 0, errors: [], asOf, modelVersion: VERSION, ensembleVersion: ENSEMBLE_VERSION,
      calibrationVersion, weightsVersion
    };
    const fixtures = (opts.fixtures || []).filter(f => f && f.fixtureId && f.sk);
    if (!fixtures.length) return out;
    if (!cat || !Object.keys(cat).length) { out.errors.push({ error: 'missing catalogue' }); return out; }

    const prior = await priorByComp(fixtures, db, asOf);
    const fits = new Map();
    for (const [comp, rows] of prior) fits.set(comp, _LPModel_L.fitDC(rows.slice(-3000), asOf, { halfLifeH, seasonMode: 'auto', empirical: true }));

    const rowsToWrite = [];
    for (const fx of fixtures) {
      const betClose = Number.isFinite(fx.betClose) ? fx.betClose : (fx.close != null ? +fx.close : null);
      const betOpen = Number.isFinite(fx.betOpen) ? fx.betOpen : (fx.ts != null ? +fx.ts : null);
      if (!Number.isFinite(betClose) || asOf >= betClose) { out.skipped++; continue; }
      const selStr = selsets[fx.sk] || fx.selStr || '';
      if (!selStr) { out.errors.push({ fixtureId: fx.fixtureId, error: 'missing selection set' }); continue; }

      const nearClose = betClose - asOf <= 150e3;
      let checkpoint;
      if (nearClose) checkpoint = 'preclose';
      else if (Number.isFinite(betOpen) && asOf - betOpen <= 120e3) checkpoint = 'open';
      else checkpoint = 'mid';

      const oddsHash = _LPUtil_L.hash64(String(fx.sk || '') + '|' + String(fx.odds || ''));
      const modelKey = VERSION + ':h' + halfLifeH + ':cal=' + (calibrationVersion || 'none') + ':w=' + (weightsVersion || 'none');
      const predictionId = fx.fixtureId + ':' + checkpoint + ':' + modelKey + ':' + oddsHash;
      let existing = null;
      try { existing = await db.get('predictions', predictionId); } catch (e) { }
      if (existing) { out.skipped++; continue; }
      if (checkpoint === 'mid') {
        // Do not add a mid row when an opening row already exists.
        try { if (await db.get('predictions', fx.fixtureId + ':open:' + modelKey + ':' + oddsHash)) { out.skipped++; continue; } } catch (e) { }
      }

      const T = fits.get(+fx.comp) || null;
      const ev = _LPModel_L.evaluate(cat, fx, selStr, T, {
        weights, calibrate, calibrationVersion, weightsVersion,
        calibrationTarget: opts.calibrationTarget
      });
      if (!ev || !ev.rows.length) { out.errors.push({ fixtureId: fx.fixtureId, error: 'no priced selections' }); continue; }
      let dec = null;
      if (policy && _LPDecision_L) { try { dec = _LPDecision_L.evaluateFixture(ev, policy, cat); } catch (e) { dec = null; } }
      const selected = dec && dec.decision === 'BET' ? dec : null;

      const ids = [], odds = [], implied = [], fair = [], mkt = [], team = [], dc = [], emp = [], blend = [], ensemble = [], weighted = [], calibrated = [], plow = [], phigh = [], pLow = [], pHigh = [], nEff = [], unc = [], evs = [], edge = [];
      for (const r of ev.rows) {
        if (!(r.odds > 1)) continue;
        ids.push(r.id); odds.push(r.odds); implied.push(1 / r.odds);
        fair.push(r.fair ?? null);
        mkt.push(r.mkt ?? null);
        team.push(r.team ?? null);
        dc.push(r.dc ?? null);
        emp.push(r.emp ?? null);
        blend.push(r.blend ?? null);
        const ens = r.ensemble ?? r.blend ?? r.mkt ?? r.fair ?? null;
        ensemble.push(ens);
        weighted.push(weights ? (r.weighted ?? ens) : null);
        calibrated.push(calibrate ? (r.calibrated ?? ens) : null);
        const lo = r.modelLow != null ? r.modelLow : (ens ?? null);
        const hi = r.modelHigh != null ? r.modelHigh : (ens ?? null);
        plow.push(lo); phigh.push(hi);
        pLow.push(r.pLow ?? lo); pHigh.push(r.pHigh ?? hi);
        nEff.push(r.nEff ?? null); unc.push(r.uncertaintyClass || 'unknown');
        evs.push(ens != null ? ens * r.odds - 1 : null);
        edge.push(ens != null && r.fair != null ? ens - r.fair : null);
      }
      if (!ids.length) { out.errors.push({ fixtureId: fx.fixtureId, error: 'no priced selections' }); continue; }

      let ci = null, ciP = -Infinity, ciEv = null;
      for (let i = 0; i < ids.length; i++) {
        const lower = pLow[i] != null && Number.isFinite(pLow[i]) ? pLow[i] : plow[i];
        if (lower == null || !Number.isFinite(lower)) continue;
        const e = lower * odds[i] - 1;
        // The fallback candidate is the most probable selection under the
        // approximate lower confidence bound, not the highest-EV longshot.
        if (lower > ciP) { ciP = lower; ci = i; ciEv = e; }
      }
      const selectedIdx = selected ? ids.indexOf(selected.selectedId) : -1;
      if (selectedIdx >= 0) { ci = selectedIdx; ciP = pLow[selectedIdx] != null ? pLow[selectedIdx] : plow[selectedIdx]; ciEv = selected.edgeLow; }

      const train = prior.get(+fx.comp) || [];
      const used = train.slice(-3000);
      const trainingCutoff = used.length ? Math.max.apply(null, used.map(m => m.ts)) : null;
      const row = {
        predictionId, fixtureId: fx.fixtureId, key: fx.key, roundKey: fx.roundKey, roundId: fx.roundId,
        game: fx.game, comp: fx.comp, season: fx.season, week: fx.week, home: fx.home, away: fx.away,
        asOf, betOpen, betClose, checkpoint,
        modelVersion: VERSION, ensembleVersion: ENSEMBLE_VERSION, weightedVersion: weightsVersion,
        calibrationVersion, uncertaintyVersion: _LPModel_L.UNCERTAINTY_VERSION,
        catalogueVersion: fx.catalogueVersion || opts.catalogueVersion || null,
        selHash: fx.sk, oddsHash, oddsProvenance: fx.oddsProvenance || 'upcoming',
        ids, odds, implied, fair, mkt, team, dc, emp, blend, ensemble, weighted, calibrated, plow, phigh, pLow, pHigh, nEff, uncertainty: unc, ev: evs, edgeVsFair: edge,
        pCalibrated: calibrate ? calibrated : null, ciMethod: CI_METHOD,
        confidenceClass: calibrate && ci != null ? (unc[ci] || 'calibrated') : 'uncalibrated',
        decision: selected ? 'BET' : 'NO_BET',
        selectedId: selected ? selected.selectedId : null,
        stakeUnits: selected ? selected.stakeUnits : 0,
        decisionPolicyVersion: policy ? policy.version || 'stage9-decision-v1' : null,
        decisionReason: selected ? 'Stage 9 lower-bound edge and staking policy' : (policy && dec ? dec.reason : 'Stage 9: no validated decision policy active'),
        selectedProb: selected ? selected.p : null,
        selectedPLow: selected ? selected.pLow : null,
        selectedOdds: selected ? selected.odds : null,
        selectedMarket: selected ? selected.market : null,
        selectedUncertainty: selected ? selected.uncertaintyClass : null,
        edgeLow: selected ? selected.edgeLow : null,
        edgePoint: selected ? selected.edgePoint : null,
        candidateId: ci != null ? ids[ci] : null,
        candidateProb: ci != null ? ciP : null,
        candidateEvLow: ci != null ? ciEv : null,
        trainingCutoff, trainN: used.length, halfLifeH,
        settlementStatus: 'pending', createdAt: asOf
      };
      row.contentHash = _LPUtil_L.contentHash({
        predictionId, fixtureId: row.fixtureId, asOf, checkpoint, ids, odds, ensemble, weighted, calibrated, plow, phigh, pLow, pHigh,
        decision: row.decision, selectedId: row.selectedId, stakeUnits: row.stakeUnits, decisionPolicyVersion: row.decisionPolicyVersion,
        modelVersion: VERSION, halfLifeH, catVersion: row.catalogueVersion, calibrationVersion, weightsVersion
      });      rowsToWrite.push(row);
    }

    if (rowsToWrite.length) {
      const w = await db.putImmutableMany('predictions', rowsToWrite, { keyPath: 'predictionId', hashField: 'contentHash' });
      out.recorded += w.added || 0;
      out.skipped += w.skipped || 0;
      out.conflicts += w.conflicts || 0;
    }
    return out;
  }

  async function settlePredictions(preds, db) {
    const out = { settled: 0, skipped: 0, invalid: 0, missingCatalogue: 0, conflicts: 0, errors: [] };
    const catCache = new Map();
    const matchCache = new Map();
    for (const p of (preds || [])) {
      if (!p || !p.predictionId || !Array.isArray(p.ids) || !p.ids.length) { out.skipped++; continue; }
      let ex = null;
      try { ex = await db.get('settlements', p.predictionId); } catch (e) { }
      if (ex) { out.skipped++; continue; }
      if (!(Number.isFinite(p.asOf) && Number.isFinite(p.betClose) && p.asOf < p.betClose)) { out.invalid++; continue; }

      let m = matchCache.get(p.fixtureId);
      if (m === undefined) {
        let arr = [];
        try { arr = await db.getAllBy('matches', 'fixtureId', p.fixtureId); } catch (e) { }
        m = arr && arr.length ? arr[0] : null;
        matchCache.set(p.fixtureId, m);
      }
      if (!m || !Number.isFinite(m.hg) || !Number.isFinite(m.ag)) { out.skipped++; continue; }
      if (m.quality && m.quality.status === 'invalid') { out.invalid++; continue; }

      let cat = catCache.get(p.catalogueVersion);
      if (!cat) {
        let rec = null;
        try { rec = await db.getCatalogue(p.catalogueVersion); } catch (e) { }
        if (!rec) { out.missingCatalogue++; continue; }
        cat = _LPCat_L.buildMap({ markets: rec.markets });
        catCache.set(p.catalogueVersion, cat);
      }

      const outcomes = p.ids.map(id => {
        const c = cat[id];
        if (!c) return null;
        const w = _LPCat_L.settle(c, m.hg, m.ag, m.goals, { tlOk: m.tlOk });
        return w == null ? null : (w ? 1 : 0);
      });

      const metrics = {};
      for (const model of MODELS) {
        const arr = p[model];
        let n = 0, wins = 0, brier = 0, ll = 0, sumP = 0;
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) {
            const y = outcomes[i], pr = arr[i];
            if (y == null || pr == null || !Number.isFinite(pr)) continue;
            const pc = Math.min(1 - 1e-9, Math.max(1e-9, pr));
            n++; wins += y; brier += (pc - y) ** 2;
            ll -= y ? Math.log(pc) : Math.log(1 - pc);
            sumP += pc;
          }
        }
        metrics[model] = { n, wins, brier: n ? brier / n : null, logLoss: n ? ll / n : null, avgP: n ? sumP / n : null };
      }

      const uncertainty = {};
      if (Array.isArray(p.uncertainty)) p.uncertainty.forEach(x => { uncertainty[x] = (uncertainty[x] || 0) + 1; });
      let bet = null;
      if (p.decision === 'BET' && p.selectedId != null && Array.isArray(p.ids)) {
        const si = p.ids.indexOf(p.selectedId);
        if (si >= 0 && outcomes[si] != null) {
          const won = outcomes[si] === 1;
          const odds = +p.odds[si];
          const stake = +p.stakeUnits || 0;
          bet = {
            selectedId: p.selectedId, market: p.selectedMarket || null, odds, stake, won,
            profitUnits: won ? stake * (odds - 1) : -stake,
            edgeLow: p.edgeLow == null ? null : +p.edgeLow,
            policyVersion: p.decisionPolicyVersion || null
          };
        }
      }
      const row = {
        predictionId: p.predictionId, fixtureId: p.fixtureId, roundKey: p.roundKey, roundId: p.roundId,
        game: p.game, comp: p.comp, settledAt: Date.now(),
        result: { hg: m.hg, ag: m.ag, goals: m.goals },
        outcomes, metrics, uncertainty, bet, decision: p.decision, selectedId: p.selectedId, candidateId: p.candidateId,
        catalogueVersion: p.catalogueVersion, modelVersion: p.modelVersion,
        calibrationVersion: p.calibrationVersion || null, weightsVersion: p.weightedVersion || null,
        decisionPolicyVersion: p.decisionPolicyVersion || null,
        settlementStatus: 'settled'
      };
      row.contentHash = _LPUtil_L.contentHash({ predictionId: row.predictionId, outcomes, metrics, bet, result: row.result, modelVersion: row.modelVersion, decision: row.decision, selectedId: row.selectedId });
      const r = await db.putImmutable('settlements', row, { keyPath: 'predictionId', hashField: 'contentHash' });
      out.settled += r.added || 0;
      out.conflicts += r.conflicts || 0;
      if (!r.added && !r.conflicts) out.skipped++;
    }
    return out;
  }

  async function settleRound(opts = {}) {
    const db = opts.db || _LPDB_L;
    const roundKey = opts.roundKey || (opts.game != null && opts.roundId != null ? opts.game + ':' + opts.roundId : null);
    if (!roundKey) return { settled: 0, skipped: 0, invalid: 0, missingCatalogue: 0, conflicts: 0, errors: ['missing roundKey'] };
    let preds = [];
    try { preds = await db.getAllBy('predictions', 'roundKey', roundKey); } catch (e) { }
    return settlePredictions(preds, db);
  }

  async function settleAll(opts = {}) {
    const db = opts.db || _LPDB_L;
    let preds = [];
    try { preds = await db.getAll('predictions'); } catch (e) { }
    return settlePredictions(preds, db);
  }

  async function recentPredictions(limit = 200, db = _LPDB_L) {
    try { if (db.getRecent) return await db.getRecent('predictions', 'asOf', limit); } catch (e) { }
    try { return (await db.getAll('predictions')).sort((a, b) => (b.asOf || 0) - (a.asOf || 0)).slice(0, limit); } catch (e) { return []; }
  }
  async function recentSettlements(limit = 200, db = _LPDB_L) {
    try { if (db.getRecent) return await db.getRecent('settlements', 'settledAt', limit); } catch (e) { }
    try { return (await db.getAll('settlements')).sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0)).slice(0, limit); } catch (e) { return []; }
  }

  async function stats(opts = {}) {
    const db = opts.db || _LPDB_L;
    let predictions = 0, settlements = 0;
    try { predictions = await db.count('predictions'); } catch (e) { }
    try { settlements = await db.count('settlements'); } catch (e) { }
    let recent = opts.recent;
    if (!Array.isArray(recent)) {
      try { recent = db.getRecent ? await db.getRecent('predictions', 'asOf', 200) : []; } catch (e) { recent = []; }
      if (!recent.length) { try { recent = (await db.getAll('predictions')).sort((a, b) => (b.asOf || 0) - (a.asOf || 0)).slice(0, 200); } catch (e) { } }
    }
    const counts = { open: 0, mid: 0, preclose: 0 };
    (recent || []).forEach(p => { if (p && counts[p.checkpoint] != null) counts[p.checkpoint]++; });
    return {
      predictions, settlements, modelVersion: VERSION, ciMethod: CI_METHOD, models: MODELS,
      recentTotal: (recent || []).length, recentOpen: counts.open, recentMid: counts.mid, recentPreclose: counts.preclose,
      settledPct: predictions ? settlements / predictions : null
    };
  }

  return { VERSION, ENSEMBLE_VERSION, WEIGHTED_VERSION, CI_METHOD, MODELS, recordFixtures, settlePredictions, settleRound, settleAll, stats, recentPredictions, recentSettlements };
})();
if (typeof module !== 'undefined') module.exports = LPLedger;
