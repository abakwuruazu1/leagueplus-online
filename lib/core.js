// League Plus (Bet9ja virtual football) – shared core.
// API client, IndexedDB v3, frozen market catalogue, settlement, data-quality
// engine, immutable history, round-aware capture and backup/restore.
//
// Data source: https://stadium-tv-api.bet9ja.com
//   /game/init, /game/{gameId}/round, /game/standings/{gameId}
// The API only returns the UPCOMING round and the LAST finished round, so the
// extension records every round as it happens. Rounds are ~6 minutes in the
// main games and ~3.5 minutes in Sonic; each match lasts 60 seconds.
const LP_API = 'https://stadium-tv-api.bet9ja.com';
const LP_SCHEMA = 3;
const LP_APP = 'leagueplus-engine';

// ---------------------------------------------------------------------------
// utilities
const LPUtil = (() => {
  // Deterministic 64-bit FNV-1a. Used for dedupe/conflict detection, not crypto.
  function hash64(str) {
    let h = 0xcbf29ce484222325n;
    const p = 0x100000001b3n;
    for (let i = 0; i < str.length; i++) {
      h ^= BigInt(str.charCodeAt(i));
      h = BigInt.asUintN(64, h * p);
    }
    return h.toString(16).padStart(16, '0');
  }
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  const contentHash = obj => hash64(stableStringify(obj));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
  const iso = ts => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);
  return { hash64, stableStringify, contentHash, clamp, num, iso };
})();

// ---------------------------------------------------------------------------
// database schema
// keyPath / indexes. Additive upgrades only; historical rows are never deleted.
const LP_STORES = {
  meta: { keyPath: 'key' },
  matches: {
    keyPath: 'key',
    indexes: {
      comp: 'comp', ts: 'ts', game: 'game', roundId: 'roundId', roundKey: 'roundKey',
      fixtureId: 'fixtureId', season: 'season', week: 'week', quality: 'quality.status'
    }
  },
  rounds: {
    keyPath: 'key',
    indexes: { game: 'game', roundId: 'roundId', betClose: 'betClose', status: 'status', lastSeenAt: 'lastSeenAt' }
  },
  catalogues: { keyPath: 'version', indexes: { hash: 'hash', builtAt: 'builtAt' } },
  snapshots: {
    keyPath: 'key',
    indexes: { fixtureId: 'fixtureId', roundKey: 'roundKey', ts: 'ts', hash: 'hash', phase: 'phase' }
  },
  predictions: {
    keyPath: 'predictionId',
    indexes: { fixtureId: 'fixtureId', asOf: 'asOf', modelVersion: 'modelVersion', roundKey: 'roundKey', comp: 'comp' }
  },
  settlements: { keyPath: 'predictionId', indexes: { fixtureId: 'fixtureId', settledAt: 'settledAt' } },
  modelStates: { keyPath: 'version', indexes: { createdAt: 'createdAt', comp: 'comp', status: 'status' } },
  modelPerf: { keyPath: 'key', indexes: { modelVersion: 'modelVersion', comp: 'comp', market: 'market', updatedAt: 'updatedAt' } },
  patterns: { keyPath: 'id', indexes: { status: 'status', createdAt: 'createdAt', comp: 'comp' } },
  learningLog: { keyPath: 'id', autoIncrement: true, indexes: { ts: 'ts', type: 'type' } },
  jobs: { keyPath: 'id', indexes: { status: 'status', updatedAt: 'updatedAt' } },
  aggregates: { keyPath: 'key' },
  conflicts: { keyPath: 'id', autoIncrement: true, indexes: { ts: 'ts', store: 'store', key: 'key' } },
  qualityLog: { keyPath: 'key', indexes: { lastTs: 'lastTs', severity: 'severity', code: 'code' } }
};

