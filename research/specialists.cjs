#!/usr/bin/env node
// Stage-6 specialist evaluation report: sequence and pattern models versus the
// Stage 5 ensemble, with automatic enable/disable decisions.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPSpecialists = require('../lib/specialists.js');

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
function ci(c) { return c && c[0] != null && c[1] != null ? '[' + f4(c[0]) + ', ' + f4(c[1]) + ']' : '–'; }
function md(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function main() {
  const data = backupPath ? loadBackup() : loadCollector();
  const r = LPSpecialists.evaluate({
    matches: data.matches, cat: data.cat, selsets: data.selsets,
    options: {
      minTrainRounds: args['min-train-rounds'] != null ? +args['min-train-rounds'] : 5,
      minCompMatches: args['min-comp-matches'] != null ? +args['min-comp-matches'] : 10,
      minPatternSupport: args['min-pattern-support'] != null ? +args['min-pattern-support'] : 20,
      maxTestRounds: args['max-test-rounds'] != null ? +args['max-test-rounds'] : 20,
      permutations: args.permutations != null ? +args.permutations : 199,
      seed: args.seed != null ? +args.seed : 20261124
    }
  });
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'specialists-' + day);
  fs.writeFileSync(base + '.json', JSON.stringify(r, null, 2));
  const L = [];
  L.push('# League Plus Specialist Evaluation');
  L.push('');
  L.push('- Generated: ' + new Date(r.meta.generatedAt).toISOString());
  L.push('- Engine: ' + r.meta.version);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + r.meta.matches + ' · rounds: ' + r.meta.rounds + ' · test matches: ' + r.meta.testMatches);
  L.push('- Minimum training rounds: ' + r.meta.minTrainRounds + ' · min competition matches: ' + r.meta.minCompMatches + ' · min pattern support: ' + r.meta.minPatternSupport);
  L.push('');
  if (r.warnings.length) { L.push('## Warnings'); for (const w of r.warnings) L.push('- ' + md(w)); L.push(''); }
  L.push('## Decisions');
  L.push('');
  L.push('| Specialist | Enabled | Reason | n | Log-loss difference vs Stage 5 | 95% interval | p | q |');
  L.push('|---|---|---|---:|---:|---|---:|---:|');
  const sr = r.sequence.comparison;
  L.push('| Sequence | ' + (r.sequence.enabled ? '**enabled**' : 'disabled') + ' | ' + (r.sequence.enabled ? 'beat Stage 5 out-of-sample' : 'no validated incremental gain') + ' | ' + (sr ? sr.n : 0) + ' | ' + (sr ? f4(sr.diffLogLoss) : '–') + ' | ' + (sr ? ci([sr.low, sr.high]) : '–') + ' | ' + (sr ? f4(sr.p) : '–') + ' | ' + (sr ? f4(sr.q) : '–') + ' |');
  const pr = r.patterns.comparison;
  L.push('| Patterns | ' + (r.patterns.enabled ? '**enabled**' : 'disabled') + ' | ' + (r.patterns.validated ? (r.patterns.validated + ' validated rule(s)') : 'no validated rules') + ' | ' + (pr ? pr.n : 0) + ' | ' + (pr ? f4(pr.diffLogLoss) : '–') + ' | ' + (pr ? ci([pr.low, pr.high]) : '–') + ' | ' + (pr ? f4(pr.p) : '–') + ' | ' + (pr ? f4(pr.q) : '–') + ' |');
  L.push('');
  L.push('A disabled specialist is not part of the ensemble, ledger or decision path. Discovery is not activation.');
  L.push('');
  L.push('## Model metrics');
  L.push('');
  L.push('| Model | Selections | Brier | Log loss |');
  L.push('|---|---:|---:|---:|');
  for (const [model, c] of Object.entries(r.byModel)) {
    if (model === 'byMarket' || !c || !c.n) continue;
    L.push('| ' + md(model) + ' | ' + c.n + ' | ' + f4(c.brier) + ' | ' + f4(c.logLoss) + ' |');
  }
  L.push('');
  L.push('## Pattern rules');
  L.push('');
  L.push('- Discovered rules: ' + r.patterns.discovered);
  L.push('- Validated rules: ' + r.patterns.validated);
  if (r.patterns.top.length) {
    L.push('');
    L.push('| Rule | n | Baseline | Observed | Difference | 95% CI | p | q | OOS same direction | Status |');
    L.push('|---|---:|---:|---:|---:|---|---:|---:|---|---|');
    for (const p of r.patterns.top) L.push('| ' + md(p.description) + ' | ' + p.n + ' | ' + f4(p.baseline) + ' | ' + f4(p.observed) + ' | ' + f4(p.diff) + ' | ' + ci(p.ci) + ' | ' + f4(p.p) + ' | ' + f4(p.q) + ' | ' + (p.oos.sameDirection == null ? '–' : p.oos.sameDirection ? 'yes' : 'no') + ' | ' + p.status + ' |');
  } else L.push('No rule met the support threshold.');
  L.push('');
  L.push('## Leakage checks');
  L.push('');
  L.push('- Checks: ' + r.checks.length);
  L.push('- Failures: ' + r.checks.filter(c => c.leakage).length);
  L.push('');
  L.push('## Interpretation limits');
  L.push('');
  L.push('- Specialists are disabled unless they improve paired out-of-sample loss after multiple-testing correction.');
  L.push('- The pattern seed is discovered once on the initial training window; its own temporal split is used for rule validation.');
  L.push('- This is not a betting strategy. The market margin, calibration and final decision thresholds are separate later stages.');
  L.push('- A small sample makes the enable/disable decision provisional.');
  fs.writeFileSync(base + '.md', L.join('\n'));
  console.log('Wrote ' + base + '.json and .md');
  console.log('Test matches ' + r.meta.testMatches + '; sequence ' + (r.sequence.enabled ? 'enabled' : 'disabled') + '; patterns ' + (r.patterns.enabled ? 'enabled' : 'disabled') + ' (' + r.patterns.validated + ' validated / ' + r.patterns.discovered + ' discovered)');
  if (r.warnings.length) console.log('Warnings: ' + r.warnings.join(' | '));
}

main();
