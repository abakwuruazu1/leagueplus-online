#!/usr/bin/env node
// Stage-10 consolidated walk-forward report.
//   node research/final.cjs
//   node research/final.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
//   node research/final.cjs --backup="C:\path\leagueplus-backup.json"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPModelEval = require('../lib/modelEval.js');
const LPCalibration = require('../lib/calibration.js');
const LPWeights = require('../lib/weights.js');
const LPDecision = require('../lib/decision.js');
const LPSpecialists = require('../lib/specialists.js');
const LPPerformance = require('../lib/performance.js');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
}));
const dir = path.resolve(args.dir || path.join(__dirname, 'data'));
const outDir = path.resolve(args.out || path.join(__dirname, 'reports'));
const backupPath = args.backup ? path.resolve(args.backup) : null;

function readJSON(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse(/\.gz$/i.test(file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
}
function initData(x) { return x && x.data && x.data.markets ? x.data : x; }
function loadCollector() {
  const initFile = path.join(dir, 'init.json');
  const init = fs.existsSync(initFile) ? initData(readJSON(initFile)) : null;
  const selsets = {}, map = new Map();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^parsed-.*\.jsonl$/.test(f)).sort() : [];
  for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch (e) { continue; }
    for (const [k, v] of Object.entries((x.results && x.results.selsets) || {})) selsets[k] = v;
    for (const m of (x.results && x.results.matches) || []) { const k = m.fixtureId || m.key; if (k && !map.has(k)) map.set(k, m); }
  }
  return { source: 'collector', init, cat: init ? LPCat.buildMap(init) : {}, selsets, matches: [...map.values()], files: files.length, predictions: [], settlements: [], stores: {} };
}
function loadBackup() {
  const b = readJSON(backupPath);
  const stores = b.stores || { matches: b.matches || [], meta: b.meta || [], catalogues: [] };
  const meta = stores.meta || [], selsets = {};
  meta.forEach(x => { if (x && typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selsets[x.key] = x.value; });
  const initMeta = meta.find(x => x && x.key === 'init');
  const cats = (stores.catalogues || []).slice().sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0));
  const defs = cats.length ? { markets: cats[0].markets } : initMeta;
  return {
    source: 'backup', init: initMeta || null, cat: defs ? LPCat.buildMap(defs) : {}, selsets,
    matches: stores.matches || [], files: 0,
    predictions: stores.predictions || [], settlements: stores.settlements || [],
    stores
  };
}
function f4(x) { return x == null || !Number.isFinite(+x) ? '–' : (+x).toFixed(4); }
function pct(x) { return x == null || !Number.isFinite(+x) ? '–' : (+x * 100).toFixed(2) + '%'; }
function ci(low, high) { return low != null && high != null ? '[' + f4(low) + ', ' + f4(high) + ']' : '–'; }
function md(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function activeSummary(data) {
  const meta = (data.stores && data.stores.meta) || [];
  const ref = meta.find(x => x && x.key === 'learn:active');
  if (!ref || !ref.version) return null;
  const states = (data.stores && data.stores.modelStates) || [];
  const st = states.find(x => x && x.version === ref.version);
  if (!st) return { version: ref.version, missing: true };
  return {
    version: st.version, status: st.status, createdAt: st.createdAt,
    calibration: st.calibration && st.calibration.enabled ? st.calibration.method : null,
    weights: st.weights && st.weights.enabled ? st.weights.weights : null,
    decision: st.decision && st.decision.enabled ? st.decision : null,
    decisionVersion: st.decisionVersion || null,
    training: st.training || null, warnings: st.warnings || []
  };
}

function main() {
  const data = backupPath ? loadBackup() : loadCollector();
  const common = {
    minTrainRounds: args['min-train-rounds'] != null ? +args['min-train-rounds'] : 3,
    minCompMatches: args['min-comp-matches'] != null ? +args['min-comp-matches'] : 10,
    maxTestRounds: args['max-test-rounds'] != null ? +args['max-test-rounds'] : 20,
    permutations: args.permutations != null ? +args.permutations : 199,
    seed: args.seed != null ? +args.seed : 20261124
  };
  const models = LPModelEval.evaluate({
    matches: data.matches, cat: data.cat, selsets: data.selsets,
    options: Object.assign({}, common, { halfLifeH: args['half-life'] != null ? +args['half-life'] : 6, fairMethod: args['fair-method'] || 'proportional' })
  });
  const collected = LPCalibration.collect({
    matches: data.matches, cat: data.cat, selsets: data.selsets,
    options: common
  });
  const calibration = LPCalibration.walkForward(collected.samples, {
    minTrainSamples: args['min-train-samples'] != null ? +args['min-train-samples'] : 200,
    minTestSamples: args['min-test-samples'] != null ? +args['min-test-samples'] : 100,
    folds: 3, bins: 10, permutations: common.permutations, seed: common.seed
  });
  const weights = LPWeights.evaluate(collected.samples, {
    minTrainSamples: args['min-train-samples'] != null ? +args['min-train-samples'] : 200,
    minTestSamples: args['min-test-samples'] != null ? +args['min-test-samples'] : 100,
    folds: 3, shrink: args.shrink != null ? +args.shrink : 0.5,
    permutations: common.permutations, seed: common.seed
  });
  const decision = LPDecision.walkForward(collected.samples, {
    minSamples: args['min-samples'] != null ? +args['min-samples'] : 200,
    minTestSamples: args['min-test-samples'] != null ? +args['min-test-samples'] : 100,
    minBets: args['min-bets'] != null ? +args['min-bets'] : 100,
    minTrainBets: args['min-train-bets'] != null ? +args['min-train-bets'] : 40,
    kellyFraction: args['kelly-fraction'] != null ? +args['kelly-fraction'] : 0.25,
    maxStakeUnits: args['max-stake'] != null ? +args['max-stake'] : 2,
    permutations: common.permutations, seed: common.seed
  });
  let specialists = null;
  try {
    specialists = LPSpecialists.evaluate({
      matches: data.matches, cat: data.cat, selsets: data.selsets,
      options: Object.assign({}, common, {
        minPatternSupport: 30,
        calibrationSamples: calibration.decision.enabled ? collected.samples : undefined,
        calibrationMethod: calibration.decision.method || 'platt'
      })
    });
  } catch (e) { specialists = { meta: { error: e.message }, warnings: ['Specialist evaluation failed: ' + e.message] }; }
  const performance = (data.predictions && data.predictions.length)
    ? LPPerformance.aggregate({
      predictions: data.predictions, settlements: data.settlements,
      startBankroll: args.bankroll != null ? +args.bankroll : 1000,
      unitValue: args.unit != null ? +args.unit : 10,
      data: { matches: data.matches.length, rounds: models.meta.rounds, predictions: data.predictions.length }
    })
    : null;
  const active = activeSummary(data);
  const warnings = [...new Set([
    ...(models.warnings || []), ...(collected.warnings || []), ...(calibration.warnings || []),
    ...(weights.warnings || []), ...(decision.warnings || []), ...(specialists && specialists.warnings || []),
    ...(performance && performance.warnings || [])
  ])];
  const report = {
    meta: {
      version: 'stage10-final-v1', generatedAt: Date.now(), source: data.source, files: data.files,
      matches: data.matches.length, rounds: models.meta.rounds, testMatches: models.meta.testMatches,
      samples: collected.samples.length, settings: common, warnings
    },
    models, calibration, weights, decision,
    specialists: specialists ? {
      meta: specialists.meta, byModel: specialists.byModel, comparisons: specialists.comparisons,
      sequence: specialists.sequence, patterns: { enabled: specialists.patterns && specialists.patterns.enabled, discovered: specialists.patterns && specialists.patterns.discovered, validated: specialists.patterns && specialists.patterns.validated, comparison: specialists.patterns && specialists.patterns.comparison }
    } : null,
    performance, active
  };
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'final-' + day);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));

  const L = [];
  L.push('# League Plus Final Walk-Forward Report');
  L.push('');
  L.push('- Generated: ' + new Date(report.meta.generatedAt).toISOString());
  L.push('- Engine: ' + report.meta.version);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + data.matches.length + ' · rounds: ' + models.meta.rounds + ' · test fixtures: ' + models.meta.testMatches);
  L.push('- Walk-forward selections: ' + collected.samples.length);
  L.push('- Settings: min train rounds ' + common.minTrainRounds + ' · min competition matches ' + common.minCompMatches + ' · permutations ' + common.permutations);
  L.push('');
  if (warnings.length) { L.push('## Warnings'); for (const w of warnings) L.push('- ' + md(w)); L.push(''); }
  L.push('## Final verdict');
  L.push('');
  const activeBits = [];
  if (active && active.calibration) activeBits.push('calibration ' + active.calibration);
  if (active && active.weights) activeBits.push('adaptive weights');
  if (active && active.decision) activeBits.push('decision policy');
  L.push('- Active learned state: ' + (active ? active.version + (activeBits.length ? ' (' + activeBits.join(', ') + ')' : '') : 'none'));
  L.push('- Decision policy gate: ' + (decision.decision.enabled ? '**enabled**' : 'disabled'));
  L.push('- Ledger decision: ' + (decision.decision.enabled ? 'BET where the policy passes' : '**NO BET** — no validated policy'));
  L.push('- Live bets are never placed by this report.');
  L.push('');
  L.push('## Model leaderboard');
  L.push('');
  L.push('| Model | Selections | Brier | Log loss |');
  L.push('|---|---:|---:|---:|');
  for (const row of models.leaderboard) L.push('| ' + md(models.meta.labels[row.model] || row.model) + ' | ' + row.n + ' | ' + f4(row.brier) + ' | ' + f4(row.logLoss) + ' |');
  if (!models.leaderboard.length) L.push('| – | – | – | – |');
  L.push('');
  L.push('## Gates');
  L.push('');
  L.push('| Component | Status | n | Difference | 95% interval | p | q |');
  L.push('|---|---|---:|---:|---|---:|---:|');
  L.push('| Calibration | ' + (calibration.decision.enabled ? '**enabled**' : 'disabled') + ' | ' + (calibration.decision.n || 0) + ' | ' + f4(calibration.decision.diffLogLoss) + ' | ' + ci(calibration.decision.low, calibration.decision.high) + ' | ' + f4(calibration.decision.p) + ' | ' + f4(calibration.decision.q) + ' |');
  L.push('| Adaptive weights | ' + (weights.decision.enabled ? '**enabled**' : 'disabled') + ' | ' + (weights.decision.n || 0) + ' | ' + f4(weights.decision.diffLogLoss) + ' | ' + ci(weights.decision.low, weights.decision.high) + ' | ' + f4(weights.decision.p) + ' | ' + f4(weights.decision.q) + ' |');
  L.push('| Decision policy | ' + (decision.decision.enabled ? '**enabled**' : 'disabled') + ' | ' + (decision.decision.test && decision.decision.test.bets || 0) + ' bets | ' + f4(decision.decision.test && decision.decision.test.roi) + ' | ' + ci(decision.decision.ciLow, decision.decision.ciHigh) + ' | ' + f4(decision.decision.p) + ' | – |');
  if (specialists) {
    L.push('| Sequence specialist | ' + (specialists.sequence.enabled ? '**enabled**' : 'disabled') + ' | ' + (specialists.sequence.comparison && specialists.sequence.comparison.n || 0) + ' | ' + f4(specialists.sequence.comparison && specialists.sequence.comparison.diffLogLoss) + ' | ' + ci(specialists.sequence.comparison && specialists.sequence.comparison.low, specialists.sequence.comparison && specialists.sequence.comparison.high) + ' | ' + f4(specialists.sequence.comparison && specialists.sequence.comparison.p) + ' | ' + f4(specialists.sequence.comparison && specialists.sequence.comparison.q) + ' |');
    L.push('| Pattern specialist | ' + (specialists.patterns.enabled ? '**enabled**' : 'disabled') + ' | ' + (specialists.patterns.comparison && specialists.patterns.comparison.n || 0) + ' | ' + f4(specialists.patterns.comparison && specialists.patterns.comparison.diffLogLoss) + ' | ' + ci(specialists.patterns.comparison && specialists.patterns.comparison.low, specialists.patterns.comparison && specialists.patterns.comparison.high) + ' | ' + f4(specialists.patterns.comparison && specialists.patterns.comparison.p) + ' | ' + f4(specialists.patterns.comparison && specialists.patterns.comparison.q) + ' |');
  }
  L.push('');
  L.push('A negative difference is an improvement. Activation requires the component-specific p/q and sample gates; see the component reports for detail.');
  L.push('');
  if (performance) {
    L.push('## Ledger performance');
    L.push('');
    L.push('- Predictions: ' + performance.counts.predictions + ' · settled: ' + performance.counts.settlements + ' · pending: ' + performance.counts.pending + ' · NO BET: ' + performance.counts.noBets + ' · BET: ' + performance.counts.bets);
    L.push('- Settlement coverage: ' + pct(performance.settlementCoverage));
    L.push('- Bets won: ' + performance.bets.wins + ' / ' + performance.bets.n + ' (' + pct(performance.bets.winRate) + ')');
    L.push('- Staked: ' + f4(performance.bets.staked) + 'u · profit: ' + f4(performance.bets.profit) + 'u · ROI: ' + pct(performance.bets.roi) + ' · flat ROI: ' + pct(performance.bets.flatRoi));
    L.push('- Bankroll: ' + f4(performance.bankroll.start) + ' → ' + f4(performance.bankroll.end) + ' (' + pct(performance.bankroll.changePct) + ') · max drawdown ' + f4(performance.bankroll.maxDrawdown) + 'u (' + pct(performance.bankroll.maxDrawdownPct) + ')');
    L.push('- Average stake: ' + f4(performance.bets.avgStake) + 'u · max stake: ' + f4(performance.bets.maxStake) + 'u');
    L.push('');
    L.push('| Market | Bets | Won | Stake | Profit | ROI |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const [k, x] of Object.entries(performance.bets.byMarket || {})) L.push('| ' + md(k) + ' | ' + x.bets + ' | ' + x.wins + ' | ' + f4(x.stake) + ' | ' + f4(x.profit) + ' | ' + pct(x.roi) + ' |');
    if (!Object.keys(performance.bets.byMarket || {}).length) L.push('| – | – | – | – | – | – |');
    L.push('');
    L.push('## Closing-line value');
    L.push('');
    L.push('- Matched selections: ' + performance.clv.n + ' · positive price movement: ' + pct(performance.clv.positiveShare));
    L.push('- Average price CLV: ' + pct(performance.clv.avgPriceClv));
    L.push('- BET-only average price CLV: ' + pct(performance.clv.betAvgPriceClv));
    L.push('- Odds were static in the live probe, so a zero CLV is expected and not a failure.');
    L.push('');
    L.push('## Ledger model leaderboard');
    L.push('');
    L.push('| Model | Selections | Brier | Log loss |');
    L.push('|---|---:|---:|---:|');
    for (const row of performance.modelLeaderboard || []) L.push('| ' + md(row.model) + ' | ' + row.n + ' | ' + f4(row.brier) + ' | ' + f4(row.logLoss) + ' |');
    if (!(performance.modelLeaderboard || []).length) L.push('| – | – | – | – |');
    L.push('');
  } else {
    L.push('## Ledger performance');
    L.push('');
    L.push('No ledger predictions were included. Use `--backup=` with an extension backup to include bankroll, ROI, exposure, drawdown and CLV.');
    L.push('');
  }
  L.push('## Interpretation limits');
  L.push('');
  L.push('- This is a small observational sample. Model differences, calibration and policy decisions are provisional.');
  L.push('- The decision policy gate is evaluated on equal-ensemble selection samples; if calibration or adaptive weights activate, the policy should be re-evaluated under those transforms.');
  L.push('- Bets are simulated at recorded prices with no stake limits, line movement, account restrictions or settlement delays.');
  L.push('- ROI and bankroll figures are descriptive, not a forecast or guarantee.');
  L.push('- The market margin dominates most small edges; the engine is allowed to conclude NO BET.');
  fs.writeFileSync(base + '.md', L.join('\n'));
  console.log('Wrote ' + base + '.json and .md');
  console.log('Models ' + models.leaderboard.length + '; calibration ' + (calibration.decision.enabled ? 'enabled' : 'disabled') + '; weights ' + (weights.decision.enabled ? 'enabled' : 'disabled') + '; decision ' + (decision.decision.enabled ? 'enabled' : 'disabled') + '; specialists ' + (specialists && (specialists.sequence.enabled || specialists.patterns.enabled) ? 'enabled' : 'disabled'));
  if (performance) console.log('Ledger bets ' + performance.counts.bets + '; ROI ' + pct(performance.bets.roi) + '; CLV ' + pct(performance.clv.avgPriceClv));
  if (warnings.length) console.log('Warnings: ' + warnings.join(' | '));
}

main();
