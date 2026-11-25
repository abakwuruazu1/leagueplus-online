#!/usr/bin/env node
// Stage-5 chronological model evaluation report.
//   node research/models.cjs
//   node research/models.cjs --min-train-rounds=5 --max-test-rounds=20
//   node research/models.cjs --backup="C:\path\leagueplus-backup.json.gz"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPModelEval = require('../lib/modelEval.js');

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
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let x; try { x = JSON.parse(line); } catch (e) { continue; }
      for (const [k, v] of Object.entries((x.results && x.results.selsets) || {})) selsets[k] = v;
      for (const m of (x.results && x.results.matches) || []) { const k = m.fixtureId || m.key; if (k && !map.has(k)) map.set(k, m); }
    }
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
  const report = LPModelEval.evaluate({
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
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'models-' + day);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));
  const L = [];
  L.push('# League Plus Model Evaluation');
  L.push('');
  L.push('- Generated: ' + new Date(report.meta.generatedAt).toISOString());
  L.push('- Engine: ' + report.meta.version);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + report.meta.matches + ' · rounds: ' + report.meta.rounds + ' · test rounds: ' + report.meta.testRounds + ' · test matches: ' + report.meta.testMatches);
  L.push('- Minimum training rounds: ' + report.meta.minTrainRounds + ' · minimum competition matches: ' + report.meta.minCompMatches + ' · permutations: ' + report.meta.permutations + ' · seed: ' + report.meta.seed);
  L.push('');
  if (report.warnings.length) { L.push('## Warnings'); for (const w of report.warnings) L.push('- ' + md(w)); L.push(''); }
  L.push('## Leaderboard');
  L.push('');
  L.push('Overall metrics aggregate every settled 1X2, O/U 2.5 and BTTS selection. Lower is better. The market is the reference, not an edge claim.');
  L.push('');
  L.push('| Model | Selections | Brier | Log loss |');
  L.push('|---|---:|---:|---:|');
  for (const row of report.leaderboard) L.push('| ' + md(report.meta.labels[row.model] || row.model) + ' | ' + row.n + ' | ' + f4(row.brier) + ' | ' + f4(row.logLoss) + ' |');
  L.push('');
  L.push('## By market');
  for (const [market, models] of Object.entries(report.byMarket)) {
    L.push('');
    L.push('### ' + market);
    L.push('| Model | n | Brier | Log loss |');
    L.push('|---|---:|---:|---:|');
    for (const [model, c] of Object.entries(models)) if (c.n) L.push('| ' + md(report.meta.labels[model] || model) + ' | ' + c.n + ' | ' + f4(c.brier) + ' | ' + f4(c.logLoss) + ' |');
  }
  L.push('');
  L.push('## Paired 1X2 comparison against market');
  L.push('');
  L.push('| Model | n | Log-loss difference | 95% interval | p | q (BH) | Improves? |');
  L.push('|---|---:|---:|---|---:|---:|---|');
  for (const c of report.comparisons) L.push('| ' + md(report.meta.labels[c.model] || c.model) + ' | ' + c.n + ' | ' + f4(c.diffLogLoss) + ' | ' + ci([c.low, c.high]) + ' | ' + f4(c.p) + ' | ' + f4(c.q) + ' | ' + (c.improves ? 'yes' : 'no') + ' |');
  if (!report.comparisons.length) L.push('| – | – | – | – | – | – | – |');
  L.push('');
  L.push('## Leakage checks');
  L.push('');
  L.push('- Training windows checked: ' + report.checks.length);
  L.push('- Failures: ' + report.checks.filter(c => c.leakage).length);
  L.push('');
  L.push('## Interpretation limits');
  L.push('');
  L.push('- This is a chronological walk-forward comparison, but the sample may still be too short or too correlated for stable conclusions.');
  L.push('- The market column is margin-adjusted Bet9ja fair odds. Beating it in Brier/log loss is not the same as beating it after the margin in a betting strategy.');
  L.push('- Model selection here is descriptive; calibration, confidence bounds and the decision engine are later stages.');
  L.push('- Repeated/static odds cannot reveal line-movement information.');
  fs.writeFileSync(base + '.md', L.join('\n'));
  console.log('Wrote ' + base + '.json and .md');
  console.log('Test rounds ' + report.meta.testRounds + ', test matches ' + report.meta.testMatches);
  if (report.leaderboard.length) console.log('Leaderboard: ' + report.leaderboard.map(x => x.model + ' ' + f4(x.logLoss)).join(' · '));
  if (report.warnings.length) console.log('Warnings: ' + report.warnings.join(' | '));
}

main();
