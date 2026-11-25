#!/usr/bin/env node
// Generate a reproducible Stage-4 research report from collector JSONL or an
// extension backup. No npm dependencies.
//
//   node research/report.cjs
//   node research/report.cjs --dir=research/data --out=research/reports
//   node research/report.cjs --backup="C:\path\leagueplus-backup.json"
//   node research/report.cjs --min-matches=30 --min-rounds=10 --min-teams=4 --permutations=99
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LPCat } = require('../lib/core.js');
const LPResearch = require('../lib/research.js');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
}));
const dir = path.resolve(args.dir || path.join(__dirname, 'data'));
const outDir = path.resolve(args.out || path.join(__dirname, 'reports'));
const backupPath = args.backup ? path.resolve(args.backup) : null;
const options = {
  minMatches: args['min-matches'] != null ? +args['min-matches'] : 100,
  minRounds: args['min-rounds'] != null ? +args['min-rounds'] : 30,
  minTeams: args['min-teams'] != null ? +args['min-teams'] : 8,
  minPatternN: args['min-pattern'] != null ? +args['min-pattern'] : 30,
  permutations: args.permutations != null ? +args.permutations : 499,
  seed: args.seed != null ? +args.seed : 20261124
};

function readJSON(file) {
  const buf = fs.readFileSync(file);
  const text = /\.gz$/i.test(file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}
function initData(x) { return x && x.data && x.data.markets ? x.data : x; }

function loadCollector() {
  const initFile = path.join(dir, 'init.json');
  const init = fs.existsSync(initFile) ? initData(readJSON(initFile)) : null;
  const cat = init ? LPCat.buildMap(init) : {};
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^parsed-.*\.jsonl$/.test(f)).sort() : [];
  const map = new Map(), selsets = {};
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let x; try { x = JSON.parse(line); } catch (e) { continue; }
      for (const [k, v] of Object.entries((x.results && x.results.selsets) || {})) selsets[k] = v;
      for (const [k, v] of Object.entries((x.upcoming && x.upcoming.selsets) || {})) selsets[k] = v;
      for (const m of (x.results && x.results.matches) || []) {
        const k = m.fixtureId || m.key;
        if (k && !map.has(k)) map.set(k, m);
      }
    }
  }
  return { source: 'collector', init, cat, selsets, matches: [...map.values()], files: files.length };
}

function loadBackup() {
  const b = readJSON(backupPath);
  const stores = b.stores || { matches: b.matches || [], meta: b.meta || [], catalogues: [] };
  const matches = stores.matches || [];
  const meta = stores.meta || [];
  const selsets = {};
  meta.forEach(x => { if (x && typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selsets[x.key] = x.value; });
  const initMeta = meta.find(x => x && x.key === 'init');
  const cats = (stores.catalogues || []).slice().sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0));
  const defs = cats.length ? { markets: cats[0].markets } : (initMeta ? initMeta : null);
  return { source: 'backup', init: initMeta || null, cat: defs ? LPCat.buildMap(defs) : {}, selsets, matches, files: 0 };
}