const LPDB = (() => {
  const NAME = 'leaguePlusDB';
  const VER = LP_SCHEMA;
  let dbp = null;
  let readyP = null;

  function open() {
    if (dbp) return dbp;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available'));
    dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(NAME, VER); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [name, def] of Object.entries(LP_STORES)) {
          let s;
          if (!db.objectStoreNames.contains(name)) {
            s = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
          } else {
            s = r.transaction.objectStore(name);
          }
          if (def.indexes) {
            for (const [iname, ipath] of Object.entries(def.indexes)) {
              if (!s.indexNames.contains(iname)) s.createIndex(iname, ipath);
            }
          }
        }
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { try { db.close(); } catch (e) { } dbp = null; };
        res(db);
      };
      r.onerror = () => rej(r.error || new Error('IndexedDB open failed'));
      r.onblocked = () => { /* another tab is holding an old version; the caller can retry */ };
    });
    return dbp;
  }

  const reqP = r => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  function tx(storeNames, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      let t;
      try { t = db.transaction(storeNames, mode); } catch (e) { rej(e); return; }
      const out = {};
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (err) rej(err); else res(out);
      };
      t.oncomplete = () => finish(null);
      t.onerror = () => finish(t.error || new Error('transaction failed'));
      t.onabort = () => finish(t.error || new Error('transaction aborted'));
      try { fn(t, out); } catch (e) { try { t.abort(); } catch (_) { } finish(e); }
    }));
  }

  async function get(store, key) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).get(key));
  }
  async function getAll(store) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).getAll());
  }
  async function getAllBy(store, index, key) {
    const db = await open();
    const s = db.transaction(store).objectStore(store);
    if (key === undefined) return reqP(s.index(index).getAll());
    return reqP(s.index(index).getAll(key));
  }
  async function count(store) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).count());
  }
  async function countBy(store, index, key) {
    const db = await open();
    const s = db.transaction(store).objectStore(store);
    if (key === undefined) return reqP(s.index(index).count());
    return reqP(s.index(index).count(key));
  }
  async function getRecent(store, index, limit = 200) {
    const db = await open();
    return new Promise((res, rej) => {
      const out = [];
      const s = db.transaction(store).objectStore(store);
      const req = s.index(index).openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) { res(out); return; }
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }
  async function put(store, item) {
    return tx([store], 'readwrite', t => { t.objectStore(store).put(item); });
  }
  async function putMany(store, items) {
    if (!items || !items.length) return 0;
    return tx([store], 'readwrite', t => { const s = t.objectStore(store); items.forEach(i => s.put(i)); });
  }
  async function add(store, item) {
    return tx([store], 'readwrite', t => { t.objectStore(store).add(item); });
  }
  async function addMany(store, items) {
    if (!items || !items.length) return 0;
    return tx([store], 'readwrite', t => { const s = t.objectStore(store); items.forEach(i => s.add(i)); });
  }
  async function del(store, key) {
    return tx([store], 'readwrite', t => { t.objectStore(store).delete(key); });
  }
  async function clear(store) {
    return tx([store], 'readwrite', t => { t.objectStore(store).clear(); });
  }
  async function clearAll() {
    const names = Object.keys(LP_STORES);
    for (const n of names) await clear(n);
    return names.length;
  }

  // Append-only write. Identical content is skipped; different content is
  // recorded in `conflicts` and the original historical row is kept.
  async function putImmutable(store, item, opts = {}) {
    const r = await putImmutableMany(store, [item], opts);
    return { added: r.added, skipped: r.skipped, conflicts: r.conflicts };
  }
  async function putImmutableMany(store, items, opts = {}) {
    if (!items || !items.length) return { added: 0, skipped: 0, conflicts: 0 };
    const def = LP_STORES[store] || {};
    const keyPath = opts.keyPath || def.keyPath || 'key';
    const hashField = opts.hashField || 'contentHash';
    const conflictStore = opts.conflictStore || 'conflicts';
    return tx([store, conflictStore], 'readwrite', (t, out) => {
      out.added = 0; out.skipped = 0; out.conflicts = 0;
      const s = t.objectStore(store), c = t.objectStore(conflictStore);
      items.forEach(item => {
        const key = item[keyPath];
        if (key === undefined || key === null) { out.skipped++; return; }
        const g = s.get(key);
        g.onsuccess = () => {
          const cur = g.result;
          if (!cur) {
            try { s.add(item); out.added++; } catch (e) { out.skipped++; }
            return;
          }
          const a = cur[hashField], b = item[hashField];
          if (a && b && a === b) { out.skipped++; return; }
          out.conflicts++;
          try {
            c.add({
              ts: Date.now(), store, key, reason: opts.reason || 'content-mismatch',
              existingHash: a || null, incomingHash: b || null,
              existingAt: cur.capturedAt || cur.ts || cur.builtAt || null,
              incomingAt: item.capturedAt || item.ts || item.builtAt || null
            });
          } catch (e) { }
        };
      });
    });
  }

  // One atomic commit for a captured game response: result rows, round rows,
  // odds snapshots, metadata and quality issues.
  async function commitRound(payload) {
    const stores = ['rounds', 'matches', 'snapshots', 'meta', 'conflicts', 'qualityLog'];
    return tx(stores, 'readwrite', (t, out) => {
      out.rounds = 0; out.added = 0; out.skipped = 0; out.conflicts = 0;
      out.snapshotsAdded = 0; out.snapshotsUpdated = 0;
      const rs = t.objectStore('rounds');
      const ms = t.objectStore('matches');
      const ss = t.objectStore('snapshots');
      const mst = t.objectStore('meta');
      const cs = t.objectStore('conflicts');
      const qs = t.objectStore('qualityLog');

      (payload.rounds || []).forEach(round => {
        const g = rs.get(round.key);
        g.onsuccess = () => {
          const cur = g.result;
          const merged = Object.assign({}, cur || {}, round);
          if (cur) {
            const rank = { legacy: 0, open: 1, finished: 2 };
            const cs = rank[cur.status] ?? 0, ns = rank[round.status] ?? 0;
            merged.status = ns >= cs ? round.status : cur.status;
            merged.createdAt = cur.createdAt || round.createdAt;
            merged.betOpen = cur.betOpen != null ? cur.betOpen : round.betOpen;
            merged.betClose = cur.betClose != null ? cur.betClose : round.betClose;
            merged.liveStart = cur.liveStart != null ? cur.liveStart : round.liveStart;
            merged.liveEnd = round.liveEnd != null ? round.liveEnd : (cur.liveEnd ?? null);
            merged.expectedMatches = round.expectedMatches != null ? round.expectedMatches : cur.expectedMatches;
            merged.catalogueVersion = cur.catalogueVersion || round.catalogueVersion;
            merged.capturedMatches = Math.max(cur.capturedMatches || 0, round.capturedMatches || 0);
            merged.quality = (ns >= cs ? round.quality : cur.quality) || cur.quality || round.quality;
            merged.lastSeenAt = Math.max(cur.lastSeenAt || 0, round.lastSeenAt || 0);
          }
          try { rs.put(merged); out.rounds++; } catch (e) { }
        };
      });

      (payload.matches || []).forEach(item => {
        const g = ms.get(item.key);
        g.onsuccess = () => {
          const cur = g.result;
          if (!cur) { try { ms.add(item); out.added++; } catch (e) { out.skipped++; } return; }
          if (cur.contentHash && item.contentHash && cur.contentHash === item.contentHash) { out.skipped++; return; }
          out.conflicts++;
          try {
            cs.add({
              ts: Date.now(), store: 'matches', key: item.key, reason: 'content-mismatch',
              existingHash: cur.contentHash || null, incomingHash: item.contentHash || null,
              existingAt: cur.capturedAt || cur.ts || null, incomingAt: item.capturedAt || item.ts || null
            });
          } catch (e) { }
        };
      });

      (payload.snapshots || []).forEach(item => {
        const g = ss.get(item.key);
        g.onsuccess = () => {
          const cur = g.result;
          if (!cur) { try { ss.add(item); out.snapshotsAdded++; } catch (e) { } return; }
          if (cur.hash && item.hash && cur.hash === item.hash) {
            cur.lastSeenAt = Math.max(cur.lastSeenAt || 0, item.lastSeenAt || item.capturedAt || 0);
            cur.observations = (cur.observations || 1) + (item.observations || 1);
            if (item.resultVerified) cur.resultVerified = true;
            if (item.phase === 'close') cur.phase = 'close';
            try { ss.put(cur); out.snapshotsUpdated++; } catch (e) { }
            return;
          }
          out.conflicts++;
          try {
            cs.add({
              ts: Date.now(), store: 'snapshots', key: item.key, reason: 'snapshot-mismatch',
              existingHash: cur.hash || null, incomingHash: item.hash || null,
              existingAt: cur.capturedAt || null, incomingAt: item.capturedAt || null
            });
          } catch (e) { }
        };
      });

      (payload.meta || []).forEach(m => { try { mst.put(m); } catch (e) { } });

      (payload.qualityLog || []).forEach(q => {
        const g = qs.get(q.key);
        g.onsuccess = () => {
          const cur = g.result;
          if (cur) {
            cur.count = (cur.count || 1) + (q.count || 1);
            cur.lastTs = Math.max(cur.lastTs || 0, q.lastTs || Date.now());
            if (q.sample !== undefined) cur.sample = q.sample;
            try { qs.put(cur); } catch (e) { }
          } else {
            try { qs.put(q); } catch (e) { }
          }
        };
      });
    });
  }

  async function mergeQuality(issues) {
    if (!issues || !issues.length) return 0;
    return tx(['qualityLog'], 'readwrite', (t) => {
      const qs = t.objectStore('qualityLog');
      issues.forEach(q => {
        const g = qs.get(q.key);
        g.onsuccess = () => {
          const cur = g.result;
          if (cur) {
            cur.count = (cur.count || 1) + (q.count || 1);
            cur.lastTs = Math.max(cur.lastTs || 0, q.lastTs || Date.now());
            cur.sample = q.sample !== undefined ? q.sample : cur.sample;
            try { qs.put(cur); } catch (e) { }
          } else { try { qs.put(q); } catch (e) { } }
        };
      });
    });
  }

  async function getLatestSnapshot(fixtureId) {
    const rows = await getAllBy('snapshots', 'fixtureId', fixtureId);
    rows.sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
    return rows.length ? rows[rows.length - 1] : null;
  }
  async function getCatalogue(version) { return version ? get('catalogues', version) : null; }
  async function putCatalogue(c) {
    return putImmutable('catalogues', c, { keyPath: 'version', hashField: 'hash', reason: 'catalogue-mismatch' });
  }
  async function getRounds(game) { return game == null ? getAll('rounds') : getAllBy('rounds', 'game', +game); }

  // Fill Stage-2 fields on records captured by v1. Only adds metadata; never
  // changes scores, goals or odds.
  async function migrate(force = false) {
    const done = await get('meta', 'migration:v3');
    if (done && done.done && !force) return done;
    const init = await get('meta', 'init');
    const compGame = {};
    if (init && init.games) init.games.forEach(g => (g.leagues || []).forEach(l => { compGame[l.id] = g.id; }));
    const current = await get('meta', 'cat:current');
    const metas = await getAll('meta');
    const selMap = {};
    metas.forEach(x => { if (x && typeof x.key === 'string' && x.key.startsWith('sel:') && x.value) selMap[x.key] = x.value; });
    const matches = await getAll('matches');
    const roundsMap = new Map();
    let n = 0;
    for (const m of matches) {
      if (!m.fixtureId) {
        const game = compGame[m.comp] || null;
        m.game = game;
        m.roundKey = game != null ? game + ':' + m.roundId : '?:' + m.roundId;
        m.fixtureId = (game != null ? game : '?') + ':' + m.key;
        m.liveStart = Number.isFinite(m.ts) ? m.ts : null;
        m.liveEnd = Number.isFinite(m.ts) ? m.ts + 60e3 : null;
        m.betClose = Number.isFinite(m.ts) ? m.ts : null;
        m.betOpen = null;
        m.oddsProvenance = 'result-v1';
        m.catalogueVersion = current ? current.version : null;
        m.contentHash = LPUtil.contentHash({ key: m.key, hg: m.hg, ag: m.ag, goals: m.goals, odds: m.odds, sk: m.sk });
        m.migratedAt = Date.now();
        n++;
      }
      if (!m.contentHash) m.contentHash = LPUtil.contentHash({ key: m.key, hg: m.hg, ag: m.ag, goals: m.goals, odds: m.odds, sk: m.sk });
      if (!m.quality) m.quality = LPQuality.validateMatch(m, { cat: null, selStr: selMap[m.sk] || '' });
      const rk = m.roundKey || ('?:' + m.roundId);
      if (!roundsMap.has(rk)) {
        roundsMap.set(rk, {
          key: rk, game: m.game ?? null, roundId: m.roundId,
          status: 'legacy', betOpen: null, betClose: m.liveStart || m.ts || null,
          liveStart: m.liveStart || m.ts || null, liveEnd: m.liveEnd || null,
          competitions: [], seasons: [], weeks: [],
          expectedMatches: 0, capturedMatches: 0,
          catalogueVersion: m.catalogueVersion || null, source: 'migration',
          createdAt: Date.now(), lastSeenAt: Date.now(),
          quality: { status: 'warn', flags: ['legacy'] }
        });
      }
      const r = roundsMap.get(rk);
      r.capturedMatches++;
      if (!r.competitions.includes(m.comp)) r.competitions.push(m.comp);
      if (m.season != null && !r.seasons.includes(m.season)) r.seasons.push(m.season);
      if (m.week != null && !r.weeks.includes(m.week)) r.weeks.push(m.week);
      if (m.liveStart && (!r.liveStart || m.liveStart < r.liveStart)) r.liveStart = m.liveStart;
    }
    // write matches in batches; only create round rows that are not already
    // present, so a concurrent live capture cannot be clobbered by migration.
    for (let i = 0; i < matches.length; i += 400) await putMany('matches', matches.slice(i, i + 400));
    const existingRounds = new Set((await getAll('rounds')).map(r => r.key));
    for (const r of roundsMap.values()) if (!existingRounds.has(r.key)) await put('rounds', r);
    const rec = { key: 'migration:v3', done: true, at: Date.now(), total: matches.length, migrated: n };
    await put('meta', rec);
    return rec;
  }

  async function ready() {
    if (!readyP) {
      readyP = open().then(() => migrate()).catch(e => {
        readyP = null;
        return { error: e.message };
      });
    }
    return readyP;
  }

  async function stats() {
    const names = ['matches', 'rounds', 'catalogues', 'snapshots', 'predictions', 'settlements', 'modelStates', 'modelPerf', 'patterns', 'learningLog', 'jobs', 'aggregates', 'conflicts', 'qualityLog'];
    const out = { schema: LP_SCHEMA };
    for (const n of names) { try { out[n] = await count(n); } catch (e) { out[n] = null; } }
    return out;
  }

  return {
    NAME, VER, STORES: LP_STORES,
    open, ready, tx, get, getAll, getAllBy, count, countBy, getRecent,
    put, putMany, add, addMany, del, clear, clearAll,
    putImmutable, putImmutableMany, commitRound, mergeQuality,
    getLatestSnapshot, getCatalogue, putCatalogue, getRounds,
    migrate, stats,
    _resetForTests() { dbp = null; readyP = null; }
  };
})();

