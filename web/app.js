/* League Plus online slip builder.
 *
 * This is a static page plus one Netlify function. It uses the current Bet9ja
 * round and market-implied probabilities only: no recorded history, no
 * calibration, no backtest, no bets.
 */
const $ = s => document.querySelector(s);
const view = $('#view');
const statusEl = $('#status');
let DATA = null, CAT = null, LEAGUES = [];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = ts => new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const f2 = x => (x == null || isNaN(x) ? '–' : (+x).toFixed(2));
const pp = p => (p == null || isNaN(p) ? '–' : (p * 100).toFixed(1) + '%');

function setStatus(text, err) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!err);
}
function leagueName(id) {
  const l = LEAGUES.find(x => +x.id === +id);
  return l ? l.name : 'League ' + id;
}
function selLabel(c, home, away) {
  if (!c) return '–';
  if (c.mId === 1) return c.name === '1' ? home + ' win' : c.name === '2' ? away + ' win' : 'Draw';
  if (c.mId === 2) return c.name === '1X' ? home + ' or draw' : c.name === 'X2' ? away + ' or draw' : home + ' or ' + away;
  return c.full || c.name;
}
function marketList() {
  const seen = new Map();
  Object.values(CAT || {}).forEach(c => {
    const k = LPCat.mkey(c);
    if (!seen.has(k)) seen.set(k, { key: k, id: k, name: LPCat.mlabel(c), group: LPCat.groupOf(c), mId: c.mId, sub: c.sub });
  });
  return [...seen.values()].sort((a, b) => a.mId - b.mId || String(a.sub || '').localeCompare(String(b.sub || '')));
}
function fixtureFor(leg) {
  if (leg.fx) return leg.fx;
  return (DATA && DATA.fixtures || []).find(f => f.key === leg.mkey || f.fixtureId === leg.fixtureId) || null;
}
function describe(leg) {
  const c = CAT[leg.id];
  const fx = fixtureFor(leg);
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
  const fxs = (DATA.fixtures || []).filter(f =>
    o.sources.includes(+f.comp) && f.close > now + 15e3 && f.close <= now + o.horizon * 60e3
  );
  for (const fx of fxs) {
    const sel = DATA.selsets[fx.sk];
    if (!sel) continue;
    let ev;
    try { ev = LPModel.evaluate(CAT, fx, sel, null); } catch (e) { continue; }
    for (const r of ev.rows) {
      const c = CAT[r.id];
      if (!c) continue;
      const k = LPCat.mkey(c);
      if (!o.markets.includes(k)) continue;
      const p = r.ensemble != null ? r.ensemble : (r.mkt != null ? r.mkt : r.fair);
      if (p == null || !Number.isFinite(p)) continue;
      cands.push({ mkey: fx.key, mkId: k, p, oddsOverride: r.odds, fx, id: r.id });
    }
  }
  return {
    cands,
    note: fxs.length
      ? 'No market met the selected filters in that window.'
      : 'No League Plus round is open for betting in that window. A new round opens every few minutes.'
  };
}

function mount() {
  const mk = marketList();
  const preferred = ['1', '2', '3', '5@1.5', '5@2.5'].filter(k => mk.some(m => m.key === k));
  const defaults = preferred.length ? preferred : mk.slice(0, 5).map(m => m.key);
  LEAGUES = (DATA.games || []).flatMap(g =>
    (g.leagues || []).filter(l => l.enabled).map(l => ({ id: +l.id, name: l.name, game: g.id }))
  );
  // De-duplicate league ids that appear in more than one game.
  const seen = new Set();
  LEAGUES = LEAGUES.filter(l => { if (seen.has(l.id)) return false; seen.add(l.id); return true; });

  ZSlip.mount(view, {
    key: 'leagueplus-online',
    realOdds: true,
    noBacktest: true,
    sourceLabel: 'League',
    sources: LEAGUES,
    horizonDefault: 8,
    markets: mk,
    defaultMarkets: defaults,
    candidates,
    describe,
    slipNote(legs) {
      const soon = Math.min(...legs.map(l => fixtureFor(l)?.close).filter(Boolean));
      return soon ? `<div class="note">⏱ Bet before <b>${fmtT(soon)}</b>. The first match closes at that time.</div>` : '';
    }
  });
}

async function loadOdds() {
  setStatus('Loading current Bet9ja round…');
  view.innerHTML = '<div class="empty"><h2>Loading current round…</h2><p>Fetching Bet9ja League Plus fixtures.</p></div>';
  try {
    const res = await fetch('/api/odds', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    DATA = data;
    CAT = LPCat.buildMap(data.catalogue);
    setStatus(`${(data.fixtures || []).length} fixtures · ${(data.games || []).length} games · updated ${fmtT(data.generatedAt)}` + ((data.warnings || []).length ? ` · ${data.warnings.length} warning(s)` : ''));
    mount();
    if (!(data.fixtures || []).length) {
      view.insertAdjacentHTML('afterbegin', '<div class="note">No upcoming round is currently open. Reload in a minute.</div>');
    }
  } catch (e) {
    setStatus('Could not load odds: ' + e.message, true);
    view.innerHTML = `<div class="empty"><h2>Could not load the current round</h2><p>${esc(e.message)}</p><p class="mute">The Bet9ja endpoint may be unavailable or the Netlify function could not reach it. Try reloading.</p></div>`;
  }
}

$('#reload').addEventListener('click', loadOdds);
loadOdds();