function pct(x, d = 1) { return x == null || !Number.isFinite(x) ? '–' : (x * 100).toFixed(d) + '%'; }
function f3(x) { return x == null || !Number.isFinite(x) ? '–' : (+x).toFixed(3); }
function ci(c) { return c && c[0] != null && c[1] != null ? '[' + f3(c[0]) + ', ' + f3(c[1]) + ']' : '–'; }
function ciPct(c) { return c && c[0] != null && c[1] != null ? '[' + pct(c[0]) + ', ' + pct(c[1]) + ']' : '–'; }
function md(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function statusClass(s) { return s === 'supported' || s === 'validated' ? '**' + s + '**' : s; }

function main() {
  const data = backupPath ? loadBackup() : loadCollector();
  const result = LPResearch.analyze({ matches: data.matches, cat: data.cat, selsets: data.selsets, options });
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.join(outDir, 'research-' + stamp);
  fs.writeFileSync(base + '.json', JSON.stringify(result, null, 2));

  const qs = {
    H1: 'Do historical results contain serial information?',
    H2: 'Do team identities have persistent statistical characteristics?',
    H3: 'Do competitions have different scoring/outcome distributions?',
    H4: 'Do round sequences contain statistically significant patterns?',
    H5: 'Do score frequencies change over time?',
    H6: 'Do market odds contain information beyond historical scores?',
    H7: 'Does combining historical information with the market improve predictions?',
    H8: 'Are some conditions more predictable than others?'
  };
  const L = [];
  L.push('# League Plus Research Report');
  L.push('');
  L.push('- Generated: ' + new Date(result.meta.generatedAt).toISOString());
  L.push('- Engine: ' + result.meta.version);
  L.push('- Source: ' + data.source + (data.files ? ' (' + data.files + ' parsed files)' : ''));
  L.push('- Matches: ' + result.meta.matches + ' · rounds: ' + result.meta.rounds + ' · competitions: ' + result.meta.competitions);
  L.push('- Date range: ' + (result.meta.dateRange ? new Date(result.meta.dateRange.from).toISOString() + ' → ' + new Date(result.meta.dateRange.to).toISOString() : '–'));
  L.push('- Minimum sample: ' + options.minMatches + ' matches / ' + options.minRounds + ' rounds / ' + options.minTeams + ' teams; ' + options.permutations + ' permutations; seed ' + options.seed);
  L.push('');
  if (result.meta.warnings.length) {
    L.push('## Warnings');
    for (const w of result.meta.warnings) L.push('- ' + md(w));
    L.push('');
  }
  L.push('## Hypothesis summary');
  L.push('');
  L.push('| ID | Question | Kind | Status | n | Effect | 95% interval | p | q (BH) |');
  L.push('|---|---|---|---|---:|---:|---|---:|---:|');
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']) {
    const h = result.hypotheses[id];
    L.push('| ' + id + ' | ' + qs[id] + ' | ' + h.kind + ' | ' + statusClass(h.status) + ' | ' + (h.n || 0) + ' | ' + f3(h.effect) + ' | ' + ci(h.ci) + ' | ' + f3(h.p) + ' | ' + f3(h.q) + ' |');
  }
  L.push('');
  L.push('`supported` means p < 0.05, Benjamini–Hochberg q < 0.10, an effect threshold and, where applicable, a consistent out-of-sample direction. `exploratory` means a raw p < 0.05 that did not survive correction or out-of-sample checks. `insufficient` means the sample threshold was not met.');
  L.push('');
  L.push('H6 tests whether margin-adjusted market probabilities carry information beyond historical frequencies. It does **not** imply positive expected value after the bookmaker margin; value requires the calibrated decision engine and walk-forward ROI evidence.');
  L.push('');
  L.push('## Test detail');
  L.push('');
  L.push('| Test | Comp | n | Statistic | Effect | p | q | Note |');
  L.push('|---|---|---:|---:|---:|---:|---:|---|');
  for (const t of result.tests) {
    L.push('| ' + md(t.name) + ' | ' + md(t.detail && t.detail.comp != null ? t.detail.comp : '–') + ' | ' + (t.n || 0) + ' | ' + f3(t.stat) + ' | ' + f3(t.effect) + ' | ' + f3(t.p) + ' | ' + f3(t.q) + ' | ' + md(t.detail && t.detail.reason ? t.detail.reason : '') + ' |');
  }
  L.push('');
  L.push('## Conditional-probability patterns');
  L.push('');
  if (!result.patterns.length) L.push('No patterns met the minimum row support (' + options.minPatternN + ') in this sample.');
  else {
    L.push('| Competition | Condition | Outcome | n | Baseline | Observed | Difference | 95% CI | p | q | OOS same direction | Status |');
    L.push('|---|---|---|---:|---:|---:|---:|---|---:|---:|---|---|');
    for (const p of result.patterns.slice(0, 60)) {
      L.push('| ' + p.comp + ' | ' + md(p.condition) + ' | ' + md(p.outcome) + ' | ' + p.n + ' | ' + pct(p.baseline) + ' | ' + pct(p.observed) + ' | ' + pct(p.diff) + ' | ' + ciPct(p.ci) + ' | ' + f3(p.p) + ' | ' + f3(p.q) + ' | ' + (p.oos.sameDirection == null ? '–' : p.oos.sameDirection ? 'yes' : 'no') + ' | ' + statusClass(p.status) + ' |');
    }
  }
  L.push('');
  L.push('## Information theory');
  L.push('');
  L.push('| Scope | Matches | Rounds | Outcome entropy (bits) | Total-goal entropy | Round transition MI | Conditional entropy | MI permutation p |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(result.information)) {
    L.push('| ' + md(k) + ' | ' + v.matches + ' | ' + v.rounds + ' | ' + f3(v.outcomeEntropyBits) + ' | ' + f3(v.totalGoalEntropyBits) + ' | ' + f3(v.roundTransitionMiBits) + ' | ' + f3(v.roundTransitionConditionalEntropyBits) + ' | ' + f3(v.roundTransitionMi && v.roundTransitionMi.p) + ' |');
  }
  L.push('');
  L.push('## Limitations');
  for (const x of result.limitations) L.push('- ' + md(x));
  L.push('');
  L.push('A significant result is not a betting strategy. It must survive chronological walk-forward testing, calibration and a value threshold before it can affect a recommendation.');
  fs.writeFileSync(base + '.md', L.join('\n'));

  console.log('Wrote ' + base + '.json and .md');
  console.log('Matches ' + result.meta.matches + ', rounds ' + result.meta.rounds + ', competitions ' + result.meta.competitions);
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']) {
    const h = result.hypotheses[id];
    console.log(id + ' ' + h.status + ' n=' + (h.n || 0) + ' p=' + f3(h.p) + ' q=' + f3(h.q) + ' effect=' + f3(h.effect));
  }
}

main();
