#!/usr/bin/env node
// League Plus research collector.
//
// This is an optional development tool, not part of the Chrome extension. It
// uses the same parser as the extension and writes raw + parsed JSONL so a
// genuine chronological backtest can be produced from data captured while the
// extension is being built.
//
// Usage:
//   node research/collect.cjs                 # keep collecting
//   node research/collect.cjs --once          # one pass over all games
//   node research/collect.cjs --games=3,4,6,7 # choose games
//
// Data is written under research/data/:
//   init.json                 latest /game/init response
//   state.json                per-game schedule and last round
//   raw-YYYY-MM-DD.jsonl      raw /game/{id}/round responses
//   parsed-YYYY-MM-DD.jsonl   parsed results and upcoming fixtures
//
// No npm dependencies. Safe to stop and restart; state is persisted after each
// pass and the API's last-finished/upcoming pair lets us reconstruct one round
// without gaps as long as the collector runs at least once per round.
const fs = require('fs');
const path = require('path');
const { LP_API, LPParse, LPSync } = require('../lib/core.js');

const ROOT = path.join(__dirname, 'data');
fs.mkdirSync(ROOT, { recursive: true });
const STATE_FILE = path.join(ROOT, 'state.json');
const args = process.argv.slice(2);
const once = args.includes('--once');
const gamesArg = (args.find(a => a.startsWith('--games=')) || '').split('=')[1];
const GAMES = (gamesArg ? gamesArg.split(',') : ['3', '4', '6', '7']).map(Number).filter(Boolean);

let state = { version: 1, startedAt: Date.now(), initAt: 0, games: {} };
try { if (fs.existsSync(STATE_FILE)) state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { }
state.games = state.games || {};

const day = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function append(name, obj) { fs.appendFileSync(path.join(ROOT, name), JSON.stringify(obj) + '\n'); }

async function api(pathname) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, 30000);
  try {
    const r = await fetch(LP_API + pathname, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + pathname);
    const j = await r.json();
    if (!j || j.status !== 1) throw new Error((j && j.error && j.error.message) || 'API error');
    return j.data;
  } finally { clearTimeout(timer); }
}

async function ensureInit() {
  if (Date.now() - (state.initAt || 0) < 6 * 3600e3 && fs.existsSync(path.join(ROOT, 'init.json'))) return;
  const d = await api('/game/init');
  fs.writeFileSync(path.join(ROOT, 'init.json'), JSON.stringify(d));
  state.initAt = Date.now();
  console.log('[init] markets=' + (d.markets || []).length + ' games=' + (d.games || []).map(g => g.id).join(','));
}

async function pass() {
  await ensureInit();
  const now = Date.now();
  for (const game of GAMES) {
    const s = state.games[game] || {};
    if (!once && s.next && s.next > now + 500) continue;
    try {
      const d = await api('/game/' + game + '/round');
      const at = Date.now();
      append('raw-' + day() + '.jsonl', { at, game, data: d });
      const rr = d.roundResults, r = d.round;
      const betOpen = rr && rr.roundId ? (s.rounds && s.rounds[+rr.roundId] ? s.rounds[+rr.roundId].betOpen : (s.betOpen ?? null)) : null;
      const results = rr && rr.roundId ? LPParse.results(game, rr, { capturedAt: at, catalogueVersion: null, betOpen }) : null;
      const upcoming = r && r.roundId ? LPParse.upcoming(game, r, { capturedAt: at, catalogueVersion: null }) : null;
      const rounds = Object.assign({}, s.rounds || {});
      if (r && r.roundId) rounds[+r.roundId] = { betOpen: Date.parse(r.startDate), betClose: Date.parse(r.noBetDate || r.endDate) };
      const keep = Object.keys(rounds).sort((a, b) => b - a).slice(0, 24);
      const trimmed = {}; keep.forEach(k => { trimmed[k] = rounds[k]; });
      append('parsed-' + day() + '.jsonl', {
        at, game,
        results: results ? { matches: results.matches, invalid: results.invalid, selsets: results.selsets } : null,
        upcoming: upcoming ? { fixtures: upcoming.fixtures, invalid: upcoming.invalid, selsets: upcoming.selsets } : null
      });
      const next = LPSync.nextSyncAt(d, at);
      state.games[game] = {
        lastResult: rr && rr.roundId ? +rr.roundId : (s.lastResult || null),
        lastUpcoming: r && r.roundId ? +r.roundId : (s.lastUpcoming || null),
        lastFetch: at, next, error: null,
        betOpen: r && r.roundId ? Date.parse(r.startDate) : (s.betOpen || null),
        rounds: trimmed
      };
      console.log('[' + new Date(at).toLocaleTimeString() + '] game ' + game +
        ' result ' + (state.games[game].lastResult ?? '-') +
        ' upcoming ' + (state.games[game].lastUpcoming ?? '-') +
        ' matches ' + (results ? results.matches.length : 0) +
        ' fixtures ' + (upcoming ? upcoming.fixtures.length : 0) +
        ' next ' + new Date(next).toLocaleTimeString());
    } catch (e) {
      const at = Date.now();
      state.games[game] = Object.assign({}, s, { lastFetch: at, next: at + 60e3, error: e.message });
      console.error('[' + new Date(at).toLocaleTimeString() + '] game ' + game + ' ERROR ' + e.message);
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log('League Plus collector; games ' + GAMES.join(',') + '; data in ' + ROOT);
  if (once) { await pass(); return; }
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; console.log('\nstopping…'); });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    await pass();
    const now = Date.now();
    const next = Math.min(...GAMES.map(g => (state.games[g] && state.games[g].next) || (now + 120e3)), now + 120e3);
    await sleep(Math.max(15000, Math.min(120000, next - now)));
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
