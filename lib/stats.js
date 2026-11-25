// Statistical primitives for League Plus research.
// Pure functions only: no IndexedDB, DOM or Chrome APIs. Used by the dashboard
// research tab and by research/report.cjs.
const LPStats = (() => {
  const LN2 = Math.LN2;
  const sum = a => (a || []).reduce((s, x) => s + x, 0);
  const mean = a => (a && a.length ? sum(a) / a.length : null);
  const variance = (a, ddof = 1) => {
    if (!a || a.length <= ddof) return null;
    const m = mean(a);
    return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof);
  };
  const sd = (a, ddof = 1) => { const v = variance(a, ddof); return v == null ? null : Math.sqrt(v); };
  const quantile = (a, p) => {
    if (!a || !a.length) return null;
    const b = a.slice().sort((x, y) => x - y);
    const i = (b.length - 1) * Math.max(0, Math.min(1, p)), lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (i - lo);
  };
  const median = a => quantile(a, 0.5);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Normal / chi-square approximations --------------------------------------
  function erf(x) {
    const s = x < 0 ? -1 : 1, ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  }
  const normalCdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
  function normalInv(p) {
    // Acklam's rational approximation; adequate for confidence bounds.
    if (!(p > 0 && p < 1)) return null;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function gammaLn(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function gammaincLower(a, x) {
    if (!(a > 0) || x < 0) return NaN;
    if (x === 0) return 0;
    if (x < a + 1) {
      let ap = a, del = 1 / a, s = del;
      for (let n = 1; n <= 300; n++) {
        ap++; del *= x / ap; s += del;
        if (Math.abs(del) < Math.abs(s) * 1e-13) break;
      }
      return s * Math.exp(-x + a * Math.log(x) - gammaLn(a));
    }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i <= 300; i++) {
      const an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-13) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
  }
  const chiSquareSurvival = (x, df) => (df > 0 && x >= 0 ? 1 - gammaincLower(df / 2, x / 2) : null);
  const zTwoSided = z => 2 * (1 - normalCdf(Math.abs(z)));
  const wilson = (k, n, z = 1.96) => {
    if (!n) return [null, null];
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / den;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return [clamp(centre - half, 0, 1), clamp(centre + half, 0, 1)];
  };

  // Information theory -------------------------------------------------------
  function entropy(counts) {
    const n = sum(counts); if (!n) return 0;
    let h = 0;
    for (const c of counts) if (c > 0) { const p = c / n; h -= p * Math.log(p) / LN2; }
    return h;
  }
  function pairCounts(pairs) {
    const xs = new Map(), ys = new Map(), cells = new Map();
    for (const [x, y] of pairs) {
      xs.set(x, (xs.get(x) || 0) + 1); ys.set(y, (ys.get(y) || 0) + 1);
      const k = String(x) + '\u0001' + String(y); cells.set(k, (cells.get(k) || 0) + 1);
    }
    return { n: pairs.length, nx: xs.size, ny: ys.size, xs: [...xs.values()], ys: [...ys.values()], cells: [...cells.values()] };
  }
  function mutualInformation(pairs, corrected = true) {
    if (!pairs || pairs.length < 2) return null;
    const c = pairCounts(pairs), n = c.n;
    const mi = entropy(c.xs) + entropy(c.ys) - entropy(c.cells);
    return corrected ? Math.max(0, mi - ((c.nx - 1) * (c.ny - 1)) / (2 * n * LN2)) : mi;
  }
  function miPermutation(pairs, B = 499, seed = 1) {
    if (!pairs || pairs.length < 10) return { mi: null, p: null, n: pairs ? pairs.length : 0 };
    const obs = mutualInformation(pairs, true), rng = seeded(seed);
    const ys = pairs.map(p => p[1]);
    let ge = 0;
    for (let b = 0; b < B; b++) {
      const sh = shuffle(ys, rng);
      const nullPairs = pairs.map((p, i) => [p[0], sh[i]]);
      if (mutualInformation(nullPairs, true) >= obs) ge++;
    }
    return { mi: obs, p: (ge + 1) / (B + 1), n: pairs.length, permutations: B };
  }
  const conditionalEntropy = (pairs) => {
    if (!pairs || !pairs.length) return null;
    const c = pairCounts(pairs);
    return entropy(c.cells) - entropy(pairs.map(p => p[1]));
  };

  // Contingency / rank tests ------------------------------------------------
  function chiSquare2D(table) {
    const rows = table.length, cols = rows ? table[0].length : 0;
    if (rows < 2 || cols < 2) return null;
    const rs = table.map(r => sum(r)), cs = Array.from({ length: cols }, (_, j) => sum(table.map(r => r[j])));
    const n = sum(rs); if (!n) return null;
    let chi = 0, minExp = Infinity;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const e = rs[i] * cs[j] / n; minExp = Math.min(minExp, e);
      if (e > 0) chi += (table[i][j] - e) ** 2 / e;
    }
    const df = (rows - 1) * (cols - 1);
    return { chi, df, p: chiSquareSurvival(chi, df), n, minExpected: minExp, cramersV: n ? Math.sqrt(chi / (n * Math.min(rows - 1, cols - 1))) : null };
  }
  function kruskalWallis(groups) {
    const gs = (groups || []).filter(g => g && g.length);
    if (gs.length < 2) return null;
    const all = [];
    gs.forEach((g, gi) => g.forEach(v => all.push({ v, gi })));
    const N = all.length;
    if (N < 5) return null;
    all.sort((a, b) => a.v - b.v);
    const ranks = new Array(N);
    for (let i = 0; i < N;) {
      let j = i;
      while (j + 1 < N && all[j + 1].v === all[i].v) j++;
      const r = (i + j + 2) / 2;
      for (let k = i; k <= j; k++) ranks[k] = r;
      i = j + 1;
    }
    const sumR = gs.map(() => 0); const counts = gs.map(g => g.length);
    for (let i = 0; i < N; i++) sumR[all[i].gi] += ranks[i];
    let H = 12 / (N * (N + 1)) * sumR.reduce((s, r, i) => s + r * r / counts[i], 0) - 3 * (N + 1);
    const tieCounts = new Map();
    for (const x of all) tieCounts.set(x.v, (tieCounts.get(x.v) || 0) + 1);
    let tie = 0; for (const t of tieCounts.values()) if (t > 1) tie += t ** 3 - t;
    const corr = 1 - tie / (N ** 3 - N);
    if (corr > 0) H /= corr;
    const df = gs.length - 1;
    return { H, df, p: chiSquareSurvival(H, df), n: N, groups: gs.length, epsilonSquared: (H - gs.length + 1) / (N - gs.length) };
  }
  function runsTest(seq) {
    const s = (seq || []).map(x => x ? 1 : 0);
    const n1 = s.filter(x => x === 1).length, n2 = s.length - n1, N = s.length;
    if (n1 < 2 || n2 < 2) return null;
    let runs = 1; for (let i = 1; i < N; i++) if (s[i] !== s[i - 1]) runs++;
    const mu = 2 * n1 * n2 / N + 1;
    const varR = 2 * n1 * n2 * (2 * n1 * n2 - N) / (N * N * (N - 1));
    const z = varR > 0 ? (runs - mu) / Math.sqrt(varR) : null;
    return { runs, n1, n2, expected: mu, z, p: z == null ? null : zTwoSided(z) };
  }
  function autocorrelation(series, lag = 1) {
    const x = series || [], n = x.length;
    if (n <= lag + 2) return null;
    const m = mean(x); let num = 0, den = 0;
    for (let i = 0; i < n; i++) den += (x[i] - m) ** 2;
    for (let i = lag; i < n; i++) num += (x[i] - m) * (x[i - lag] - m);
    return den > 0 ? num / den : null;
  }
  function ljungBox(series, lags = 5) {
    const x = series || [], n = x.length;
    const m = Math.min(lags, n - 2);
    if (n < 8 || m < 1) return null;
    let Q = 0, rs = [];
    for (let k = 1; k <= m; k++) { const r = autocorrelation(x, k); rs.push(r); if (r != null) Q += r * r / (n - k); }
    Q *= n * (n + 2);
    return { Q, df: m, p: chiSquareSurvival(Q, m), n, lags: m, autocorrelations: rs };
  }
  function pearson(x, y) {
    if (!x || !y || x.length !== y.length || x.length < 3) return null;
    const mx = mean(x), my = mean(y);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < x.length; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
  }
  function pacf(series, maxLag = 5) {
    const x = series || [], n = x.length;
    if (n < 5) return null;
    const m = Math.min(maxLag, n - 2);
    const r = [1];
    for (let k = 1; k <= m; k++) r[k] = autocorrelation(x, k);
    const phi = {}, out = [];
    for (let k = 1; k <= m; k++) {
      let num = r[k], den = 1;
      for (let j = 1; j < k; j++) { num -= (phi[j] || 0) * r[k - j]; den -= (phi[j] || 0) * r[j]; }
      const pk = den !== 0 ? num / den : 0;
      const prev = Object.assign({}, phi);
      phi[k] = pk;
      for (let j = 1; j < k; j++) phi[j] = prev[j] - pk * (prev[k - j] || 0);
      out.push(pk);
    }
    return out;
  }
  function corrPermutation(x, y, B = 499, seed = 1) {
    const obs = pearson(x, y);
    if (obs == null) return { r: null, p: null, n: x ? x.length : 0 };
    const rng = seeded(seed); let ge = 0;
    for (let b = 0; b < B; b++) {
      const sh = shuffle(y, rng), r = pearson(x, sh);
      if (r != null && Math.abs(r) >= Math.abs(obs)) ge++;
    }
    return { r: obs, p: (ge + 1) / (B + 1), n: x.length, permutations: B };
  }

  // Randomisation / bootstrap ----------------------------------------------
  function seeded(seed = 1) {
    let a = seed >>> 0;
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function shuffle(a, rng) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  }
  function permutationDiff(a, b, B = 999, seed = 1) {
    if (!a || !b || a.length < 2 || b.length < 2) return { diff: null, p: null, n: (a || []).length + (b || []).length };
    const obs = mean(a) - mean(b), all = a.concat(b), n1 = a.length, rng = seeded(seed);
    let ge = 0;
    for (let i = 0; i < B; i++) {
      const sh = shuffle(all, rng); const d = mean(sh.slice(0, n1)) - mean(sh.slice(n1));
      if (Math.abs(d) >= Math.abs(obs)) ge++;
    }
    return { diff: obs, p: (ge + 1) / (B + 1), n: all.length, permutations: B };
  }
  function bootstrapCI(values, stat = mean, B = 999, alpha = 0.05, seed = 1) {
    if (!values || values.length < 3) return { value: values && values.length ? stat(values) : null, low: null, high: null, n: values ? values.length : 0 };
    const rng = seeded(seed), out = [];
    for (let i = 0; i < B; i++) {
      const s = new Array(values.length);
      for (let j = 0; j < values.length; j++) s[j] = values[Math.floor(rng() * values.length)];
      out.push(stat(s));
    }
    out.sort((a, b) => a - b);
    return { value: stat(values), low: quantile(out, alpha / 2), high: quantile(out, 1 - alpha / 2), n: values.length, bootstrap: B };
  }
  function pairedBootstrapDiff(a, b, stat = mean, B = 999, alpha = 0.05, seed = 1) {
    if (!a || !b || a.length !== b.length || a.length < 3) return { diff: null, low: null, high: null, p: null, n: a ? a.length : 0 };
    const d = a.map((x, i) => x - b[i]), obs = stat(d), rng = seeded(seed), out = [];
    for (let i = 0; i < B; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(rng() * d.length)]; out.push(s / d.length); }
    out.sort((x, y) => x - y);
    const le = out.filter(x => x <= 0).length, ge = out.filter(x => x >= 0).length;
    return { diff: obs, low: quantile(out, alpha / 2), high: quantile(out, 1 - alpha / 2), p: Math.min(1, 2 * Math.min((le + 1) / (B + 1), (ge + 1) / (B + 1))), n: d.length, bootstrap: B };
  }
  function bh(pValues) {
    const p = pValues || [], m = p.length;
    const order = p.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const q = new Array(m); let prev = 1;
    for (let k = m - 1; k >= 0; k--) {
      const val = Math.min(prev, order[k].x * m / (k + 1));
      q[order[k].i] = val; prev = val;
    }
    return q;
  }

  // Change point / divergence ----------------------------------------------
  function cusum(series, target) {
    const x = series || []; if (x.length < 8) return null;
    const m = target == null ? mean(x) : target, sdv = sd(x) || 1;
    let c = 0, max = 0, at = -1;
    const path = [];
    for (let i = 0; i < x.length; i++) { c += (x[i] - m) / sdv; path.push(c); if (Math.abs(c) > Math.abs(max)) { max = c; at = i; } }
    return { target: m, stat: max, index: at, split: at + 1, n: x.length, path };
  }
  function cusumPermutation(series, B = 499, seed = 1) {
    const obs = cusum(series); if (!obs) return { stat: null, p: null, n: (series || []).length };
    const rng = seeded(seed); let ge = 0;
    for (let b = 0; b < B; b++) { const x = shuffle(series, rng), c = cusum(x); if (Math.abs(c.stat) >= Math.abs(obs.stat)) ge++; }
    return { stat: obs.stat, index: obs.index, p: (ge + 1) / (B + 1), n: series.length, permutations: B };
  }
  function pageHinkley(series, delta = 0.5) {
    const x = series || []; if (x.length < 8) return null;
    const m = mean(x);
    let mp = 0, mn = 0, max = -Infinity, min = Infinity, at = -1;
    for (let i = 0; i < x.length; i++) {
      mp += x[i] - m - delta; mn += x[i] - m + delta;
      if (mp > max) { max = mp; at = i; }
      if (mn < min) { min = mn; at = i; }
    }
    return { mean: m, max, min, stat: Math.max(max, -min), index: at, n: x.length };
  }
  function kl(p, q, alpha = 1e-9) {
    if (!p || !q || p.length !== q.length) return null;
    const ps = sum(p) || 1, qs = sum(q) || 1; let d = 0;
    for (let i = 0; i < p.length; i++) {
      const a = Math.max(alpha, p[i] / ps), b = Math.max(alpha, q[i] / qs);
      d += a * Math.log(a / b) / LN2;
    }
    return d;
  }

  // Scoring ----------------------------------------------------------------
  function brierMulticlass(probs, outcome) {
    if (!probs || !Number.isFinite(outcome)) return null;
    let s = 0; for (let i = 0; i < probs.length; i++) s += (probs[i] - (i === outcome ? 1 : 0)) ** 2;
    return s;
  }
  function logLossMulticlass(probs, outcome) {
    if (!probs || !Number.isFinite(outcome)) return null;
    const p = Math.min(1 - 1e-12, Math.max(1e-12, probs[outcome]));
    return -Math.log(p) / Math.LN2;
  }

  return {
    sum, mean, variance, sd, quantile, median, clamp, erf, normalCdf, normalInv, gammaLn, gammaincLower,
    chiSquareSurvival, zTwoSided, wilson, entropy, mutualInformation, miPermutation, conditionalEntropy,
    chiSquare2D, kruskalWallis, runsTest, autocorrelation, ljungBox, pacf, pearson, corrPermutation, seeded, shuffle, permutationDiff,
    bootstrapCI, pairedBootstrapDiff, bh, cusum, cusumPermutation, pageHinkley, kl, brierMulticlass, logLossMulticlass
  };
})();
if (typeof module !== 'undefined') module.exports = LPStats;