// ---------------------------------------------------------------------------
// market catalogue (frozen per round)
const LPCat = (() => {
  let CAT = null;
  // exclusive: selections partition the score space; pair: each selection is a
  // pair of 1X2 outcomes; overlap: events can happen together; unknown: no
  // structural assumption.
  const GROUP = {
    1: 'ex', 2: 'pair', 3: 'ex', 4: 'ex', 5: 'ex', 6: 'ex', 7: 'ex', 8: 'ex',
    9: 'overlap', 10: 'pair', 11: 'overlap', 12: 'overlap', 13: 'ex', 14: 'pair', 15: 'overlap'
  };

  function buildMap(defs) {
    const cat = {};
    const markets = (defs && (defs.markets || defs)) || [];
    markets.forEach(m => {
      const add = (sels, sub) => Object.entries(sels || {}).forEach(([id, s]) => {
        cat[id] = {
          id: +id, mId: m.id, market: String(m.name || '').trim(), sub: sub || null,
          name: s.name, full: s.fullName || s.name, type: s.type,
          aw: !!s.alwaysWin, al: !!s.alwaysLose,
          ws: new Set(String(s.winningScores || '').split('|').filter(Boolean)),
          cond: s.winningConditions || null,
          group: GROUP[m.id] || 'unknown'
        };
      });
      add(m.selections, null);
      (m.submarkets || []).forEach(sm => add(sm.selections, sm.name));
    });
    return cat;
  }
  function build(init) { CAT = buildMap(init); return CAT; }
  const get = () => CAT;
  const mkey = c => c.mId + (c.sub ? '@' + c.sub : '');
  const mlabel = c => c.market + (c.sub ? ' ' + c.sub : '');
  const groupOf = c => c.group || GROUP[c.mId] || 'unknown';
  const UNIVERSE = new Set(); for (let h = 0; h <= 6; h++) for (let a = 0; a + h <= 6; a++) UNIVERSE.add(h + ':' + a);

  function semantic(c, h, a) {
    const n = String(c.name || '').replace(/\s+/g, '');
    const t = h + a, R = h > a ? '1' : h < a ? '2' : 'X', gg = h > 0 && a > 0;
    let m;
    if (c.mId === 15) return n.startsWith('X') ? h === a : n.startsWith('1') ? h > a : a > h;
    if (c.mId === 1) return n === R;
    if (c.mId === 2) return n.includes(R) || (n === 'X2' && R === 'X');
    if (c.mId === 3) return (n === 'GG') === gg;
    if (c.mId === 4) return n === h + '-' + a;
    if ((m = n.match(/^([OU])(\d+\.5)$/))) return m[1] === 'O' ? t > +m[2] : t < +m[2];
    if ((m = n.match(/^([HA])([OU])(\d+\.5)$/))) { const g = m[1] === 'H' ? h : a; return m[2] === 'O' ? g > +m[3] : g < +m[3]; }
    if ((m = n.match(/^([12X])([OU])(\d+\.5)$/))) return R === m[1] && (m[2] === 'O' ? t > +m[3] : t < +m[3]);
    if ((m = n.match(/^(1X|12|X2|2X)([OU])(\d+\.5)$/))) return m[1].includes(R) && (m[2] === 'O' ? t > +m[3] : t < +m[3]);
    if ((m = n.match(/^MultiHome(\d)-(\d)$/))) return h >= +m[1] && h <= +m[2];
    if ((m = n.match(/^MultiAway(\d)-(\d)$/))) return a >= +m[1] && a <= +m[2];
    if ((m = n.match(/^Multi(\d)-(\d)$/))) return t >= +m[1] && t <= +m[2];
    if ((m = n.match(/^([12X])\+(GG|NG)$/))) return R === m[1] && ((m[2] === 'GG') === gg);
    if ((m = n.match(/^(1X|12|2X)\+(GG|NG)$/))) return m[1].includes(R) && ((m[2] === 'GG') === gg);
    // Unknown definition: do not guess a winner. Return null so the caller can
    // mark the selection unsettleable instead of silently paying it.
    return c.aw ? true : null;
  }

  function settle(c, h, a, goals, opts = {}) {
    if (!c) return null;
    if (c.type === 2 || c.cond) {
      if (opts.tlOk === false) return null;
      const side = String(c.name || '').trim().startsWith('1') ? 'h' : 'a';
      if (side === 'h' ? h > a : a > h) return true;
      if (!Array.isArray(goals)) return null;
      let x = 0, y = 0;
      for (const ev of goals) {
        const s = Array.isArray(ev) ? ev[1] : ev.side;
        if (s === 'h') x++; else y++;
        if ((side === 'h' ? x - y : y - x) === 1) return true;
      }
      return false;
    }
    const k = h + ':' + a;
    if (UNIVERSE.has(k) && c.ws && c.ws.size) return c.ws.has(k);
    const v = semantic(c, h, a);
    return v === undefined ? null : v;
  }

  // Market-level structural audit, used by tests and the data-quality panel.
  function audit(cat) {
    const byKey = {};
    Object.values(cat).forEach(c => {
      const k = mkey(c);
      const g = byKey[k] = byKey[k] || { key: k, label: mlabel(c), mId: c.mId, group: groupOf(c), ids: [], type2: 0 };
      g.ids.push(c.id); if (c.type === 2) g.type2++;
    });
    Object.values(byKey).forEach(g => {
      let ones = 0, twos = 0, nulls = 0, total = 0;
      for (let h = 0; h <= 6; h++) for (let a = 0; a + h <= 6; a++) {
        let n = 0, bad = false;
        for (const id of g.ids) {
          const w = settle(cat[id], h, a, null, { tlOk: true });
          if (w === true) n++; else if (w == null) bad = true;
        }
        if (g.type2 || bad) continue;
        total++; if (n === 1) ones++; else if (n === 2) twos++; else nulls++;
      }
      g.pattern = total ? (ones === total ? 'exclusive' : twos === total ? 'pair' : 'overlap-or-gap') : 'timeline';
      g.coverage = total;
    });
    return byKey;
  }

  return { build, buildMap, get, mkey, mlabel, groupOf, settle, semantic, audit, GROUP, UNIVERSE };
})();

