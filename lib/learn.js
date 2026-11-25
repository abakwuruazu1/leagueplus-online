// Autonomous learning and activation pipeline (Stage 8).
//
// The pipeline is intentionally conservative:
//   - it only refreshes when enough new matches have arrived and a minimum
//     interval has elapsed;
//   - it re-uses the Stage 7 calibration and weight gates;
//   - it stores every trained state, including rejected ones, for audit;
//   - only a state that passed a gate can be activated;
//   - activation is a pointer swap, so rollback is immediate and auditable.
//
// The background service worker calls refresh() on a schedule and activeOpts()
// before recording ledger fixtures. The dashboard can trigger the same path
// manually and can activate/roll back a stored state.
const _coreLr = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _calLr = (typeof module !== 'undefined' && module.exports) ? require('./calibration.js') : null;
const _weightsLr = (typeof module !== 'undefined' && module.exports) ? require('./weights.js') : null;
const _modelLr = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _specLr = (typeof module !== 'undefined' && module.exports) ? require('./specialists.js') : null;
const _decisionLr = (typeof module !== 'undefined' && module.exports) ? require('./decision.js') : null;

const _LPCat_Lr = (typeof LPCat !== 'undefined') ? LPCat : _coreLr && _coreLr.LPCat;
const _LPUtil_Lr = (typeof LPUtil !== 'undefined') ? LPUtil : _coreLr && _coreLr.LPUtil;
const _LPCal_Lr = (typeof LPCalibration !== 'undefined') ? LPCalibration : _calLr;
const _LPW_Lr = (typeof LPWeights !== 'undefined') ? LPWeights : _weightsLr;
const _LPSpec_Lr = (typeof LPSpecialists !== 'undefined') ? LPSpecialists : _specLr;
const _LPDec_Lr = (typeof LPDecision !== 'undefined') ? LPDecision : _decisionLr;

