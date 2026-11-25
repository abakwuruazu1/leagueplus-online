/* League Plus Engine – dashboard */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const pc = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(1) + '%');
const pp = p => (p == null || isNaN(p) ? '–' : (p * 100).toFixed(1) + '%');
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const f4 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(4));
const f3 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(3));
const pe = x => (x == null || isNaN(x) ? '–' : (x >= 0 ? '+' : '') + (+x * 100).toFixed(1) + '%');
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTs = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = ts => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
const bar = (p, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></div>`;
const ENG = { mkt: 'Bet9ja market model', fair: 'Bet9ja fair odds', team: 'Team ratings', dc: 'Dixon-Coles', emp: 'Empirical/Bayesian', blend: 'Blend (team + market)', ensemble: 'Equal ensemble (mkt/DC/emp/team)' };

const St = {
  init: null, cat: null, cats: new Map(), comps: [], matches: [], byComp: new Map(), selsets: {}, up: [], standings: {}, status: null, sched: null,
  rounds: [], quality: [], conflicts: [], stats: null, catCurrent: null, predRecent: [], settleRecent: [], ledgerStats: null, research: null, specialists: null, calibration: null, learning: null, decision: null, acc: null, intel: null, cloud: null, tab: 'overview', teamCache: {}, vf: null,
  ui: Object.assign({ comp: 'all', mk: '1', eng: 'mkt', minEdge: 3, maxOdds: 10, vComp: 'all', vEng: 'team', vEdge: 3, vHours: 0, vMk: 'ALL', rComp: null, tComp: null, halfLifeH: 6 }, (() => { try { return JSON.parse(localStorage.getItem('lpui') || '{}'); } catch (e) { return {}; } })())
};
const saveUI = () => { try { localStorage.setItem('lpui', JSON.stringify(St.ui)); } catch (e) { } };
const cname = id => (St.comps.find(c => c.id === +id) || {}).name || 'League ' + id;
const CM = c => St.byComp.get(+c) || [];
const catFor = m => (m && m.catalogueVersion && St.cats.get(m.catalogueVersion)) || St.cat || {};

async function load() {
  await LPDB.ready().catch(() => { });
  const [init, ms, meta, rounds, cats, quality, conflicts, cSnap, cPred, cModel, store] = await Promise.all([
    LPDB.get('meta', 'init'), LPDB.getAll('matches'), LPDB.getAll('meta'),
    LPDB.getAll('rounds').catch(() => []), LPDB.getAll('catalogues').catch(() => []),
    LPDB.getAll('qualityLog').catch(() => []), LPDB.getAll('conflicts').catch(() => []),
    LPDB.count('snapshots').catch(() => 0), LPDB.count('predictions').catch(() => 0), LPDB.count('modelStates').catch(() => 0),
    hasChrome ? chrome.storage.local.get(['lpstatus', 'lpsched']) : Promise.resolve({})
  ]);
  St.status = store.lpstatus; St.sched = store.lpsched || null; St.init = init;
  St.cats = new Map();
  (cats || []).forEach(c => { try { St.cats.set(c.version, LPCat.buildMap({ markets: c.markets })); } catch (e) { } });
  if (init) {
    St.cat = LPCat.buildMap(init);
    St.comps = init.games.flatMap(g => g.leagues.filter(l => l.enabled).map(l => ({ id: l.id, name: l.name, game: g.id })));
  } else {
    St.cat = [...St.cats.values()][0] || {};
  }
  St.rounds = rounds || [];
  St.quality = quality || [];
  St.conflicts = conflicts || [];
  St.stats = { snapshots: cSnap, predictions: cPred, modelStates: cModel };
  St.catCurrent = (meta.find(x => x.key === 'cat:current') || null);
  St.matches = ms.sort((a, b) => a.ts - b.ts || a.idx - b.idx);
  St.byComp = new Map(); St.matches.forEach(m => { if (!St.byComp.has(m.comp)) St.byComp.set(m.comp, []); St.byComp.get(m.comp).push(m); });
  St.selsets = {}; St.up = []; St.standings = {};
  meta.forEach(x => { if (x.key.startsWith('sel:')) St.selsets[x.key] = x.value; else if (x.key.startsWith('up:')) St.up.push(...x.fixtures); else if (x.key.startsWith('st:')) (x.standings || []).forEach(s => { St.standings[s.competition] = s; }); });
  const seen = new Set(); St.up = St.up.filter(f => { if (!f || seen.has(f.key)) return false; seen.add(f.key); return true; });
  St.teamCache = {};
  if (typeof LPLedger !== 'undefined') {
    try { St.predRecent = await LPLedger.recentPredictions(160, LPDB); } catch (e) { St.predRecent = []; }
    try { St.settleRecent = await LPLedger.recentSettlements(160, LPDB); } catch (e) { St.settleRecent = []; }
    try { St.ledgerStats = await LPLedger.stats({ db: LPDB, recent: St.predRecent }); } catch (e) { St.ledgerStats = null; }
  } else { St.predRecent = []; St.settleRecent = []; St.ledgerStats = null; }
  if (St.tab === 'learning' || St.tab === 'decision' || !St.learning) await loadLearningSnapshot();
  if (St.tab === 'intelligence' || !St.intel) await loadIntel();
  if (St.tab === 'settings' || !St.cloud) await loadCloud();
  syncLine();
}
async function loadCloud() {
  if (typeof LPCloud === 'undefined') { St.cloud = null; return; }
  try {
    St.cloud = { config: await LPCloud.getConfig(LPDB), status: await LPCloud.getStatus(LPDB) };
  } catch (e) { St.cloud = null; }
}
async function loadLearningSnapshot() {
  if (typeof LPLearn === 'undefined') { St.learning = null; return; }
  try { St.learning = await LPLearn.snapshot({ db: LPDB }); } catch (e) { St.learning = null; }
}
async function loadIntel() {
  if (typeof LPPerformance === 'undefined' || typeof LPLedger === 'undefined') { St.intel = null; return; }
  try {
    const [predictions, settlements] = await Promise.all([
      LPLedger.recentPredictions(1500, LPDB), LPLedger.recentSettlements(1500, LPDB)
    ]);
    St.intel = LPPerformance.aggregate({
      predictions, settlements,
      data: {
        matches: St.matches.length, rounds: St.rounds.length,
        conflicts: (St.conflicts || []).length,
        qualityInvalid: (St.quality || []).filter(q => q.severity === 'invalid').reduce((n, q) => n + (q.count || 1), 0),
        qualityWarn: (St.quality || []).filter(q => q.severity === 'warn').reduce((n, q) => n + (q.count || 1), 0),
        lastSync: St.status && St.status.lastSync || null
      }
    });
  } catch (e) { St.intel = null; }
}
function syncLine() {
  const s = St.status || {};
  const bad = (St.quality || []).filter(q => q.severity === 'invalid').reduce((n, q) => n + (q.count || 1), 0);
  const warn = (St.quality || []).filter(q => q.severity === 'warn').reduce((n, q) => n + (q.count || 1), 0);
  const conflicts = (St.conflicts || []).length;
  $('#syncLine').innerHTML = `${St.matches.length.toLocaleString()} matches · ${St.rounds.length.toLocaleString()} rounds · ${(St.stats?.snapshots || 0).toLocaleString()} odds snapshots · last check ${ago(s.lastSync)}` +
    (conflicts ? ` · <span class="bad">${conflicts} conflict(s)</span>` : '') +
    (bad ? ` · <span class="bad">${bad} invalid record(s)</span>` : '') +
    (warn ? ` · <span class="warnc">${warn} warning(s)</span>` : '') +
    (s.log && s.log.length ? ` · <span class="bad">${s.log.length} sync warning(s)</span>` : '');
}
$('#btnSync').addEventListener('click', async () => {
  $('#btnSync').disabled = true;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) await chrome.runtime.sendMessage({ type: 'lpSyncNow' });
    else if (typeof lpSync === 'function') await lpSync();
  } catch (e) { }
  await load(); render(true); $('#btnSync').disabled = false;
});
let reloadTimer = null;
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(ch => {
  if (!ch.lpstatus && !ch.lpsched) return;
  if (ch.lpstatus) { St.status = ch.lpstatus.newValue; syncLine(); }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    await load();
    if (['overview', 'next', 'results', 'tables', 'data', 'ledger', 'specialists', 'calibration', 'learning', 'decision', 'intelligence'].includes(St.tab)) render(true);
  }, 350);
});
$('#tabs').addEventListener('click', async e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  St.tab = b.dataset.tab;
  if (St.tab === 'learning' || St.tab === 'decision' || St.tab === 'intelligence') await loadLearningSnapshot();
  if (St.tab === 'intelligence') await loadIntel();
  if (St.tab === 'settings') await loadCloud();
  render();
});
const view = $('#view');
view.addEventListener('change', e => { const k = e.target.dataset.ui; if (!k) return; St.ui[k] = e.target.type === 'number' ? +e.target.value : e.target.value; saveUI(); if (k.startsWith('v')) St.vf = null; render(true); });
view.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return; if (t.tagName === 'A') e.preventDefault();
  if (t.dataset.act === 'match') showMatch(t.dataset.key);
  if (t.dataset.act === 'vf') runValueFinder();
  if (t.dataset.act === 'export') exportJSON();
  if (t.dataset.act === 'csv') exportCSV();
  if (t.dataset.act === 'import') $('#impFile').click();
  if (t.dataset.act === 'clear') clearDB();
  if (t.dataset.act === 'audit') runAudit();
  if (t.dataset.act === 'recordLedger') recordLedger();
  if (t.dataset.act === 'settleLedger') settleLedger();
  if (t.dataset.act === 'runResearch') runResearch();
  if (t.dataset.act === 'runSpecialists') runSpecialists();
  if (t.dataset.act === 'runCalibration') runCalibration();
  if (t.dataset.act === 'runLearning') runLearningUI();
  if (t.dataset.act === 'runDecision') runDecisionPolicy();
  if (t.dataset.act === 'buildAccumulator') runAccumulator();
  if (t.dataset.act === 'refreshIntel') refreshIntel();
  if (t.dataset.act === 'activateLearning') activateLearning(t.dataset.version || null);
  if (t.dataset.act === 'rollbackLearning') rollbackLearning(t.dataset.version === undefined ? null : t.dataset.version);
  if (t.dataset.act === 'saveLearnConfig') saveLearnConfig();
  if (t.dataset.act === 'saveCloud') saveCloud();
  if (t.dataset.act === 'syncCloud') syncCloud();
  if (t.dataset.act === 'saveSet') { St.ui.halfLifeH = +$('#set_hl').value || 6; saveUI(); St.teamCache = {}; $('#setMsg').textContent = 'Saved ✓'; }
});
$('#modalX').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
function render(keep) {
  const y = window.scrollY;
  if (!St.init) { view.innerHTML = '<div class="empty"><h2>Starting up…</h2><p>The first capture runs within 30 seconds. Keep Chrome open.</p></div>'; return; }
  ({ overview: rOverview, next: rNext, slip: rSlip, value: rValue, results: rResults, tables: rTables, data: rData, ledger: rLedger, research: rResearch, specialists: rSpecialists, calibration: rCalibration, learning: rLearning, decision: rDecision, intelligence: rIntel, settings: rSettings })[St.tab]();
  if (keep) window.scrollTo(0, y);
}

// ---------------- helpers
function markets() { // market keys present in the catalogue, in a sensible order
  const seen = new Map();
  Object.values(St.cat).sort((a, b) => a.mId - b.mId || String(a.sub).localeCompare(String(b.sub)) || a.id - b.id).forEach(c => { const k = LPCat.mkey(c); if (!seen.has(k)) seen.set(k, { key: k, label: LPCat.mlabel(c), group: c.market, ids: [] }); seen.get(k).ids.push(c.id); });
  return [...seen.values()];
}
const selLabel = (c, home, away) => { if (c.mId === 1) return c.name === '1' ? home + ' win' : c.name === '2' ? away + ' win' : 'Draw'; if (c.mId === 2) return c.name === '1X' ? home + ' or draw' : c.name === 'X2' ? away + ' or draw' : home + ' or ' + away; return c.full; };
function teamFit(comp) {
  const c = St.teamCache[comp]; const hist = CM(comp);
  if (c && c.n === hist.length) return c.T;
  const T = LPModel.fitDC(hist.slice(-3000), Date.now(), { halfLifeH: St.ui.halfLifeH, seasonMode: 'auto', empirical: true });
  St.teamCache[comp] = { n: hist.length, T }; return T;
}
const engP = (r, eng) => (eng === 'team' ? r.team : r[eng]);
const evalCache = new Map();
function evalFx(fx) {
  const k = fx.key + ':' + (fx.catalogueVersion || '') + ':' + St.ui.halfLifeH + ':' + CM(fx.comp).length + ':' + St.ui.eng; if (evalCache.has(k)) return evalCache.get(k);
  const needT = !['mkt', 'fair'].includes(St.ui.eng);
  const ev = LPModel.evaluate(catFor(fx), fx, St.selsets[fx.sk] || '', needT ? teamFit(fx.comp) : null); evalCache.set(k, ev); if (evalCache.size > 400) evalCache.clear(); return ev;
}
const openFx = () => St.up.filter(f => f.close > Date.now());
const compSel = (name, val, all = true) => `<label>League<select data-ui="${name}">${all ? `<option value="all" ${val === 'all' ? 'selected' : ''}>All leagues</option>` : ''}${St.comps.map(c => `<option value="${c.id}" ${+val === c.id ? 'selected' : ''}>${esc(c.name)} (${CM(c.id).length})</option>`).join('')}</select></label>`;
const mkSel = (name, val, withAll) => { const g = {}; markets().forEach(m => (g[m.group] = g[m.group] || []).push(m)); return `<label>Market<select data-ui="${name}">${withAll ? `<option value="ALL" ${val === 'ALL' ? 'selected' : ''}>All markets</option>` : ''}${Object.entries(g).map(([n, ms]) => `<optgroup label="${esc(n)}">${ms.map(m => `<option value="${m.key}" ${val === m.key ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>`; };
const engSel = (name, val, opts = ['mkt', 'fair', 'team', 'dc', 'emp', 'blend', 'ensemble']) => `<label>Probability engine<select data-ui="${name}">${opts.map(k => `<option value="${k}" ${val === k ? 'selected' : ''}>${ENG[k]}</option>`).join('')}</select></label>`;
const countdown = ts => { const s = Math.max(0, Math.round((ts - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
setInterval(() => document.querySelectorAll('[data-cd]').forEach(e => { e.textContent = countdown(+e.dataset.cd); }), 1000);

// ---------------- OVERVIEW
function rOverview() {
  const s = St.status || {};
  const hrs = s.firstSync ? (Date.now() - s.firstSync) / 3600e3 : 0;
  const cards = St.comps.map(c => {
    const ms = CM(c.id), last = ms[ms.length - 1], fx = openFx().filter(f => f.comp === c.id), st = St.standings[c.id];
    const top = st ? String(st.value).split('|').slice(0, 5).map((r, i) => { const [t, pts, form] = r.split('-'); return `<tr><td>${i + 1}</td><td><b>${esc(t)}</b></td><td class="n">${pts}</td><td><span class="form">${String(form || '').split('').map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>`; }).join('') : '';
    return `<div class="card"><h3>${esc(c.name)} <small>${ms.length} matches recorded</small></h3>
      ${fx.length ? `<div>Next round: <b>${fx.length} matches</b> · betting closes in <span class="cd good" data-cd="${fx[0].close}">${countdown(fx[0].close)}</span> · week ${fx[0].week}</div>` : '<div class="mute">Waiting for the next round…</div>'}
      ${last ? `<div class="mute">Last result recorded ${ago(last.ts + 60e3)} (week ${last.week})</div>` : ''}
      ${top ? `<table style="margin-top:8px">${top}</table>` : ''}</div>`;
  }).join('');
  const qBad = (St.quality || []).filter(q => q.severity === 'invalid').reduce((n, q) => n + (q.count || 1), 0);
  const qWarn = (St.quality || []).filter(q => q.severity === 'warn').reduce((n, q) => n + (q.count || 1), 0);
  view.innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${St.matches.length.toLocaleString()}</div><div class="l">Matches recorded with Bet9ja odds</div></div>
    <div class="kpi"><div class="v">${St.rounds.length.toLocaleString()}</div><div class="l">Rounds recorded</div></div>
    <div class="kpi"><div class="v">${(St.stats?.snapshots || 0).toLocaleString()}</div><div class="l">Immutable odds snapshots</div></div>
    <div class="kpi"><div class="v">${(St.ledgerStats?.predictions || 0).toLocaleString()}</div><div class="l">Ledger predictions</div></div>
    <div class="kpi"><div class="v ${qBad ? 'bad' : qWarn ? 'warnc' : 'good'}">${qBad || qWarn || 'OK'}</div><div class="l">Data-quality ${qBad ? 'invalid records' : qWarn ? 'warnings' : 'clean'}</div></div>
    <div class="kpi"><div class="v">${hrs.toFixed(1)} h</div><div class="l">Recording for</div></div>
    <div class="kpi"><div class="v">${ago(s.lastSync)}</div><div class="l">Last check</div></div></div>
  ${s.log && s.log.length ? `<div class="note"><b>Warnings</b><br>${s.log.map(esc).join('<br>')}</div>` : ''}
  <div class="grid">${cards}</div>
  <div class="note"><b>Keep Chrome open.</b> Bet9ja's League Plus feed only shows the round about to start and the one that just finished. The engine now schedules a capture at each game's result time plus a closing-price check, records immutable history, and flags gaps, partial rounds and conflicts. See the <b>Data quality</b> tab for provenance and integrity reports.</div>`;
}

// ---------------- NEXT ROUND
function rNext() {
  const mks = markets(); if (!mks.find(m => m.key === St.ui.mk)) St.ui.mk = '1';
  const M = mks.find(m => m.key === St.ui.mk), eng = St.ui.eng, minE = (St.ui.minEdge || 0) / 100;
  const fxs = openFx().filter(f => St.ui.comp === 'all' || f.comp === +St.ui.comp);
  let h = `<div class="controls">${compSel('comp', St.ui.comp)}${mkSel('mk', St.ui.mk)}${engSel('eng', eng)}<label>Value if edge ≥ %<input type="number" data-ui="minEdge" value="${St.ui.minEdge}" step="0.5" style="width:110px;min-width:0"></label><label>Value picks: max odds<input type="number" data-ui="maxOdds" value="${St.ui.maxOdds}" step="1" style="width:110px;min-width:0"></label></div>`;
  if (!fxs.length) { view.innerHTML = h + '<div class="empty">No round open for betting right now — the next one appears within a minute.</div>'; return; }
  const teamNote = !['fair', 'mkt'].includes(eng) ? fxs.some(f => teamFit(f.comp).n < 30) ? '<div class="note">Team/Dixon-Coles/empirical models need at least 30 recorded matches per league and per-team evidence; leagues below that fall back to the market model.</div>' : '' : '';
  // value across ALL markets
  const vals = [];
  for (const fx of fxs) { const ev = evalFx(fx); for (const r of ev.rows) { const p = engP(r, eng); if (p == null) continue; const e = p * r.odds - 1; if (e >= minE && r.odds >= 1.2 && r.odds <= (St.ui.maxOdds || 1e9)) vals.push({ fx, r, p, e }); } }
  vals.sort((a, b) => b.e - a.e);
  h += teamNote + `<div class="card" style="margin-bottom:16px"><h3>💰 Value picks in this round <small>${ENG[eng]} chance × Bet9ja odds − 1 ≥ ${St.ui.minEdge}% · any market · odds ≤ ${St.ui.maxOdds}</small></h3>
    ${vals.length ? `<div class="scroll" style="max-height:360px"><table><tr><th>League</th><th>Match</th><th>Market</th><th>Pick</th><th class="n">Bet9ja odds</th><th class="n">Engine chance</th><th class="n">Fair (Bet9ja)</th><th class="n">Edge</th></tr>${vals.slice(0, 60).map(v => { const c = catFor(v.fx)[v.r.id] || St.cat[v.r.id]; return `<tr><td>${esc(cname(v.fx.comp))}</td><td><b>${esc(v.fx.home)} v ${esc(v.fx.away)}</b></td><td>${esc(LPCat.mlabel(c))}</td><td><span class="pill pick">${esc(selLabel(c, v.fx.home, v.fx.away))}</span></td><td class="n">${f2(v.r.odds)}</td><td class="n">${pp(v.p)}</td><td class="n mute">${pp(v.r.fair)}</td><td class="n good"><b>+${(v.e * 100).toFixed(1)}%</b></td></tr>`; }).join('')}</table></div>` : `<p class="mute">No selection reaches a ${St.ui.minEdge}% edge with the ${ENG[eng]}. ${eng === 'mkt' || eng === 'fair' ? 'That is expected: Bet9ja\'s prices are internally consistent, so the market model mostly agrees with them. Try Team ratings once enough rounds are recorded.' : ''}</p>`}
    <p class="mute" style="font-size:13px">Check the Value finder tab: it shows how picks like these have actually paid on recorded rounds before you trust them. <b>Exploratory only</b> in this build: probabilities are not calibrated and no lower confidence bound is applied yet.</p></div>`;
  const byComp = {}; fxs.forEach(f => (byComp[f.comp] = byComp[f.comp] || []).push(f));
  h += `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(560px,1fr))">`;
  for (const comp in byComp) {
    const L = byComp[comp];
    h += `<div class="card"><h3>${esc(cname(comp))} · week ${L[0].week} <small>closes in <span class="cd" data-cd="${L[0].close}">${countdown(L[0].close)}</span></small></h3><div style="overflow-x:auto"><table><tr><th>Match</th>${M.ids.map(id => `<th class="n">${esc(St.cat[id].name)}</th>`).join('')}</tr>`;
    for (const fx of L) {
      const ev = evalFx(fx);
      h += `<tr><td><b>${esc(fx.home)}</b> v <b>${esc(fx.away)}</b></td>${M.ids.map(id => { const r = ev.rows.find(x => x.id === id); if (!r) return '<td class="n mute">–</td>'; const p = engP(r, eng); const e = p != null ? p * r.odds - 1 : null; return `<td class="n"><span class="odd ${e != null && e >= minE ? 'val' : ''}">${f2(r.odds)}</span><div class="gm">${pp(p)}${e != null ? ` · ${e >= 0 ? '+' : ''}${(e * 100).toFixed(0)}%` : ''}</div></td>`; }).join('')}</tr>`;
    }
    h += `</table></div></div>`;
  }
  view.innerHTML = h + `</div><div class="note">Each cell: Bet9ja odds, then the engine's chance and its edge (chance × odds − 1). Bet9ja's margin is about 5% on 1X2, GG/NG and over/under and about 18% on correct score, so most edges are negative.</div>`;
}

// ---------------- SLIP BUILDER (real odds)
function rSlip() {
  const eng = St.ui.eng;
  const needEmp = ['emp', 'ensemble'].includes(eng);
  const mk = markets();
  ZSlip.mount(view, {
    key: 'leagueplus', realOdds: true, sourceLabel: 'League', sources: St.comps.map(c => ({ id: c.id, name: c.name })), horizonDefault: 8,
    markets: mk.map(m => ({ group: m.group, id: m.key, name: m.label })), defaultMarkets: ['1', '2', '3', '5@1.5', '5@2.5'],
    candidates(o) {
      const now = Date.now(), cands = [];
      const fxs = openFx().filter(f => o.sources.includes(f.comp) && f.close <= now + o.horizon * 60e3 && f.close > now + 15e3);
      for (const fx of fxs) { const ev = evalFx(fx), cat = catFor(fx); for (const r of ev.rows) { const c = cat[r.id] || St.cat[r.id]; if (!c) continue; const k = LPCat.mkey(c); if (!o.markets.includes(k)) continue; const p = engP(r, eng); if (p == null) continue; cands.push({ mkey: fx.key, mkId: k, p, oddsOverride: r.odds, fx, id: r.id }); } }
      return { cands, note: 'No League Plus round is open for betting in that window. A new round opens every few minutes.' };
    },
    async backtestSlots(o, onProgress) {
      // past rounds grouped by game; slot j = j-th most recent round of every selected league
      const perGame = {};
      const ms = St.matches.filter(m => o.sources.includes(m.comp) && m.odds && St.selsets[m.sk]);
      ms.forEach(m => { ((perGame[m.game] = perGame[m.game] || {})[m.roundId] = (perGame[m.game] || {})[m.roundId] || []).push(m); });
      const lists = Object.values(perGame).map(r => Object.keys(r).sort((a, b) => b - a).slice(0, 60).map(id => r[id]));
      const len = Math.max(0, ...lists.map(l => l.length)), slots = [];
      const tf = {};
      for (let j = 0; j < len; j++) {
        const cands = [];
        for (const L of lists) {
          const R = L[j]; if (!R) continue;
          for (const m of R) {
            let T = null;
            if (!['fair', 'mkt'].includes(eng)) { const key = m.comp + ':' + m.roundId; T = tf[key] || (tf[key] = LPModel.fitDC(CM(m.comp).filter(x => x.ts < m.ts).slice(-3000), m.ts, { halfLifeH: St.ui.halfLifeH, seasonMode: 'auto', empirical: needEmp })); }
            const cat = catFor(m);
            const ev = LPModel.evaluate(cat, m, St.selsets[m.sk], T);
            for (const r of ev.rows) { const c = cat[r.id]; const k = LPCat.mkey(c); if (!o.markets.includes(k)) continue; const p = engP(r, eng); if (p == null) continue; const w = LPCat.settle(c, m.hg, m.ag, m.goals, { tlOk: m.tlOk }); if (w == null) continue; cands.push({ mkey: m.key, mkId: k, p, oddsOverride: r.odds, won: w }); }
          }
        }
        slots.push(cands); onProgress(j / len); await new Promise(r => setTimeout(r, 0));
      }
      return slots;
    },
    describe(l) { const c = catFor(l.fx)[l.id] || St.cat[l.id]; return { when: 'closes ' + fmtTs(l.fx.close), comp: cname(l.fx.comp), event: l.fx.home + ' v ' + l.fx.away, market: LPCat.mlabel(c), pick: selLabel(c, l.fx.home, l.fx.away) }; },
    slipNote: legs => { const soon = Math.min(...legs.map(l => l.fx.close)); return `<div class="note">⏱ Bet before <b>${fmtTs(soon)}</b> — betting on the first match closes in <span class="cd" data-cd="${soon}">${countdown(soon)}</span>.</div>`; }
  });
  view.insertAdjacentHTML('beforeend', `<div class="note">Probabilities: <b>${ENG[eng]}</b> (change on the Next round tab). Odds are Bet9ja's real prices for the open round, so the slip's total odds are what Bet9ja pays. Because each pick carries Bet9ja's margin, the slip that reaches your target with the fewest, lowest-margin picks gives the best chance.</div>`);
}

// ---------------- VALUE FINDER (history with real odds)
function rValue() {
  view.innerHTML = `<div class="controls">${compSel('vComp', St.ui.vComp)}${engSel('vEng', St.ui.vEng, ['team', 'dc', 'emp', 'blend', 'ensemble', 'fair'])}<label>Edge needed %<input type="number" data-ui="vEdge" value="${St.ui.vEdge}" step="0.5" style="width:110px;min-width:0"></label><label>Value picks: max odds<input type="number" data-ui="maxOdds" value="${St.ui.maxOdds}" step="1" style="width:110px;min-width:0"></label><label>Period<select data-ui="vHours">${[[0, 'All recorded'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [72, 'Last 3 days']].map(([k, l]) => `<option value="${k}" ${+St.ui.vHours === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${mkSel('vMk', St.ui.vMk, true)}<button class="btn" data-act="vf">▶ Analyse recorded rounds</button></div>
  <div class="note">Uses every recorded match with Bet9ja's real pre-match odds. For each market it shows: what you'd have made backing <b>every</b> selection, how accurate Bet9ja's prices were, and what you'd have made backing only the picks the engine rated as value at the time (team ratings are rebuilt using only matches before each round). <b>Exploratory:</b> this view is in-sample and not yet a walk-forward calibrated test.</div>
  <div id="vfProg" class="progress" style="display:none"><span></span></div><div id="vfOut"></div>`;
  if (St.vf) drawVF(St.vf);
}
async function runValueFinder() {
  const eng = St.ui.vEng, minE = St.ui.vEdge / 100, since = +St.ui.vHours ? Date.now() - St.ui.vHours * 3600e3 : 0;
  const needEmp = ['emp', 'ensemble'].includes(eng);
  const ms = St.matches.filter(m => (St.ui.vComp === 'all' || m.comp === +St.ui.vComp) && m.ts >= since && m.odds && St.selsets[m.sk]);
  const prog = () => $('#vfProg span') || { style: {} }; if ($('#vfProg')) $('#vfProg').style.display = 'block';
  const A = {}, bands = {}, tf = {};
  const BANDS = [[1, 1.3], [1.3, 1.6], [1.6, 2], [2, 3], [3, 5], [5, 10], [10, 1e9]];
  const add = (o, k) => (o[k] = o[k] || { n: 0, w: 0, stake: 0, ret: 0, fp: 0, odds: 0, vn: 0, vw: 0, vret: 0 });
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    let T = null;
    if (!['fair', 'mkt'].includes(eng)) { const key = m.comp + ':' + m.roundId; T = tf[key] || (tf[key] = LPModel.fitDC(CM(m.comp).filter(x => x.ts < m.ts).slice(-3000), m.ts, { halfLifeH: St.ui.halfLifeH, seasonMode: 'auto', empirical: needEmp })); }
    const cat = catFor(m);
    const ev = LPModel.evaluate(cat, m, St.selsets[m.sk], T);
    for (const row of ev.rows) {
      const c = cat[row.id]; if (!c) continue; const k = LPCat.mkey(c);
      if (St.ui.vMk !== 'ALL' && k !== St.ui.vMk) continue;
      const w = LPCat.settle(c, m.hg, m.ag, m.goals, { tlOk: m.tlOk }); if (w == null) continue;
      const f = row.fair; const p = engP(row, eng);
      if (p == null) continue;
      const o = row.odds;
      for (const r of [add(A, k), add(bands, BANDS.findIndex(([a, b]) => o >= a && o < b))]) {
        r.n++; r.stake++; r.odds += o; if (f != null) r.fp += f; if (w) { r.w++; r.ret += o; }
        if (p * o - 1 >= minE && o <= (St.ui.maxOdds || 1e9)) { r.vn++; if (w) { r.vw++; r.vret += o; } }
      }
    }
    if (i % 25 === 0) { prog().style.width = (100 * i / ms.length) + '%'; await new Promise(r => setTimeout(r, 0)); }
  }
  prog().style.width = '100%';
  St.vf = { A, bands, BANDS, n: ms.length, eng, minE }; drawVF(St.vf);
}
function drawVF(R) {
  const out = $('#vfOut'); if (!out) return;
  if (!R.n) { out.innerHTML = '<div class="empty">No recorded matches in that selection yet.</div>'; return; }
  const lab = Object.fromEntries(markets().map(m => [m.key, m.label]));
  const roi = (ret, n) => (n ? ret / n - 1 : null);
  const cell = x => (x == null ? '<span class="mute">–</span>' : `<b class="${x >= 0 ? 'good' : 'bad'}">${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%</b>`);
  const rows = Object.entries(R.A).sort((a, b) => (roi(b[1].ret, b[1].n) ?? -9) - (roi(a[1].ret, a[1].n) ?? -9)).map(([k, r]) => `<tr><td>${esc(lab[k] || k)}</td><td class="n">${r.n.toLocaleString()}</td><td class="n">${pc(100 * r.w / r.n)}</td><td class="n mute">${pc(100 * r.fp / r.n)}</td><td class="n">${f2(r.odds / r.n)}</td><td class="n">${cell(roi(r.ret, r.n))}</td><td class="n">${r.vn}</td><td class="n">${r.vn ? pc(100 * r.vw / r.vn) : '–'}</td><td class="n">${cell(roi(r.vret, r.vn))}</td></tr>`).join('');
  const bl = ['1.00–1.30', '1.30–1.60', '1.60–2.00', '2.00–3.00', '3.00–5.00', '5.00–10.0', '10.0+'];
  const brows = Object.entries(R.bands).sort((a, b) => a[0] - b[0]).map(([i, r]) => `<tr><td>${bl[i]}</td><td class="n">${r.n.toLocaleString()}</td><td class="n">${pc(100 * r.w / r.n)}</td><td class="n mute">${pc(100 * r.fp / r.n)}</td><td class="n">${cell(roi(r.ret, r.n))}</td><td class="n">${r.vn}</td><td class="n">${cell(roi(r.vret, r.vn))}</td></tr>`).join('');
  out.innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${R.n.toLocaleString()}</div><div class="l">Recorded matches analysed</div></div></div>
  <div class="card"><h3>By market <small>flat ₦1 stakes · "value picks" = ${ENG[R.eng]} edge ≥ ${(R.minE * 100).toFixed(1)}% at the time, odds ≤ ${St.ui.maxOdds}</small></h3><div class="scroll" style="max-height:none"><table>
    <tr><th>Market</th><th class="n">Selections</th><th class="n">Won</th><th class="n">Bet9ja fair said</th><th class="n">Avg odds</th><th class="n">Profit backing all</th><th class="n">Value picks</th><th class="n">Won</th><th class="n">Profit on value picks</th></tr>${rows}</table></div>
    <p class="mute" style="font-size:13px">"Won" vs "Bet9ja fair said": if they match, Bet9ja's prices are accurate in that market. Profit backing all ≈ minus the margin. A market is only worth betting if "Profit on value picks" stays positive over a large sample (hundreds of picks).</p></div>
  <div class="card" style="margin-top:16px"><h3>By odds range <small>is there a favourite–longshot bias?</small></h3><table><tr><th>Odds</th><th class="n">Selections</th><th class="n">Won</th><th class="n">Bet9ja fair said</th><th class="n">Profit backing all</th><th class="n">Value picks</th><th class="n">Profit on value picks</th></tr>${brows}</table></div>`;
}

// ---------------- RESULTS
function rResults() {
  if (!St.ui.rComp || !St.comps.some(c => c.id === +St.ui.rComp)) St.ui.rComp = St.comps[0]?.id;
  const ms = CM(St.ui.rComp).slice().reverse().slice(0, 240);
  const byR = []; ms.forEach(m => { let r = byR.find(x => x.id === m.roundId); if (!r) { r = { id: m.roundId, week: m.week, ts: m.ts, ms: [] }; byR.push(r); } r.ms.push(m); });
  view.innerHTML = `<div class="controls">${compSel('rComp', St.ui.rComp, false)}</div><div class="grid">${byR.map(r => `<div class="card"><h3>Week ${r.week} <small>${fmtT(r.ts)}</small></h3><table>${r.ms.sort((a, b) => a.idx - b.idx).map(m => `<tr class="click" data-act="match" data-key="${m.key}"><td>${esc(m.home)}</td><td class="n"><b>${m.hg} - ${m.ag}</b><div class="gm">${m.goals.map(([mn, s]) => mn + "'" + (s === 'h' ? 'H' : 'A')).join(' ')}</div></td><td>${esc(m.away)}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No results recorded yet.</div>'}</div>`;
}
function showMatch(key) {
  const m = St.matches.find(x => x.key === key); if (!m) return;
  const cat = catFor(m);
  const om = LPParse.oddsMap(m.odds, St.selsets[m.sk] || ''); const fp = LPModel.fair(cat, om);
  const groups = {}; for (const [id, o] of om) { const c = cat[id]; if (!c) continue; (groups[LPCat.mlabel(c)] = groups[LPCat.mlabel(c)] || []).push({ c, o, f: fp.get(id), w: LPCat.settle(c, m.hg, m.ag, m.goals, { tlOk: m.tlOk }) }); }
  const q = m.quality || {};
  const qline = q.status && q.status !== 'ok' ? `<div class="note" style="margin-top:8px"><b>Data quality: ${esc(q.status)}</b> · ${esc((q.flags || []).join(', '))}</div>` : '';
  $('#modalBody').innerHTML = `<div class="mute">${esc(cname(m.comp))} · week ${m.week} · ${fmtT(m.ts)} · catalogue ${esc(m.catalogueVersion || 'legacy')}</div><div class="score" style="margin:10px 0">${esc(m.home)} ${m.hg} - ${m.ag} ${esc(m.away)}</div>
  <div class="mute" style="text-align:center">Goals: ${m.goals.map(([mn, s]) => `${mn}' ${s === 'h' ? esc(m.home) : esc(m.away)}`).join(' · ') || 'none'}</div>${qline}
  <div class="card" style="margin-top:14px"><h3>Every market with Bet9ja's pre-match odds <small>green = won</small></h3><div class="scroll" style="max-height:460px"><table>${Object.entries(groups).map(([g, L]) => `<tr><td><b>${esc(g)}</b></td><td style="white-space:normal">${L.map(x => `<span class="pill ${x.w ? 'pick' : ''}" style="margin:2px" title="fair ${pp(x.f)}">${esc(selLabel(x.c, m.home, m.away))} @ ${f2(x.o)}</span>`).join(' ')}</td></tr>`).join('')}</table></div></div>`;
  $('#modal').classList.remove('hidden');
}

// ---------------- TABLES & TEAMS
function rTables() {
  if (!St.ui.tComp || !St.comps.some(c => c.id === +St.ui.tComp)) St.ui.tComp = St.comps[0]?.id;
  const c = +St.ui.tComp, st = St.standings[c], ms = CM(c), T = teamFit(c);
  const rows = st ? String(st.value).split('|').map(r => r.split('-')) : [];
  const ts = {}; ms.forEach(m => { for (const [t, gf, ga] of [[m.home, m.hg, m.ag], [m.away, m.ag, m.hg]]) { const x = ts[t] = ts[t] || { P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, O25: 0, GG: 0 }; x.P++; x.GF += gf; x.GA += ga; if (gf > ga) x.W++; else if (gf < ga) x.L++; else x.D++; if (gf + ga > 2.5) x.O25++; if (gf && ga) x.GG++; } });
  view.innerHTML = `<div class="controls">${compSel('tComp', c, false)}</div><div class="split">
  <div class="card"><h3>Bet9ja league table <small>${st ? 'week ' + st.week : ''}</small></h3><table><tr><th>#</th><th>Team</th><th class="n">Pts</th><th>Form</th></tr>${rows.map(([t, pts, form], i) => `<tr><td>${i + 1}</td><td><b>${esc(t)}</b></td><td class="n">${pts}</td><td><span class="form">${String(form || '').split('').map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>`).join('') || '<tr><td class="mute">Not loaded yet</td></tr>'}</table></div>
  <div class="card"><h3>Recorded team stats <small>${ms.length} matches · rating = attack × defence strength</small></h3><div class="scroll" style="max-height:620px"><table><tr><th>Team</th><th class="n">P</th><th class="n">W-D-L</th><th class="n">Goals</th><th class="n">O2.5</th><th class="n">GG</th><th class="n">Attack</th><th class="n">Defence</th></tr>
  ${Object.entries(ts).sort((a, b) => (T.att[b[0]] / T.def[b[0]]) - (T.att[a[0]] / T.def[a[0]])).map(([t, x]) => `<tr><td><b>${esc(t)}</b></td><td class="n">${x.P}</td><td class="n">${x.W}-${x.D}-${x.L}</td><td class="n">${x.GF}:${x.GA}</td><td class="n">${pc(100 * x.O25 / x.P)}</td><td class="n">${pc(100 * x.GG / x.P)}</td><td class="n">${f2(T.att[t])}</td><td class="n">${f2(T.def[t])}</td></tr>`).join('')}</table></div>
  <p class="mute" style="font-size:13px">Attack above 1 scores more than average; defence below 1 concedes less than average.</p></div></div>`;
}

// ---------------- PREDICTION LEDGER
function rLedger() {
  const ls = St.ledgerStats || {};
  const preds = St.predRecent || [];
  const settles = St.settleRecent || [];
  const sById = new Map(settles.map(s => [s.predictionId, s]));
  const modelVersion = ls.modelVersion || (typeof LPLedger !== 'undefined' ? LPLedger.VERSION : '—');
  const settledPct = ls.predictions ? 100 * (ls.settlements || 0) / ls.predictions : null;
  const agg = {};
  for (const s of settles) {
    for (const m of ['fair', 'mkt', 'team', 'dc', 'emp', 'blend', 'ensemble', 'weighted', 'calibrated']) {
      const x = s.metrics && s.metrics[m];
      if (!x || !x.n) continue;
      const a = agg[m] = agg[m] || { n: 0, brier: 0, ll: 0 };
      a.n += x.n; a.brier += x.brier * x.n; a.ll += x.logLoss * x.n;
    }
  }
  const metricsRows = Object.entries(agg).map(([m, a]) => `<tr><td><b>${esc(m)}</b></td><td class="n">${a.n.toLocaleString()}</td><td class="n">${f4(a.brier / a.n)}</td><td class="n">${f4(a.ll / a.n)}</td></tr>`).join('');
  const rows = preds.map(p => {
    const s = sById.get(p.predictionId);
    const cat = catFor({ catalogueVersion: p.catalogueVersion });
    const idx = p.candidateId != null && Array.isArray(p.ids) ? p.ids.indexOf(p.candidateId) : -1;
    const c = idx >= 0 ? cat[p.ids[idx]] : null;
    const pick = c ? selLabel(c, p.home, p.away) : (p.candidateId != null ? '#' + p.candidateId : '–');
    const odds = idx >= 0 ? p.odds[idx] : null;
    const ens = idx >= 0 ? p.ensemble[idx] : null;
    const cal = idx >= 0 && Array.isArray(p.calibrated) ? p.calibrated[idx] : null;
    const lo = idx >= 0 ? p.plow[idx] : null;
    const hi = idx >= 0 ? p.phigh[idx] : null;
    const pLo = idx >= 0 && Array.isArray(p.pLow) ? p.pLow[idx] : null;
    const pHi = idx >= 0 && Array.isArray(p.pHigh) ? p.pHigh[idx] : null;
    const ev = idx >= 0 ? p.ev[idx] : null;
    const b = s && s.metrics && s.metrics.ensemble ? s.metrics.ensemble : null;
    const res = s && s.result ? `${s.result.hg}-${s.result.ag}` : '–';
    const unc = idx >= 0 && Array.isArray(p.uncertainty) ? p.uncertainty[idx] : null;
    const decisionLabel = (p.decision || 'NO_BET') + (p.stakeUnits ? ' · ' + f2(p.stakeUnits) + 'u' : '');
    const betLine = s && s.bet ? ' · ' + (s.bet.won ? 'won' : 'lost') + ' ' + (s.bet.profitUnits >= 0 ? '+' : '') + f2(s.bet.profitUnits) + 'u' : '';
    return `<tr><td>${p.asOf ? fmtT(p.asOf) : '–'}</td><td>${esc(cname(p.comp))}</td><td><b>${esc(p.home)} v ${esc(p.away)}</b></td><td><span class="pill">${esc(p.checkpoint || '–')}</span></td><td>${esc(pick)}</td><td class="n">${f2(odds)}</td><td class="n">${pp(ens)}</td><td class="n">${pp(cal)}</td><td class="n">${pLo != null ? pp(pLo) + ' – ' + pp(pHi) : '–'}<div class="gm">${esc(unc || '–')} · n=${idx >= 0 && Array.isArray(p.nEff) ? p.nEff[idx] : '–'}</div></td><td class="n">${pp(lo)} – ${pp(hi)}</td><td class="n">${pe(ev)}</td><td><span class="pill ${p.decision === 'BET' ? 'pick' : 'nobet'}">${esc(decisionLabel)}</span></td><td>${s ? '<span class="pill">settled ' + esc(res) + '</span>' + betLine : '<span class="mute">pending</span>'}</td><td class="n">${b ? f4(b.brier) : '–'}</td><td class="n">${b ? f4(b.logLoss) : '–'}</td><td class="n">${b ? b.n : '–'}</td></tr>`;
  }).join('');
  view.innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${(ls.predictions || 0).toLocaleString()}</div><div class="l">Immutable predictions</div></div>
    <div class="kpi"><div class="v">${(ls.settlements || 0).toLocaleString()}</div><div class="l">Settled predictions</div></div>
    <div class="kpi"><div class="v">${settledPct == null ? '–' : settledPct.toFixed(1) + '%'}</div><div class="l">Settlement coverage</div></div>
    <div class="kpi"><div class="v">${(ls.recentOpen || 0)} / ${(ls.recentMid || 0)} / ${(ls.recentPreclose || 0)}</div><div class="l">Recent open / mid / pre-close</div></div>
    <div class="kpi"><div class="v" style="font-size:18px">${esc(modelVersion)}</div><div class="l">Ledger model version</div></div>
    <div class="kpi"><div class="v" style="font-size:18px">${esc(ls.ciMethod || (typeof LPLedger !== 'undefined' ? LPLedger.CI_METHOD : '—'))}</div><div class="l">Uncertainty method</div></div>
  </div>
  <div class="note"><b>Stage 9 ledger:</b> every row is written before the match closes and settled in a separate immutable row. Each selection records the equal ensemble, optional weighted/calibrated probabilities, the model range, an approximate Wilson interval and the decision policy. A BET is only possible when a validated Stage 9 policy is active; otherwise the decision remains <b>NO BET</b>. Stake and settlement profit are recorded for BET rows.</div>
  <div class="controls"><button class="btn ghost" data-act="recordLedger">📝 Record current open-round predictions</button><button class="btn" data-act="settleLedger">⚖ Settle ledger now</button></div>
  <div class="card"><h3>Recent predictions <small>latest 160 by prediction time · candidate = highest lower confidence bound</small></h3><div class="scroll" style="max-height:620px"><table><tr><th>When</th><th>League</th><th>Fixture</th><th>Checkpoint</th><th>Candidate</th><th class="n">Odds</th><th class="n">Ensemble</th><th class="n">Calibrated</th><th class="n">95% approx</th><th class="n">Model range</th><th class="n">EV</th><th>Decision</th><th>Result</th><th class="n">Brier</th><th class="n">Log loss</th><th class="n">n</th></tr>${rows || '<tr><td colspan="16" class="mute">No ledger rows yet. They are recorded automatically by the background capture, or with the button above while a round is open.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Recent settlement metrics <small>recent settled predictions only; this is not yet a calibration report</small></h3><table><tr><th>Model</th><th class="n">Settled selections</th><th class="n">Brier</th><th class="n">Log loss</th></tr>${metricsRows || '<tr><td colspan="4" class="mute">No settlements yet.</td></tr>'}</table></div>`;
}
async function recordLedger() {
  if (typeof LPLedger === 'undefined') { alert('Ledger module not loaded.'); return; }
  const fixtures = (St.up || []).filter(f => f && f.close > Date.now());
  if (!fixtures.length) { alert('No open-round fixtures right now.'); return; }
  let learned = {};
  try { if (typeof LPLearn !== 'undefined') learned = await LPLearn.activeOpts({ db: LPDB }); } catch (e) { }
  const calibration = learned.calibration || (St.calibration && St.calibration.calibration && St.calibration.calibration.decision && St.calibration.calibration.decision.enabled ? St.calibration.calibration.decision.calibrator : null);
  const weights = learned.weights || (St.calibration && St.calibration.weights && St.calibration.weights.decision && St.calibration.weights.decision.enabled ? St.calibration.weights.decision.weights : null);
  const calibrationVersion = learned.calibrationVersion || (calibration ? calibration.version : null);
  const weightsVersion = learned.weightsVersion || (weights && typeof LPWeights !== 'undefined' ? LPWeights.VERSION : null);
  try {
    const r = await LPLedger.recordFixtures({ fixtures, selsets: St.selsets, cat: St.cat, db: LPDB, asOf: Date.now(), halfLifeH: St.ui.halfLifeH, catalogueVersion: St.catCurrent?.version, calibration, calibrate: learned.calibrate, weights, calibrationVersion, weightsVersion });
    await load(); render(true);
    alert(`Ledger: ${r.recorded} recorded, ${r.skipped} skipped, ${r.conflicts} conflict(s).${r.errors && r.errors.length ? ' ' + r.errors.length + ' error(s).' : ''}`);
  } catch (e) { alert('Ledger record failed: ' + e.message); }
}
async function settleLedger() {
  if (typeof LPLedger === 'undefined') { alert('Ledger module not loaded.'); return; }
  try {
    const r = await LPLedger.settleAll({ db: LPDB });
    await load(); render(true);
    alert(`Ledger settlement: ${r.settled} settled, ${r.skipped} skipped, ${r.invalid} invalid, ${r.missingCatalogue} missing catalogue, ${r.conflicts} conflict(s).`);
  } catch (e) { alert('Ledger settlement failed: ' + e.message); }
}

// ---------------- RESEARCH
const RESEARCH_QUESTIONS = {
  H1: 'Historical results contain serial information',
  H2: 'Team identities have persistent statistical characteristics',
  H3: 'Competitions have different scoring/outcome distributions',
  H4: 'Round sequences contain significant patterns',
  H5: 'Score frequencies change over time',
  H6: 'Market odds contain information beyond historical scores',
  H7: 'Combining history with the market improves predictions',
  H8: 'Some conditions are more predictable than others'
};
const researchPill = s => {
  const cls = s === 'supported' || s === 'validated' ? 'sev-ok' : s === 'exploratory' ? 'sev-warn' : '';
  return `<span class="pill ${cls}">${esc(s || '–')}</span>`;
};
function rResearch() {
  const r = St.research;
  const head = `<div class="note"><b>Stage 4 research:</b> these are statistical investigations of the recorded game, not betting instructions. A result is only marked <b>supported</b> when it survives Benjamini–Hochberg correction, an effect threshold and, where applicable, a consistent out-of-sample direction. Small samples are marked <b>insufficient</b> instead of being over-interpreted.</div>
  <div class="controls"><button class="btn" data-act="runResearch">🔬 Run research on recorded matches</button><span class="mute" style="font-size:13px">Uses the most recent 2,000 matches and records the report in this tab only.</span></div>`;
  if (!r) {
    view.innerHTML = head + `<div class="empty"><h2>Research not run yet</h2><p>Run the tests after the engine has recorded enough rounds. With a very small sample, most hypotheses will legitimately return “insufficient”.</p></div>`;
    return;
  }
  const m = r.meta || {};
  const hyp = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'].map(id => {
    const h = r.hypotheses[id] || {};
    return `<tr><td><b>${id}</b></td><td>${esc(RESEARCH_QUESTIONS[id])}</td><td>${esc(h.kind || '')}</td><td>${researchPill(h.status)}</td><td class="n">${(h.n || 0).toLocaleString()}</td><td class="n">${f3(h.effect)}</td><td class="n">${h.ci ? esc('[' + f3(h.ci[0]) + ', ' + f3(h.ci[1]) + ']') : '–'}</td><td class="n">${f3(h.p)}</td><td class="n">${f3(h.q)}</td></tr>`;
  }).join('');
  const tests = (r.tests || []).slice().sort((a, b) => (a.p == null ? 2 : a.p) - (b.p == null ? 2 : b.p)).slice(0, 50).map(t => `<tr><td>${esc(t.hypothesis || '')}</td><td>${esc(t.name || '')}</td><td class="n">${t.n || 0}</td><td class="n">${f3(t.stat)}</td><td class="n">${f3(t.effect)}</td><td class="n">${f3(t.p)}</td><td class="n">${f3(t.q)}</td></tr>`).join('');
  const patterns = (r.patterns || []).slice(0, 60).map(p => `<tr><td>${esc(cname(p.comp))}</td><td>${esc(p.condition)}</td><td>${esc(p.outcome)}</td><td class="n">${p.n}</td><td class="n">${pp(p.baseline)}</td><td class="n">${pp(p.observed)}</td><td class="n">${pe(p.diff)}</td><td class="n">${p.ci ? esc('[' + pp(p.ci[0]) + ', ' + pp(p.ci[1]) + ']') : '–'}</td><td class="n">${f3(p.p)}</td><td class="n">${f3(p.q)}</td><td>${p.oos && p.oos.sameDirection != null ? (p.oos.sameDirection ? '<span class="good">yes</span>' : '<span class="bad">no</span>') : '–'}</td><td>${researchPill(p.status)}</td></tr>`).join('');
  const info = Object.entries(r.information || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.matches}</td><td class="n">${v.rounds}</td><td class="n">${f3(v.outcomeEntropyBits)}</td><td class="n">${f3(v.totalGoalEntropyBits)}</td><td class="n">${f3(v.roundTransitionMiBits)}</td><td class="n">${f3(v.roundTransitionConditionalEntropyBits)}</td><td class="n">${f3(v.roundTransitionMi && v.roundTransitionMi.p)}</td></tr>`).join('');
  const warnings = (m.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
  const limitations = (r.limitations || []).map(w => `<li>${esc(w)}</li>`).join('');
  view.innerHTML = head + `<div class="kpis">
    <div class="kpi"><div class="v">${(m.matches || 0).toLocaleString()}</div><div class="l">Matches analysed</div></div>
    <div class="kpi"><div class="v">${(m.rounds || 0).toLocaleString()}</div><div class="l">Rounds analysed</div></div>
    <div class="kpi"><div class="v">${(m.competitions || 0)}</div><div class="l">Competitions</div></div>
    <div class="kpi"><div class="v">${(r.patterns || []).length}</div><div class="l">Conditional patterns reported</div></div>
    <div class="kpi"><div class="v">${(r.patterns || []).filter(p => p.status === 'validated').length}</div><div class="l">Validated patterns</div></div>
  </div>
  ${warnings ? `<div class="note"><b>Sample warnings</b><ul>${warnings}</ul></div>` : ''}
  <div class="card"><h3>Hypotheses <small>${esc(m.version || '')} · ${m.dateRange ? new Date(m.dateRange.from).toLocaleDateString() + ' → ' + new Date(m.dateRange.to).toLocaleDateString() : ''}</small></h3><table><tr><th>ID</th><th>Question</th><th>Kind</th><th>Status</th><th class="n">n</th><th class="n">Effect</th><th class="n">95% interval</th><th class="n">p</th><th class="n">q (BH)</th></tr>${hyp}</table>
  <p class="mute" style="font-size:13px">Effect definitions vary by test: autocorrelation, split-half correlation, epsilon-squared/Cramér's V, mutual information in bits, mean Brier/log-loss difference, or mean goal change. Read the test detail table before interpreting a number.</p></div>
  <div class="card" style="margin-top:16px"><h3>Test detail <small>raw tests before/after multiple-testing correction</small></h3><div class="scroll" style="max-height:360px"><table><tr><th>H</th><th>Test</th><th class="n">n</th><th class="n">Statistic</th><th class="n">Effect</th><th class="n">p</th><th class="n">q</th></tr>${tests || '<tr><td colspan="7" class="mute">No tests produced a finite p-value at this sample size.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Conditional-probability patterns <small>only rows with enough support are shown; validated requires q &lt; 0.10 and consistent out-of-sample direction</small></h3><div class="scroll" style="max-height:420px"><table><tr><th>League</th><th>Condition</th><th>Outcome</th><th class="n">n</th><th class="n">Baseline</th><th class="n">Observed</th><th class="n">Diff</th><th class="n">95% CI</th><th class="n">p</th><th class="n">q</th><th>OOS</th><th>Status</th></tr>${patterns || '<tr><td colspan="12" class="mute">No pattern met the minimum support threshold.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Information theory <small>bits · MI permutation p is a null check</small></h3><table><tr><th>Scope</th><th class="n">Matches</th><th class="n">Rounds</th><th class="n">Outcome entropy</th><th class="n">Total-goal entropy</th><th class="n">Round MI</th><th class="n">Conditional entropy</th><th class="n">MI p</th></tr>${info}</table></div>
  <div class="note"><b>Limitations</b><ul>${limitations}</ul></div>`;
}
function runResearch() {
  if (typeof LPResearch === 'undefined') { alert('Research module not loaded.'); return; }
  if (!St.matches.length) { alert('No recorded matches yet.'); return; }
  const btn = document.querySelector('[data-act="runResearch"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Running research…'; }
  setTimeout(() => {
    try {
      St.research = LPResearch.analyze({
        matches: St.matches.slice(-2000), cat: St.cat, selsets: St.selsets,
        options: { minMatches: 100, minRounds: 30, minTeams: 8, minPatternN: 30, permutations: 199, seed: 20261124 }
      });
      render(true);
    } catch (e) {
      alert('Research failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '🔬 Run research on recorded matches'; }
    }
  }, 20);
}

// ---------------- SPECIALISTS
function specialistPill(enabled) { return `<span class="pill ${enabled ? 'sev-ok' : 'sev-warn'}">${enabled ? 'enabled' : 'disabled'}</span>`; }
function rSpecialists() {
  const r = St.specialists;
  const head = `<div class="note"><b>Stage 6 evaluation gate:</b> a sequence or pattern specialist may be considered for production only when it beats the Stage 5 ensemble out-of-sample after paired correction. Discovery is not activation. Specialists that do not pass remain disabled and do not enter the ledger, ensemble or decision path.</div>
  <div class="controls"><button class="btn" data-act="runSpecialists">🧬 Evaluate specialists</button><span class="mute" style="font-size:13px">Uses the most recent 2,000 matches; the first training window is held out chronologically.</span></div>`;
  if (!r) { view.innerHTML = head + `<div class="empty"><h2>Specialists not evaluated yet</h2><p>Run the evaluator after enough rounds. A small sample will normally disable both specialists, which is the correct outcome.</p></div>`; return; }
  const m = r.meta || {}, sr = r.sequence && r.sequence.comparison, pr = r.patterns && r.patterns.comparison;
  const metricRows = Object.entries(r.byModel || {}).filter(([k, v]) => k !== 'byMarket' && v && v.n).map(([model, c]) => `<tr><td><b>${esc(model)}</b></td><td class="n">${c.n}</td><td class="n">${f4(c.brier)}</td><td class="n">${f4(c.logLoss)}</td></tr>`).join('');
  const patternRows = (r.patterns && r.patterns.top || []).slice(0, 40).map(p => `<tr><td>${esc(p.description)}</td><td class="n">${p.n}</td><td class="n">${pp(p.baseline)}</td><td class="n">${pp(p.observed)}</td><td class="n">${pe(p.diff)}</td><td class="n">${esc(p.ci ? '[' + pp(p.ci[0]) + ', ' + pp(p.ci[1]) + ']' : '–')}</td><td class="n">${f3(p.p)}</td><td class="n">${f3(p.q)}</td><td>${p.oos && p.oos.sameDirection != null ? (p.oos.sameDirection ? '<span class="good">yes</span>' : '<span class="bad">no</span>') : '–'}</td><td>${researchPill(p.status)}</td></tr>`).join('');
  const warnings = (r.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
  const checks = r.checks || [];
  view.innerHTML = head + `<div class="kpis">
    <div class="kpi"><div class="v">${(m.testMatches || 0).toLocaleString()}</div><div class="l">Test matches</div></div>
    <div class="kpi"><div class="v">${(m.sequenceUsable || 0).toLocaleString()}</div><div class="l">Sequence-usable observations</div></div>
    <div class="kpi"><div class="v">${(m.patternRules || 0).toLocaleString()}</div><div class="l">Pattern rules discovered</div></div>
    <div class="kpi"><div class="v ${m.patternValidated ? 'good' : 'warnc'}">${m.patternValidated || 0}</div><div class="l">Validated rules</div></div>
    <div class="kpi"><div class="v">${specialistPill(r.sequence && r.sequence.enabled)}</div><div class="l">Sequence model</div></div>
    <div class="kpi"><div class="v">${specialistPill(r.patterns && r.patterns.enabled)}</div><div class="l">Pattern model</div></div>
  </div>
  ${warnings ? `<div class="note"><b>Decision warnings</b><ul>${warnings}</ul></div>` : ''}
  <div class="card"><h3>Automatic decisions <small>paired 1X2 log loss versus the Stage 5 equal ensemble</small></h3><table><tr><th>Specialist</th><th>Status</th><th class="n">n</th><th class="n">Log-loss difference</th><th class="n">95% interval</th><th class="n">p</th><th class="n">q (BH)</th></tr>
  <tr><td><b>Sequence</b></td><td>${specialistPill(r.sequence && r.sequence.enabled)}</td><td class="n">${sr ? sr.n : 0}</td><td class="n">${sr ? f4(sr.diffLogLoss) : '–'}</td><td class="n">${sr ? esc('[' + f4(sr.low) + ', ' + f4(sr.high) + ']') : '–'}</td><td class="n">${sr ? f4(sr.p) : '–'}</td><td class="n">${sr ? f4(sr.q) : '–'}</td></tr>
  <tr><td><b>Patterns</b></td><td>${specialistPill(r.patterns && r.patterns.enabled)}</td><td class="n">${pr ? pr.n : 0}</td><td class="n">${pr ? f4(pr.diffLogLoss) : '–'}</td><td class="n">${pr ? esc('[' + f4(pr.low) + ', ' + f4(pr.high) + ']') : '–'}</td><td class="n">${pr ? f4(pr.p) : '–'}</td><td class="n">${pr ? f4(pr.q) : '–'}</td></tr></table>
  <p class="mute" style="font-size:13px">Negative difference means the specialist had lower log loss. A specialist must be negative, p &lt; 0.05, q &lt; 0.10 and have sufficient usable observations; otherwise it is disabled.</p></div>
  <div class="card" style="margin-top:16px"><h3>Model metrics</h3><table><tr><th>Model</th><th class="n">Selections</th><th class="n">Brier</th><th class="n">Log loss</th></tr>${metricRows || '<tr><td colspan="4" class="mute">No evaluable selections.</td></tr>'}</table></div>
  <div class="card" style="margin-top:16px"><h3>Top discovered rules <small>support, baseline, observed, uncertainty, FDR and out-of-sample direction</small></h3><div class="scroll" style="max-height:420px"><table><tr><th>Rule</th><th class="n">n</th><th class="n">Baseline</th><th class="n">Observed</th><th class="n">Diff</th><th class="n">95% CI</th><th class="n">p</th><th class="n">q</th><th>OOS</th><th>Status</th></tr>${patternRows || '<tr><td colspan="10" class="mute">No rule met the support threshold.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Leakage checks</h3><p>${checks.length} chronological training windows checked; failures: <b class="${checks.some(c => c.leakage) ? 'bad' : 'good'}">${checks.filter(c => c.leakage).length}</b>.</p></div>
  <div class="note"><b>Current decision:</b> ${(r.sequence && r.sequence.enabled) || (r.patterns && r.patterns.enabled) ? 'at least one specialist passed the gate; re-run the full walk-forward report before relying on it.' : 'both specialists remain disabled and are excluded from the Stage 5 ensemble, the immutable ledger and every recommendation.'} Stage 7 may re-evaluate them after calibration and adaptive weighting.</div>`;
}
function runSpecialists() {
  if (typeof LPSpecialists === 'undefined') { alert('Specialist module not loaded.'); return; }
  if (!St.matches.length) { alert('No recorded matches yet.'); return; }
  const btn = document.querySelector('[data-act="runSpecialists"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Evaluating specialists…'; }
  setTimeout(() => {
    try {
      St.specialists = LPSpecialists.evaluate({
        matches: St.matches.slice(-2000), cat: St.cat, selsets: St.selsets,
        options: { minTrainRounds: 3, minCompMatches: 10, minPatternSupport: 30, maxTestRounds: 20, permutations: 199, seed: 20261124 }
      });
      render(true);
    } catch (e) {
      alert('Specialist evaluation failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '🧬 Evaluate specialists'; }
    }
  }, 20);
}

// ---------------- CALIBRATION & ADAPTIVE WEIGHTS
function rCalibration() {
  const r = St.calibration;
  const head = `<div class="note"><b>Stage 7 calibration and weights:</b> a calibrator or weight vector is activated only when it beats the raw ensemble in a chronological walk-forward comparison, with paired bootstrap uncertainty and Benjamini–Hochberg correction. A failed gate is reported as disabled; nothing is silently applied.</div>
  <div class="controls"><button class="btn" data-act="runCalibration">🎯 Run calibration &amp; weight analysis</button><span class="mute" style="font-size:13px">Uses the most recent 1,500 matches and up to 12 test rounds. Model probabilities are regenerated walk-forward before calibration is fitted; this can take up to a minute.</span></div>`;
  if (!r) {
    view.innerHTML = head + `<div class="empty"><h2>Calibration not evaluated yet</h2><p>Run the analysis after enough rounds. With a small sample the correct outcome is usually <b>disabled</b>: the raw equal ensemble remains in use and uncertainty bounds are shown as approximate.</p></div>`;
    return;
  }
  const cal = r.calibration || {}, w = r.weights || {};
  const raw = cal.reliability && cal.reliability.raw;
  const calRel = cal.reliability && cal.reliability.calibrated;
  const methods = (cal.metrics && cal.metrics.methods) || {};
  const calRows = Object.entries(methods).map(([m, x]) => `<tr><td><b>${esc(m)}</b></td><td class="n">${x.n || 0}</td><td class="n">${f4(x.brier)}</td><td class="n">${f4(x.logLoss)}</td><td class="n">${f4(x.diffLogLoss)}</td><td class="n">${x.low != null ? esc('[' + f4(x.low) + ', ' + f4(x.high) + ']') : '–'}</td><td class="n">${f4(x.p)}</td><td class="n">${f4(x.q)}</td></tr>`).join('');
  const bins = (raw && raw.bins || []).map((b, i) => {
    const c = calRel && calRel.bins ? calRel.bins[i] : null;
    const bars = b.n ? `<div class="bar" title="predicted ${pp(b.avgP)}"><span style="width:${Math.max(0, Math.min(100, b.avgP * 100))}%"></span></div><div class="bar" style="margin-top:2px" title="observed ${pp(b.obs)}"><span style="width:${Math.max(0, Math.min(100, b.obs * 100))}%"></span></div>` : '–';
    return `<tr><td class="n">${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%</td><td class="n">${b.n}</td><td class="n">${pp(b.avgP)}</td><td class="n">${pp(b.obs)}</td><td class="n">${pe(b.gap)}</td><td style="min-width:90px">${bars}<div class="gm">predicted / observed</div></td><td class="n">${c ? c.n : '–'}</td><td class="n">${c ? pp(c.avgP) : '–'}</td><td class="n">${c ? pp(c.obs) : '–'}</td><td class="n">${c ? pe(c.gap) : '–'}</td></tr>`;
  }).join('');
  const decomp = (label, rel) => rel && rel.decomposition ? `<tr><td><b>${esc(label)}</b></td><td class="n">${rel.n}</td><td class="n">${f4(rel.brier)}</td><td class="n">${f4(rel.logLoss)}</td><td class="n">${f4(rel.decomposition.uncertainty)}</td><td class="n">${f4(rel.decomposition.reliability)}</td><td class="n">${f4(rel.decomposition.resolution)}</td><td class="n">${f4(rel.ece)}</td><td class="n">${f4(rel.mce)}</td></tr>` : '';
  const wm = w.metrics || {};
  const weightRows = ['equal', 'global', 'perMarket', 'market'].map(k => wm[k] ? `<tr><td><b>${esc(k)}</b></td><td class="n">${wm[k].n}</td><td class="n">${f4(wm[k].brier)}</td><td class="n">${f4(wm[k].logLoss)}</td></tr>` : '').join('');
  const singleRows = Object.entries(wm.single || {}).map(([k, x]) => `<tr><td>${esc(LPWeights.LABELS[k] || k)}</td><td class="n">${x.n}</td><td class="n">${f4(x.brier)}</td><td class="n">${f4(x.logLoss)}</td></tr>`).join('');
  const wt = (w.decision && (w.decision.weights || w.decision.rawWeights)) || {};
  const weightList = LPWeights.MODELS.map(m => `<tr><td>${esc(LPWeights.LABELS[m] || m)}</td><td class="n">${wt[m] == null ? '–' : (wt[m] * 100).toFixed(1) + '%'}</td><td class="n">${w.decision && w.decision.rawWeights && w.decision.rawWeights[m] != null ? (w.decision.rawWeights[m] * 100).toFixed(1) + '%' : '–'}</td></tr>`).join('');
  const cmpRows = (w.comparisons || []).map(c => `<tr><td><b>${esc(c.model)}</b></td><td class="n">${c.n}</td><td class="n">${f4(c.diffLogLoss)}</td><td class="n">${c.low != null ? esc('[' + f4(c.low) + ', ' + f4(c.high) + ']') : '–'}</td><td class="n">${f4(c.p)}</td><td class="n">${f4(c.q)}</td></tr>`).join('');
  const pmRows = (w.perMarket || []).map(x => `<tr><td><b>${esc(x.market)}</b></td><td class="n">${x.n}</td><td class="n">${f4(x.diffLogLoss)}</td><td class="n">${x.low != null ? esc('[' + f4(x.low) + ', ' + f4(x.high) + ']') : '–'}</td><td class="n">${f4(x.p)}</td><td class="n">${f4(x.q)}</td><td>${specialistPill(!!x.enabled)}</td></tr>`).join('');
  const warnings = (r.warnings || []).filter((x, i, a) => a.indexOf(x) === i).map(x => `<li>${esc(x)}</li>`).join('');
  const calOn = !!(cal.decision && cal.decision.enabled);
  const wOn = !!(w.decision && w.decision.enabled);
  view.innerHTML = head + `<div class="kpis">
    <div class="kpi"><div class="v">${(r.samples || 0).toLocaleString()}</div><div class="l">Walk-forward selections</div></div>
    <div class="kpi"><div class="v">${(r.meta && r.meta.testMatches || 0).toLocaleString()}</div><div class="l">Test fixtures</div></div>
    <div class="kpi"><div class="v">${calOn ? esc(cal.decision.method) : 'disabled'}</div><div class="l">Calibration</div></div>
    <div class="kpi"><div class="v">${wOn ? 'adaptive' : 'equal'}</div><div class="l">Model weights</div></div>
    <div class="kpi"><div class="v">${raw ? f4(raw.logLoss) : '–'}</div><div class="l">Raw ensemble log loss</div></div>
    <div class="kpi"><div class="v">${calOn && calRel ? f4(calRel.logLoss) : '–'}</div><div class="l">Calibrated log loss</div></div>
  </div>
  ${warnings ? `<div class="note"><b>Gate warnings</b><ul>${warnings}</ul></div>` : ''}
  <div class="card"><h3>Calibration decision <small>raw versus walk-forward calibrated, paired selection-level log loss</small></h3>
    <table><tr><th>Method</th><th class="n">Test selections</th><th class="n">Brier</th><th class="n">Log loss</th><th class="n">Difference</th><th class="n">95% interval</th><th class="n">p</th><th class="n">q (BH)</th></tr>${calRows || '<tr><td colspan="8" class="mute">No calibration method had a finite comparison.</td></tr>'}</table>
    <p class="mute" style="font-size:13px">Negative difference means calibration improved the loss. Activation requires a negative difference, p &lt; 0.05, q &lt; 0.10 and enough test selections. The ledgers and decisions remain conservative.</p></div>
  <div class="card" style="margin-top:16px"><h3>Reliability</h3><div class="scroll" style="max-height:360px"><table><tr><th>Bin</th><th class="n">Raw n</th><th class="n">Raw predicted</th><th class="n">Raw observed</th><th class="n">Raw gap</th><th>Diagram</th><th class="n">Cal n</th><th class="n">Cal predicted</th><th class="n">Cal observed</th><th class="n">Cal gap</th></tr>${bins || '<tr><td colspan="10" class="mute">Reliability requires a walk-forward test sample.</td></tr>'}</table></div>
    <table style="margin-top:12px"><tr><th>Series</th><th class="n">n</th><th class="n">Brier</th><th class="n">Log loss</th><th class="n">Uncertainty</th><th class="n">Reliability</th><th class="n">Resolution</th><th class="n">ECE</th><th class="n">MCE</th></tr>${decomp('raw', raw)}${decomp('calibrated', calRel)}</table></div>
  <div class="card" style="margin-top:16px"><h3>Adaptive model weights <small>learned on prior walk-forward selections and shrunk toward equal</small></h3>
    <table><tr><th>Model</th><th class="n">Active weight</th><th class="n">Unshrunk fit</th></tr>${weightList}</table>
    <table style="margin-top:12px"><tr><th>Series</th><th class="n">Selections</th><th class="n">Brier</th><th class="n">Log loss</th></tr>${weightRows}${singleRows}</table>
    <p class="mute" style="font-size:13px">The active weight includes shrinkage toward 1/K. A disabled weight vector means the equal ensemble remains in use.</p></div>
  <div class="card" style="margin-top:16px"><h3>Weight comparison <small>paired log loss against the equal ensemble</small></h3><table><tr><th>Weighting</th><th class="n">n</th><th class="n">Difference</th><th class="n">95% interval</th><th class="n">p</th><th class="n">q</th></tr>${cmpRows || '<tr><td colspan="6" class="mute">No weight comparison had enough test selections.</td></tr>'}</table>
    <table style="margin-top:12px"><tr><th>Market</th><th class="n">n</th><th class="n">Difference</th><th class="n">95% interval</th><th class="n">p</th><th class="n">q</th><th>Status</th></tr>${pmRows || '<tr><td colspan="7" class="mute">No per-market weight comparison.</td></tr>'}</table></div>
  <div class="note"><b>Uncertainty:</b> every probability also carries an approximate Wilson interval derived from the fixture's effective evidence (weakest team sample or market fit). It is recorded in the ledger as <b>pLow/pHigh</b> and is not a guarantee. The final decision engine and value thresholds are Stage 9.</div>`;
}
function runCalibration() {
  if (typeof LPCalibration === 'undefined' || typeof LPWeights === 'undefined' || typeof LPModelEval === 'undefined') { alert('Calibration modules not loaded.'); return; }
  if (!St.matches.length) { alert('No recorded matches yet.'); return; }
  const btn = document.querySelector('[data-act="runCalibration"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Running calibration…'; }
  setTimeout(async () => {
    try {
      const ms = St.matches.slice(-1500);
      const collected = LPCalibration.collect({
        matches: ms, cat: St.cat, selsets: St.selsets,
        options: { minTrainRounds: 3, minCompMatches: 10, maxTestRounds: 12, permutations: 199, seed: 20261124 }
      });
      const calibration = LPCalibration.walkForward(collected.samples, {
        minTrainSamples: 200, minTestSamples: 100, folds: 3, bins: 10, permutations: 199, seed: 20261124
      });
      const weights = LPWeights.evaluate(collected.samples, {
        minTrainSamples: 200, minTestSamples: 100, folds: 3, shrink: 0.5, permutations: 199, seed: 20261124
      });
      St.calibration = {
        generatedAt: Date.now(), samples: collected.samples.length, meta: collected.meta,
        calibration, weights,
        warnings: [...(collected.warnings || []), ...(calibration.warnings || []), ...(weights.warnings || [])]
      };
      render(true);
    } catch (e) {
      alert('Calibration failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '🎯 Run calibration & weight analysis'; }
    }
  }, 20);
}

// ---------------- AUTONOMOUS LEARNING
const learnPill = s => `<span class="pill ${s === 'candidate' || s === 'active' ? 'sev-ok' : s === 'rejected' ? 'sev-warn' : ''}">${esc(s || '–')}</span>`;
function rLearning() {
  const r = St.learning;
  const head = `<div class="note"><b>Stage 8 autonomous learning:</b> the engine refits calibration and adaptive weights only when enough new matches have arrived and a minimum interval has elapsed. Every candidate state is stored with its walk-forward evidence. Activation is a pointer swap; rejected states are kept for audit and cannot be activated without an explicit force.</div>
  <div class="controls"><button class="btn" data-act="runLearning">🧠 Refresh learning now</button><button class="btn ghost" data-act="rollbackLearning" data-version="">↩ Roll back to equal ensemble</button><span class="mute" style="font-size:13px">Automatic refresh runs hourly in the background and skips unless the configured data/time thresholds are met.</span></div>`;
  if (!r) { view.innerHTML = head + `<div class="empty"><h2>Learning state not loaded</h2><p>Reload the extension or open the dashboard after the background service worker has initialised.</p></div>`; return; }
  const cfg = r.config || {};
  const active = r.active;
  const states = r.states || [];
  const logs = r.log || [];
  const activeVersion = active ? active.version : null;
  const activeCal = active && active.calibration && active.calibration.enabled ? active.calibration.method : 'off';
  const activeW = active && active.weights && active.weights.enabled ? 'adaptive' : 'equal';
  const activeDec = active && active.decision && active.decision.enabled ? 'active' : 'NO BET';
  const stateRows = states.map(s => {
    const isActive = s.version === activeVersion;
    const cal = s.calibration && s.calibration.enabled ? s.calibration.method : '–';
    const w = s.weights && s.weights.enabled ? 'adaptive' : '–';
    const dec = s.decision && s.decision.enabled ? 'active' : '–';
    const train = s.training || {};
    const warn = (s.warnings || []).length;
    const action = isActive ? '<span class="pill">active</span>' : (s.status === 'candidate' ? `<button class="btn ghost" data-act="activateLearning" data-version="${esc(s.version)}">Activate</button>` : '<span class="mute">rejected</span>');
    return `<tr><td><b>${esc(s.version)}</b>${isActive ? ' <span class="pill sev-ok">active</span>' : ''}</td><td>${s.createdAt ? fmtT(s.createdAt) : '–'}</td><td>${learnPill(s.status)}</td><td>${esc(cal)}</td><td>${esc(w)}</td><td>${esc(dec)}</td><td class="n">${(train.sampleCount || 0).toLocaleString()}</td><td class="n">${(train.testMatches || 0).toLocaleString()}</td><td class="n">${warn}</td><td>${action}</td></tr>`;
  }).join('');
  const logRows = logs.slice(0, 80).map(x => `<tr><td>${x.ts ? fmtT(x.ts) : '–'}</td><td><b>${esc(x.type || '')}</b></td><td>${esc(x.from || '–')}</td><td>${esc(x.to || '–')}</td><td>${esc(x.reason || '')}</td><td>${esc(x.by || '–')}</td><td>${esc(x.state || '')}</td></tr>`).join('');
  const activeCard = active ? `<div class="card"><h3>Active model <small>${esc(active.version)}</small></h3>
    <table><tr><th>Field</th><th>Value</th></tr>
      <tr><td>Status</td><td>${learnPill('active')}</td></tr>
      <tr><td>Activated</td><td>${active.activation && active.activation.activatedAt ? fmtT(active.activation.activatedAt) : '–'} · ${esc(active.activation && active.activation.by || '–')}</td></tr>
      <tr><td>Calibration</td><td>${esc(activeCal)}</td></tr>
      <tr><td>Weights</td><td>${esc(activeW)}</td></tr>
      <tr><td>Decision policy</td><td>${esc(activeDec)}</td></tr>
      <tr><td>Training matches</td><td>${(active.training && active.training.matchCount || 0).toLocaleString()} · samples ${(active.training && active.training.sampleCount || 0).toLocaleString()} · test fixtures ${(active.training && active.training.testMatches || 0).toLocaleString()}</td></tr>
      <tr><td>Training window</td><td>${active.training && active.training.firstTs ? fmtT(active.training.firstTs) : '–'} → ${active.training && active.training.lastTs ? fmtT(active.training.lastTs) : '–'}</td></tr>
      <tr><td>Model versions</td><td>${esc(active.modelVersion || '–')} · ${esc(active.calibrationVersion || 'calibration off')} · ${esc(active.weightsVersion || 'weights equal')}</td></tr>
    </table>
    ${(active.warnings || []).length ? `<div class="note" style="margin-top:10px"><b>Active warnings</b><ul>${active.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <p class="mute" style="font-size:13px">This state is used by the background ledger capture. Deactivating restores the Stage 5 equal ensemble immediately.</p></div>`
    : `<div class="card"><h3>Active model <small>equal Stage 5 ensemble</small></h3><p>No learned state is active. The engine is using the equal ensemble and recording uncertainty intervals as approximate.</p></div>`;
  view.innerHTML = head + `<div class="kpis">
    <div class="kpi"><div class="v" style="font-size:18px">${activeVersion ? esc(activeVersion) : 'equal ensemble'}</div><div class="l">Active model</div></div>
    <div class="kpi"><div class="v">${states.length}</div><div class="l">Stored learning states</div></div>
    <div class="kpi"><div class="v">${esc(activeCal)}</div><div class="l">Active calibration</div></div>
    <div class="kpi"><div class="v">${esc(activeW)}</div><div class="l">Active weights</div></div>
    <div class="kpi"><div class="v">${cfg.enabled === false ? 'off' : cfg.autoActivate === false ? 'manual' : 'auto'}</div><div class="l">Learning mode</div></div>
    <div class="kpi"><div class="v">${logs.length ? fmtT(logs[0].ts) : '–'}</div><div class="l">Last audit event</div></div>
  </div>
  ${activeCard}
  <div class="card" style="margin-top:16px"><h3>Refresh policy</h3>
    <div class="controls" style="flex-wrap:wrap">
      <label><input type="checkbox" id="lcfg_enabled" ${cfg.enabled !== false ? 'checked' : ''}> Learning enabled</label>
      <label><input type="checkbox" id="lcfg_auto" ${cfg.autoActivate !== false ? 'checked' : ''}> Auto-activate candidates that pass the gate</label>
      <label>Minimum new matches <input type="number" id="lcfg_minNew" value="${cfg.minNewMatches}" min="1" step="1" style="width:90px"></label>
      <label>Minimum interval (hours) <input type="number" id="lcfg_intH" value="${cfg.minIntervalH}" min="0" step="1" style="width:90px"></label>
      <label>Minimum selections <input type="number" id="lcfg_minSamples" value="${cfg.minSamples}" min="20" step="10" style="width:100px"></label>
      <label><input type="checkbox" id="lcfg_reeval" ${cfg.reevaluateSpecialists !== false ? 'checked' : ''}> Re-evaluate specialists when calibration activates</label>
      <button class="btn" data-act="saveLearnConfig">Save policy</button>
    </div>
    <p class="mute" style="font-size:13px">The pipeline uses the Stage 7 gates unchanged: a component must improve out-of-sample log loss, pass paired correction and meet the sample floor. Auto-activation never bypasses those gates.</p></div>
  <div class="card" style="margin-top:16px"><h3>Stored states <small>every trained candidate, including rejected ones</small></h3><div class="scroll" style="max-height:420px"><table><tr><th>Version</th><th>Created</th><th>Status</th><th>Calibration</th><th>Weights</th><th>Decision</th><th class="n">Selections</th><th class="n">Test fixtures</th><th class="n">Warnings</th><th>Action</th></tr>${stateRows || '<tr><td colspan="10" class="mute">No learning states yet. The hourly job will create one after enough matches; you can run it manually.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Activation audit</h3><div class="scroll" style="max-height:360px"><table><tr><th>When</th><th>Event</th><th>From</th><th>To</th><th>Reason</th><th>By</th><th>State</th></tr>${logRows || '<tr><td colspan="7" class="mute">No audit events yet.</td></tr>'}</table></div></div>
  <div class="note"><b>Rollback:</b> activation changes only a pointer. The previous model states remain stored, so “Roll back to equal ensemble” or activating an older candidate restores the previous behaviour without retraining. The ledger records which versions were used on each row.</div>`;
}
async function learningReload() {
  await loadLearningSnapshot();
  render(true);
}
async function sendLearn(type, payload, fallback) {
  if (hasChrome && chrome.runtime && chrome.runtime.sendMessage) {
    try { return await chrome.runtime.sendMessage(Object.assign({ type }, payload || {})); } catch (e) { }
  }
  return fallback();
}
async function runLearningUI() {
  if (typeof LPLearn === 'undefined') { alert('Learning module not loaded.'); return; }
  const btn = document.querySelector('[data-act="runLearning"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Training…'; }
  try {
    const r = await sendLearn('lpLearnNow', {}, () => LPLearn.refresh({ db: LPDB, force: true }));
    await learningReload();
    if (r && r.error) alert('Learning failed: ' + r.error);
  } catch (e) { alert('Learning failed: ' + e.message); if (btn) btn.disabled = false; }
}
async function activateLearning(version) {
  if (typeof LPLearn === 'undefined') return;
  try {
    const r = await sendLearn('lpActivate', { version }, () => LPLearn.activate(LPDB, version, { by: 'dashboard', reason: 'manual activation' }));
    await learningReload();
    if (r && r.error) alert('Activation failed: ' + r.error);
  } catch (e) { alert('Activation failed: ' + e.message); }
}
async function rollbackLearning(version) {
  if (typeof LPLearn === 'undefined') return;
  try {
    const r = await sendLearn('lpRollback', { version }, () => LPLearn.rollback(LPDB, version, { by: 'dashboard' }));
    await learningReload();
    if (r && r.error) alert('Rollback failed: ' + r.error);
  } catch (e) { alert('Rollback failed: ' + e.message); }
}
async function saveLearnConfig() {
  if (typeof LPLearn === 'undefined') return;
  const patch = {
    enabled: !!$('#lcfg_enabled')?.checked,
    autoActivate: !!$('#lcfg_auto')?.checked,
    minNewMatches: +($('#lcfg_minNew')?.value || 40),
    minIntervalH: +($('#lcfg_intH')?.value || 6),
    minSamples: +($('#lcfg_minSamples')?.value || 500),
    reevaluateSpecialists: !!$('#lcfg_reeval')?.checked
  };
  try {
    const r = await sendLearn('lpLearnConfig', { config: patch }, () => LPLearn.setConfig(LPDB, patch, { by: 'dashboard' }));
    await learningReload();
    if (r && r.error) alert('Config save failed: ' + r.error);
  } catch (e) { alert('Config save failed: ' + e.message); }
}

// ---------------- DECISION & STAKING
function activeDecisionOpts() {
  const a = St.learning && St.learning.active;
  if (!a) return {};
  const o = {};
  if (a.calibration && a.calibration.enabled && a.calibration.calibrator) {
    o.calibration = a.calibration.calibrator;
    o.calibrate = p => LPCalibration.apply(a.calibration.calibrator, p);
    o.calibrationVersion = a.calibrationVersion;
  }
  if (a.weights && a.weights.enabled && a.weights.weights) {
    o.weights = a.weights.weights;
    o.weightsVersion = a.weightsVersion;
  }
  if (a.decision && a.decision.enabled && a.decision.policy) o.policy = a.decision.policy;
  return o;
}
function rDecision() {
  const active = St.learning && St.learning.active;
  const ad = active && active.decision;
  const policy = ad && ad.enabled ? ad.policy : null;
  const rep = St.decision && St.decision.result;
  const d = rep && rep.decision;
  const kpi = policy ? (100 * (policy.minEdge['1X2'] || 0)).toFixed(1) + '%' : '—';
  const test = ad && ad.decision && ad.decision.test;
  const policyRows = policy ? ['1X2', 'OU2.5', 'BTTS'].map(m => `<tr><td><b>${m}</b></td><td class="n">${((policy.minEdge[m] || 0) * 100).toFixed(1)}%</td><td class="n">${(policy.kellyFraction * 100).toFixed(0)}% Kelly</td><td class="n">${f2(policy.maxStakeUnits)}u cap</td></tr>`).join('') : '';
  const variants = (rep && rep.variants || []).map(v => `<tr><td class="n">${(v.threshold * 100).toFixed(1)}%</td><td class="n">${v.train.bets}</td><td class="n">${f4(v.train.roi)}</td><td class="n">${v.test.bets}</td><td class="n">${f4(v.test.roi)}</td><td class="n">${v.ciLow == null ? '–' : '[' + f4(v.ciLow) + ', ' + f4(v.ciHigh) + ']'}</td><td class="n">${f4(v.p)}</td></tr>`).join('');
  const acc = St.acc;
  const accRows = acc && acc.slip ? acc.slip.legs.map(l => `<tr><td>${esc(l.label || ('#' + l.id))}</td><td>${esc(l.market || '')}</td><td class="n">${f2(l.odds)}</td><td class="n">${pp(l.pLow)}</td><td class="n">${pe(l.edgeLow)}</td><td>${esc(l.uncertaintyClass || '')}</td></tr>`).join('') : '';
  const warnings = ((rep && rep.warnings) || (ad && ad.warnings) || []).filter((x, i, a) => a.indexOf(x) === i).map(w => `<li>${esc(w)}</li>`).join('');
  view.innerHTML = `<div class="note"><b>Stage 9 decision layer:</b> a bet requires the <b>lower confidence bound</b> to beat the price by a market-specific threshold. Stakes are fractional Kelly on that lower bound, reduced for wide uncertainty and capped. A policy is active only after a chronological holdout with a positive lower confidence bound. If no policy is active, every ledger decision remains <b>NO BET</b>.</div>
  <div class="controls"><button class="btn" data-act="runDecision">💵 Evaluate decision policy</button><span class="mute" style="font-size:13px">Uses the same walk-forward model samples as calibration; this is an analysis, not an activation.</span></div>
  <div class="kpis">
    <div class="kpi"><div class="v">${policy ? 'active' : 'NO BET'}</div><div class="l">Decision policy</div></div>
    <div class="kpi"><div class="v">${kpi}</div><div class="l">1X2 lower-bound edge</div></div>
    <div class="kpi"><div class="v">${policy ? (policy.kellyFraction * 100).toFixed(0) + '%' : '—'}</div><div class="l">Kelly fraction</div></div>
    <div class="kpi"><div class="v">${test ? test.bets : '—'}</div><div class="l">Holdout bets</div></div>
    <div class="kpi"><div class="v">${test ? f4(test.roi) : '—'}</div><div class="l">Holdout flat ROI</div></div>
    <div class="kpi"><div class="v">${ad && ad.decision && ad.decision.ciLow != null ? f4(ad.decision.ciLow) : '—'}</div><div class="l">Holdout ROI lower bound</div></div>
  </div>
  ${warnings ? `<div class="note"><b>Policy warnings</b><ul>${warnings}</ul></div>` : ''}
  <div class="card"><h3>Active policy <small>${policy ? 'validated Stage 9 policy' : 'disabled — equal ensemble stays in production'}</small></h3>
    ${policy ? `<table><tr><th>Market</th><th class="n">Minimum lower edge</th><th class="n">Stake</th><th class="n">Cap</th></tr>${policyRows}</table>` : '<p class="mute">No decision policy passed the chronological holdout. The ledger continues to record NO BET.</p>'}
    ${test ? `<table style="margin-top:12px"><tr><th>Series</th><th class="n">Bets</th><th class="n">Wins</th><th class="n">Flat ROI</th><th class="n">Staked ROI</th><th class="n">Max drawdown</th></tr><tr><td>Holdout</td><td class="n">${test.bets}</td><td class="n">${test.wins}</td><td class="n">${f4(test.roi)}</td><td class="n">${f4(test.roiStaked)}</td><td class="n">${f2(test.maxDrawdown)}u</td></tr></table>` : ''}
  </div>
  <div class="card" style="margin-top:16px"><h3>Walk-forward policy variants <small>chosen on the earlier window, scored on the later window</small></h3><div class="scroll" style="max-height:340px"><table><tr><th class="n">Threshold</th><th class="n">Train bets</th><th class="n">Train ROI</th><th class="n">Test bets</th><th class="n">Test ROI</th><th class="n">95% ROI interval</th><th class="n">p</th></tr>${variants || '<tr><td colspan="7" class="mute">Run the decision evaluation to see policy variants.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Accumulator optimiser <small>lower-bound joint probability · one leg per fixture by default</small></h3>
    <div class="controls"><label>Target odds <input type="number" id="acc_target" value="3" step="0.5" min="1.1" style="width:100px"></label><label>Max legs <input type="number" id="acc_legs" value="4" step="1" min="2" max="8" style="width:80px"></label><button class="btn" data-act="buildAccumulator">Build optimal slip</button></div>
    ${acc ? `<div class="note"><b>${acc.decision}</b> · ${esc(acc.reason || '')} · candidates ${acc.candidates || 0}</div>${acc.slip ? `<table><tr><th>Leg</th><th>Market</th><th class="n">Odds</th><th class="n">Lower p</th><th class="n">Lower edge</th><th>Uncertainty</th></tr>${accRows}</table><div class="kpis" style="margin-top:10px"><div class="kpi"><div class="v">${f2(acc.slip.totalOdds)}</div><div class="l">Total odds</div></div><div class="kpi"><div class="v">${pp(acc.slip.jointP)}</div><div class="l">Lower-bound joint</div></div><div class="kpi"><div class="v">${pe(acc.slip.ev)}</div><div class="l">Lower-bound EV</div></div><div class="kpi"><div class="v">${f2(acc.slip.stakeUnits)}u</div><div class="l">Suggested stake</div></div></div>` : ''}` : '<p class="mute">Build a slip from currently open fixtures. If no open round exists, this section stays empty.</p>'}
    <p class="mute" style="font-size:13px">Multiple legs from the same fixture are disallowed by default; allowing them applies a correlation penalty. This is not a joint score model.</p></div>
  <div class="note"><b>Important:</b> the accumulator and decision views are analyses. No live bet is placed. A validated policy must still be activated through the Learning tab (or produced by the autonomous pipeline) before the ledger can record BET decisions.</div>`;
}
async function runDecisionPolicy() {
  if (typeof LPDecision === 'undefined' || typeof LPCalibration === 'undefined') { alert('Decision modules not loaded.'); return; }
  if (!St.matches.length) { alert('No recorded matches yet.'); return; }
  const btn = document.querySelector('[data-act="runDecision"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Evaluating policy…'; }
  setTimeout(() => {
    try {
      const collected = LPCalibration.collect({
        matches: St.matches.slice(-1500), cat: St.cat, selsets: St.selsets,
        options: { minTrainRounds: 3, minCompMatches: 10, maxTestRounds: 12, permutations: 199, seed: 20261124 }
      });
      const cfg = (St.learning && St.learning.config) || {};
      const result = LPDecision.walkForward(collected.samples, {
        minSamples: cfg.decisionMinSamples || 500, minTestSamples: cfg.decisionMinTestSamples || 100,
        minBets: cfg.decisionMinBets || 100, minTrainBets: cfg.decisionMinTrainBets || 40,
        kellyFraction: cfg.decisionKellyFraction != null ? cfg.decisionKellyFraction : 0.25,
        maxStakeUnits: cfg.decisionMaxStakeUnits || 2,
        permutations: 199, seed: 20261124
      });
      St.decision = { samples: collected.samples.length, meta: collected.meta, result, warnings: [...new Set([...(collected.warnings || []), ...(result.warnings || [])])] };
      render(true);
    } catch (e) {
      alert('Decision evaluation failed: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '💵 Evaluate decision policy'; }
    }
  }, 20);
}
function runAccumulator() {
  if (typeof LPAccumulator === 'undefined') { alert('Accumulator module not loaded.'); return; }
  const target = +($('#acc_target')?.value || 3), maxLegs = +($('#acc_legs')?.value || 4);
  const fxs = openFx();
  if (!fxs.length) { alert('No open round is currently available.'); return; }
  const opts = activeDecisionOpts();
  const legs = [];
  for (const fx of fxs) {
    const cat = catFor(fx);
    let ev;
    try { ev = LPModel.evaluate(cat, fx, St.selsets[fx.sk] || '', teamFit(fx.comp), opts); } catch (e) { continue; }
    for (const r of ev.rows) {
      const p = r.calibrated != null ? r.calibrated : r.ensemble;
      if (p == null || r.pLow == null) continue;
      const c = cat[r.id] || St.cat[r.id];
      legs.push({
        fixtureId: fx.fixtureId, id: r.id, market: LPDecision.marketForRow(r, cat), odds: r.odds,
        p, pLow: r.pLow, uncertaintyClass: r.uncertaintyClass,
        label: (c ? selLabel(c, fx.home, fx.away) : '#' + r.id) + ' · ' + fx.home + ' v ' + fx.away
      });
    }
  }
  St.acc = LPAccumulator.optimise(legs, { targetOdds: target, maxLegs, minJointP: 0.005, minEdge: 0, beam: 250 });
  render(true);
}

// ---------------- INTELLIGENCE
async function refreshIntel() {
  await loadLearningSnapshot();
  await loadIntel();
  render(true);
}
function rIntel() {
  const r = St.intel;
  const head = `<div class="note"><b>Stage 10 intelligence:</b> one consolidated view of data health, model gates, active learning state, decision policy and ledger performance. Bankroll, ROI, drawdown and CLV are descriptive; a small ledger is not evidence of an edge.</div>
  <div class="controls"><button class="btn" data-act="refreshIntel">📊 Refresh intelligence</button><button class="btn ghost" data-act="rollbackLearning" data-version="">↩ Roll back to equal ensemble</button><span class="mute" style="font-size:13px">Reads up to 1,500 recent ledger rows from IndexedDB.</span></div>`;
  if (!r) { view.innerHTML = head + `<div class="empty"><h2>Intelligence not loaded</h2><p>No ledger rows or the performance module is unavailable. Record a round or use the refresh button.</p></div>`; return; }
  const c = r.counts, b = r.bets, bk = r.bankroll, clv = r.clv, data = r.data || {};
  const a = St.learning && St.learning.active;
  const activeCal = a && a.calibration && a.calibration.enabled ? a.calibration.method : 'off';
  const activeW = a && a.weights && a.weights.enabled ? 'adaptive' : 'equal';
  const activeD = a && a.decision && a.decision.enabled ? 'active' : 'disabled';
  const activeSpec = a && a.specialists ? ((a.specialists.sequence && a.specialists.sequence.enabled) || (a.specialists.patterns && a.specialists.patterns.enabled) ? 'enabled' : 'disabled') : '—';
  const ensembleCal = r.calibration && r.calibration.ensemble;
  const stateRows = ((St.learning && St.learning.states) || []).slice(0, 12).map(s => {
    const isActive = a && s.version === a.version;
    const cal = s.calibration && s.calibration.enabled ? s.calibration.method : '–';
    const w = s.weights && s.weights.enabled ? 'adaptive' : '–';
    const dec = s.decision && s.decision.enabled ? 'policy' : '–';
    const act = isActive ? '<span class="pill sev-ok">active</span>' : (s.status === 'candidate' ? `<button class="btn ghost" data-act="activateLearning" data-version="${esc(s.version)}">Activate</button>` : '<span class="mute">rejected</span>');
    return `<tr><td><b>${esc(s.version)}</b></td><td>${s.createdAt ? fmtT(s.createdAt) : '–'}</td><td>${learnPill(s.status)}</td><td>${esc(cal)}</td><td>${esc(w)}</td><td>${esc(dec)}</td><td class="n">${(s.training && s.training.sampleCount || 0).toLocaleString()}</td><td>${act}</td></tr>`;
  }).join('');
  const modelRows = (r.modelLeaderboard || []).map(x => `<tr><td><b>${esc(x.model)}</b></td><td class="n">${x.n}</td><td class="n">${f4(x.brier)}</td><td class="n">${f4(x.logLoss)}</td><td class="n">${pc(100 * (x.winRate || 0))}</td></tr>`).join('');
  const betRows = (b.rows || []).slice().reverse().slice(0, 80).map(x => `<tr><td>${x.asOf ? fmtT(x.asOf) : '–'}</td><td>${esc(cname(x.comp))}</td><td>${esc(x.home || '')} v ${esc(x.away || '')}</td><td>${esc(x.market || '')}</td><td class="n">${f2(x.odds)}</td><td class="n">${f2(x.stake)}u</td><td>${x.won ? '<span class="good">won</span>' : '<span class="bad">lost</span>'}</td><td class="n">${x.profitUnits >= 0 ? '+' : ''}${f2(x.profitUnits)}u</td></tr>`).join('');
  const marketRows = Object.entries(b.byMarket || {}).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="n">${x.bets}</td><td class="n">${x.wins}</td><td class="n">${f2(x.stake)}u</td><td class="n">${x.profit >= 0 ? '+' : ''}${f2(x.profit)}u</td><td class="n">${pe(x.roi)}</td></tr>`).join('');
  const compRows = Object.entries(b.byComp || {}).map(([k, x]) => `<tr><td>${esc(cname(k))}</td><td class="n">${x.bets}</td><td class="n">${f2(x.stake)}u</td><td class="n">${x.profit >= 0 ? '+' : ''}${f2(x.profit)}u</td><td class="n">${pe(x.roi)}</td></tr>`).join('');
  const clvRows = (clv.rows || []).slice(0, 30).map(x => `<tr><td>${esc(x.fixtureId)}</td><td class="n">${f2(x.openOdds)}</td><td class="n">${f2(x.closeOdds)}</td><td class="n">${pe(x.priceClv)}</td><td>${esc(x.decision)}</td></tr>`).join('');
  view.innerHTML = head + `<div class="kpis">
    <div class="kpi"><div class="v">${(data.matches || 0).toLocaleString()}</div><div class="l">Matches recorded</div></div>
    <div class="kpi"><div class="v">${(data.rounds || 0).toLocaleString()}</div><div class="l">Rounds recorded</div></div>
    <div class="kpi"><div class="v">${r.settlementCoverage == null ? '–' : (r.settlementCoverage * 100).toFixed(1) + '%'}</div><div class="l">Settlement coverage</div></div>
    <div class="kpi"><div class="v">${a ? esc(a.version) : 'equal ensemble'}</div><div class="l">Active learned state</div></div>
    <div class="kpi"><div class="v">${esc(activeD)}</div><div class="l">Decision policy</div></div>
    <div class="kpi"><div class="v">${b.n}</div><div class="l">Settled BET rows</div></div>
    <div class="kpi"><div class="v">${pe(b.roi)}</div><div class="l">Staked ROI</div></div>
    <div class="kpi"><div class="v">${f2(bk.end)}</div><div class="l">Bankroll (units)</div></div>
    <div class="kpi"><div class="v">${pe(bk.changePct)}</div><div class="l">Bankroll change</div></div>
    <div class="kpi"><div class="v">${f2(bk.maxDrawdown)}u</div><div class="l">Max drawdown</div></div>
    <div class="kpi"><div class="v">${f2(b.staked)}u</div><div class="l">Total exposure</div></div>
    <div class="kpi"><div class="v">${pe(clv.avgPriceClv)}</div><div class="l">Average price CLV</div></div>
  </div>
  ${(r.warnings || []).length ? `<div class="note"><b>Performance warnings</b><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
  <div class="card"><h3>Active components</h3><table><tr><th>Component</th><th>Status</th><th>Detail</th></tr>
    <tr><td>Calibration</td><td>${activeCal === 'off' ? '<span class="mute">off</span>' : '<span class="pill sev-ok">active</span>'}</td><td>${esc(activeCal)}</td></tr>
    <tr><td>Adaptive weights</td><td>${activeW === 'equal' ? '<span class="mute">equal</span>' : '<span class="pill sev-ok">active</span>'}</td><td>${esc(activeW)}</td></tr>
    <tr><td>Decision policy</td><td>${activeD === 'active' ? '<span class="pill sev-ok">active</span>' : '<span class="mute">NO BET</span>'}</td><td>${esc(activeD)}</td></tr>
    <tr><td>Specialists</td><td>${activeSpec === 'enabled' ? '<span class="pill sev-ok">enabled</span>' : '<span class="mute">disabled</span>'}</td><td>${esc(activeSpec)}</td></tr>
    <tr><td>Ensemble calibration ECE</td><td colspan="2">${ensembleCal ? f4(ensembleCal.ece) + ' · Brier ' + f4(ensembleCal.brier) : 'not enough settled rows'}</td></tr>
  </table></div>
  <div class="card" style="margin-top:16px"><h3>Ledger model leaderboard <small>settled predictions only</small></h3><table><tr><th>Model</th><th class="n">Selections</th><th class="n">Brier</th><th class="n">Log loss</th><th class="n">Win rate</th></tr>${modelRows || '<tr><td colspan="5" class="mute">No settlements yet.</td></tr>'}</table></div>
  <div class="card" style="margin-top:16px"><h3>Bankroll & exposure</h3>
    <div class="kpis"><div class="kpi"><div class="v">${f2(bk.start)}</div><div class="l">Start</div></div><div class="kpi"><div class="v">${f2(bk.end)}</div><div class="l">Current</div></div><div class="kpi"><div class="v">${pe(bk.changePct)}</div><div class="l">Change</div></div><div class="kpi"><div class="v">${f2(b.avgStake)}u</div><div class="l">Average stake</div></div><div class="kpi"><div class="v">${f2(b.maxStake)}u</div><div class="l">Largest stake</div></div><div class="kpi"><div class="v">${f2(bk.maxDrawdown)}u</div><div class="l">Max drawdown</div></div></div>
    <table style="margin-top:12px"><tr><th>Market</th><th class="n">Bets</th><th class="n">Won</th><th class="n">Stake</th><th class="n">Profit</th><th class="n">ROI</th></tr>${marketRows || '<tr><td colspan="6" class="mute">No settled bets.</td></tr>'}</table>
    <table style="margin-top:12px"><tr><th>League</th><th class="n">Bets</th><th class="n">Stake</th><th class="n">Profit</th><th class="n">ROI</th></tr>${compRows || '<tr><td colspan="5" class="mute">No settled bets.</td></tr>'}</table>
    <p class="mute" style="font-size:13px">Bankroll assumes one stake unit = ${f2(bk.unitValue)} currency units. Profit is from recorded settlement rows, not a live account.</p></div>
  <div class="card" style="margin-top:16px"><h3>Recent BET rows</h3><div class="scroll" style="max-height:360px"><table><tr><th>When</th><th>League</th><th>Fixture</th><th>Market</th><th class="n">Odds</th><th class="n">Stake</th><th>Result</th><th class="n">Profit</th></tr>${betRows || '<tr><td colspan="8" class="mute">No BET rows. The decision policy is disabled or no selection passed its gate.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Closing-line value <small>open/candidate price versus pre-close price</small></h3><table><tr><th>Fixture</th><th class="n">Open</th><th class="n">Close</th><th class="n">Price CLV</th><th>Decision</th></tr>${clvRows || '<tr><td colspan="5" class="mute">No matched open/pre-close rows.</td></tr>'}</table><p class="mute" style="font-size:13px">Matched selections: ${clv.n}. Average price CLV: ${pe(clv.avgPriceClv)}. Positive movement: ${pe(clv.positiveShare)}. The live probe found static odds, so zero CLV is expected.</p></div>
  <div class="card" style="margin-top:16px"><h3>Stored policies & rollback <small>activation is a pointer swap</small></h3><div class="scroll" style="max-height:320px"><table><tr><th>Version</th><th>Created</th><th>Status</th><th>Calibration</th><th>Weights</th><th>Decision</th><th class="n">Selections</th><th>Action</th></tr>${stateRows || '<tr><td colspan="8" class="mute">No learned states yet.</td></tr>'}</table></div></div>
  <div class="note"><b>Data health:</b> ${(data.qualityInvalid || 0)} invalid, ${(data.qualityWarn || 0)} warnings, ${(data.conflicts || 0)} conflicts. The final report can be generated with <code>node research/final.cjs --backup="path"</code> to include these ledger statistics.</div>`;
}

async function saveCloud() {
  if (typeof LPCloud === 'undefined') { alert('Cloud module not loaded.'); return; }
  const patch = {
    enabled: !!$('#cloud_enabled')?.checked,
    endpoint: $('#cloud_endpoint')?.value || '',
    intervalMin: +($('#cloud_interval')?.value || 1)
  };
  const token = $('#cloud_token')?.value || '';
  if (token.trim()) patch.token = token.trim();
  try {
    await LPCloud.setConfig(LPDB, patch);
    await loadCloud();
    render(true);
  } catch (e) { alert('Cloud settings failed: ' + e.message); }
}
async function syncCloud() {
  if (typeof LPCloud === 'undefined') { alert('Cloud module not loaded.'); return; }
  try {
    const r = await LPCloud.maybeUpload({ db: LPDB, force: true, reason: 'manual' });
    await loadCloud();
    render(true);
    if (r.skipped) alert('Cloud sync skipped: ' + r.reason);
    else if (r.ok) alert(`Cloud sync OK: ${r.fixtures} fixtures, ${Math.round(r.bytes / 1024)} KB.`);
    else alert('Cloud sync failed: ' + (r.error || 'unknown error'));
  } catch (e) { alert('Cloud sync failed: ' + e.message); }
}

// ---------------- SETTINGS
function rSettings() {
  const st = St.stats || {};
  const cat = St.catCurrent || St.status?.catalogue || {};
  const cl = St.cloud || {}, cc = cl.config || {}, cs = cl.status || {};
  const cloudLine = cs.at ? `${cs.ok ? '<span class="good">OK</span>' : '<span class="bad">error</span>'} · ${fmtT(cs.at)} · ${cs.bytes ? Math.round(cs.bytes / 1024) + ' KB' : '–'}${cs.error ? ' · ' + esc(cs.error) : ''}` : 'never synced';
  view.innerHTML = `<div class="card"><h3>Team ratings</h3><div class="controls"><label>Memory half-life (hours)<input type="number" id="set_hl" value="${St.ui.halfLifeH}" step="1" min="1" style="width:120px;min-width:0"></label><button class="btn" data-act="saveSet">Save</button> <span id="setMsg" class="good"></span></div></div>
  <div class="card" style="margin-top:16px"><h3>Cloud sync for phone <small>read-only snapshot</small></h3>
    <div class="controls" style="flex-wrap:wrap">
      <label><input type="checkbox" id="cloud_enabled" ${cc.enabled ? 'checked' : ''}> Enabled</label>
      <label>Endpoint <input type="url" id="cloud_endpoint" value="${esc(cc.endpoint || '')}" placeholder="https://your-site.netlify.app/api/snapshot" style="width:340px;min-width:0"></label>
      <label>Write token <input type="password" id="cloud_token" value="" placeholder="${cc.token ? 'saved token (leave blank to keep)' : 'LP_WRITE_TOKEN'}" style="width:260px;min-width:0"></label>
      <label>Interval (min) <input type="number" id="cloud_interval" value="${cc.intervalMin != null ? cc.intervalMin : 1}" min="0" max="1440" step="1" style="width:90px"></label>
      <button class="btn" data-act="saveCloud">Save cloud settings</button>
      <button class="btn ghost" data-act="syncCloud">☁ Sync now</button>
    </div>
    <p class="mute" style="font-size:13px">Uploads a compact snapshot to your Netlify Function after a capture or learning refresh. The write token stays in this extension and is never placed in the phone page. The phone page only reads the latest snapshot with its PIN.</p>
    <div class="note">Last cloud sync: ${cloudLine}</div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Data</h3>
  <div class="kpis" style="margin-bottom:12px">
    <div class="kpi"><div class="v">${LPDB.VER}</div><div class="l">IndexedDB schema</div></div>
    <div class="kpi"><div class="v">${(St.matches.length || 0).toLocaleString()}</div><div class="l">Matches</div></div>
    <div class="kpi"><div class="v">${(St.rounds.length || 0).toLocaleString()}</div><div class="l">Rounds</div></div>
    <div class="kpi"><div class="v">${(st.snapshots || 0).toLocaleString()}</div><div class="l">Odds snapshots</div></div>
    <div class="kpi"><div class="v">${(St.conflicts || []).length.toLocaleString()}</div><div class="l">Conflicts</div></div>
  </div>
  <div class="controls"><button class="btn ghost" data-act="csv">Export matches CSV (with main odds)</button> <button class="btn ghost" data-act="export">Export full backup (JSON.gz)</button> <button class="btn ghost" data-act="import">Import backup</button><input type="file" id="impFile" accept=".json,.gz,application/json,application/gzip" style="display:none"> <button class="btn danger" data-act="clear">Clear database</button></div>
  <p class="mute" style="font-size:13px">Catalogue: <b>${esc(cat.version || 'not captured yet')}</b>${cat.hash ? ' · ' + esc(cat.hash.slice(0, 16)) : ''}. Backups include matches, rounds, frozen catalogues, odds snapshots, quality log and conflicts. The site keeps no history, so this data exists only here.</p></div>`;
  $('#impFile').addEventListener('change', importJSON);
}
function downloadBlob(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function download(name, text, type) { downloadBlob(name, new Blob([text], { type })); }
async function exportJSON() {
  try {
    const data = await LPBackup.exportAll();
    const text = JSON.stringify(data);
    const gz = await LPBackup.gzipText(text);
    const day = new Date().toISOString().slice(0, 10);
    if (gz) downloadBlob(`leagueplus-backup-${day}.json.gz`, gz);
    else download(`leagueplus-backup-${day}.json`, text, 'application/json');
  } catch (e) { alert('Export failed: ' + e.message); }
}
function exportCSV() {
  const pick = [101, 102, 103, 104, 105, 106, 107, 108, 155, 156, 109, 110, 157, 158];
  const labelOf = id => { const c = St.cat[id]; return c ? LPCat.mlabel(c) + ' ' + c.name : String(id); };
  const L = [['league', 'week', 'time', 'home', 'away', 'home_goals', 'away_goals', 'goal_minutes', 'quality', 'catalogue', ...pick.map(labelOf)].join(',')];
  St.matches.forEach(m => {
    const om = LPParse.oddsMap(m.odds, St.selsets[m.sk] || '');
    L.push([cname(m.comp), m.week, Number.isFinite(m.ts) ? new Date(m.ts).toISOString() : '', m.home, m.away, m.hg, m.ag, '"' + (m.goals || []).map(([mn, s]) => mn + s).join(' ') + '"', m.quality?.status || '', m.catalogueVersion || '', ...pick.map(id => om.get(id) || '')].join(','));
  });
  download(`leagueplus-matches-${new Date().toISOString().slice(0, 10)}.csv`, L.join('\n'), 'text/csv');
}
async function importJSON(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const text = await LPBackup.readFile(f);
    const d = JSON.parse(text);
    const r = await LPBackup.importAll(d);
    const schema = d.schema != null ? +d.schema : (+d.v || 3);
    if (schema < 3) { try { await LPDB.migrate(true); } catch (e) { } }
    await load(); render();
    alert(`Import complete: ${r.added} new, ${r.skipped} already present, ${r.conflicts} conflict(s).`);
  } catch (err) { alert('Import failed: ' + err.message); }
  finally { try { e.target.value = ''; } catch (_) { } }
}
async function clearDB() { if (!confirm('Delete ALL recorded League Plus data from this browser?')) return; await LPDB.clearAll(); await load(); render(); }

// ---------------- DATA QUALITY
function rData() {
  const st = St.stats || {};
  const cat = St.catCurrent || St.status?.catalogue || {};
  const bad = (St.quality || []).filter(q => q.severity === 'invalid');
  const warn = (St.quality || []).filter(q => q.severity === 'warn');
  const nBad = bad.reduce((n, q) => n + (q.count || 1), 0);
  const nWarn = warn.reduce((n, q) => n + (q.count || 1), 0);
  const games = new Map();
  (St.rounds || []).forEach(r => {
    const g = games.get(r.game) || { game: r.game, rounds: 0, finished: 0, open: null, lastResult: null, partial: 0, flags: {} };
    g.rounds++;
    if (r.status === 'finished') {
      g.finished++;
      if (!g.lastResult || (+r.roundId || 0) > (+g.lastResult.roundId || 0)) g.lastResult = r;
    }
    if (r.status === 'open' && (!g.open || (+r.roundId || 0) > (+g.open.roundId || 0))) g.open = r;
    if ((r.quality?.flags || []).includes('partial_round')) g.partial++;
    (r.quality?.flags || []).forEach(f => { g.flags[f] = (g.flags[f] || 0) + 1; });
    games.set(r.game, g);
  });
  const grows = [...games.values()].sort((a, b) => a.game - b.game).map(g => {
    const sch = St.sched && St.sched[g.game];
    const sg = St.status?.games?.[g.game];
    const last = g.lastResult, open = g.open;
    return `<tr><td><b>${esc(g.game)}</b></td><td class="n">${g.rounds}</td><td class="n">${g.finished}</td>
      <td class="n">${last ? '#' + last.roundId + ' <span class="mute">' + (last.status || '') + '</span>' : '–'}</td>
      <td class="n">${open ? '#' + open.roundId : '–'}</td>
      <td class="n">${last ? (last.capturedMatches ?? '–') + ' / ' + (last.expectedMatches ?? '–') : '–'}</td>
      <td class="n">${g.partial}</td>
      <td class="n">${sch && sch.at ? new Date(sch.at).toLocaleTimeString() : '–'}</td>
      <td>${sg ? (sg.ok ? '<span class="good">ok</span>' : '<span class="bad">' + esc(sg.error || 'error') + '</span>') : '<span class="mute">–</span>'}</td></tr>`;
  }).join('');
  const qrows = (St.quality || []).slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 120).map(q => `<tr><td><span class="pill sev-${esc(q.severity)}">${esc(q.severity)}</span></td><td><b>${esc(q.code)}</b></td><td>${esc(q.entity)}</td><td class="n">${(q.count || 1).toLocaleString()}</td><td>${q.lastTs ? new Date(q.lastTs).toLocaleString() : '–'}</td><td class="mute" style="white-space:normal;max-width:420px">${esc(JSON.stringify(q.sample || {}).slice(0, 300))}</td></tr>`).join('');
  const crows = (St.conflicts || []).slice(-80).reverse().map(c => `<tr><td>${c.ts ? new Date(c.ts).toLocaleString() : '–'}</td><td>${esc(c.store)}</td><td style="white-space:normal;max-width:300px">${esc(c.key)}</td><td>${esc(c.reason || '')}</td><td class="mute">${esc((c.existingHash || '').slice(0, 10))} → ${esc((c.incomingHash || '').slice(0, 10))}</td></tr>`).join('');
  const lastAudit = (St.quality || []).reduce((m, q) => Math.max(m, q.lastTs || 0), 0);
  view.innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${LPDB.VER}</div><div class="l">IndexedDB schema</div></div>
    <div class="kpi"><div class="v">${esc((cat.version || '—').slice(0, 20))}</div><div class="l">Frozen catalogue</div></div>
    <div class="kpi"><div class="v ${nBad ? 'bad' : nWarn ? 'warnc' : 'good'}">${nBad || nWarn || 'OK'}</div><div class="l">${nBad ? 'Invalid records' : nWarn ? 'Warnings' : 'Quality clean'}</div></div>
    <div class="kpi"><div class="v">${(st.snapshots || 0).toLocaleString()}</div><div class="l">Odds snapshots</div></div>
    <div class="kpi"><div class="v ${(St.conflicts || []).length ? 'bad' : 'good'}">${(St.conflicts || []).length.toLocaleString()}</div><div class="l">Immutable-record conflicts</div></div>
    <div class="kpi"><div class="v">${lastAudit ? ago(lastAudit) : 'never'}</div><div class="l">Last quality event</div></div>
  </div>
  <div class="controls"><button class="btn" data-act="audit">🔎 Run full audit</button><button class="btn ghost" data-act="export">Export backup v2</button><button class="btn ghost" data-act="import">Import backup</button><button class="btn ghost" data-act="csv">Export CSV</button><input type="file" id="impFile" accept=".json,.gz,application/json,application/gzip" style="display:none"></div>
  <div id="auditOut" class="note">Audit revalidates every match against the frozen catalogue that was active when it was captured. It never changes scores, goals or odds.</div>
  <div class="card" style="margin-top:16px"><h3>Capture schedule by game <small>one-shot alarms at result time and closing price</small></h3><div class="scroll" style="max-height:360px"><table><tr><th>Game</th><th class="n">Rounds</th><th class="n">Finished</th><th class="n">Last result</th><th class="n">Open round</th><th class="n">Captured / expected</th><th class="n">Partial</th><th class="n">Next alarm</th><th>Last status</th></tr>${grows || '<tr><td colspan="9" class="mute">No rounds captured yet.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Quality issues <small>grouped by entity, code and severity</small></h3><div class="scroll" style="max-height:420px"><table><tr><th>Severity</th><th>Code</th><th>Entity</th><th class="n">Count</th><th>Last seen</th><th>Sample</th></tr>${qrows || '<tr><td colspan="6" class="mute">No quality issues.</td></tr>'}</table></div></div>
  <div class="card" style="margin-top:16px"><h3>Conflicts <small>existing historical rows are kept; incoming rows are logged</small></h3><div class="scroll" style="max-height:320px"><table><tr><th>When</th><th>Store</th><th>Key</th><th>Reason</th><th>Hashes</th></tr>${crows || '<tr><td colspan="5" class="mute">No conflicts.</td></tr>'}</table></div></div>`;
  const inp = $('#impFile'); if (inp) inp.addEventListener('change', importJSON);
}
async function runAudit() {
  const out = $('#auditOut');
  if (!St.matches.length) { if (out) out.textContent = 'No stored matches to audit yet.'; return; }
  if (out) out.textContent = 'Auditing matches…';
  let issues = [], updated = [], bad = 0, warn = 0;
  const all = St.matches.slice();
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    const cat = catFor(m);
    const sel = St.selsets[m.sk] || '';
    const round = (St.rounds || []).find(r => r.key === m.roundKey);
    const ctx = { cat, selStr: sel, round: { betClose: m.betClose, competitions: round ? (round.competitions || []) : undefined } };
    const q = LPQuality.validateMatch(m, ctx);
    m.quality = q;
    updated.push(m);
    if (q.status === 'invalid') bad++; else if (q.status === 'warn') warn++;
    issues.push(...LPQuality.issuesForMatch(m, ctx));
    if (updated.length >= 300) {
      await LPDB.putMany('matches', updated); updated = [];
      await LPDB.mergeQuality(issues); issues = [];
      if (out) out.textContent = `Audited ${i + 1} / ${all.length}…`;
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (updated.length) await LPDB.putMany('matches', updated);
  if (issues.length) await LPDB.mergeQuality(issues);
  await load(); render(true);
  const o = $('#auditOut');
  if (o) o.innerHTML = `Audit complete: <b class="${bad ? 'bad' : 'good'}">${bad}</b> invalid, <b class="${warn ? 'warnc' : 'good'}">${warn}</b> warnings across ${all.length.toLocaleString()} matches.`;
}

(async () => { await load(); render(); setInterval(() => { syncLine(); }, 15000); })();