// ---------------------------------------------------------------------------
// parsing
const LPParse = (() => {
  function hashSel(s) { return 'sel:' + LPUtil.hash64(String(s)); }
  function splitTeams(nm) {
    const i = String(nm).indexOf('-');
    if (i <= 0 || i >= nm.length - 1) return null;
    return [nm.slice(0, i), nm.slice(i + 1)];
  }
  function goalsFor(count, timeline) {
    const goals = Array.from({ length: count }, () => []);
    String(timeline || '').split('|').filter(Boolean).forEach(ev => {
      const parts = ev.split(':');
      const min = +parts[0], codes = String(parts[1] || '');
      codes.split('-').forEach(cs => {
        const c = +cs; if (!c) return;
        const idx = Math.floor((c - 1) / 2);
        if (goals[idx]) goals[idx].push([min, c % 2 === 1 ? 'h' : 'a']);
      });
    });
    goals.forEach(g => g.sort((x, y) => x[0] - y[0]));
    return goals;
  }
  function results(game, rr, ctx = {}) {
    const out = [], invalid = [], selsets = {};
    const capturedAt = ctx.capturedAt || Date.now();
    const catalogueVersion = ctx.catalogueVersion || null;
    const betOpen = ctx.betOpen ?? null;
    const betClose = ctx.betClose ?? LPUtil.num(Date.parse(rr.liveStartDate));
    const liveStart = LPUtil.num(Date.parse(rr.liveStartDate));
    const liveEnd = LPUtil.num(Date.parse(rr.liveEndDate));
    (rr.competitions || []).forEach((comp, ci) => {
      const names = String((rr.matches || [])[ci] || '').split('|').filter(Boolean);
      const scores = String((rr.results || [])[ci] || '').split('|');
      const odds = String((rr.odds || [])[ci] || '').split('|');
      const sel = String((rr.selections || [])[ci] || '');
      const sk = hashSel(sel); selsets[sk] = sel;
      const goals = goalsFor(names.length, (rr.timeline || [])[ci]);
      names.forEach((nm, i) => {
        const teams = splitTeams(nm);
        const sc = String(scores[i] || '').split(':');
        const hg = LPUtil.num(sc[0]), ag = LPUtil.num(sc[1]);
        if (!teams || hg == null || ag == null || hg < 0 || ag < 0 || hg > 30 || ag > 30) {
          invalid.push({ game, comp, roundId: +rr.roundId, idx: i, name: nm, reason: !teams ? 'team_parse' : 'score_invalid', rawScore: scores[i] || '' });
          return;
        }
        const g = goals[i] || [];
        const tlOk = g.length === hg + ag;
        out.push({
          key: rr.roundId + ':' + comp + ':' + i,
          fixtureId: game + ':' + rr.roundId + ':' + comp + ':' + i,
          roundKey: game + ':' + rr.roundId,
          game, comp, roundId: +rr.roundId, season: +rr.seasons?.[ci], week: +rr.weeks?.[ci], idx: i,
          home: teams[0], away: teams[1], hg, ag, goals: g, tlOk,
          odds: odds[i] || '', sk, selHash: sk,
          ts: liveStart, betOpen, betClose, liveStart, liveEnd,
          oddsProvenance: 'result', catalogueVersion, capturedAt,
          roundSpecial: null, quality: { status: 'ok', flags: [] }
        });
      });
    });
    return { matches: out, invalid, selsets };
  }
  function upcoming(game, r, ctx = {}) {
    const out = [], invalid = [], selsets = {};
    const capturedAt = ctx.capturedAt || Date.now();
    const catalogueVersion = ctx.catalogueVersion || null;
    const betOpen = LPUtil.num(Date.parse(r.startDate));
    const betClose = LPUtil.num(Date.parse(r.noBetDate || r.endDate));
    const liveStart = LPUtil.num(Date.parse(r.endDate));
    (r.competitions || []).forEach((comp, ci) => {
      const names = String((r.matches || [])[ci] || '').split('|').filter(Boolean);
      const odds = String((r.odds || [])[ci] || '').split('|');
      const sel = String((r.selections || [])[ci] || '');
      const sk = hashSel(sel); selsets[sk] = sel;
      names.forEach((nm, i) => {
        const teams = splitTeams(nm);
        if (!teams) {
          invalid.push({ game, comp, roundId: +r.roundId, idx: i, name: nm, reason: 'team_parse' });
          return;
        }
        out.push({
          key: r.roundId + ':' + comp + ':' + i,
          fixtureId: game + ':' + r.roundId + ':' + comp + ':' + i,
          roundKey: game + ':' + r.roundId,
          game, comp, roundId: +r.roundId, season: +r.seasons?.[ci], week: +r.weeks?.[ci], idx: i,
          home: teams[0], away: teams[1],
          odds: odds[i] || '', sk, selHash: sk,
          ts: betOpen, betClose, close: betClose, end: betClose, liveStart, liveEnd: null,
          betOpen, oddsProvenance: 'upcoming', catalogueVersion, capturedAt,
          quality: { status: 'ok', flags: [] }
        });
      });
    });
    return { fixtures: out, invalid, selsets };
  }
  // odds string + selection string -> Map selId -> odds
  function oddsMap(oddsStr, selStr) {
    const ids = String(selStr).split('-'), o = String(oddsStr).split('-').map(Number), m = new Map();
    ids.forEach((id, i) => { if (o[i] > 1 && Number.isFinite(o[i])) m.set(+id, o[i]); });
    return m;
  }
  function roundSpecials(rr) {
    const out = {};
    (rr.competitions || []).forEach((comp, ci) => {
      out[comp] = {
        selections: String(rr.roundSpecialSelections?.[ci] || ''),
        odds: String(rr.roundSpecialOdds?.[ci] || ''),
        results: String(rr.roundSpecialResults?.[ci] || '')
      };
    });
    return out;
  }
  return { results, upcoming, oddsMap, hashSel, splitTeams, roundSpecials };
})();

