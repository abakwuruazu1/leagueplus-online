#!/usr/bin/env node
// Stage-9 uncertainty-aware decision and staking report.
//   node research/decision.cjs
//   node research/decision.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
//   node research/decision.cjs --backup="C:\path\leagueplus-backup.json"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPCalibration = require('../lib/calibration.js');
const LPDecision = require('../lib/decision.js');

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
function pct(x) { return x == null || !Number.isFinite(x) ? '–' : (x * 100).toFixed(2) + '%'; }
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
  const result = LPDecision.walkForward(collected.samples, {
    minSamples: args['min-samples'] != null ? +args['min-samples'] : 500,
    minTestSamples: args['min-test-samples'] != null ? +args['min-test-samples'] : 100,
    minBets: args['min-bets'] != null ? +args['min-bets'] : 100,
    minTrainBets: args['min-train-bets'] != null ? +args['min-train-bets'] : 40,
    kellyFraction: args['kelly-fraction'] != null ? +args['kelly-fraction'] : 0.25,
    maxStakeUnits: args['max-stake'] != null ? +args['max-stake'] : 2,
    permutations: args.permutations != null ? +args.permutations : 299,
    seed: args.seed != null ? +args.seed : 20261124
  });
  const report = {
    meta: {
      version: LPDecision.VERSION, generatedAt: Date.now(), source: data.source, files: data.files,
      samples: collected.samples.length, evaluation: collected.meta,
      decision: result.decision, warnings: [...new Set([...(collected.warnings || []), ...(result.warnings || [])])]
    },
    result
  };
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'decision-' + day);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));

  const d = result.decision || {};
  const L = [];
  L.push('# League Plus Decision & Staking');
  L.push('');
  L.push('- Generated: ' + new Date(report.meta.generatedAt).toISOString());
  L.push('- Engine: ' + LPDecision.VERSION);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + collected.meta.matches + ' · rounds: ' + collected.meta.rounds + ' · test fixtures: ' + collected.meta.testMatches);
  L.push('- Walk-forward selections: ' + collected.samples.length);
  L.push('');
  if (report.meta.warnings.length) { L.push('## Warnings'); for (const w of report.meta.warnings) L.push('- ' + md(w)); L.push(''); }
  L.push('## Decision');
  L.push('');
  L.push('| Field | Value |');
  L.push('|---|---|');
  L.push('| Status | ' + (d.enabled ? '**enabled**' : 'disabled') + ' |');
  L.push('| Threshold | ' + (!d.enabled || d.threshold == null ? '–' : pct(d.threshold)) + ' |');
  L.push('| Train selections | ' + (d.nTrain || 0) + ' |');
  L.push('| Holdout selections | ' + (d.nTest || 0) + ' |');
  L.push('| Holdout bets | ' + (d.test && d.test.bets || 0) + ' |');
  L.push('| Holdout wins | ' + (d.test && d.test.wins || 0) + ' |');
  L.push('| Holdout flat ROI | ' + f4(d.test && d.test.roi) + ' |');
  L.push('| Holdout staked ROI | ' + f4(d.test && d.test.roiStaked) + ' |');
  L.push('| Holdout ROI interval | ' + ci([d.ciLow, d.ciHigh]) + ' |');
  L.push('| Bootstrap p | ' + f4(d.p) + ' |');
  L.push('| Max drawdown (units) | ' + f4(d.test && d.test.maxDrawdown) + ' |');
  L.push('');
  L.push('A policy is enabled only when the chronological holdout has enough bets, positive flat ROI and a positive lower confidence bound. Otherwise every selection remains NO BET.');
  L.push('');
  if (d.policy && d.enabled) {
    L.push('## Policy');
    L.push('');
    L.push('| Market | Minimum lower-bound edge |');
    L.push('|---|---:|');
    for (const m of LPDecision.MARKETS) L.push('| ' + m + ' | ' + pct(d.policy.minEdge && d.policy.minEdge[m]) + ' |');
    L.push('');
    L.push('- Kelly fraction: ' + pct(d.policy.kellyFraction));
    L.push('- Maximum stake: ' + f4(d.policy.maxStakeUnits) + ' units');
    L.push('- Uncertainty multipliers: narrow ' + pct(d.policy.uncertaintyMultiplier.narrow) + ', moderate ' + pct(d.policy.uncertaintyMultiplier.moderate) + ', wide ' + pct(d.policy.uncertaintyMultiplier.wide));
    L.push('');
  } else {
    L.push('## Policy');
    L.push('');
    L.push('No decision policy is active. The table above shows the evaluated variants; none passed the chronological holdout gate.');
    L.push('');
  }
  L.push('## Policy variants');
  L.push('');
  L.push('| Threshold | Train bets | Train ROI | Test bets | Test ROI | 95% ROI interval | p |');
  L.push('|---:|---:|---:|---:|---:|---|---:|');
  for (const v of result.variants || []) L.push('| ' + pct(v.threshold) + ' | ' + v.train.bets + ' | ' + f4(v.train.roi) + ' | ' + v.test.bets + ' | ' + f4(v.test.roi) + ' | ' + ci([v.ciLow, v.ciHigh]) + ' | ' + f4(v.p) + ' |');
  if (!(result.variants || []).length) L.push('| – | – | – | – | – | – | – |');
  L.push('');
  L.push('## Interpretation limits');
  L.push('');
  L.push('- The decision sample is selection-level and includes multiple selections per fixture; the simulation picks at most one per fixture.');
  L.push('- The holdout is chronological, but threshold selection over a small set of variants is still a source of selection bias.');
  L.push('- Bets are simulated at the recorded Bet9ja price with no stake limits, account restrictions or line movement.');
  L.push('- The accumulator correlation penalty is a heuristic, not a joint score model.');
  L.push('- This is not a guarantee of profit. The market margin and uncertainty usually dominate small edges.');
  L.push('- No live bet is placed.');
  fs.writeFileSync(base + '.md', L.join('\n'));
  console.log('Wrote ' + base + '.json and .md');
  console.log('Decision ' + (d.enabled ? 'enabled at ' + pct(d.threshold) : 'disabled') + '; holdout bets ' + (d.test && d.test.bets || 0) + '; flat ROI ' + f4(d.test && d.test.roi));
  if (report.meta.warnings.length) console.log('Warnings: ' + report.meta.warnings.join(' | '));
}

main();
