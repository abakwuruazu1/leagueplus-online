/* League Plus phone/remote view.
 * Read-only: PIN login -> latest extension snapshot -> status + slip builder.
 */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const f4 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(4));
const pp = p => (p == null || isNaN(p) ? '–' : (p * 100).toFixed(1) + '%');
const pe = x => (x == null || isNaN(x) ? '–' : (x >= 0 ? '+' : '') + (+x * 100).toFixed(1) + '%');
const statusEl = $('#status'), loginEl = $('#login'), appEl = $('#app');
let SNAP = null, CAT = null, SOURCES = [];

function setStatus(t, err) { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); }
function showLogin() { loginEl.style.display = 'block'; appEl.style.display = 'none'; $('#logout').style.display = 'none'; setStatus('PIN required'); }
function showApp() { loginEl.style.display = 'none'; appEl.style.display = 'block'; $('#logout').style.display = ''; }
async function api(path, opts = {}) {
  const r = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts));
  let j = null; try { j = await r.json(); } catch (e) { }
  if (r.status === 401) { const e = new Error('PIN required'); e.auth = true; throw e; }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}
async function boot() {
  try {
    await api('/api/session');
    await loadSnapshot();
  } catch (e) {
    if (e.auth) showLogin();
    else { setStatus('Remote API unavailable: ' + e.message, true); showLogin(); }
  }
}
async function loadSnapshot() {
  const s = await api('/api/snapshot');
  SNAP = s;
  CAT = s.catalogue ? LPCat.buildMap(s.catalogue) : {};
  showApp();
  render();
}
function leagueName(id) { const l = SOURCES.find(x => +x.id === +id); return l ? l.name : 'League ' + id; }
function fixtureFor(leg) {
  if (leg.fx) return leg.fx;
  return (SNAP && SNAP.fixtures || []).find(f => f.key === leg.mkey || f.fixtureId === leg.fixtureId) || null;
}
function selLabel(c, home, away) {
  if (!c) return '–';
  if (c.mId === 1) return c.name === '1' ? home + ' win' : c.name === '2' ? away + ' win' : 'Draw';
  if (c.mId === 2) return c.name === '1X' ? home + ' or draw' : c.name === 'X2' ? away + ' or draw' : home + ' or ' + away;
  return c.full || c.name;
}
function describe(leg) {
  const c = CAT[leg.id], fx = fixtureFor(leg);
  return {
    when: fx && fx.close ? 'closes ' + fmtT(fx.close) : '–',
    comp: fx ? leagueName(fx.comp) : '',
    event: fx ? fx.home + ' v ' + fx.away : '',
    market: c ? LPCat.mlabel(c) : '',
    pick: c ? selLabel(c, fx ? fx.home : '', fx ? fx.away : '') : '#' + leg.id
  };
}
function candidates(o) {
  const now = Date.now(), cands = [];
  const fxs = (SNAP.fixtures || []).filter(f => o.sources.includes(+f.comp) && f.close > now + 15e3 && f.close <= now + o.horizon * 60e3);
  for (const fx of fxs) {
    const sel = SNAP.selsets[fx.sk];
    if (!sel) continue;
    let ev; try { ev = LPModel.evaluate(CAT, fx, sel, null); } catch (e) { continue; }
    for (const r of ev.rows) {
      const c = CAT[r.id]; if (!c) continue;
      const k = LPCat.mkey(c); if (!o.markets.includes(k)) continue;
      const p = r.ensemble != null ? r.ensemble : (r.mkt != null ? r.mkt : r.fair);
      if (p == null || !Number.isFinite(p)) continue;
      cands.push({ mkey: fx.key, mkId: k, p, oddsOverride: r.odds, fx, id: r.id });
    }
  }
  return { cands, note: 'No round is open in that window, or no selection matched the filters.' };
}
function marketList() {
  const seen = new Map();
  Object.values(CAT || {}).forEach(c => {
    const k = LPCat.mkey(c);
    if (!seen.has(k)) seen.set(k, { key: k, id: k, name: LPCat.mlabel(c), group: LPCat.groupOf(c), mId: c.mId, sub: c.sub });
  });
  return [...seen.values()].sort((a, b) => a.mId - b.mId || String(a.sub || '').localeCompare(String(b.sub || '')));
}
function mountSlip(ageMin) {
  const mk = marketList();
  const preferred = ['1', '2', '3', '5@1.5', '5@2.5'].filter(k => mk.some(m => m.key === k));
  const defaults = preferred.length ? preferred : mk.slice(0, 5).map(m => m.key);
  const warn = $('#slipWarn');
  if (warn) warn.innerHTML = ageMin > 30
    ? `<span class="offline">This snapshot is ${Math.round(ageMin)} minutes old. The PC may be offline and the odds are probably stale.</span>`
    : ageMin > 15
      ? `<span class="stale">This snapshot is ${Math.round(ageMin)} minutes old. Refresh before relying on the odds.</span>`
      : 'Slip probabilities are market-implied from the snapshot. There is no backtest or calibration online.';
  ZSlip.mount($('#slipView'), {
    key: 'leagueplus-remote', realOdds: true, noBacktest: true, sourceLabel: 'League',
    sources: SOURCES, horizonDefault: 8, markets: mk, defaultMarkets: defaults,
    candidates, describe,
    slipNote(legs) {
      const soon = Math.min(...legs.map(l => fixtureFor(l)?.close).filter(Boolean));
      return soon ? `<div class="note">⏱ First match closes at <b>${fmtT(soon)}</b>. Check the price before betting.</div>` : '';
    }
  });
}
function render() {
  if (!SNAP) return;
  const ageMin = Math.max(0, (Date.now() - (+SNAP.generatedAt || Date.now())) / 60000);
  setStatus(`Snapshot ${fmtT(SNAP.generatedAt)} · ${(SNAP.fixtures || []).length} fixtures · ${(SNAP.counts || {}).matches ?? '–'} matches recorded`);
  $('#freshness').innerHTML = ageMin > 30
    ? `<span class="offline">Last snapshot ${Math.round(ageMin)} minutes ago. PC may be offline.</span>`
    : ageMin > 15
      ? `<span class="stale">Last snapshot ${Math.round(ageMin)} minutes ago. Refresh before trusting the odds.</span>`
      : `Last snapshot ${Math.round(ageMin)} minute(s) ago.`;
  SOURCES = (SNAP.games || []).flatMap(g => (g.leagues || []).filter(l => l.enabled).map(l => ({ id: +l.id, name: l.name, game: g.id })));
  const seenSrc = new Set(); SOURCES = SOURCES.filter(l => { if (seenSrc.has(l.id)) return false; seenSrc.add(l.id); return true; });
  const a = SNAP.active;
  const cal = a && a.calibration && a.calibration.enabled ? a.calibration.method : 'off';
  const w = a && a.weights && a.weights.enabled ? 'adaptive' : 'equal';
  const dec = a && a.decision && a.decision.enabled ? 'ACTIVE' : 'NO BET';
  const p = SNAP.performance || {};
  const bets = p.bets || {}, bk = p.bankroll || {}, clv = p.clv || {};
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="v">${esc(dec)}</div><div class="l">Decision policy</div></div>
    <div class="kpi"><div class="v">${esc(cal)}</div><div class="l">Calibration</div></div>
    <div class="kpi"><div class="v">${esc(w)}</div><div class="l">Weights</div></div>
    <div class="kpi"><div class="v">${bets.n || 0}</div><div class="l">Settled BET rows</div></div>
    <div class="kpi"><div class="v">${pe(bets.roi)}</div><div class="l">Staked ROI</div></div>
    <div class="kpi"><div class="v">${f2(bk.end)}</div><div class="l">Bankroll</div></div>
    <div class="kpi"><div class="v">${f2(bk.maxDrawdown)}u</div><div class="l">Max drawdown</div></div>
    <div class="kpi"><div class="v">${pe(clv.avgPriceClv)}</div><div class="l">Average CLV</div></div>`;
  $('#components').innerHTML = `<table><tr><th>Component</th><th>Status</th><th>Detail</th></tr>
    <tr><td>Calibration</td><td>${cal === 'off' ? 'off' : 'active'}</td><td>${esc(cal)}</td></tr>
    <tr><td>Adaptive weights</td><td>${w}</td><td>${esc(w)}</td></tr>
    <tr><td>Decision policy</td><td>${dec}</td><td>${a && a.decision && a.decision.decision ? 'holdout bets ' + (a.decision.decision.test && a.decision.decision.test.bets || 0) : 'no validated policy'}</td></tr>
    <tr><td>Active state</td><td colspan="2">${a ? esc(a.version) + ' · ' + fmtT(a.createdAt) : 'equal ensemble'}</td></tr>
  </table>`;
  const preds = (SNAP.ledger && SNAP.ledger.recentPredictions || []).slice(0, 18);
  $('#decisions').innerHTML = preds.length ? `<div class="scroll" style="max-height:360px"><table><tr><th>When</th><th>League</th><th>Fixture</th><th>Checkpoint</th><th>Decision</th><th class="n">Odds</th><th class="n">Stake</th></tr>${preds.map(x => `<tr><td>${x.asOf ? fmtT(x.asOf) : '–'}</td><td>${esc(leagueName(x.comp))}</td><td><b>${esc(x.home)} v ${esc(x.away)}</b></td><td>${esc(x.checkpoint || '')}</td><td><span class="pill ${x.decision === 'BET' ? 'pick' : 'nobet'}">${esc(x.decision || 'NO_BET')}</span></td><td class="n">${f2(x.selectedOdds)}</td><td class="n">${f2(x.stakeUnits)}u</td></tr>`).join('')}</table></div>` : '<p class="mute">No recent predictions in the snapshot.</p>';
  $('#perf').innerHTML = `<div class="kpis">
    <div class="kpi"><div class="v">${f2(bk.start)}</div><div class="l">Start bankroll</div></div>
    <div class="kpi"><div class="v">${f2(bk.end)}</div><div class="l">Current</div></div>
    <div class="kpi"><div class="v">${pe(bk.changePct)}</div><div class="l">Change</div></div>
    <div class="kpi"><div class="v">${bets.wins || 0} / ${bets.n || 0}</div><div class="l">Bets won</div></div>
    <div class="kpi"><div class="v">${f4(bets.roi)}</div><div class="l">ROI</div></div>
    <div class="kpi"><div class="v">${f2(bets.staked)}u</div><div class="l">Exposure</div></div>
  </div>`;
  const models = (p.modelLeaderboard || []).map(x => `<tr><td>${esc(x.model)}</td><td class="n">${x.n}</td><td class="n">${f4(x.brier)}</td><td class="n">${f4(x.logLoss)}</td></tr>`).join('');
  $('#models').innerHTML = `<table><tr><th>Model</th><th class="n">Selections</th><th class="n">Brier</th><th class="n">Log loss</th></tr>${models || '<tr><td colspan="4" class="mute">No settled ledger rows yet.</td></tr>'}</table>`;
  mountSlip(ageMin);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pin = $('#pin').value.trim();
  if (!pin) return;
  $('#loginMsg').textContent = 'Checking…';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Invalid PIN');
    $('#pin').value = '';
    $('#loginMsg').textContent = '';
    await loadSnapshot();
  } catch (e) { $('#loginMsg').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
});
$('#logout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { }
  SNAP = null; showLogin();
});
$('#refreshSnap').addEventListener('click', async () => {
  try { await loadSnapshot(); } catch (e) { alert('Refresh failed: ' + e.message); }
});
$('#copySlip').addEventListener('click', async () => {
  const t = document.querySelector('#sl_out')?.innerText || '';
  if (!t.trim()) { alert('Build a slip first.'); return; }
  try { await navigator.clipboard.writeText(t); alert('Slip copied.'); } catch (e) { alert('Copy failed. Select the slip text manually.'); }
});
boot();