// ---------------------------------------------------------------------------
// data quality
const LPQuality = (() => {
  const CRITICAL = new Set([
    'team_invalid', 'team_parse', 'score_missing', 'score_invalid', 'ts_invalid', 'odds_missing',
    'odds_sel_mismatch', 'catalogue_missing', 'round_mismatch', 'fixture_duplicate',
    'comp_mismatch', 'odds_invalid'
  ]);
  const WARN = new Set([
    'timeline_incomplete', 'timeline_invalid', 'odds_unavailable', 'season_missing',
    'week_missing', 'legacy', 'unknown_selection', 'partial_round', 'round_gap', 'bet_times_missing'
  ]);
  function flagSeverity(f) { return CRITICAL.has(f) ? 'invalid' : WARN.has(f) ? 'warn' : 'info'; }
  function statusOf(flags) {
    if (!flags || !flags.length) return 'ok';
    if (flags.some(f => CRITICAL.has(f))) return 'invalid';
    return 'warn';
  }
  function validateMatch(m, ctx = {}) {
    const flags = [];
    if (!m || !m.home || !m.away) flags.push('team_invalid');
    if (m.hg == null || m.ag == null) flags.push('score_missing');
    else if (!Number.isInteger(m.hg) || !Number.isInteger(m.ag) || m.hg < 0 || m.ag < 0 || m.hg > 30 || m.ag > 30) flags.push('score_invalid');
    if (!Number.isFinite(m.ts)) flags.push('ts_invalid');
    else if (ctx.round && Number.isFinite(ctx.round.betClose) && (m.ts < ctx.round.betClose - 3600e3 || m.ts > ctx.round.betClose + 3600e3)) flags.push('ts_invalid');
    if (ctx.round && Array.isArray(ctx.round.competitions) && ctx.round.competitions.length && !ctx.round.competitions.map(Number).includes(+m.comp)) flags.push('comp_mismatch');
    if (!m.odds) flags.push('odds_missing');
    else {
      if (String(m.odds).split('-').some(x => { const n = Number(x); return !Number.isFinite(n) || n < 0; })) flags.push('odds_invalid');
      const selStr = ctx.selStr || m.selStr || '';
      if (!selStr) {
        // We have prices but no selection definition to attach them to.
        flags.push('odds_sel_mismatch');
      } else {
        const om = LPParse.oddsMap(m.odds, selStr);
        if (!om.size) flags.push('odds_missing');
        if (String(m.odds).split('-').length !== String(selStr).split('-').length) flags.push('odds_sel_mismatch');
        if (ctx.cat) {
          for (const id of om.keys()) if (!ctx.cat[id]) { flags.push('unknown_selection'); break; }
        }
      }
    }
    if (m.goals && m.hg != null && m.ag != null && m.goals.length !== m.hg + m.ag) flags.push('timeline_incomplete');
    if (Array.isArray(m.goals) && m.goals.some(g => !Array.isArray(g) || !Number.isFinite(g[0]) || (g[1] !== 'h' && g[1] !== 'a'))) flags.push('timeline_invalid');
    if (m.season == null || !Number.isFinite(m.season)) flags.push('season_missing');
    if (m.week == null || !Number.isFinite(m.week)) flags.push('week_missing');
    if (!m.catalogueVersion) flags.push('catalogue_missing');
    return { status: statusOf(flags), flags: [...new Set(flags)], checkedAt: Date.now() };
  }
  function validateRound(r, matches, ctx = {}) {
    const flags = [];
    if (!r || r.roundId == null) flags.push('round_mismatch');
    if (r && r.expectedMatches != null && r.capturedMatches != null && r.capturedMatches < r.expectedMatches) flags.push('partial_round');
    if (r && r.expectedMatches === 0) flags.push('partial_round');
    if (r && (!Number.isFinite(r.betOpen) || !Number.isFinite(r.betClose))) flags.push('bet_times_missing');
    if (!r || !r.catalogueVersion) flags.push('catalogue_missing');
    const seen = new Set();
    (matches || []).forEach(m => {
      if (m.key && seen.has(m.key)) flags.push('fixture_duplicate'); else if (m.key) seen.add(m.key);
      if (r && m.roundId != null && +m.roundId !== +r.roundId) flags.push('round_mismatch');
      if (r && m.game != null && +m.game !== +r.game) flags.push('round_mismatch');
    });
    return { status: statusOf(flags), flags: [...new Set(flags)], checkedAt: Date.now() };
  }
  function logKey(entity, key, code) { return entity + '|' + key + '|' + code; }
  function makeIssue(opts) {
    const sev = opts.severity || flagSeverity(opts.code);
    return {
      key: logKey(opts.entity, opts.entityKey, opts.code),
      entity: opts.entity, entityKey: opts.entityKey, code: opts.code, severity: sev,
      count: opts.count || 1, firstTs: opts.ts || Date.now(), lastTs: opts.ts || Date.now(),
      message: opts.message || opts.code, sample: opts.sample ?? null
    };
  }
  function issuesForMatch(m, ctx = {}) {
    const q = m.quality || validateMatch(m, ctx);
    return (q.flags || []).map(f => makeIssue({
      entity: 'match', entityKey: m.key, code: f, severity: flagSeverity(f),
      message: f.replace(/_/g, ' '), sample: { game: m.game, comp: m.comp, home: m.home, away: m.away, hg: m.hg, ag: m.ag }
    }));
  }
  function issuesForRound(r) {
    const q = r.quality || { flags: [] };
    return (q.flags || []).map(f => makeIssue({
      entity: 'round', entityKey: r.key, code: f, severity: flagSeverity(f),
      message: f.replace(/_/g, ' '), sample: { game: r.game, roundId: r.roundId, captured: r.capturedMatches, expected: r.expectedMatches }
    }));
  }
  function summarize(matches) {
    const out = { total: 0, ok: 0, warn: 0, invalid: 0, flags: {} };
    (matches || []).forEach(m => {
      out.total++;
      const s = m.quality?.status || 'ok';
      out[s] = (out[s] || 0) + 1;
      (m.quality?.flags || []).forEach(f => { out.flags[f] = (out.flags[f] || 0) + 1; });
    });
    return out;
  }
  return { CRITICAL, WARN, flagSeverity, statusOf, validateMatch, validateRound, makeIssue, issuesForMatch, issuesForRound, summarize };
})();

