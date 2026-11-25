// Cloud snapshot and upload for the phone/remote view.
//
// The extension keeps all history locally. This module builds a compact,
// read-only snapshot for a Netlify Function and uploads it with a write token.
// The token is stored only in the extension's IndexedDB settings; it is never
// included in the snapshot.
const _coreCl = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _ledgerCl = (typeof module !== 'undefined' && module.exports) ? require('./ledger.js') : null;
const _perfCl = (typeof module !== 'undefined' && module.exports) ? require('./performance.js') : null;
const _learnCl = (typeof module !== 'undefined' && module.exports) ? require('./learn.js') : null;

const _LPDB_Cl = (typeof LPDB !== 'undefined') ? LPDB : _coreCl && _coreCl.LPDB;
const _LPLedger_Cl = (typeof LPLedger !== 'undefined') ? LPLedger : _ledgerCl;
const _LPPerformance_Cl = (typeof LPPerformance !== 'undefined') ? LPPerformance : _perfCl;
const _LPLearn_Cl = (typeof LPLearn !== 'undefined') ? LPLearn : _learnCl;

const LPCloud = (() => {
  const VERSION = 'stage11-cloud-v1';
  const SCHEMA = 1;
  const CONFIG_KEY = 'cloud:config';
  const STATUS_KEY = 'cloud:status';
  const MAX_BYTES = 4 * 1024 * 1024;
  const DEFAULT_CONFIG = { enabled: false, endpoint: '', token: '', intervalMin: 1 };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function dbOf(opts = {}) { return opts.db || _LPDB_Cl; }
  async function getConfig(db) {
    let row = null;
    try { row = await db.get('meta', CONFIG_KEY); } catch (e) { }
    return Object.assign({}, DEFAULT_CONFIG, (row && row.value) || {});
  }
  async function setConfig(db, patch = {}) {
    const cur = await getConfig(db);
    const next = Object.assign({}, cur, patch);
    next.enabled = !!next.enabled;
    next.intervalMin = clamp(+next.intervalMin || 1, 0, 1440);
    next.endpoint = String(next.endpoint || '').trim();
    next.token = String(next.token || '').trim();
    await db.put('meta', { key: CONFIG_KEY, value: next, at: Date.now() });
    return next;
  }
  async function getStatus(db) {
    try { return await db.get('meta', STATUS_KEY); } catch (e) { return null; }
  }

  function compactActive(a) {
    if (!a) return null;
    const c = a.calibration || {}, w = a.weights || {}, d = a.decision || {};
    return {
      version: a.version, createdAt: a.createdAt, status: a.status,
      modelVersion: a.modelVersion, calibrationVersion: a.calibrationVersion || null,
      weightsVersion: a.weightsVersion || null, decisionVersion: a.decisionVersion || null,
      training: a.training || null,
      calibration: { enabled: !!c.enabled, method: c.method || null, warnings: c.warnings || [] },
      weights: { enabled: !!w.enabled, weights: w.weights || null, warnings: w.warnings || [] },
      decision: {
        enabled: !!d.enabled, policy: d.policy || null,
        decision: d.decision ? {
          enabled: !!d.decision.enabled, threshold: d.decision.threshold,
          ciLow: d.decision.ciLow, ciHigh: d.decision.ciHigh, p: d.decision.p,
          nTrain: d.decision.nTrain, nTest: d.decision.nTest,
          train: d.decision.train, test: d.decision.test
        } : null,
        warnings: d.warnings || []
      },
      specialists: a.specialists ? {
        sequence: a.specialists.sequence || null,
        patterns: a.specialists.patterns || null
      } : null,
      warnings: a.warnings || []
    };
  }
  function compactPrediction(p) {
    return {
      predictionId: p.predictionId, fixtureId: p.fixtureId, comp: p.comp, home: p.home, away: p.away,
      asOf: p.asOf, checkpoint: p.checkpoint, decision: p.decision, selectedId: p.selectedId,
      selectedMarket: p.selectedMarket || null, selectedOdds: p.selectedOdds == null ? null : p.selectedOdds,
      selectedProb: p.selectedProb == null ? null : p.selectedProb,
      selectedPLow: p.selectedPLow == null ? null : p.selectedPLow,
      stakeUnits: p.stakeUnits || 0, edgeLow: p.edgeLow == null ? null : p.edgeLow,
      decisionPolicyVersion: p.decisionPolicyVersion || null,
      decisionReason: p.decisionReason || null,
      candidateId: p.candidateId ?? null, candidateProb: p.candidateProb ?? null,
      candidateEvLow: p.candidateEvLow ?? null
    };
  }
  function compactSettlement(s) {
    return {
      predictionId: s.predictionId, fixtureId: s.fixtureId, settledAt: s.settledAt,
      result: s.result || null, bet: s.bet || null,
      decision: s.decision || null, selectedId: s.selectedId ?? null,
      metrics: s.metrics ? { ensemble: s.metrics.ensemble || null, calibrated: s.metrics.calibrated || null } : null
    };
  }
  function compactPerformance(perf) {
    if (!perf) return null;
    const out = JSON.parse(JSON.stringify(perf));
    if (out.bets) out.bets.rows = (out.bets.rows || []).slice(-60);
    if (out.bankroll) out.bankroll.curve = (out.bankroll.curve || []).slice(-120);
    if (out.clv) out.clv.rows = (out.clv.rows || []).slice(0, 40);
    return out;
  }

  async function buildSnapshot(opts = {}) {
    const db = dbOf(opts);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const meta = await db.getAll('meta').catch(() => []);
    const init = meta.find(x => x && x.key === 'init') || null;
    const selsets = {}, up = [];
    meta.forEach(x => {
      if (!x) return;
      if (typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selsets[x.key] = x.value;
      if (typeof x.key === 'string' && x.key.startsWith('up:') && Array.isArray(x.fixtures)) up.push(...x.fixtures);
    });
    const seen = new Set();
    const fixtures = up.filter(f => f && f.fixtureId && !seen.has(f.fixtureId) && (f.close == null || +f.close > now - 60e3))
      .filter(f => { if (seen.has(f.fixtureId)) return false; seen.add(f.fixtureId); return true; })
      .sort((a, b) => (+a.close || 0) - (+b.close || 0));
    const usedSel = {};
    fixtures.forEach(f => { if (f.sk && selsets[f.sk]) usedSel[f.sk] = selsets[f.sk]; });
    let cats = [];
    try { cats = await db.getAll('catalogues'); } catch (e) { }
    cats = (cats || []).slice().sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0));
    const catRec = cats[0];
    const catalogue = catRec && catRec.markets
      ? { markets: catRec.markets, roundSpecialMarkets: catRec.roundSpecialMarkets || [], extraMarkets: catRec.extraMarkets || [], version: catRec.version || null }
      : (init && init.markets ? { markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], version: null } : null);
    const active = opts.active !== undefined ? opts.active : (_LPLearn_Cl ? await _LPLearn_Cl.getActive(db).catch(() => null) : null);
    let predictions = [], settlements = [];
    try { predictions = await _LPLedger_Cl.recentPredictions(opts.ledgerLimit || 300, db); } catch (e) { }
    try { settlements = await _LPLedger_Cl.recentSettlements(opts.ledgerLimit || 300, db); } catch (e) { }
    let performance = null;
    try {
      performance = _LPPerformance_Cl.aggregate({
        predictions, settlements,
        data: { matches: await db.count('matches').catch(() => null), rounds: await db.count('rounds').catch(() => null) }
      });
    } catch (e) { }
    const counts = {
      matches: await db.count('matches').catch(() => null),
      rounds: await db.count('rounds').catch(() => null),
      predictions: await db.count('predictions').catch(() => null),
      settlements: await db.count('settlements').catch(() => null),
      catalogues: cats.length,
      conflicts: await db.count('conflicts').catch(() => null),
      quality: await db.count('qualityLog').catch(() => null)
    };
    const recentLimit = Math.min(opts.recentLimit || 100, predictions.length);
    const recentPred = predictions.slice(0, recentLimit).map(compactPrediction);
    const recentSet = settlements.slice(0, recentLimit).map(compactSettlement);
    return {
      schema: SCHEMA, version: VERSION, source: 'leagueplus-extension', generatedAt: now,
      lastCaptureAt: opts.lastCaptureAt || null,
      catalogue,
      games: (init && init.games) || [],
      fixtures,
      selsets: usedSel,
      active: compactActive(active),
      learning: active ? { version: active.version, training: active.training || null } : null,
      performance: compactPerformance(performance),
      ledger: { recentPredictions: recentPred, recentSettlements: recentSet },
      counts,
      warnings: [
        ...(fixtures.length ? [] : ['No upcoming fixtures in the local database.']),
        ...(catalogue ? [] : ['No market catalogue available.']),
        ...(counts.conflicts ? [counts.conflicts + ' data conflict(s) recorded.'] : [])
      ]
    };
  }

  async function upload(opts = {}) {
    const db = dbOf(opts);
    const cfg = await getConfig(db);
    if (!cfg.endpoint || (!/^https:\/\//i.test(cfg.endpoint) && !/^http:\/\/localhost[:/]/i.test(cfg.endpoint))) throw new Error('Cloud endpoint must be an https URL');
    if (!cfg.token) throw new Error('Cloud write token is missing');
    const snapshot = opts.snapshot || await buildSnapshot(Object.assign({}, opts, { db }));
    const body = JSON.stringify(snapshot);
    if (body.length > MAX_BYTES) throw new Error('Snapshot is too large (' + Math.round(body.length / 1024) + ' KB)');
    let res;
    try {
      res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lp-token': cfg.token },
        body
      });
    } catch (e) {
      const error = 'Network error: ' + e.message;
      await db.put('meta', { key: STATUS_KEY, at: Date.now(), ok: false, error, bytes: body.length, generatedAt: snapshot.generatedAt }).catch(() => { });
      throw new Error(error);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const error = 'Cloud upload failed (HTTP ' + res.status + ')' + (text ? ': ' + text.slice(0, 180) : '');
      await db.put('meta', { key: STATUS_KEY, at: Date.now(), ok: false, error, bytes: body.length, generatedAt: snapshot.generatedAt }).catch(() => { });
      throw new Error(error);
    }
    const status = {
      key: STATUS_KEY, at: Date.now(), ok: true, error: null, bytes: body.length,
      generatedAt: snapshot.generatedAt, fixtures: snapshot.fixtures.length, lastSuccessAt: Date.now()
    };
    await db.put('meta', status).catch(() => { });
    return { ok: true, bytes: body.length, generatedAt: snapshot.generatedAt, fixtures: snapshot.fixtures.length };
  }

  async function maybeUpload(opts = {}) {
    const db = dbOf(opts);
    const cfg = await getConfig(db);
    if (!cfg.enabled) return { skipped: true, reason: 'cloud sync disabled' };
    if (!cfg.endpoint || !cfg.token) return { skipped: true, reason: 'cloud sync is not configured' };
    if (!opts.force) {
      const status = await getStatus(db);
      if (status && status.lastSuccessAt && Date.now() - status.lastSuccessAt < cfg.intervalMin * 60e3) {
        return { skipped: true, reason: 'cloud sync interval has not elapsed' };
      }
    }
    try {
      return await upload(Object.assign({}, opts, { db }));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { VERSION, SCHEMA, DEFAULT_CONFIG, MAX_BYTES, getConfig, setConfig, getStatus, buildSnapshot, upload, maybeUpload, compactActive };
})();
if (typeof module !== 'undefined') module.exports = LPCloud;