const LPLearn = (() => {
  const VERSION = 'stage8-learning-v1';
  const ACTIVE_KEY = 'learn:active';
  const CONFIG_KEY = 'learn:config';
  const ATTEMPT_KEY = 'learn:lastAttempt';
  const DEFAULT_CONFIG = {
    enabled: true,
    autoActivate: true,
    minNewMatches: 40,
    minIntervalH: 6,
    minSamples: 500,
    minTrainSamples: 200,
    minTestSamples: 100,
    minTrainRounds: 3,
    minCompMatches: 10,
    maxTestRounds: 20,
    maxMatches: 3000,
    permutations: 199,
    seed: 20261124,
    shrink: 0.5,
    reevaluateSpecialists: true,
    decisionMinSamples: 500,
    decisionMinTestSamples: 100,
    decisionMinBets: 100,
    decisionMinTrainBets: 40,
    decisionKellyFraction: 0.25,
    decisionMaxStakeUnits: 2
  };
  function nowMs() { return Date.now(); }
  function dbOf(opts = {}) { return opts.db || (typeof LPDB !== 'undefined' ? LPDB : null); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clampInt(x, lo, hi, fallback) { const n = +x; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback; }
  function clampNum(x, lo, hi, fallback) { const n = +x; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback; }

  async function log(db, type, payload = {}) {
    try { await db.add('learningLog', Object.assign({ ts: nowMs(), type }, payload)); } catch (e) { }
  }
  async function getConfig(db) {
    let row = null;
    try { row = await db.get('meta', CONFIG_KEY); } catch (e) { }
    return Object.assign({}, DEFAULT_CONFIG, (row && row.value) || {});
  }
  async function setConfig(db, patch = {}, opts = {}) {
    const cur = await getConfig(db);
    const next = Object.assign({}, cur, patch);
    next.minNewMatches = clampInt(next.minNewMatches, 1, 10000, DEFAULT_CONFIG.minNewMatches);
    next.minIntervalH = clampNum(next.minIntervalH, 0, 720, DEFAULT_CONFIG.minIntervalH);
    next.minSamples = clampInt(next.minSamples, 20, 100000, DEFAULT_CONFIG.minSamples);
    next.minTrainSamples = clampInt(next.minTrainSamples, 20, 100000, DEFAULT_CONFIG.minTrainSamples);
    next.minTestSamples = clampInt(next.minTestSamples, 20, 100000, DEFAULT_CONFIG.minTestSamples);
    next.minTrainRounds = clampInt(next.minTrainRounds, 1, 200, DEFAULT_CONFIG.minTrainRounds);
    next.minCompMatches = clampInt(next.minCompMatches, 1, 1000, DEFAULT_CONFIG.minCompMatches);
    next.maxTestRounds = clampInt(next.maxTestRounds, 1, 500, DEFAULT_CONFIG.maxTestRounds);
    next.maxMatches = clampInt(next.maxMatches, 100, 20000, DEFAULT_CONFIG.maxMatches);
    next.permutations = clampInt(next.permutations, 49, 9999, DEFAULT_CONFIG.permutations);
    next.shrink = clampNum(next.shrink, 0, 1, DEFAULT_CONFIG.shrink);
    next.decisionMinSamples = clampInt(next.decisionMinSamples, 50, 100000, DEFAULT_CONFIG.decisionMinSamples);
    next.decisionMinTestSamples = clampInt(next.decisionMinTestSamples, 20, 100000, DEFAULT_CONFIG.decisionMinTestSamples);
    next.decisionMinBets = clampInt(next.decisionMinBets, 10, 100000, DEFAULT_CONFIG.decisionMinBets);
    next.decisionMinTrainBets = clampInt(next.decisionMinTrainBets, 5, 100000, DEFAULT_CONFIG.decisionMinTrainBets);
    next.decisionKellyFraction = clampNum(next.decisionKellyFraction, 0, 1, DEFAULT_CONFIG.decisionKellyFraction);
    next.decisionMaxStakeUnits = clampNum(next.decisionMaxStakeUnits, 0.01, 100, DEFAULT_CONFIG.decisionMaxStakeUnits);
    next.enabled = next.enabled !== false;
    next.autoActivate = next.autoActivate !== false;
    next.reevaluateSpecialists = next.reevaluateSpecialists !== false;
    try { await db.put('meta', { key: CONFIG_KEY, value: next, at: nowMs() }); } catch (e) { }
    await log(db, 'config', { config: next, by: opts.by || 'manual' });
    return next;
  }

  async function loadContext(db, opts = {}) {
    const matches = (await db.getAll('matches').catch(() => [])).filter(m => m && Number.isFinite(+m.ts))
      .sort((a, b) => a.ts - b.ts);
    let init = null;
    try { init = await db.get('meta', 'init'); } catch (e) { }
    let cats = [];
    try { cats = await db.getAll('catalogues'); } catch (e) { }
    cats = (cats || []).slice().sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0));
    const latest = cats[0];
    let cat = {};
    try {
      if (latest && latest.markets) cat = _LPCat_Lr.buildMap({ markets: latest.markets });
      else if (init && init.markets) cat = _LPCat_Lr.buildMap(init);
    } catch (e) { }
    const selsets = {};
    let meta = [];
    try { meta = await db.getAll('meta'); } catch (e) { }
    (meta || []).forEach(x => { if (x && typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selsets[x.key] = x.value; });
    return { matches: opts.maxMatches ? matches.slice(-opts.maxMatches) : matches, cat, selsets, catalogueVersion: latest ? latest.version : null, init };
  }

  async function getActiveRow(db) {
    try { return await db.get('meta', ACTIVE_KEY); } catch (e) { return null; }
  }
  async function getState(db, version) {
    if (!version) return null;
    try { return await db.get('modelStates', version); } catch (e) { return null; }
  }
  async function getActive(db) {
    const ref = await getActiveRow(db);
    if (!ref || !ref.version) return null;
    const state = await getState(db, ref.version);
    return state ? Object.assign({}, state, { activation: ref }) : null;
  }
  async function activeOpts(opts = {}) {
    const db = dbOf(opts);
    const state = await getActive(db);
    if (!state) return {};
    const out = {};
    if (state.calibration && state.calibration.enabled && state.calibration.calibrator) {
      out.calibration = state.calibration.calibrator;
      out.calibrate = p => _LPCal_Lr.apply(state.calibration.calibrator, p);
    }
    if (state.weights && state.weights.enabled && state.weights.weights) out.weights = state.weights.weights;
    if (state.decision && state.decision.enabled && state.decision.policy) out.policy = state.decision.policy;
    if (state.calibrationVersion) out.calibrationVersion = state.calibrationVersion;
    if (state.weightsVersion) out.weightsVersion = state.weightsVersion;
    if (state.decisionVersion) out.decisionVersion = state.decisionVersion;
    return out;
  }

  function simSummary(x) {
    if (!x) return null;
    return {
      bets: x.bets, wins: x.wins, profit: x.profit, roi: x.roi,
      staked: x.staked, profitStaked: x.profitStaked, roiStaked: x.roiStaked,
      avgStake: x.avgStake, maxDrawdown: x.maxDrawdown
    };
  }
  function specialistSummary(r) {
    if (!r) return null;
    return {
      meta: r.meta, byModel: r.byModel, comparisons: r.comparisons,
      sequence: r.sequence, patterns: { enabled: r.patterns && r.patterns.enabled, discovered: r.patterns && r.patterns.discovered, validated: r.patterns && r.patterns.validated, comparison: r.patterns && r.patterns.comparison },
      warnings: r.warnings
    };
  }
  function stateVersion(createdAt, hash) { return 'learn-' + createdAt + '-' + String(hash || '').slice(0, 10); }

  async function activate(db, version, opts = {}) {
    if (version === undefined) return { ok: false, error: 'missing version' };
    const current = await getActiveRow(db);
    if ((current && current.version) === (version || null) && !opts.force) return { ok: true, activated: false, version: version || null };
    if (version) {
      const state = await getState(db, version);
      if (!state) return { ok: false, error: 'model state not found' };
      if (state.status === 'rejected' && !opts.force) return { ok: false, error: 'model state was rejected by the activation gate' };
    }
    const ref = {
      key: ACTIVE_KEY, version: version || null, previousVersion: current ? current.version || null : null,
      activatedAt: nowMs(), by: opts.by || 'manual', reason: opts.reason || (version ? 'activation' : 'deactivate')
    };
    await db.put('meta', ref);
    await log(db, version ? 'activate' : 'deactivate', { from: ref.previousVersion, to: ref.version, reason: ref.reason, by: ref.by });
    return { ok: true, activated: true, version: ref.version, previousVersion: ref.previousVersion, ref };
  }

  async function rollback(db, targetVersion, opts = {}) {
    const res = await activate(db, targetVersion === undefined ? null : targetVersion, Object.assign({}, opts, { by: opts.by || 'manual', reason: opts.reason || 'rollback', force: !!opts.force }));
    if (res.ok) await log(db, 'rollback', { to: res.version || 'equal-ensemble', by: opts.by || 'manual' });
    return res;
  }

  function buildState(calibration, weights, decision, specialists, training, config, extra = {}) {
    const createdAt = nowMs();
    const cal = calibration || {};
    const w = weights || {};
    const dec = decision || {};
    const calOn = !!(cal.decision && cal.decision.enabled);
    const wOn = !!(w.decision && w.decision.enabled);
    const decOn = !!(dec.decision && dec.decision.enabled);
    const status = calOn || wOn || decOn ? 'candidate' : 'rejected';
    const state = {
      version: '',
      createdAt,
      status,
      stage: VERSION,
      modelVersion: _modelLr && _modelLr.VERSION || null,
      calibrationVersion: calOn ? 'stage7-calibration-v1' : null,
      weightsVersion: wOn ? 'stage7-weights-v1' : null,
      decisionVersion: decOn ? 'stage9-decision-v1' : null,
      training,
      config: clone(config || {}),
      calibration: {
        enabled: calOn,
        method: cal.decision && cal.decision.method || null,
        calibrator: calOn && cal.decision ? cal.decision.calibrator : null,
        metrics: cal.metrics || null,
        decision: cal.decision || null,
        reliability: cal.reliability || null,
        warnings: cal.warnings || []
      },
      weights: {
        enabled: wOn,
        weights: wOn && w.decision ? w.decision.weights : null,
        rawWeights: wOn && w.decision ? w.decision.rawWeights : null,
        shrink: w.decision && w.decision.shrink,
        metrics: w.metrics || null,
        comparisons: w.comparisons || [],
        perMarket: w.perMarket || [],
        decision: w.decision || null,
        warnings: w.warnings || []
      },
      decision: {
        enabled: decOn,
        policy: decOn && dec.decision ? dec.decision.policy : null,
        metrics: dec.metrics ? { train: simSummary(dec.metrics.train), test: simSummary(dec.metrics.test) } : null,
        decision: dec.decision ? {
          enabled: !!dec.decision.enabled, threshold: dec.decision.threshold,
          ciLow: dec.decision.ciLow, ciHigh: dec.decision.ciHigh, p: dec.decision.p,
          nTrain: dec.decision.nTrain, nTest: dec.decision.nTest,
          train: simSummary(dec.decision.train), test: simSummary(dec.decision.test)
        } : null,
        warnings: dec.warnings || []
      },
      specialists: specialistSummary(specialists),
      warnings: [...new Set([...(cal.warnings || []), ...(w.warnings || []), ...(dec.warnings || []), ...(specialists && specialists.warnings || []), ...(extra.warnings || [])])],
      reason: extra.reason || null
    };
    state.hash = _LPUtil_Lr.contentHash({
      status: state.status, modelVersion: state.modelVersion, calibrationVersion: state.calibrationVersion,
      weightsVersion: state.weightsVersion, decisionVersion: state.decisionVersion, training: state.training,
      calibration: state.calibration, weights: state.weights, decision: state.decision, specialists: state.specialists
    });
    state.version = stateVersion(createdAt, state.hash);
    return state;
  }

  async function refresh(opts = {}) {
    const db = dbOf(opts);
    const config = await getConfig(db);
    if (!config.enabled && !opts.force) return { ok: true, skipped: true, reason: 'learning disabled' };
    const now = Number.isFinite(opts.now) ? opts.now : nowMs();
    const lastAttempt = await db.get('meta', ATTEMPT_KEY).catch(() => null);
    const context = opts.context || await loadContext(db, { maxMatches: config.maxMatches });
    const maxTs = context.matches.length ? Math.max.apply(null, context.matches.map(m => +m.ts || 0)) : 0;
    const active = await getActive(db);
    let latest = null;
    try {
      const states = await db.getAll('modelStates');
      latest = (states || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
    } catch (e) { }
    const prior = active && latest ? (active.createdAt >= latest.createdAt ? active : latest) : (active || latest);
    if (!opts.force) {
      if (lastAttempt && now - (+lastAttempt.at || 0) < config.minIntervalH * 3600e3) {
        return { ok: true, skipped: true, reason: 'minimum learning interval has not elapsed' };
      }
      if (!prior) {
        if (context.matches.length < config.minNewMatches) {
          return { ok: true, skipped: true, reason: 'not enough recorded matches yet', matches: context.matches.length };
        }
      } else {
        const lastTs = prior.training && Number.isFinite(+prior.training.lastTs) ? +prior.training.lastTs : 0;
        const newMatches = context.matches.filter(m => +m.ts > lastTs).length;
        if (newMatches < config.minNewMatches) {
          return { ok: true, skipped: true, reason: 'not enough new matches since the latest learning state', newMatches, required: config.minNewMatches };
        }
      }
      if (prior && prior.training && prior.training.lastTs >= maxTs) {
        return { ok: true, skipped: true, reason: 'no new match data since the latest learning state' };
      }
    }
    await db.put('meta', { key: ATTEMPT_KEY, at: now, matches: context.matches.length, lastTs: maxTs }).catch(() => { });
    if (!context.cat || !Object.keys(context.cat).length) {
      await log(db, 'skip', { reason: 'missing market catalogue' });
      return { ok: false, skipped: true, reason: 'missing market catalogue' };
    }
    let collected;
    try {
      collected = _LPCal_Lr.collect({
        matches: context.matches, cat: context.cat, selsets: context.selsets,
        options: {
          minTrainRounds: config.minTrainRounds, minCompMatches: config.minCompMatches,
          maxTestRounds: config.maxTestRounds, permutations: config.permutations, seed: config.seed
        }
      });
    } catch (e) {
      await log(db, 'error', { reason: 'sample collection failed', error: e.message });
      return { ok: false, error: 'sample collection failed: ' + e.message };
    }
    const training = {
      matchCount: context.matches.length,
      roundCount: collected.meta ? collected.meta.rounds : null,
      sampleCount: collected.samples.length,
      testMatches: collected.meta ? collected.meta.testMatches : null,
      firstTs: context.matches.length ? +context.matches[0].ts : null,
      lastTs: maxTs,
      generatedAt: now
    };
    if (collected.samples.length < config.minSamples) {
      const state = buildState(null, null, null, null, training, config, { reason: 'insufficient samples', warnings: ['Only ' + collected.samples.length + ' selections; need ' + config.minSamples + ' for autonomous training.'] });
      await db.putImmutable('modelStates', state, { keyPath: 'version', hashField: 'hash' }).catch(() => { });
      await log(db, 'skip', { reason: 'insufficient samples', samples: collected.samples.length, state: state.version });
      return { ok: true, skipped: true, reason: 'insufficient samples', samples: collected.samples.length, state: state.version };
    }

    const calibration = _LPCal_Lr.walkForward(collected.samples, {
      minTrainSamples: config.minTrainSamples, minTestSamples: config.minTestSamples,
      folds: 3, bins: 10, permutations: config.permutations, seed: config.seed
    });
    const weights = _LPW_Lr.evaluate(collected.samples, {
      minTrainSamples: config.minTrainSamples, minTestSamples: config.minTestSamples,
      folds: 3, shrink: config.shrink, permutations: config.permutations, seed: config.seed
    });
    let decision = null;
    if (_LPDec_Lr) {
      try {
        decision = _LPDec_Lr.walkForward(collected.samples, {
          minSamples: config.decisionMinSamples, minTestSamples: config.decisionMinTestSamples,
          minBets: config.decisionMinBets, minTrainBets: config.decisionMinTrainBets,
          kellyFraction: config.decisionKellyFraction, maxStakeUnits: config.decisionMaxStakeUnits,
          permutations: config.permutations, seed: config.seed
        });
      } catch (e) {
        decision = { decision: { enabled: false, policy: null }, warnings: ['Decision policy evaluation failed: ' + e.message] };
      }
    }

    let specialists = null;
    if (calibration.decision && calibration.decision.enabled && config.reevaluateSpecialists) {
      try {
        specialists = _LPSpec_Lr.evaluate({
          matches: context.matches, cat: context.cat, selsets: context.selsets,
          options: {
            minTrainRounds: config.minTrainRounds, minCompMatches: config.minCompMatches,
            maxTestRounds: Math.min(8, config.maxTestRounds), minPatternSupport: 30,
            permutations: Math.min(99, config.permutations), seed: config.seed,
            calibrationSamples: collected.samples, calibrationMethod: calibration.decision.method
          }
        });
      } catch (e) {
        specialists = { meta: { version: _LPSpec_Lr.VERSION, error: e.message }, warnings: ['Specialist re-evaluation failed: ' + e.message] };
      }
    }
    const state = buildState(calibration, weights, decision, specialists, training, config);
    await db.putImmutable('modelStates', state, { keyPath: 'version', hashField: 'hash' }).catch(() => { });
    let activation = null;
    if (state.status === 'candidate' && config.autoActivate) {
      activation = await activate(db, state.version, { by: 'auto', reason: 'passed walk-forward gate', force: false });
    } else if (state.status === 'rejected') {
      await log(db, 'reject', { state: state.version, reason: 'no component passed its walk-forward gate', warnings: state.warnings });
    } else if (state.status === 'candidate') {
      await log(db, 'candidate', { state: state.version, reason: 'auto-activation disabled' });
    }
    return {
      ok: true, skipped: false, state: state.version, status: state.status,
      calibration: { enabled: calibration.decision && calibration.decision.enabled, method: calibration.decision && calibration.decision.method },
      weights: { enabled: weights.decision && weights.decision.enabled },
      decision: decision ? { enabled: decision.decision && decision.decision.enabled, threshold: decision.decision && decision.decision.threshold, test: decision.decision && decision.decision.test } : null,
      specialists: specialists ? { calibration: specialists.meta && specialists.meta.calibration, sequence: specialists.sequence && specialists.sequence.enabled, patterns: specialists.patterns && specialists.patterns.enabled } : null,
      activation, warnings: state.warnings
    };
  }

  async function snapshot(opts = {}) {
    const db = dbOf(opts);
    const config = await getConfig(db);
    const active = await getActive(db);
    let states = [];
    try { states = await db.getAll('modelStates'); } catch (e) { }
    states = (states || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, opts.limit || 60);
    let logRows = [];
    try { logRows = db.getRecent ? await db.getRecent('learningLog', 'ts', opts.logLimit || 120) : await db.getAll('learningLog'); }
    catch (e) { try { logRows = await db.getAll('learningLog'); } catch (e2) { logRows = []; } }
    if (!Array.isArray(logRows)) logRows = [];
    logRows = logRows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return { version: VERSION, active, config, states, log: logRows };
  }

  return {
    VERSION, DEFAULT_CONFIG, getConfig, setConfig, loadContext,
    getActive, getState, activeOpts, refresh, maybeRefresh: refresh,
    activate, rollback, snapshot
  };
})();
if (typeof module !== 'undefined') module.exports = LPLearn;
