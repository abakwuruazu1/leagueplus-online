// Probability engines for League Plus (Stage 5).
//
//  market : margin-adjusted Bet9ja odds (proportional/power/additive methods)
//  mkt    : Poisson score model fitted to Bet9ja's main markets
//  team   : time-decayed attack/defence ratings (independent Poisson)
//  dc     : Dixon-Coles low-score correction on top of the team ratings
//  emp    : Bayesian-smoothed empirical score distribution with an inner
//           walk-forward window selection
//  blend  : backward-compatible mean of mkt and team
//  ensemble: equal-weight mean of the available mkt/dc/emp/team models
//
// All score matrices are normalised on the retained grid; no model may claim
// probabilities that sum to more than 1 for an exclusive market.
const _core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _LPCat = (typeof LPCat !== 'undefined') ? LPCat : _core.LPCat;
const _LPParse = (typeof LPParse !== 'undefined') ? LPParse : _core.LPParse;

const LPModel = (() => {
  const VERSION = 'stage7-models-v1';
  const ENSEMBLE_VERSION = 'equal-mkt-dc-emp-team-v1';
  const WEIGHTED_VERSION = 'adaptive-shrunk-v1';
  const UNCERTAINTY_VERSION = 'wilson-effective-n-approx-v1';
  const MAXG = 12;
  const W = MAXG + 1;
  const LOGFACT = [0]; for (let i = 1; i <= 40; i++) LOGFACT[i] = LOGFACT[i - 1] + Math.log(i);

  const pois = (l, n) => {
    const a = new Array(n + 1); let p = Math.exp(-l); a[0] = p;
    for (let k = 1; k <= n; k++) { p *= l / k; a[k] = p; }
    return a;
  };
  const logPois = (k, l) => (l > 0 && k >= 0 ? -l + k * Math.log(l) - (LOGFACT[k] || 0) : -Infinity);
  function tau(h, a, lh, la, rho) {
    if (!rho) return 1;
    if (h === 0 && a === 0) return Math.max(1e-9, 1 - lh * la * rho);
    if (h === 0 && a === 1) return Math.max(1e-9, 1 + lh * rho);
    if (h === 1 && a === 0) return Math.max(1e-9, 1 + la * rho);
    if (h === 1 && a === 1) return Math.max(1e-9, 1 - rho);
    return 1;
  }
  function matrix(lh, la, opts = {}) {
    const rho = Number.isFinite(opts.rho) ? opts.rho : 0;
    const ph = pois(lh, MAXG), pa = pois(la, MAXG), M = [];
    let total = 0;
    for (let i = 0; i <= MAXG; i++) {
      M[i] = [];
      for (let j = 0; j <= MAXG; j++) {
        const v = ph[i] * pa[j] * tau(i, j, lh, la, rho);
        M[i][j] = v; total += v;
      }
    }
    if (total > 0) for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) M[i][j] /= total;
    return M;
  }
  function leadProb(lh, la, side) {
    const L = lh + la;
    if (!(L > 0)) return 0;
    const q = side === 'h' ? lh / L : la / L;
    const pN = pois(L, 30);
    let denom = 0; for (let n = 0; n <= 30; n++) denom += pN[n];
    if (!(denom > 0)) return 0;
    let dist = { 0: 1 }, reached = 0, res = 0;
    for (let n = 1; n <= 30; n++) {
      const nd = {};
      for (const d in dist) {
        const v = dist[d], up = +d + 1, dn = +d - 1;
        if (up === 1) reached += v * q; else nd[up] = (nd[up] || 0) + v * q;
        nd[dn] = (nd[dn] || 0) + v * (1 - q);
      }
      dist = nd;
      res += (pN[n] / denom) * reached;
    }
    return Math.max(0, Math.min(1, res));
  }
  const MASKS = new WeakMap();
  function mask(cat, id) {
    let C = MASKS.get(cat); if (!C) { C = new Map(); MASKS.set(cat, C); }
    let m = C.get(id); if (m) return m;
    const c = cat[id], L = [];
    if (c && c.type !== 2 && !c.cond) {
      for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
        if (_LPCat.settle(c, i, j, null, { tlOk: true }) === true) L.push(i * W + j);
      }
    }
    m = Int16Array.from(L); C.set(id, m); return m;
  }
  function selProbsMatrix(cat, ids, M) {
    const out = new Map();
    for (const id of ids) {
      const c = cat[id]; if (!c) continue;
      if (c.mId === 15 && String(c.name || '').trim().startsWith('X')) {
        let p = 0; for (let i = 0; i <= MAXG; i++) p += M[i][i];
        out.set(id, p); continue;
      }
      if (c.type === 2 || c.cond) { out.set(id, null); continue; }
      const mk = mask(cat, id); let p = 0;
      for (let k = 0; k < mk.length; k++) { const x = mk[k]; p += M[(x / W) | 0][x % W]; }
      out.set(id, p);
    }
    return out;
  }
  function selProbs(cat, ids, lh, la, opts = {}) {
    const M = matrix(lh, la, opts), out = new Map();
    for (const id of ids) {
      const c = cat[id]; if (!c) continue;
      if (c.mId === 15 && String(c.name || '').trim().startsWith('X')) {
        let p = 0; for (let i = 0; i <= MAXG; i++) p += M[i][i];
        out.set(id, p); continue;
      }
      if (c.type === 2 || c.cond) {
        out.set(id, leadProb(lh, la, String(c.name || '').trim().startsWith('1') ? 'h' : 'a'));
        continue;
      }
      const mk = mask(cat, id); let p = 0;
      for (let k = 0; k < mk.length; k++) { const x = mk[k]; p += M[(x / W) | 0][x % W]; }
      out.set(id, p);
    }
    return out;
  }

  // Margin removal ----------------------------------------------------------
  function powerProbs(raw, target) {
    const sumAt = k => raw.reduce((s, r) => s + Math.pow(r, k), 0);
    let lo = 0.01, hi = 6;
    if (sumAt(lo) < target) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (sumAt(mid) > target) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2, p = raw.map(r => Math.pow(r, k)), s = p.reduce((a, b) => a + b, 0);
    return s > 0 ? p.map(x => x / s * target) : null;
  }
  function fair(cat, om, opts = {}) {
    const method = opts.method || 'proportional';
    const groups = new Map();
    let f1 = 0, n1 = 0;
    for (const [id, o] of om) {
      const c = cat[id]; if (!c) continue;
      const k = _LPCat.mkey(c);
      if (!groups.has(k)) groups.set(k, { key: k, label: _LPCat.mlabel(c), group: _LPCat.groupOf(c), mId: c.mId, items: [] });
      groups.get(k).items.push([id, o, c]);
      if (c.mId === 1) { f1 += 1 / o; n1++; }
    }
    const F1 = n1 && f1 > 0 ? f1 : 1.065;
    const out = new Map();
    out.flags = { singles: [], overlaps: [], unknown: [], incomplete: [] };
    out.overround = {}; out.margin = {}; out.method = method;
    for (const g of groups.values()) {
      const n = g.items.length;
      const sum = g.items.reduce((s, [, o]) => s + 1 / o, 0);
      let F = 1;
      if (n === 1) { out.flags.singles.push(g.key); F = 1; }
      else if (g.group === 'ex') {
        F = Math.max(sum, 1); if (g.mId === 4) out.flags.incomplete.push(g.key);
      } else if (g.group === 'pair') {
        F = Math.max(n >= 3 ? sum / 2 : F1, 1); if (n < 3) out.flags.incomplete.push(g.key);
      } else if (g.group === 'overlap') {
        F = Math.max(F1, 1); out.flags.overlaps.push(g.key);
      } else {
        F = Math.max(F1, 1); out.flags.unknown.push(g.key);
      }
      out.overround[g.key] = sum;
      out.margin[g.key] = F;
      const target = g.group === 'pair' ? 2 : 1;
      let probs = null;
      if (n > 1 && (g.group === 'ex' || g.group === 'pair') && method !== 'proportional') {
        const raw = g.items.map(([, o]) => 1 / o);
        if (method === 'power') probs = powerProbs(raw, target);
        else if (method === 'additive') {
          const margin = sum - target;
          if (margin > 0) {
            const p = raw.map(r => r - margin / n);
            if (p.every(x => x > 0)) { const s = p.reduce((a, b) => a + b, 0); probs = p.map(x => x / s * target); }
          }
        }
      }
      g.items.forEach(([id, o], idx) => {
        let p = probs ? probs[idx] : (1 / o) / F;
        if (!Number.isFinite(p) || p < 0) p = 0;
        if (p > 1) p = 1;
        out.set(id, p);
      });
    }
    return out;
  }

  // Market-fitted Poisson ---------------------------------------------------
  function fitMarket(cat, fp) {
    const tgt = [];
    for (const [id, p] of fp) {
      const c = cat[id]; if (!c) continue;
      const ok = c.mId === 1 || c.mId === 3 ||
        (c.mId === 5 && ['1.5', '2.5', '3.5', '4.5'].includes(c.sub)) ||
        ((c.mId === 6 || c.mId === 7) && ['0.5', '1.5'].includes(c.sub)) ||
        ((c.mId === 8 || c.mId === 10) && ['1.5', '2.5'].includes(c.sub));
      if (ok && Number.isFinite(p) && p > 0 && p < 1) tgt.push([id, p]);
    }
    if (tgt.length < 3) return null;
    const ids = tgt.map(t => t[0]);
    const err = (lh, la) => {
      const sp = selProbs(cat, ids, lh, la); let e = 0;
      for (const [id, p] of tgt) e += (sp.get(id) - p) ** 2;
      return e;
    };
    let bestAll = null;
    for (const start of [[1.4, 1.1], [1.0, 1.0], [2.0, 1.0], [1.0, 2.0], [2.0, 2.0], [1.6, 0.8], [0.8, 1.6]]) {
      let lh = start[0], la = start[1], best = err(lh, la), step = 0.4;
      while (step > 0.003) {
        let moved = false;
        for (const [dh, da] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
          const h = Math.max(0.05, Math.min(6, lh + dh)), a = Math.max(0.05, Math.min(6, la + da)), e = err(h, a);
          if (e < best) { best = e; lh = h; la = a; moved = true; }
        }
        if (!moved) step /= 2;
      }
      if (!bestAll || best < bestAll.err) bestAll = { lh, la, err: best };
    }
    const rmse = Math.sqrt(bestAll.err / tgt.length);
    return { lh: bestAll.lh, la: bestAll.la, err: bestAll.err, rmse, n: tgt.length, quality: rmse < 0.01 ? 'good' : rmse < 0.03 ? 'fair' : 'poor' };
  }

  // Team / Dixon-Coles fitting ----------------------------------------------
  function selectMatches(matches, refTs, o = {}) {
    let ms = (matches || []).filter(m => Number.isFinite(m.ts) && m.ts < refTs && Number.isFinite(m.hg) && Number.isFinite(m.ag) && m.hg >= 0 && m.ag >= 0 && (!m.quality || m.quality.status !== 'invalid'))
      .sort((a, b) => a.ts - b.ts);
    if (!ms.length) return ms;
    const mode = o.seasonMode || 'auto';
    const latestSeason = ms[ms.length - 1].season;
    const target = o.season != null ? +o.season : latestSeason;
    if (mode !== 'all' && target != null && Number.isFinite(target)) {
      const current = ms.filter(m => +m.season === target);
      const minSeason = o.minSeasonMatches ?? 20;
      if (current.length >= minSeason || mode === 'current') ms = current;
    }
    return ms;
  }
  function weightsFor(ms, refTs, o = {}) {
    if (!ms.length) return [];
    if ((o.decayUnit || 'hours') === 'rounds') {
      const ref = Number.isFinite(o.refRound) ? o.refRound : Math.max(...ms.map(m => Number.isFinite(+m.week) ? +m.week : -Infinity));
      const hl = o.halfLifeRounds || 40;
      if (Number.isFinite(ref)) return ms.map(m => Math.pow(0.5, Math.max(0, ref - (Number.isFinite(+m.week) ? +m.week : ref)) / hl));
    }
    const hl = (o.halfLifeH || 6) * 3600e3;
    return ms.map(m => Math.pow(0.5, Math.max(0, refTs - m.ts) / hl));
  }
  function fitTeams(matches, refTs, o = {}) {
    const ms = selectMatches(matches, refTs, o);
    const Wt = weightsFor(ms, refTs, o);
    const prior = o.prior ?? 4;
    let sw = 0, sH = 0, sA = 0;
    ms.forEach((m, i) => { sw += Wt[i]; sH += Wt[i] * m.hg; sA += Wt[i] * m.ag; });
    const muH = sw ? sH / sw : 1.4, muA = sw ? sA / sw : 1.1;
    const teams = new Set(), nTeam = {}, wTeam = {};
    ms.forEach((m, i) => {
      teams.add(m.home); teams.add(m.away);
      nTeam[m.home] = (nTeam[m.home] || 0) + 1; nTeam[m.away] = (nTeam[m.away] || 0) + 1;
      wTeam[m.home] = (wTeam[m.home] || 0) + Wt[i]; wTeam[m.away] = (wTeam[m.away] || 0) + Wt[i];
    });
    const att = {}, def = {}; teams.forEach(t => { att[t] = 1; def[t] = 1; });
    for (let it = 0; it < 12; it++) {
      const nA = {}, dA = {}, nD = {}, dD = {};
      teams.forEach(t => { nA[t] = prior; dA[t] = prior; nD[t] = prior; dD[t] = prior; });
      ms.forEach((m, i) => {
        const w = Wt[i], h = m.home, a = m.away;
        nA[h] += w * m.hg; dA[h] += w * muH * def[a];
        nA[a] += w * m.ag; dA[a] += w * muA * def[h];
        nD[h] += w * m.ag; dD[h] += w * muA * att[a];
        nD[a] += w * m.hg; dD[a] += w * muH * att[h];
      });
      let ma = 0;
      teams.forEach(t => { att[t] = nA[t] / dA[t]; def[t] = nD[t] / dD[t]; ma += att[t]; });
      ma /= teams.size || 1;
      teams.forEach(t => { att[t] /= ma; def[t] *= ma; });
    }
    const attSd = {}, defSd = {}, reliability = {};
    teams.forEach(t => {
      const w = wTeam[t] || 0;
      reliability[t] = w / (w + prior);
      attSd[t] = Math.sqrt(1 / (w + prior));
      defSd[t] = Math.sqrt(1 / (w + prior));
    });
    const lastSeason = ms.length ? ms[ms.length - 1].season : (o.season != null ? o.season : null);
    return {
      muH, muA, att, def, n: ms.length, nTeam, wTeam, attSd, defSd, reliability,
      season: lastSeason, seasonMode: o.seasonMode || 'auto',
      halfLifeH: o.halfLifeH || 6, halfLifeRounds: o.halfLifeRounds || 40, decayUnit: o.decayUnit || 'hours'
    };
  }
  function scoreLogLik(ms, T, rho, weights) {
    let ll = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i], lh = T.muH * (T.att[m.home] ?? 1) * (T.def[m.away] ?? 1), la = T.muA * (T.att[m.away] ?? 1) * (T.def[m.home] ?? 1);
      const t = tau(m.hg, m.ag, lh, la, rho);
      const v = logPois(m.hg, lh) + logPois(m.ag, la) + Math.log(t);
      if (!Number.isFinite(v)) continue;
      ll += (weights ? weights[i] : 1) * v;
    }
    return ll;
  }
  function fitDC(matches, refTs, o = {}) {
    const T = fitTeams(matches, refTs, o);
    const ms = selectMatches(matches, refTs, o);
    if (!ms.length) return T;
    const Wt = weightsFor(ms, refTs, o);
    let bestRho = 0, bestLL = scoreLogLik(ms, T, 0, Wt);
    for (let r = -0.20; r <= 0.2001; r += 0.01) {
      const ll = scoreLogLik(ms, T, r, Wt);
      if (ll > bestLL) { bestLL = ll; bestRho = r; }
    }
    const refineLo = bestRho - 0.02, refineHi = bestRho + 0.0201;
    for (let r = refineLo; r <= refineHi; r += 0.001) {
      const ll = scoreLogLik(ms, T, r, Wt);
      if (ll > bestLL) { bestLL = ll; bestRho = r; }
    }
    T.rho = bestRho; T.dcLL = bestLL;
    T.emp = o.empirical === false ? null : fitEmpiricalFromRows(ms, o);
    return T;
  }

  // Empirical / Bayesian score distribution ---------------------------------
  function empMatrix(rows, alpha = 20, o = {}) {
    const counts = Array.from({ length: W }, () => new Array(W).fill(0));
    let sh = 0, sa = 0, n = 0;
    for (const m of rows) {
      if (m.hg <= MAXG && m.ag <= MAXG) counts[m.hg][m.ag]++;
      sh += m.hg; sa += m.ag; n++;
    }
    const muH = n ? sh / n : 1.4, muA = n ? sa / n : 1.1;
    const prior = matrix(muH, muA);
    const P = Array.from({ length: W }, () => new Array(W).fill(0));
    let total = 0;
    for (let i = 0; i < W; i++) for (let j = 0; j < W; j++) {
      const v = counts[i][j] + alpha * prior[i][j];
      P[i][j] = v; total += v;
    }
    if (total > 0) for (let i = 0; i < W; i++) for (let j = 0; j < W; j++) P[i][j] /= total;
    return { matrix: P, n, muH, muA, alpha };
  }
  function matrix1x2(P) {
    let h = 0, d = 0, a = 0;
    for (let i = 0; i < W; i++) for (let j = 0; j < W; j++) { if (i > j) h += P[i][j]; else if (i === j) d += P[i][j]; else a += P[i][j]; }
    return [h, d, a];
  }
  function selectEmpiricalWindow(rows, o = {}) {
    if (rows.length < 120) return Math.min(2000, Math.max(100, rows.length));
    const cut = Math.floor(rows.length * 0.7), tr = rows.slice(0, cut), va = rows.slice(cut);
    if (tr.length < 40 || va.length < 20) return Math.min(2000, Math.max(100, rows.length));
    const windows = [100, 250, 500, 1000, 2000];
    let best = null;
    for (const w of windows) {
      const P = empMatrix(tr.slice(-w), o.alpha || 20).matrix;
      let ll = 0, n = 0;
      for (const m of va) {
        const p = matrix1x2(P), y = m.hg > m.ag ? 0 : m.hg < m.ag ? 2 : 1;
        ll -= Math.log(Math.max(1e-9, p[y])); n++;
      }
      if (n && (!best || ll / n < best.ll)) best = { window: w, ll: ll / n, n };
    }
    return best ? best.window : Math.min(2000, Math.max(100, rows.length));
  }
  function fitEmpiricalFromRows(rows, o = {}) {
    const window = Number.isFinite(o.window) ? o.window : selectEmpiricalWindow(rows, o);
    const sub = rows.slice(-Math.max(1, window));
    const E = empMatrix(sub, o.alpha ?? 20, o);
    E.window = Math.min(window, rows.length);
    E.windowSelected = !Number.isFinite(o.window);
    E.season = rows.length ? rows[rows.length - 1].season : null;
    return E;
  }
  function fitEmpirical(matches, refTs, o = {}) {
    const ms = selectMatches(matches, refTs, o);
    return fitEmpiricalFromRows(ms, o);
  }

  const teamLam = (T, h, a) => [T.muH * (T.att[h] ?? 1) * (T.def[a] ?? 1), T.muA * (T.att[a] ?? 1) * (T.def[h] ?? 1)];
  function wilsonFromP(p, n, z = 1.96) {
    const x = Math.max(0, Math.min(1, +p));
    const N = Math.max(1, +n || 1);
    const denom = 1 + z * z / N;
    const centre = (x + z * z / (2 * N)) / denom;
    const half = z * Math.sqrt(Math.max(0, x * (1 - x) / N + z * z / (4 * N * N))) / denom;
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
  }
  function effectiveN(T, fx, fit) {
    let n = Infinity;
    if (T) {
      if (Number.isFinite(T.n) && T.n > 0) n = Math.min(n, T.n);
      const nh = T.nTeam && T.nTeam[fx.home], na = T.nTeam && T.nTeam[fx.away];
      if (Number.isFinite(nh) && nh > 0) n = Math.min(n, nh);
      if (Number.isFinite(na) && na > 0) n = Math.min(n, na);
    }
    if (!Number.isFinite(n) || n <= 0) n = fit && Number.isFinite(fit.n) && fit.n > 0 ? fit.n : 30;
    return Math.max(5, Math.min(1000, Math.round(n)));
  }
  function uncertaintyClass(low, high) {
    const w = high - low;
    return w < 0.12 ? 'narrow' : w < 0.25 ? 'moderate' : 'wide';
  }

  // Main per-fixture evaluation ---------------------------------------------
  function evaluate(cat, fx, selStr, T, opts = {}) {
    const om = _LPParse.oddsMap(fx.odds, selStr), ids = [...om.keys()];
    const fp = fair(cat, om, { method: opts.fairMethod || 'proportional' });
    const fit = fitMarket(cat, fp);
    const mp = fit ? selProbs(cat, ids, fit.lh, fit.la) : new Map();
    let tp = new Map(), dp = new Map(), ep = new Map(), tl = null;
    const hasT = T && T.n >= 30 && (T.nTeam?.[fx.home] || 0) >= 5 && (T.nTeam?.[fx.away] || 0) >= 5;
    const hasDC = T && T.rho != null && T.n >= 30 && (T.nTeam?.[fx.home] || 0) >= 3 && (T.nTeam?.[fx.away] || 0) >= 3;
    if (hasT) {
      tl = teamLam(T, fx.home, fx.away);
      tp = selProbs(cat, ids, tl[0], tl[1]);
    }
    if (hasDC) {
      const l = teamLam(T, fx.home, fx.away);
      dp = selProbs(cat, ids, l[0], l[1], { rho: T.rho || 0 });
    }
    if (T && T.emp && T.emp.n >= 30) ep = selProbsMatrix(cat, ids, T.emp.matrix);
    const nEff = effectiveN(T, fx, fit);
    const weights = opts.weights || null;
    const targetWeighted = opts.calibrationTarget === 'weighted';
    const rows = ids.map(id => {
      const o = om.get(id), f = fp.get(id), m = mp.get(id), t = tp.get(id), d = dp.get(id), e = ep.get(id);
      const parts = [{ key: 'mkt', p: m }, { key: 'dc', p: d }, { key: 'emp', p: e }, { key: 'team', p: t }]
        .filter(x => x.p != null && Number.isFinite(x.p));
      const ens = parts.length ? parts.reduce((a, b) => a + b.p, 0) / parts.length : (m ?? f);
      let weighted = ens;
      if (weights) {
        let ws = 0, sum = 0;
        for (const x of parts) { const w = +weights[x.key]; if (w > 0) { ws += w; sum += w * x.p; } }
        if (ws > 0) weighted = sum / ws;
      }
      const base = targetWeighted ? weighted : ens;
      let calibrated = base;
      if (typeof opts.calibrate === 'function') {
        const cp = opts.calibrate(base);
        if (Number.isFinite(cp)) calibrated = Math.max(0, Math.min(1, cp));
      }
      const ci = wilsonFromP(calibrated, nEff);
      const mlow = parts.length ? Math.min.apply(null, parts.map(x => x.p)) : base;
      const mhigh = parts.length ? Math.max.apply(null, parts.map(x => x.p)) : base;
      return {
        id, odds: o, fair: f, mkt: m ?? f, team: t ?? null, dc: d ?? null, emp: e ?? null,
        blend: t != null && m != null ? (t + m) / 2 : (m ?? f), ensemble: ens,
        weighted, calibrated, pLow: ci[0], pHigh: ci[1], nEff,
        uncertaintyClass: uncertaintyClass(ci[0], ci[1]), modelLow: mlow, modelHigh: mhigh
      };
    });
    return {
      rows, fit, tl, om, fairFlags: fp.flags, fairMargin: fp.margin, fairMethod: fp.method,
      dc: T && T.rho != null ? T.rho : null, empN: T && T.emp ? T.emp.n : 0,
      ensembleVersion: ENSEMBLE_VERSION,
      weightedVersion: weights ? (opts.weightsVersion || WEIGHTED_VERSION) : null,
      calibrationVersion: opts.calibrationVersion || null,
      uncertaintyVersion: UNCERTAINTY_VERSION, nEff
    };
  }

  return {
    VERSION, ENSEMBLE_VERSION, WEIGHTED_VERSION, UNCERTAINTY_VERSION, MAXG,
    evaluate, fair, fitMarket, fitTeams, fitDC, fitEmpirical, fitEmpiricalFromRows,
    teamLam, selProbs, selProbsMatrix, leadProb, matrix, tau, selectMatches, weightsFor,
    empMatrix, matrix1x2, selectEmpiricalWindow, wilsonFromP, effectiveN, uncertaintyClass
  };
})();
if (typeof module !== 'undefined') module.exports = LPModel;
