// League Plus research engine (Stage 4).
//
// Tests the data-generating process rather than assuming football-like
// behaviour: serial dependence, team persistence, competition differences,
// sequence/transition information, change points, whether the market contains
// information beyond historical frequencies, whether history adds to the
// market, and whether some conditions are more predictable.
//
// Every test reports sample size, effect, uncertainty and a multiple-testing
// adjusted q-value. A pattern is only called "validated" when it survives an
// out-of-sample split; otherwise it stays exploratory.
const _coreR = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : null;
const _modelR = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : null;
const _statsR = (typeof module !== 'undefined' && module.exports) ? require('./stats.js') : null;
const _LPCat_R = (typeof LPCat !== 'undefined') ? LPCat : _coreR.LPCat;
const _LPParse_R = (typeof LPParse !== 'undefined') ? LPParse : _coreR.LPParse;
const _LPModel_R = (typeof LPModel !== 'undefined') ? LPModel : _modelR;
const _LPStats_R = (typeof LPStats !== 'undefined') ? LPStats : _statsR;

const LPResearch = (() => {
  const VERSION = 'stage4-research-v1';

  function enrichMarket(matches, cat, selsets) {
    const out = [];
    for (const m of (matches || [])) {
      const copy = Object.assign({}, m);
      if (Array.isArray(copy.market) && copy.market.length === 3) { out.push(copy); continue; }
      if (!copy.odds || !copy.sk || !cat) { out.push(copy); continue; }
      const selStr = (selsets || {})[copy.sk] || copy.selStr || '';
      if (!selStr) { out.push(copy); continue; }
      try {
        const om = _LPParse_R.oddsMap(copy.odds, selStr);
        if (!om.size) { out.push(copy); continue; }
        const fp = _LPModel_R.fair(cat, om);
        const p = [fp.get(101), fp.get(102), fp.get(103)];
        if (p.every(x => x != null && Number.isFinite(x) && x >= 0)) {
          const s = p[0] + p[1] + p[2];
          if (s > 0) { copy.market = p.map(x => x / s); copy.marketSource = 'fair'; }
        }
      } catch (e) { }
      out.push(copy);
    }
    return out;
  }

  function prepare(matches, opts = {}) {
    const ms = [];
    for (const m of (matches || [])) {
      if (!m || m.hg == null || m.ag == null || !Number.isFinite(+m.hg) || !Number.isFinite(+m.ag)) continue;
      if (!Number.isFinite(+m.ts) || m.comp == null) continue;
      if (m.quality && m.quality.status === 'invalid') continue;
      const hg = +m.hg, ag = +m.ag;
      ms.push(Object.assign({}, m, {
        hg, ag, total: hg + ag, outcome: hg > ag ? 0 : hg < ag ? 2 : 1,
        over25: hg + ag > 2.5 ? 1 : 0, btts: hg > 0 && ag > 0 ? 1 : 0,
        roundKey: m.roundKey || (m.game != null ? m.game + ':' + m.roundId : m.comp + ':' + m.roundId)
      }));
    }
    ms.sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
    const byComp = new Map(), roundsByComp = new Map();
    for (const m of ms) {
      if (!byComp.has(m.comp)) byComp.set(m.comp, []);
      byComp.get(m.comp).push(m);
      if (!roundsByComp.has(m.comp)) roundsByComp.set(m.comp, new Map());
      const rm = roundsByComp.get(m.comp);
      if (!rm.has(m.roundKey)) rm.set(m.roundKey, { roundKey: m.roundKey, roundId: m.roundId, comp: m.comp, ts: m.ts, n: 0, total: 0, hw: 0, d: 0, aw: 0, over25: 0, btts: 0 });
      const r = rm.get(m.roundKey);
      r.n++; r.total += m.total; r.over25 += m.over25; r.btts += m.btts;
      if (m.outcome === 0) r.hw++; else if (m.outcome === 1) r.d++; else r.aw++;
      if (m.ts < r.ts) r.ts = m.ts;
    }
    const rounds = new Map();
    for (const [comp, rm] of roundsByComp) {
      const arr = [...rm.values()].sort((a, b) => a.ts - b.ts || (+a.roundId || 0) - (+b.roundId || 0));
      rounds.set(comp, arr);
    }
    return { matches: ms, byComp, roundsByComp: rounds };
  }

  function marketRows(ms) {
    const sorted = (ms || []).filter(m => Array.isArray(m.market) && m.market.length === 3 && m.market.every(x => Number.isFinite(x) && x >= 0))
      .sort((a, b) => a.ts - b.ts);
    const counts = new Map(), rows = [];
    for (const m of sorted) {
      const c = counts.get(m.comp) || { n: 0, h: 0, d: 0, a: 0 };
      const base = [(c.h + 1) / (c.n + 3), (c.d + 1) / (c.n + 3), (c.a + 1) / (c.n + 3)];
      let market = m.market.slice(0, 3);
      const s = market[0] + market[1] + market[2];
      if (!(s > 0)) continue;
      market = market.map(x => x / s);
      rows.push({ m, market, base, outcome: m.outcome });
      c.n++; if (m.outcome === 0) c.h++; else if (m.outcome === 1) c.d++; else c.a++;
      counts.set(m.comp, c);
    }
    return rows;
  }

  function pearsonRows(rows, key) {
    const a = rows.map(r => r[key]);
    return a;
  }

  function addTest(tests, t) { tests.push(t); return t; }

  function summarize(id, kind, tests, minN) {
    const list = tests.filter(t => t.hypothesis === id);
    const valid = list.filter(t => Number.isFinite(t.p) && t.n >= (t.minN || minN));
    if (!valid.length) {
      const n = list.length ? Math.max.apply(null, list.map(t => t.n || 0)) : 0;
      return { status: 'insufficient', kind, n, effect: null, ci: null, p: null, q: null, detail: list };
    }
    const best = valid.slice().sort((a, b) => a.p - b.p)[0];
    const effectOk = best.effectOk != null ? best.effectOk : (best.effectAbs == null || (best.effect != null && Math.abs(best.effect) >= best.effectAbs));
    const sig = best.p < 0.05 && best.q != null && best.q < 0.1 && effectOk && best.oosOk !== false;
    const status = sig ? 'supported' : (best.p < 0.05 ? 'exploratory' : 'not_supported');
    return { status, kind, n: best.n, effect: best.effect, ci: best.ci || null, p: best.p, q: best.q, best: best.name, detail: list };
  }

  function history(rows) {
    const prior = new Map(), out = [];
    for (const r of rows) {
      const c = prior.get(r.m.comp) || { n: 0, h: 0, d: 0, a: 0 };
      const base = [(c.h + 1) / (c.n + 3), (c.d + 1) / (c.n + 3), (c.a + 1) / (c.n + 3)];
      out.push({ r, base });
      c.n++; if (r.outcome === 0) c.h++; else if (r.outcome === 1) c.d++; else c.a++;
      prior.set(r.m.comp, c);
    }
    return out;
  }

  function hist(vals, max = 12) {
    const h = new Array(max + 1).fill(0);
    for (const v of vals) if (v >= 0 && v <= max) h[v]++;
    return h;
  }

  function analyze(opts = {}) {
    const cfg = (opts.options && typeof opts.options === 'object') ? Object.assign({}, opts, opts.options) : opts;
    const minMatches = Number.isFinite(cfg.minMatches) ? cfg.minMatches : 100;
    const minRounds = Number.isFinite(cfg.minRounds) ? cfg.minRounds : 30;
    const minTeams = Number.isFinite(cfg.minTeams) ? cfg.minTeams : 8;
    const minPatternN = Number.isFinite(cfg.minPatternN) ? cfg.minPatternN : 30;
    const B = Number.isFinite(cfg.permutations) ? cfg.permutations : 499;
    const seed = Number.isFinite(cfg.seed) ? cfg.seed : 20261124;
    const ms0 = enrichMarket(opts.matches || cfg.matches || [], opts.cat || cfg.cat, opts.selsets || cfg.selsets);
    const prep = prepare(ms0, opts);
    const ms = prep.matches, byComp = prep.byComp, roundsByComp = prep.roundsByComp;
    const comps = [...byComp.keys()];
    const tests = [], patterns = [];
    const add = (t) => addTest(tests, t);

    // H1: serial dependence in round-level goals ---------------------------
    for (const comp of comps) {
      const rounds = roundsByComp.get(comp) || [];
      const series = rounds.map(r => r.total);
      if (rounds.length < minRounds) { add({ id: 'H1-' + comp, hypothesis: 'H1', name: 'Ljung-Box round goals — ' + comp, n: rounds.length, stat: null, effect: null, p: null, minN: minRounds, effectAbs: 0.15, detail: { comp, reason: 'insufficient rounds' } }); continue; }
      const lb = _LPStats_R.ljungBox(series, Math.min(5, rounds.length - 2));
      const r1 = _LPStats_R.autocorrelation(series, 1);
      const pac = _LPStats_R.pacf(series, Math.min(5, rounds.length - 2));
      const med = _LPStats_R.median(series);
      const runs = _LPStats_R.runsTest(series.map(x => x > med ? 1 : 0));
      add({
        id: 'H1-' + comp, hypothesis: 'H1', name: 'Ljung-Box round goals — ' + comp,
        n: rounds.length, stat: lb ? lb.Q : null, effect: r1, p: lb ? lb.p : null,
        minN: minRounds, effectAbs: 0.15, oosOk: true,
        detail: { comp, lags: lb ? lb.lags : null, autocorrelations: lb ? lb.autocorrelations : null, partialAutocorrelations: pac, runs, median: med }
      });
    }

    // H2: team identity persistence (split-half) ---------------------------
    for (const comp of comps) {
      const teamMap = new Map();
      for (const m of byComp.get(comp) || []) {
        for (const [team, gf, ga] of [[m.home, m.hg, m.ag], [m.away, m.ag, m.hg]]) {
          if (!teamMap.has(team)) teamMap.set(team, []);
          teamMap.get(team).push({ ts: m.ts, gf, ga });
        }
      }
      const teams = [...teamMap.entries()].filter(([, arr]) => arr.length >= 6).map(([team, arr]) => {
        arr.sort((a, b) => a.ts - b.ts);
        const cut = Math.floor(arr.length / 2);
        const a1 = arr.slice(0, cut), a2 = arr.slice(cut);
        return { team, n: arr.length, gf1: _LPStats_R.mean(a1.map(x => x.gf)), gf2: _LPStats_R.mean(a2.map(x => x.gf)), ga1: _LPStats_R.mean(a1.map(x => x.ga)), ga2: _LPStats_R.mean(a2.map(x => x.ga)) };
      });
      if (teams.length < minTeams) { add({ id: 'H2-' + comp, hypothesis: 'H2', name: 'Team attack persistence — ' + comp, n: teams.length, effect: null, p: null, minN: minTeams, effectAbs: 0.3, detail: { comp, reason: 'insufficient teams' } }); continue; }
      for (const [label, k1, k2] of [['attack', 'gf1', 'gf2'], ['defence', 'ga1', 'ga2']]) {
        const cr = _LPStats_R.corrPermutation(teams.map(t => t[k1]), teams.map(t => t[k2]), B, seed + comp * 31 + (label === 'attack' ? 1 : 2));
        add({
          id: 'H2-' + comp + '-' + label, hypothesis: 'H2', name: 'Split-half team ' + label + ' persistence — ' + comp,
          n: teams.length, stat: cr.r, effect: cr.r, p: cr.p, minN: minTeams, effectAbs: 0.3, oosOk: true,
          detail: { comp, teams: teams.length, matches: (byComp.get(comp) || []).length }
        });
      }
    }

    // H3: competition differences -----------------------------------------
    const goalGroups = comps.map(c => (byComp.get(c) || []).map(m => m.total)).filter(g => g.length >= 30);
    if (goalGroups.length < 2) add({ id: 'H3-goals', hypothesis: 'H3', name: 'Competition goal distributions', n: ms.length, effect: null, p: null, minN: minMatches, effectAbs: 0.02, detail: { reason: 'insufficient competition groups' } });
    else {
      const kw = _LPStats_R.kruskalWallis(goalGroups);
      add({ id: 'H3-goals', hypothesis: 'H3', name: 'Competition goal distributions', n: kw ? kw.n : ms.length, stat: kw ? kw.H : null, effect: kw ? kw.epsilonSquared : null, p: kw ? kw.p : null, minN: minMatches, effectAbs: 0.02, oosOk: true, detail: { comps: comps.length, groups: goalGroups.map(g => g.length), kruskalWallis: kw } });
      const outComps = comps.filter(c => (byComp.get(c) || []).length >= 30);
      if (outComps.length >= 2) {
        const table = outComps.map(c => { const a = [0, 0, 0]; for (const m of byComp.get(c)) a[m.outcome]++; return a; });
        const chi = _LPStats_R.chiSquare2D(table);
        add({ id: 'H3-outcomes', hypothesis: 'H3', name: 'Competition outcome distributions', n: chi ? chi.n : ms.length, stat: chi ? chi.chi : null, effect: chi ? chi.cramersV : null, p: chi ? chi.p : null, minN: minMatches, effectAbs: 0.1, oosOk: true, detail: { comps: outComps, table, chiSquare: chi } });
      }
    }

    // H4: round transitions / sequence information -------------------------
    for (const comp of comps) {
      const rounds = roundsByComp.get(comp) || [];
      if (rounds.length < minRounds) { add({ id: 'H4-' + comp, hypothesis: 'H4', name: 'Round total-goal transitions — ' + comp, n: rounds.length, effect: null, p: null, minN: minRounds, effectAbs: 0.01, detail: { comp, reason: 'insufficient rounds' } }); continue; }
      const cat = r => r.total <= 2 ? 'low(0-2)' : r.total <= 4 ? 'mid(3-4)' : 'high(5+)';
      const pairs = [];
      for (let i = 1; i < rounds.length; i++) pairs.push([cat(rounds[i - 1]), cat(rounds[i])]);
      const xs = ['low(0-2)', 'mid(3-4)', 'high(5+)'];
      const table = xs.map(a => xs.map(b => pairs.filter(p => p[0] === a && p[1] === b).length));
      const chi = _LPStats_R.chiSquare2D(table);
      const mi = _LPStats_R.miPermutation(pairs, B, seed + comp * 17);
      add({ id: 'H4-' + comp, hypothesis: 'H4', name: 'Round total-goal transitions — ' + comp, n: pairs.length, stat: chi ? chi.chi : null, effect: mi ? mi.mi : null, p: chi ? chi.p : (mi ? mi.p : null), minN: Math.max(10, minRounds - 1), effectAbs: 0.01, detail: { comp, table, chiSquare: chi, mutualInformation: mi } });

      const op = [];
      for (let i = 1; i < rounds.length; i++) op.push([rounds[i - 1].hw > rounds[i - 1].aw ? 'H' : rounds[i - 1].hw === rounds[i - 1].aw ? 'D' : 'A', rounds[i].hw > rounds[i].aw ? 'H' : rounds[i].hw === rounds[i].aw ? 'D' : 'A']);
      const otable = ['H', 'D', 'A'].map(a => ['H', 'D', 'A'].map(b => op.filter(p => p[0] === a && p[1] === b).length));
      const ochi = _LPStats_R.chiSquare2D(otable), omi = _LPStats_R.miPermutation(op, B, seed + comp * 23);
      add({ id: 'H4-outcome-' + comp, hypothesis: 'H4', name: 'Round outcome transitions — ' + comp, n: op.length, stat: ochi ? ochi.chi : null, effect: omi ? omi.mi : null, p: ochi ? ochi.p : (omi ? omi.p : null), minN: Math.max(10, minRounds - 1), effectAbs: 0.01, detail: { comp, table: otable, chiSquare: ochi, mutualInformation: omi } });
    }

    // H5: change points in round-level scoring ----------------------------
    for (const comp of comps) {
      const rounds = roundsByComp.get(comp) || [];
      const series = rounds.map(r => r.total);
      if (rounds.length < minRounds) { add({ id: 'H5-' + comp, hypothesis: 'H5', name: 'Change point round goals — ' + comp, n: rounds.length, effect: null, p: null, minN: minRounds, effectAbs: 0.2, detail: { comp, reason: 'insufficient rounds' } }); continue; }
      const cp = _LPStats_R.cusumPermutation(series, B, seed + comp * 37);
      const ph = _LPStats_R.pageHinkley(series);
      const at = cp && cp.index != null ? cp.index + 1 : null;
      const before = at ? series.slice(0, at) : [], after = at ? series.slice(at) : [];
      const diff = before.length && after.length ? _LPStats_R.mean(after) - _LPStats_R.mean(before) : null;
      const kl = before.length && after.length ? _LPStats_R.kl(hist(after), hist(before)) : null;
      add({ id: 'H5-' + comp, hypothesis: 'H5', name: 'Change point round goals — ' + comp, n: rounds.length, stat: cp ? cp.stat : null, effect: diff, p: cp ? cp.p : null, minN: minRounds, effectAbs: 0.2, detail: { comp, index: cp ? cp.index : null, pageHinkley: ph, beforeMean: before.length ? _LPStats_R.mean(before) : null, afterMean: after.length ? _LPStats_R.mean(after) : null, klBits: kl } });
    }

    // H6: does the market contain information beyond historical frequencies?
    const rows = marketRows(ms);
    if (rows.length < minMatches) add({ id: 'H6-market', hypothesis: 'H6', name: 'Market vs historical frequency', n: rows.length, effect: null, p: null, minN: minMatches, detail: { reason: 'insufficient market rows' } });
    else {
      const marketLoss = rows.map(r => _LPStats_R.brierMulticlass(r.market, r.outcome));
      const baseLoss = rows.map(r => _LPStats_R.brierMulticlass(r.base, r.outcome));
      const diff = _LPStats_R.pairedBootstrapDiff(marketLoss, baseLoss, _LPStats_R.mean, B, 0.05, seed + 101);
      const marketLL = rows.map(r => _LPStats_R.logLossMulticlass(r.market, r.outcome));
      const baseLL = rows.map(r => _LPStats_R.logLossMulticlass(r.base, r.outcome));
      const llDiff = _LPStats_R.pairedBootstrapDiff(marketLL, baseLL, _LPStats_R.mean, B, 0.05, seed + 102);
      add({ id: 'H6-market', hypothesis: 'H6', name: 'Market vs historical frequency', n: rows.length, stat: diff.diff, effect: diff.diff, ci: [diff.low, diff.high], p: diff.p, minN: minMatches, effectOk: diff.diff < 0, detail: { brier: diff, logLoss: llDiff, marketBrier: _LPStats_R.mean(marketLoss), baseBrier: _LPStats_R.mean(baseLoss) } });
    }

    // H7: does adding history to the market improve out-of-sample? ---------
    const histRows = history(rows);
    if (rows.length < Math.max(2 * 30, minMatches)) add({ id: 'H7-blend', hypothesis: 'H7', name: 'Market + history blend', n: rows.length, effect: null, p: null, minN: minMatches, detail: { reason: 'insufficient market rows' } });
    else {
      const cut = Math.floor(rows.length * 0.6);
      const train = histRows.slice(0, cut), test = histRows.slice(cut);
      if (train.length < 30 || test.length < 30) add({ id: 'H7-blend', hypothesis: 'H7', name: 'Market + history blend', n: test.length, effect: null, p: null, minN: 30, detail: { reason: 'insufficient train/test split' } });
      else {
        const weights = [0, 0.25, 0.5, 0.75, 1];
        const blendProb = (x, w) => [0, 1, 2].map(i => w * x.r.market[i] + (1 - w) * x.base[i]);
        const logLoss = (probs, y) => _LPStats_R.logLossMulticlass(probs, y);
        let chosen = 1, best = Infinity;
        for (const w of weights) {
          const l = _LPStats_R.mean(train.map(x => logLoss(blendProb(x, w), x.r.outcome)));
          if (l < best) { best = l; chosen = w; }
        }
        const testMarket = test.map(x => logLoss(x.r.market, x.r.outcome));
        const testBlend = test.map(x => logLoss(blendProb(x, chosen), x.r.outcome));
        const d = _LPStats_R.pairedBootstrapDiff(testBlend, testMarket, _LPStats_R.mean, B, 0.05, seed + 111);
        add({ id: 'H7-blend', hypothesis: 'H7', name: 'Market + history blend', n: test.length, stat: d.diff, effect: d.diff, ci: [d.low, d.high], p: d.p, minN: 30, effectOk: d.diff < 0 && chosen > 0, detail: { weight: chosen, trainN: train.length, testN: test.length, trainLogLoss: best, blendVsMarket: d } });
      }
    }

    // H8: are some conditions more predictable? ---------------------------
    if (rows.length < minMatches) add({ id: 'H8-strata', hypothesis: 'H8', name: 'Predictability by market confidence', n: rows.length, effect: null, p: null, minN: minMatches, detail: { reason: 'insufficient market rows' } });
    else {
      const sorted = rows.slice().sort((a, b) => (Math.max.apply(null, a.market) - Math.max.apply(null, b.market)));
      const groups = [0, 1, 2].map(i => sorted.filter((_, j) => j >= Math.floor(i * sorted.length / 3) && j < Math.floor((i + 1) * sorted.length / 3)));
      const labels = ['uncertain', 'middle', 'confident'];
      groups.forEach((g, gi) => {
        if (g.length < 30) return;
        const m = g.map(r => _LPStats_R.brierMulticlass(r.market, r.outcome));
        const b = g.map(r => _LPStats_R.brierMulticlass(r.base, r.outcome));
        const d = _LPStats_R.pairedBootstrapDiff(m, b, _LPStats_R.mean, B, 0.05, seed + 121 + gi);
        add({ id: 'H8-' + labels[gi], hypothesis: 'H8', name: 'Market predictability — ' + labels[gi], n: g.length, stat: d.diff, effect: d.diff, ci: [d.low, d.high], p: d.p, minN: 30, effectOk: d.diff < 0, detail: { stratum: labels[gi], marketBrier: _LPStats_R.mean(m), baseBrier: _LPStats_R.mean(b) } });
      });
      if (!tests.some(t => t.hypothesis === 'H8' && Number.isFinite(t.p))) add({ id: 'H8-strata', hypothesis: 'H8', name: 'Predictability by market confidence', n: rows.length, effect: null, p: null, minN: minMatches, detail: { reason: 'strata below sample threshold' } });
    }

    // Multiple testing -----------------------------------------------------
    const finite = tests.filter(t => Number.isFinite(t.p));
    const q = _LPStats_R.bh(finite.map(t => t.p));
    finite.forEach((t, i) => { t.q = q[i]; });

    const hypotheses = {};
    const kinds = { H1: 'descriptive', H2: 'predictive', H3: 'descriptive', H4: 'descriptive', H5: 'descriptive', H6: 'predictive', H7: 'predictive', H8: 'descriptive' };
    for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']) {
      hypotheses[id] = summarize(id, kinds[id], tests, id === 'H3' || id === 'H6' || id === 'H7' || id === 'H8' ? minMatches : id === 'H2' ? minTeams : minRounds);
    }

    // Conditional-probability patterns ------------------------------------
    for (const comp of comps) {
      const rounds = roundsByComp.get(comp) || [];
      if (rounds.length < minRounds) continue;
      const totalCat = r => r.total <= 2 ? 'low(0-2)' : r.total <= 4 ? 'mid(3-4)' : 'high(5+)';
      const cats = ['low(0-2)', 'mid(3-4)', 'high(5+)'];
      const pairs = [];
      for (let i = 1; i < rounds.length; i++) pairs.push({ i, prev: totalCat(rounds[i - 1]), next: totalCat(rounds[i]) });
      const overall = {}; for (const c of cats) overall[c] = pairs.filter(p => p.next === c).length / (pairs.length || 1);
      const cut = Math.max(1, Math.floor(rounds.length * 0.6));
      for (const a of cats) for (const b of cats) {
        const row = pairs.filter(p => p.prev === a), hit = row.filter(p => p.next === b);
        const n = row.length, k = hit.length;
        if (n < minPatternN) continue;
        const base = overall[b], obs = k / n, ci = _LPStats_R.wilson(k, n);
        const se = Math.sqrt(Math.max(1e-12, base * (1 - base) / n));
        const z = se ? (obs - base) / se : 0, p = _LPStats_R.zTwoSided(z);
        const tr = row.filter(p => p.i < cut), te = row.filter(p => p.i >= cut);
        const trBase = tr.length ? tr.filter(p => p.next === b).length / tr.length : null;
        const teBase = te.length ? te.filter(p => p.next === b).length / te.length : null;
        const oosSame = trBase != null && teBase != null ? ((trBase - base) * (teBase - base) > 0) : null;
        patterns.push({ id: comp + ':total:' + a + '->' + b, comp, type: 'round total category', condition: 'previous round ' + a, outcome: 'next round ' + b, n, total: pairs.length, observed: obs, baseline: base, diff: obs - base, ci, p, q: null, oos: { n: te.length, observed: teBase, baseline: base, sameDirection: oosSame }, support: n / (pairs.length || 1) });
      }
      const outcomeCat = r => r.hw > r.aw ? 'H' : r.hw === r.aw ? 'D' : 'A';
      const ocats = ['H', 'D', 'A'];
      const op = [];
      for (let i = 1; i < rounds.length; i++) op.push({ i, prev: outcomeCat(rounds[i - 1]), next: outcomeCat(rounds[i]) });
      const oall = {}; for (const c of ocats) oall[c] = op.filter(p => p.next === c).length / (op.length || 1);
      for (const a of ocats) for (const b of ocats) {
        const row = op.filter(p => p.prev === a), hit = row.filter(p => p.next === b);
        const n = row.length, k = hit.length;
        if (n < minPatternN) continue;
        const base = oall[b], obs = k / n, ci = _LPStats_R.wilson(k, n);
        const se = Math.sqrt(Math.max(1e-12, base * (1 - base) / n));
        const z = se ? (obs - base) / se : 0, p = _LPStats_R.zTwoSided(z);
        const tr = row.filter(p => p.i < cut), te = row.filter(p => p.i >= cut);
        const trBase = tr.length ? tr.filter(p => p.next === b).length / tr.length : null;
        const teBase = te.length ? te.filter(p => p.next === b).length / te.length : null;
        const oosSame = trBase != null && teBase != null ? ((trBase - base) * (teBase - base) > 0) : null;
        patterns.push({ id: comp + ':outcome:' + a + '->' + b, comp, type: 'round outcome', condition: 'previous round ' + a, outcome: 'next round ' + b, n, total: op.length, observed: obs, baseline: base, diff: obs - base, ci, p, q: null, oos: { n: te.length, observed: teBase, baseline: base, sameDirection: oosSame }, support: n / (op.length || 1) });
      }
    }
    const pf = patterns.filter(p => Number.isFinite(p.p));
    const pq = _LPStats_R.bh(pf.map(p => p.p));
    pf.forEach((p, i) => { p.q = pq[i]; });
    for (const p of patterns) {
      if (!Number.isFinite(p.p) || p.n < minPatternN) p.status = 'insufficient';
      else if (p.p < 0.05 && p.q != null && p.q < 0.1 && p.oos.sameDirection === true && p.oos.n >= Math.max(10, Math.floor(minPatternN / 2)) && p.n >= minPatternN * 2) p.status = 'validated';
      else if (p.p < 0.05) p.status = 'exploratory';
      else p.status = 'not_supported';
    }
    patterns.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // Information theory ---------------------------------------------------
    const information = {};
    for (const key of ['all', ...comps]) {
      const subset = key === 'all' ? ms : (byComp.get(key) || []);
      const rset = key === 'all' ? comps.flatMap(c => roundsByComp.get(c) || []) : (roundsByComp.get(key) || []);
      const outcomes = [0, 0, 0]; subset.forEach(m => outcomes[m.outcome]++);
      const totals = hist(subset.map(m => m.total));
      const pairs = [];
      const addPairs = (rounds) => {
        for (let i = 1; i < rounds.length; i++) {
          const a = rounds[i - 1], b = rounds[i];
          pairs.push([a.total <= 2 ? 'low' : a.total <= 4 ? 'mid' : 'high', b.total <= 2 ? 'low' : b.total <= 4 ? 'mid' : 'high']);
        }
      };
      if (key === 'all') comps.forEach(c => addPairs(roundsByComp.get(c) || []));
      else addPairs(rset);
      information[key] = {
        matches: subset.length, rounds: rset.length,
        outcomeEntropyBits: _LPStats_R.entropy(outcomes),
        totalGoalEntropyBits: _LPStats_R.entropy(totals),
        roundTransitionMiBits: pairs.length ? _LPStats_R.mutualInformation(pairs, true) : null,
        roundTransitionConditionalEntropyBits: pairs.length ? _LPStats_R.conditionalEntropy(pairs) : null,
        roundTransitionMi: pairs.length >= 20 ? _LPStats_R.miPermutation(pairs, B, seed + (typeof key === 'string' ? key.length : 0)) : null
      };
    }

    const dateRange = ms.length ? { from: Math.min.apply(null, ms.map(m => m.ts)), to: Math.max.apply(null, ms.map(m => m.ts)) } : null;
    const warnings = [];
    if (ms.length < minMatches) warnings.push('Only ' + ms.length + ' usable matches; the minimum for inference is ' + minMatches + '. Most hypotheses will be insufficient.');
    if (comps.length < 2) warnings.push('Fewer than two competitions; competition-difference tests are limited.');
    if (!rows.length) warnings.push('No market probabilities were available; H6–H8 are limited.');
    const limitations = [
      'Observational data only; no causal claims.',
      'The sample is recorded in real time and may contain gaps; gap warnings from the capture layer still apply.',
      'Odds were static in the live probe; this analysis does not assume line movement.',
      'Multiple testing is controlled with Benjamini–Hochberg q-values; exploratory findings are not trading rules.',
      'Team persistence is split-half, not a full generative model.',
      'Market comparisons use margin-adjusted 1X2 fair probabilities, not raw odds.'
    ];
    return {
      meta: { version: VERSION, generatedAt: Date.now(), matches: ms.length, rounds: comps.reduce((s, c) => s + (roundsByComp.get(c) || []).length, 0), competitions: comps.length, dateRange, byComp: comps.map(c => ({ comp: c, matches: (byComp.get(c) || []).length, rounds: (roundsByComp.get(c) || []).length })), options: { minMatches, minRounds, minTeams, minPatternN, permutations: B, seed }, warnings },
      hypotheses, tests, patterns, information, limitations
    };
  }

  return { VERSION, enrichMarket, prepare, marketRows, analyze };
})();
if (typeof module !== 'undefined') module.exports = LPResearch;