// ---------------------------------------------------------------------------
// capture/sync
const LPSync = (() => {
  const MEM = {};
  let syncing = new Set();
  let deps = { db: LPDB, fetch: null, storage: null, alarms: null, ledger: null, learning: null, ledgerHalfLifeH: 6, now: () => Date.now(), games: [3, 4, 6, 7] };

  function configure(d = {}) { deps = Object.assign({}, deps, d); }
  function getDep(k) { return deps[k]; }

  async function storageGet(key) {
    if (deps.storage && deps.storage.get) return deps.storage.get(key);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const v = await chrome.storage.local.get(key); return v[key];
    }
    return MEM[key];
  }
  async function storageSet(obj) {
    if (deps.storage && deps.storage.set) return deps.storage.set(obj);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local.set(obj);
    Object.assign(MEM, obj);
  }
  function alarmCreate(name, when) {
    if (deps.alarms && deps.alarms.create) return deps.alarms.create(name, { when });
    if (typeof chrome !== 'undefined' && chrome.alarms) return chrome.alarms.create(name, { when });
  }

  async function apiFetch(path, opts = {}) {
    const f = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('fetch unavailable');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, opts.timeout || 20000) : null;
    try {
      const r = await f(LP_API + path, { cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
      const j = await r.json();
      if (!j || j.status !== 1) throw new Error((j && j.error && j.error.message) || 'API error');
      return j.data;
    } finally { if (timer) clearTimeout(timer); }
  }

  async function getInit(force = false) {
    const db = deps.db;
    let init = await db.get('meta', 'init');
    const stale = !init || !init.markets || (deps.now() - (init.at || 0) > 6 * 3600e3);
    if (force || stale) {
      try {
        const d = await apiFetch('/game/init');
        const hash = LPUtil.hash64(LPUtil.stableStringify({ markets: d.markets, roundSpecialMarkets: d.roundSpecialMarkets, extraMarkets: d.extraMarkets }));
        const version = 'cat-' + hash.slice(0, 12);
        const catRec = {
          version, hash, builtAt: deps.now(), serverTime: d.serverTime || null,
          markets: d.markets, roundSpecialMarkets: d.roundSpecialMarkets || [], extraMarkets: d.extraMarkets || [], games: d.games
        };
        await db.putCatalogue(catRec);
        init = {
          key: 'init', at: deps.now(), games: d.games, markets: d.markets,
          roundSpecialMarkets: d.roundSpecialMarkets || [], extraMarkets: d.extraMarkets || [],
          serverTime: d.serverTime || null, version, hash
        };
        await db.put('meta', init);
        await db.put('meta', { key: 'cat:current', version, hash, at: deps.now() });
      } catch (e) {
        // Keep using the last good catalogue if the network is unavailable;
        // only fail when we have never successfully captured one.
        if (!init || !init.markets) throw e;
      }
    }
    // Make sure the catalogue record referenced by init still exists (it can
    // be missing after a selective restore or a manual clear).
    let rec = init.version ? await db.getCatalogue(init.version) : null;
    if (!rec) {
      const hash = LPUtil.hash64(LPUtil.stableStringify({ markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [] }));
      const version = 'cat-' + hash.slice(0, 12);
      rec = {
        version, hash, builtAt: deps.now(), serverTime: init.serverTime || null,
        markets: init.markets, roundSpecialMarkets: init.roundSpecialMarkets || [], extraMarkets: init.extraMarkets || [], games: init.games
      };
      await db.putCatalogue(rec);
      init = Object.assign({}, init, { version, hash });
      await db.put('meta', init);
      await db.put('meta', { key: 'cat:current', version, hash, at: deps.now() });
    }
    const markets = init.markets || rec.markets || [];
    const cat = LPCat.buildMap({ markets });
    return { init, cat, version: init.version || rec.version, hash: init.hash || rec.hash };
  }

  function expectedCount(raw) {
    return String(raw || '').split('|').filter(Boolean).length;
  }

  async function buildPayload(gameId, d, catInfo, now) {
    const db = deps.db;
    const rr = d.roundResults, r = d.round;
    const rounds = [], matches = [], snapshots = [], meta = [], qualityLog = [];
    const upcomingFixtures = [], upcomingSelsets = {};
    const gameMeta = (catInfo.init.games || []).find(g => +g.id === +gameId);
    const leagues = gameMeta ? (gameMeta.leagues || []).filter(l => l.enabled) : [];

    // ----- finished round -----
    if (rr && rr.roundId) {
      const roundKey = gameId + ':' + rr.roundId;
      const existing = await db.get('rounds', roundKey);
      const catalogueVersion = existing?.catalogueVersion || catInfo.version;
      const betOpen = existing?.betOpen ?? null;
      const betClose = LPUtil.num(Date.parse(rr.liveStartDate));
      const p = LPParse.results(gameId, rr, { catalogueVersion, betOpen, betClose, capturedAt: now });
      const comps = (rr.competitions || []).map(Number);
      for (const m of p.matches) {
        m.roundKey = roundKey;
        m.fixtureId = gameId + ':' + m.key;
        m.catalogueVersion = catalogueVersion;
        m.quality = LPQuality.validateMatch(m, { cat: catInfo.cat, round: { betOpen, betClose, competitions: comps }, selStr: p.selsets[m.sk] || '' });
        m.contentHash = LPUtil.contentHash({ key: m.key, hg: m.hg, ag: m.ag, goals: m.goals, odds: m.odds, sk: m.sk });
        matches.push(m);
        qualityLog.push(...LPQuality.issuesForMatch(m, { cat: catInfo.cat, round: { betOpen, betClose, competitions: comps }, selStr: p.selsets[m.sk] || '' }));
        if (m.odds) {
          const hash = LPUtil.hash64((m.sk || '') + '|' + m.odds);
          const latest = await db.getLatestSnapshot(m.fixtureId);
          if (latest && latest.roundKey === roundKey && latest.hash === hash) {
            snapshots.push(Object.assign({}, latest, { lastSeenAt: now, observations: 1, resultVerified: true, phase: 'close' }));
          } else {
            snapshots.push({
              key: m.fixtureId + ':' + now + ':' + hash.slice(0, 8),
              fixtureId: m.fixtureId, roundKey, game: gameId, comp: m.comp,
              capturedAt: now, phase: 'result', odds: m.odds, selHash: m.sk, hash,
              oddsCount: String(m.odds).split('-').filter(x => Number(x) > 1).length,
              resultVerified: true, observations: 1, firstSeenAt: now, lastSeenAt: now
            });
          }
        }
      }
      const expected = (rr.matches || []).reduce((s, x) => s + expectedCount(x), 0);
      const round = {
        key: roundKey, game: gameId, roundId: +rr.roundId, status: 'finished',
        betOpen, betClose, liveStart: betClose, liveEnd: LPUtil.num(Date.parse(rr.liveEndDate)),
        competitions: comps, seasons: (rr.seasons || []).map(Number), weeks: (rr.weeks || []).map(Number),
        expectedMatches: expected, capturedMatches: p.matches.length,
        catalogueVersion, source: 'results', createdAt: existing?.createdAt || now, lastSeenAt: now,
        roundSpecial: LPParse.roundSpecials(rr)
      };
      round.quality = LPQuality.validateRound(round, p.matches, { cat: catInfo.cat });
      qualityLog.push(...LPQuality.issuesForRound(round));
      p.invalid.forEach(iv => qualityLog.push(LPQuality.makeIssue({
        entity: 'match', entityKey: roundKey + ':' + iv.comp + ':' + iv.idx, code: iv.reason,
        message: iv.reason.replace(/_/g, ' '), sample: iv
      })));
      rounds.push(round);
      for (const [sk, sel] of Object.entries(p.selsets)) meta.push({ key: sk, value: sel, at: now });
    }

    // ----- upcoming round -----
    if (r && r.roundId) {
      const roundKey = gameId + ':' + r.roundId;
      const existing = await db.get('rounds', roundKey);
      const catalogueVersion = existing?.catalogueVersion || catInfo.version;
      const p = LPParse.upcoming(gameId, r, { catalogueVersion, capturedAt: now });
      const expected = (r.matches || []).reduce((s, x) => s + expectedCount(x), 0);
      const round = {
        key: roundKey, game: gameId, roundId: +r.roundId, status: 'open',
        betOpen: LPUtil.num(Date.parse(r.startDate)),
        betClose: LPUtil.num(Date.parse(r.noBetDate || r.endDate)),
        liveStart: LPUtil.num(Date.parse(r.endDate)), liveEnd: null,
        competitions: (r.competitions || []).map(Number), seasons: (r.seasons || []).map(Number), weeks: (r.weeks || []).map(Number),
        expectedMatches: expected, capturedMatches: p.fixtures.length,
        catalogueVersion, source: 'upcoming', createdAt: existing?.createdAt || now, lastSeenAt: now,
        roundSpecial: { selections: r.roundSpecialSelections || [], odds: r.roundSpecialOdds || [] }
      };
      round.quality = LPQuality.validateRound(round, [], { cat: catInfo.cat });
      // A missing score/odds on an upcoming fixture is a warning, not a result
      // defect; the round is still open and may be re-captured.
      qualityLog.push(...LPQuality.issuesForRound(round));
      p.invalid.forEach(iv => qualityLog.push(LPQuality.makeIssue({
        entity: 'fixture', entityKey: roundKey + ':' + iv.comp + ':' + iv.idx, code: iv.reason,
        message: iv.reason.replace(/_/g, ' '), sample: iv
      })));
      rounds.push(round);
      for (const [sk, sel] of Object.entries(p.selsets)) { meta.push({ key: sk, value: sel, at: now }); upcomingSelsets[sk] = sel; }
      for (const fx of p.fixtures) {
        fx.roundKey = roundKey; fx.fixtureId = gameId + ':' + fx.key;
        if (!fx.odds) {
          qualityLog.push(LPQuality.makeIssue({
            entity: 'fixture', entityKey: fx.key, code: 'odds_missing',
            message: 'no odds captured for upcoming fixture', sample: { game: gameId, round: fx.roundId, home: fx.home, away: fx.away }
          }));
          continue;
        }
        const hash = LPUtil.hash64((fx.sk || '') + '|' + fx.odds);
        upcomingFixtures.push(fx);
        const latest = await db.getLatestSnapshot(fx.fixtureId);
        if (latest && latest.roundKey === roundKey && latest.hash === hash) {
          snapshots.push(Object.assign({}, latest, {
            lastSeenAt: now, observations: 1,
            phase: round.betClose && now >= round.betClose - 60e3 ? 'close' : latest.phase
          }));
        } else {
          snapshots.push({
            key: fx.fixtureId + ':' + now + ':' + hash.slice(0, 8),
            fixtureId: fx.fixtureId, roundKey, game: gameId, comp: fx.comp,
            capturedAt: now, phase: 'open', odds: fx.odds, selHash: fx.sk, hash,
            oddsCount: String(fx.odds).split('-').filter(x => Number(x) > 1).length,
            observations: 1, firstSeenAt: now, lastSeenAt: now
          });
        }
      }
      meta.push({ key: 'up:' + gameId, at: now, fixtures: p.fixtures, roundId: +r.roundId, close: round.betClose });
    }

    // ----- gap detection -----
    const prev = await db.get('meta', 'sync:game:' + gameId);
    if (prev && rr && Number.isFinite(prev.lastResultRound) && Number.isFinite(+rr.roundId)) {
      const gap = +rr.roundId - prev.lastResultRound;
      if (gap > 1) {
        qualityLog.push(LPQuality.makeIssue({
          entity: 'game', entityKey: String(gameId), code: 'round_gap',
          message: 'missed ' + (gap - 1) + ' round(s)', sample: { from: prev.lastResultRound, to: +rr.roundId }
        }));
      }
    }
    meta.push({
      key: 'sync:game:' + gameId, at: now,
      lastResultRound: rr && rr.roundId ? +rr.roundId : (prev?.lastResultRound ?? null),
      lastUpcomingRound: r && r.roundId ? +r.roundId : (prev?.lastUpcomingRound ?? null),
      lastRound: rr && rr.roundId ? +rr.roundId : (prev?.lastRound ?? null)
    });

    // ----- standings (optional, at most every 10 minutes) -----
    const stPrev = await db.get('meta', 'st:' + gameId);
    if (!stPrev || now - (stPrev.at || 0) > 10 * 60e3) {
      try {
        const ids = leagues.map(l => l.id).join(',');
        if (ids) {
          const st = await apiFetch('/game/standings/' + gameId + '?competitionIds=' + ids);
          meta.push({ key: 'st:' + gameId, at: now, standings: st.standings || [] });
        }
      } catch (e) { /* optional */ }
    }

    const next = nextSyncAt(d, now);
    meta.push({ key: 'sync:next:' + gameId, at: now, next });
    return { rounds, matches, snapshots, meta, qualityLog, next, resultRound: rr?.roundId || null, upcomingRound: r?.roundId || null, fixtures: upcomingFixtures, selsets: upcomingSelsets, capturedAt: now };
  }

  function nextSyncAt(d, now) {
    const rr = d && d.roundResults, r = d && d.round;
    const parse = x => LPUtil.num(Date.parse(x));
    const min = now + 30e3;
    const candidates = [];
    // Result is normally ready ~60s after the round closes.
    if (rr) {
      const end = parse(rr.liveEndDate);
      if (end != null) candidates.push(end + 25e3);
      const start = parse(rr.liveStartDate);
      if (start != null && now < start) candidates.push(start + 85e3);
    }
    // A closing price check ~65s before the next round starts. If prices are
    // static this is redundant, but it proves the provenance and catches rare
    // movement. It also gives us a close snapshot.
    if (r) {
      const close = parse(r.noBetDate || r.endDate);
      if (close != null) {
        candidates.push(close - 65e3);       // closing-price check
        candidates.push(close - 5e3);        // late pre-close snapshot if the check was missed
        candidates.push(close + 85e3);       // result for this upcoming round
      }
    }
    const future = candidates.filter(t => Number.isFinite(t) && t > min);
    if (future.length) return Math.min.apply(null, future);
    return now + 120e3;
  }

  async function scheduleGame(gameId, when) {
    const sched = (await storageGet('lpsched')) || {};
    sched[gameId] = { at: when, updatedAt: deps.now() };
    await storageSet({ lpsched: sched });
    alarmCreate('lpG:' + gameId, Math.max(when, deps.now() + 30e3));
  }

  async function updateStatus(patch) {
    const cur = (await storageGet('lpstatus')) || {};
    const next = Object.assign({}, cur, patch, { firstSync: cur.firstSync || deps.now() });
    next.games = Object.assign({}, cur.games || {});
    if (patch.game) next.games[patch.game] = Object.assign({}, next.games[patch.game], patch.gameStatus || {});
    await storageSet({ lpstatus: next });
    return next;
  }

  async function statusFor(patch) {
    const db = deps.db;
    let total = null;
    try { total = await db.count('matches'); } catch (e) { }
    return updateStatus(Object.assign({ lastSync: deps.now(), total }, patch));
  }

  async function syncGame(gameId, opts = {}) {
    if (syncing.has(+gameId)) return { busy: true };
    syncing.add(+gameId);
    const t0 = deps.now();
    try {
      const catInfo = opts.catInfo || await getInit();
      const d = await apiFetch('/game/' + gameId + '/round');
      const payload = await buildPayload(+gameId, d, catInfo, deps.now());
      const res = await deps.db.commitRound(payload);
      let ledger = null;
      try {
        const L = deps.ledger || (typeof LPLedger !== 'undefined' ? LPLedger : null);
        if (L) {
          const ledgerAt = Number.isFinite(payload.capturedAt) ? payload.capturedAt : deps.now();
          let learnOpts = {};
          try {
            const LM = deps.learning || (typeof LPLearn !== 'undefined' ? LPLearn : null);
            if (LM && typeof LM.activeOpts === 'function') learnOpts = await LM.activeOpts({ db: deps.db });
          } catch (e) { }
          ledger = await L.recordFixtures(Object.assign({
            fixtures: payload.fixtures, selsets: payload.selsets, cat: catInfo.cat, db: deps.db,
            asOf: ledgerAt, halfLifeH: deps.ledgerHalfLifeH || 6, catalogueVersion: catInfo.version
          }, learnOpts));
          if (payload.resultRound != null) {
            const settled = await L.settleRound({ db: deps.db, game: +gameId, roundId: +payload.resultRound, roundKey: gameId + ':' + payload.resultRound });
            ledger.settlements = settled;
          }
        }
      } catch (e) { ledger = { error: e.message }; }
      try { await scheduleGame(+gameId, payload.next); } catch (e) { }
      const st = {
        lastSync: deps.now(), lastRound: payload.resultRound, lastResultRound: payload.resultRound,
        upcomingRound: payload.upcomingRound, next: payload.next, ok: true, error: null,
        added: res.added, conflicts: res.conflicts, ledger,
        partial: payload.rounds.some(r => (r.quality?.flags || []).includes('partial_round'))
      };
      try {
        await statusFor({
          took: deps.now() - t0, added: res.added, conflicts: res.conflicts,
          game: +gameId, gameStatus: st,
          catalogue: { version: catInfo.version, hash: catInfo.hash },
          lastAdded: res.added ? deps.now() : (await storageGet('lpstatus'))?.lastAdded
        });
      } catch (e) { }
      return { ok: true, game: +gameId, added: res.added, skipped: res.skipped, conflicts: res.conflicts, snapshotsAdded: res.snapshotsAdded, ledger, next: payload.next, resultRound: payload.resultRound, upcomingRound: payload.upcomingRound };
    } catch (e) {
      const now = deps.now();
      const next = now + 60e3;
      await scheduleGame(+gameId, next);
      const cur = (await storageGet('lpstatus')) || {};
      const log = (cur.log || []).slice(-8).concat(['Game ' + gameId + ': ' + e.message]);
      await statusFor({ game: +gameId, gameStatus: { lastSync: now, ok: false, error: e.message, next }, log });
      return { ok: false, game: +gameId, error: e.message, next };
    } finally {
      syncing.delete(+gameId);
    }
  }

  async function syncAll(opts = {}) {
    const catInfo = opts.catInfo || await getInit(opts.forceInit);
    const games = (catInfo.init.games || []).map(g => g.id);
    const out = [];
    for (const g of games) out.push(await syncGame(g, Object.assign({}, opts, { catInfo })));
    const total = await deps.db.count('matches').catch(() => null);
    await statusFor({ lastSync: deps.now(), total, log: out.filter(x => !x.ok).map(x => 'Game ' + x.game + ': ' + x.error) });
    return { ok: out.every(x => x.ok), games: out, total, catalogue: { version: catInfo.version, hash: catInfo.hash }, results: out };
  }

  async function ensureSchedules() {
    const sched = (await storageGet('lpsched')) || {};
    if (!Object.keys(sched).length) { await syncAll(); return; }
    for (const [game, s] of Object.entries(sched)) {
      alarmCreate('lpG:' + game, Math.max(s.at || deps.now() + 30e3, deps.now() + 30e3));
    }
  }

  return {
    configure, getInit, buildPayload, nextSyncAt, scheduleGame, ensureSchedules,
    syncGame, syncAll, apiFetch, storageGet, storageSet, updateStatus, getDep
  };
})();

