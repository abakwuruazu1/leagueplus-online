#!/usr/bin/env node
// Stage-7 calibration and adaptive-weight report.
//   node research/calibration.cjs
//   node research/calibration.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
//   node research/calibration.cjs --backup="C:\path\leagueplus-backup.json"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPCalibration = require('../lib/calibration.js');
const LPWeights = require('../lib/weights.js');

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
  return { source: 'collector', init, cat: init ? LPCat.buildMap(init) : {}, selsets, matches: [...map.values()], files: files.length };
}
function loadBackup() {
  const b = readJSON(backupPath);
  const stores = b.stores || { matches: b.matches || [], meta: b.meta || [], catalogues: [] };
  const meta = stores.meta || [], selsets = {};
  meta.forEach(x => { if (x && typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selsets[x.key] = x.value; });
  const initMeta = meta.find(x => x && x.key === 'init');
  const cats = (stores.catalogues || []).slice().sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0));
  const defs = cats.length ? { markets: cats[0].markets } : initMeta;
  return { source: 'backup', init: initMeta || null, cat: defs ? LPCat.buildMap(defs) : {}, selsets, matches: stores.matches || [], files: 0 };
}
function f4(x) { return x == null || !Number.isFinite(x) ? '–' : (+x).toFixed(4); }
function pct(x) { return x == null || !Number.isFinite(x) ? '–' : (x * 100).toFixed(1) + '%'; }
function ci(c) { return c && c[0] != null && c[1] != null ? '[' + f4(c[0]) + ', ' + f4(c[1]) + ']' : '–'; }
function md(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function main() {
  const data = backupPath ? loadBackup() : loadCollector();
  const collected = LPCalibration.collect({
    matches: data.matches, cat: data.cat, selsets: data.selsets,
    options: {
      minTrainRounds: args['min-train-rounds'] != null ? +args['min-train-rounds'] : 5,
      minCompMatches: args['min-comp-matches'] != null ? +args['min-comp-matches'] : 20,
      maxTestRounds: args['max-test-rounds'] != null ? +args['max-test-rounds'] : 200,
      halfLifeH: args['half-life'] != null ? +args['half-life'] : 6,
      fairMethod: args['fair-method'] || 'proportional',
      permutations: args.permutations != null ? +args.permutations : 299,
      seed: args.seed != null ? +args.seed : 20261124
    }
  });
  const calOpts = {
    minTrainSamples: args['min-train-samples'] != null ? +args['min-train-samples'] : 200,
    minTestSamples: args['min-test-samples'] != null ? +args['min-test-samples'] : 100,
    folds: args.folds != null ? +args.folds : 3,
    bins: args.bins != null ? +args.bins : 10,
    permutations: args.permutations != null ? +args.permutations : 299,
    seed: args.seed != null ? +args.seed : 20261124
  };
  const calibration = LPCalibration.walkForward(collected.samples, calOpts);
  const weights = LPWeights.evaluate(collected.samples, Object.assign({}, calOpts, {
    shrink: args.shrink != null ? +args.shrink : 0.5
  }));

  const report = {
    meta: {
      version: LPCalibration.VERSION, generatedAt: Date.now(),
      source: data.source, files: data.files,
      samples: collected.samples.length,
      evaluation: collected.meta,
      calibration: calibration.meta,
      weights: weights.meta
    },
    calibration: {
      metrics: calibration.metrics, decision: calibration.decision,
      reliability: calibration.reliability, warnings: calibration.warnings
    },
    weights,
    checks: collected.checks,
    warnings: [...new Set([...(collected.warnings || []), ...(calibration.warnings || []), ...(weights.warnings || [])])]
  };
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'calibration-' + day);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));

  const L = [];
  L.push('# League Plus Calibration & Adaptive Weights');
  L.push('');
  L.push('- Generated: ' + new Date(report.meta.generatedAt).toISOString());
  L.push('- Engine: ' + LPCalibration.VERSION + ' / ' + LPWeights.VERSION);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + collected.meta.matches + ' · rounds: ' + collected.meta.rounds + ' · test fixtures: ' + collected.meta.testMatches);
  L.push('- Walk-forward selections: ' + collected.samples.length + ' · calibration test selections: ' + (calibration.meta.test || 0));
  L.push('- Minimum training rounds: ' + collected.meta.minTrainRounds + ' · minimum competition matches: ' + collected.meta.minCompMatches + ' · permutations: ' + collected.meta.permutations + ' · seed: ' + collected.meta.seed);
  L.push('');
  if (report.warnings.length) { L.push('## Warnings'); for (const w of report.warnings) L.push('- ' + md(w)); L.push(''); }
  L.push('## Decisions');
  L.push('');
  L.push('| Component | Status | Method | n | Difference vs raw/equal | 95% interval | p | q |');
  L.push('|---|---|---|---:|---:|---|---:|---:|');
  L.push('| Calibration | ' + (calibration.decision.enabled ? '**enabled**' : 'disabled') + ' | ' + md(calibration.decision.method || '–') + ' | ' + (calibration.decision.n || 0) + ' | ' + f4(calibration.decision.diffLogLoss) + ' | ' + ci([calibration.decision.low, calibration.decision.high]) + ' | ' + f4(calibration.decision.p) + ' | ' + f4(calibration.decision.q) + ' |');
  L.push('| Adaptive weights | ' + (weights.decision.enabled ? '**enabled**' : 'disabled') + ' | ' + (weights.decision.weights ? 'shrunk global' : 'not fitted (insufficient components)') + ' | ' + (weights.decision.n || 0) + ' | ' + f4(weights.decision.diffLogLoss) + ' | ' + ci([weights.decision.low, weights.decision.high]) + ' | ' + f4(weights.decision.p) + ' | ' + f4(weights.decision.q) + ' |');
  L.push('');
  L.push('A disabled component is not applied. Negative differences mean the component improved log loss; activation also requires p < 0.05, q < 0.10 and enough test selections.');
  L.push('');
  L.push('## Calibration metrics');
  L.push('');
  L.push('| Series | n | Brier | Log loss | Uncertainty | Reliability | Resolution | ECE | MCE |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  const relRow = (label, r) => r && r.decomposition ? '| ' + md(label) + ' | ' + r.n + ' | ' + f4(r.brier) + ' | ' + f4(r.logLoss) + ' | ' + f4(r.decomposition.uncertainty) + ' | ' + f4(r.decomposition.reliability) + ' | ' + f4(r.decomposition.resolution) + ' | ' + f4(r.ece) + ' | ' + f4(r.mce) + ' |' : null;
  const rr = relRow('raw', calibration.reliability.raw); if (rr) L.push(rr);
  const cr = relRow('calibrated', calibration.reliability.calibrated); if (cr) L.push(cr);
  const methods = (calibration.metrics && calibration.metrics.methods) || {};
  if (Object.keys(methods).length) {
    L.push('');
    L.push('| Method | n | Brier | Log loss | Difference | 95% interval | p | q |');
    L.push('|---|---:|---:|---:|---:|---|---:|---:|');
    for (const [m, x] of Object.entries(methods)) L.push('| ' + md(m) + ' | ' + x.n + ' | ' + f4(x.brier) + ' | ' + f4(x.logLoss) + ' | ' + f4(x.diffLogLoss) + ' | ' + ci([x.low, x.high]) + ' | ' + f4(x.p) + ' | ' + f4(x.q) + ' |');
  }
  const raw = calibration.reliability && calibration.reliability.raw;
  const calRel = calibration.reliability && calibration.reliability.calibrated;
  if (raw && raw.bins) {
    L.push('');
    L.push('## Reliability');
    L.push('');
    L.push('| Bin | Raw n | Raw predicted | Raw observed | Cal n | Cal predicted | Cal observed |');
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    raw.bins.forEach((b, i) => {
      const c = calRel && calRel.bins ? calRel.bins[i] : null;
      L.push('| ' + (b.lo * 100).toFixed(0) + '–' + (b.hi * 100).toFixed(0) + '% | ' + b.n + ' | ' + pct(b.avgP) + ' | ' + pct(b.obs) + ' | ' + (c ? c.n : '–') + ' | ' + (c ? pct(c.avgP) : '–') + ' | ' + (c ? pct(c.obs) : '–') + ' |');
    });
  }
  L.push('');
  L.push('## Adaptive weights');
  L.push('');
  if (weights.decision.weights) {
    L.push('| Model | Active weight | Unshrunk fit |');
    L.push('|---|---:|---:|');
    for (const m of LPWeights.MODELS) L.push('| ' + md(LPWeights.LABELS[m] || m) + ' | ' + pct(weights.decision.weights[m]) + ' | ' + pct(weights.decision.rawWeights && weights.decision.rawWeights[m]) + ' |');
  } else L.push('No adaptive weight vector was activated.');
  L.push('');
  L.push('| Series | n | Brier | Log loss |');
  L.push('|---|---:|---:|---:|');
  const wm = weights.metrics || {};
  for (const k of ['equal', 'market', 'global', 'perMarket']) if (wm[k]) L.push('| ' + md(k) + ' | ' + wm[k].n + ' | ' + f4(wm[k].brier) + ' | ' + f4(wm[k].logLoss) + ' |');
  if (wm.single) for (const [k, x] of Object.entries(wm.single)) L.push('| ' + md(LPWeights.LABELS[k] || k) + ' (single) | ' + x.n + ' | ' + f4(x.brier) + ' | ' + f4(x.logLoss) + ' |');
  L.push('');
  L.push('| Weighting | n | Difference vs equal | 95% interval | p | q |');
  L.push('|---|---:|---:|---|---:|---:|');
  for (const c of (weights.comparisons || [])) L.push('| ' + md(c.model) + ' | ' + c.n + ' | ' + f4(c.diffLogLoss) + ' | ' + ci([c.low, c.high]) + ' | ' + f4(c.p) + ' | ' + f4(c.q) + ' |');
  if (!(weights.comparisons || []).length) L.push('| – | – | – | – | – | – |');
  L.push('');
  L.push('| Market | n | Difference | 95% interval | p | q | Status |');
  L.push('|---|---:|---:|---|---:|---:|---|');
  for (const x of (weights.perMarket || [])) L.push('| ' + md(x.market) + ' | ' + x.n + ' | ' + f4(x.diffLogLoss) + ' | ' + ci([x.low, x.high]) + ' | ' + f4(x.p) + ' | ' + f4(x.q) + ' | ' + (x.enabled ? 'enabled' : 'disabled') + ' |');
  if (!(weights.perMarket || []).length) L.push('| – | – | – | – | – | – | – |');
  L.push('');
  L.push('## Leakage checks');
  L.push('');
  L.push('- Training windows checked: ' + collected.checks.length);
  L.push('- Failures: ' + collected.checks.filter(c => c.leakage).length);
  L.push('');
  L.push('## Interpretation limits');
  L.push('');
  L.push('- The calibration and weight samples are selections, not independent matches. Selections from the same fixture are correlated, so the bootstrap intervals are optimistic.');
  L.push('- Activation is deliberately conservative: no component is applied unless it improves out-of-sample loss after paired correction and sample gates.');
  L.push('- A calibration map corrects the average probability scale; it does not create an edge over the bookmaker.');
  L.push('- Calibration targets the equal ensemble. It is not jointly re-fitted on the adaptive-weight output; the series are reported separately.');
  L.push('- The Wilson interval in the ledger is an approximate effective-sample interval, not a formal guarantee.');
  L.push('- The final value thresholds, staking and accumulator optimisation are Stage 9.');
  fs.writeFileSync(base + '.md', L.join('\n'));
  console.log('Wrote ' + base + '.json and .md');
  console.log('Samples ' + collected.samples.length + '; calibration ' + (calibration.decision.enabled ? 'enabled (' + calibration.decision.method + ')' : 'disabled') + '; adaptive weights ' + (weights.decision.enabled ? 'enabled' : 'disabled'));
  if (report.warnings.length) console.log('Warnings: ' + report.warnings.join(' | '));
}

main();