async function lpSync() {
  try {
    const r = await LPSync.syncAll();
    try { if (typeof LPCloud !== 'undefined') await LPCloud.maybeUpload({ db: LPDB, reason: 'syncAll', lastCaptureAt: Date.now() }); } catch (e) { }
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
}
async function lpSyncGame(id) {
  try {
    const r = await LPSync.syncGame(id);
    try { if (typeof LPCloud !== 'undefined') await LPCloud.maybeUpload({ db: LPDB, reason: 'capture', lastCaptureAt: Date.now() }); } catch (e) { }
    return r;
  } catch (e) { return { ok: false, game: +id, error: e.message }; }
}
async function lpStatus(patch) { return LPSync.updateStatus(patch); }

// ---------------------------------------------------------------------------
// backup / restore
const LPBackup = (() => {
  const ORDER = ['catalogues', 'rounds', 'matches', 'snapshots', 'predictions', 'settlements', 'modelStates', 'modelPerf', 'patterns', 'learningLog', 'jobs', 'aggregates', 'conflicts', 'qualityLog', 'meta'];
  async function exportAll() {
    const stores = {};
    for (const name of ORDER) { try { stores[name] = await LPDB.getAll(name); } catch (e) { stores[name] = []; } }
    // Upcoming fixtures and per-game schedules are transient; including them
    // would let an old backup overwrite the current betting window.
    stores.meta = (stores.meta || []).filter(x => {
      const k = String(x && x.key || '');
      return !k.startsWith('up:') && !k.startsWith('sync:') && k !== 'lpstatus' && k !== 'cloud:config';
    });
    return { app: LP_APP, schema: LP_SCHEMA, exportedAt: Date.now(), stores };
  }
  async function importAll(obj) {
    // Accept the v1 backup shape as well: {v:1, matches:[...], meta:[...]}.
    if (obj && !obj.app && obj.v && (obj.matches || obj.meta)) {
      obj = { app: LP_APP, schema: +obj.v || 1, exportedAt: obj.exportedAt || null, stores: { matches: obj.matches || [], meta: obj.meta || [] } };
    }
    if (!obj || obj.app !== LP_APP) throw new Error('Not a League Plus backup');
    if (!obj.stores) throw new Error('Backup has no stores');
    if (+obj.schema > LP_SCHEMA) throw new Error('Backup schema ' + obj.schema + ' is newer than this extension (' + LP_SCHEMA + ')');
    const out = { added: 0, skipped: 0, conflicts: 0, stores: {} };
    const immutable = {
      catalogues: { keyPath: 'version', hashField: 'hash' },
      matches: { keyPath: 'key', hashField: 'contentHash' },
      snapshots: { keyPath: 'key', hashField: 'hash' },
      predictions: { keyPath: 'predictionId', hashField: 'contentHash' },
      settlements: { keyPath: 'predictionId', hashField: 'contentHash' },
      modelStates: { keyPath: 'version', hashField: 'hash' },
      patterns: { keyPath: 'id', hashField: 'contentHash' }
    };
    for (const [name, rows] of Object.entries(obj.stores)) {
      if (!LP_STORES[name] || !Array.isArray(rows) || !rows.length) continue;
      if (immutable[name]) {
        const hashField = immutable[name].hashField;
        const prepared = rows.map(r => {
          if (r[hashField]) return r;
          const copy = Object.assign({}, r);
          if (name === 'matches') copy[hashField] = LPUtil.contentHash({ key: r.key, hg: r.hg, ag: r.ag, goals: r.goals, odds: r.odds, sk: r.sk });
          else copy[hashField] = LPUtil.contentHash(r);
          return copy;
        });
        const r = await LPDB.putImmutableMany(name, prepared, immutable[name]);
        out.added += r.added; out.skipped += r.skipped; out.conflicts += r.conflicts;
        out.stores[name] = r;
      } else if (name === 'qualityLog') {
        await LPDB.mergeQuality(rows);
        out.stores[name] = { merged: rows.length };
      } else if (name === 'learningLog' || name === 'conflicts') {
        // auto-increment logs; import only rows that do not already exist by
        // their original id, otherwise keep the local log.
        let n = 0;
        for (const row of rows) { try { const ex = row.id != null ? await LPDB.get(name, row.id) : null; if (!ex) { await LPDB.put(name, row); n++; } } catch (e) { } }
        out.stores[name] = { merged: n };
      } else if (name === 'meta') {
        const local = new Map((await LPDB.getAll('meta')).map(x => [x.key, x]));
        const toPut = [];
        for (const row of rows) {
          const k = String(row.key || '');
          if (k.startsWith('migration:')) continue;
          const cur = local.get(row.key);
          if (!cur) { toPut.push(row); continue; }
          if (k.startsWith('sel:')) continue;
          if (k === 'init' || k === 'cat:current' || k.startsWith('st:')) {
            if ((row.at || 0) > (cur.at || 0)) toPut.push(row);
          } else if (k.startsWith('learn:')) {
            if ((row.at || row.activatedAt || 0) > (cur.at || cur.activatedAt || 0)) toPut.push(row);
          } else {
            toPut.push(row);
          }
        }
        await LPDB.putMany('meta', toPut);
        out.stores[name] = { merged: toPut.length };
      } else if (name === 'rounds') {
        const local = new Map((await LPDB.getAll('rounds')).map(x => [x.key, x]));
        const toPut = [];
        for (const row of rows) {
          const cur = local.get(row.key);
          if (!cur || (row.lastSeenAt || 0) >= (cur.lastSeenAt || 0)) toPut.push(row);
        }
        await LPDB.putMany('rounds', toPut);
        out.stores[name] = { merged: toPut.length };
      } else {
        await LPDB.putMany(name, rows);
        out.stores[name] = { merged: rows.length };
      }
    }
    return out;
  }
  async function gzipText(text) {
    if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined') return null;
    const cs = new CompressionStream('gzip');
    const blob = await new Response(new Blob([text]).stream().pipeThrough(cs)).blob();
    return blob;
  }
  async function readFile(file) {
    if (typeof DecompressionStream !== 'undefined' && (/\.gz$/i.test(file.name || '') || file.type === 'application/gzip')) {
      return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return file.text();
  }
  return { ORDER, exportAll, importAll, gzipText, readFile };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LP_API, LP_SCHEMA, LP_APP, LPUtil, LP_STORES, LPDB, LPCat, LPParse, LPQuality, LPSync, LPBackup, lpSync, lpSyncGame, lpStatus };
}
