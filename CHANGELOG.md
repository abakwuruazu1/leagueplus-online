# Changelog

## 2.9.0 — Remote phone access through Netlify

- Added `lib/cloud.js`: compact read-only snapshot construction, token upload,
  interval throttling and upload status.
- Added Settings → Cloud sync for phone: endpoint, write token, interval,
  enable/disable and Sync now.
- Added Netlify Functions for snapshot upload/download, PIN login, session check
  and logout using Netlify Blobs.
- Added `/remote`: PIN-protected mobile page with snapshot age, active
  components, current decisions, bankroll/ROI/CLV, model leaderboard and a
  slip builder using the snapshot odds.
- The phone view is read-only; no activation, settings or bets are sent back.
- Added 2 cloud tests and 3 auth tests; suite is now 76 tests.
- Added complete Netlify and phone setup instructions in `NETLIFY.md`.

### Not yet claimed

- Remote activation/rollback or command queue
- Push notifications for new BET/round events
- Multi-device history or full ledger sync

## 2.8.0 — Stage 10: consolidated intelligence and final report

- Added `lib/performance.js`: ledger counts, model leaderboard, calibration,
  BET/ROI, bankroll, drawdown, exposure and closing-line value.
- Added an Intelligence tab consolidating data health, active components, model
  performance, bankroll/exposure, recent BET rows, CLV and policy rollback.
- Added `research/final.cjs`, which runs every model, calibration, weight,
  specialist and decision gate and writes `final-YYYY-MM-DD.json/.md`.
- Added 3 performance tests; suite is now 71 tests.
- On the current sample all gates are disabled and the final verdict is NO BET;
  the collector-only report marks ledger performance unavailable until a backup
  is supplied.

### Not yet claimed

- Sustained multi-month data collection and repeated activation evidence
- Real account bankroll/currency modelling
- Bankroll compounding, limits and account-restriction simulation

## 2.7.0 — Stage 9: uncertainty-aware decisions and staking

- Added `lib/decision.js`: lower-confidence-bound value gating, market-specific
  minimum edges, odds/probability bands, wide-uncertainty blocking and
  fractional-Kelly staking with caps.
- Added a chronological policy holdout: threshold variants are selected on an
  earlier window and activated only with enough holdout bets, positive flat ROI
  and a positive bootstrap lower bound.
- Added `lib/accumulator.js`: target-odds search using lower-bound joint
  probability, one leg per fixture by default and a correlation penalty when
  same-fixture legs are allowed.
- Ledger rows record decision, selected selection, lower-bound edge, stake units
  and policy version; settlement records bet outcome and profit units.
- Added the Decision dashboard tab and `research/decision.cjs`.
- Integrated the decision policy into the Stage 8 learning state and active
  background capture path.
- Added 5 decision/accumulator tests; suite is now 68 tests.
- On the current 104-match sample the holdout produces zero qualifying bets, so
  no policy is active and every ledger decision remains NO BET.

### Not yet claimed

- Final consolidated intelligence dashboard and performance report (Stage 10)
- Bankroll/CLV reporting and multi-policy comparison
- Joint score/copula accumulator correlation model

## 2.6.0 — Stage 8: autonomous learning and activation

- Added `lib/learn.js`: schedule/data thresholds, persisted model states,
  gate-respecting candidate creation, pointer activation, rollback and an
  append-only learning audit log.
- The background service worker now runs an hourly learning alarm and applies
  the active calibrator/weight state to the live ledger capture path.
- Added a Learning tab showing the active model, refresh policy, stored
  candidates, activation controls, rollback and audit history.
- Specialist re-evaluation now supports calibration samples and fits a
  calibrator only on earlier selections per test round.
- Rejected states are stored for audit and cannot be activated without force.
- Added 5 learning tests plus a chronological specialist-calibration test;
  suite is now 63 tests.
- On the current 104-match sample the default 500-selection/40-match policy
  does not auto-activate anything; the equal ensemble remains in production.

### Not yet claimed

- Uncertainty-aware value thresholds, staking and accumulators (Stage 9)
- Full intelligence dashboard and final walk-forward report (Stage 10)
- Multi-worker/long-running training beyond the MV3 alarm budget

## 2.5.0 — Stage 7: calibration, adaptive weights and uncertainty

- Added `lib/calibration.js`: Platt scaling, isotonic regression, reliability
  bins, ECE/MCE, Brier decomposition and a chronological activation gate with
  paired bootstrap and BH correction.
- Added `lib/weights.js`: walk-forward adaptive weights for market, Dixon-Coles,
  empirical and team models, with non-negativity, shrinkage toward equal and
  per-market comparisons.
- Added approximate Wilson uncertainty intervals (`pLow`/`pHigh`, effective n
  and narrow/moderate/wide labels) to every evaluated selection.
- Ledger version is now `stage7-calibrated-v1`; it records weighted/calibrated
  arrays, uncertainty fields and settles their metrics. Every decision remains
  NO BET.
- Added the Calibration dashboard tab and `research/calibration.cjs`.
- Added 7 calibration/weight tests, a model-integration test and a ledger
  active-series test; suite is now 57 tests.
- On the current 104-match sample both components are disabled: Platt changes
  log loss by -0.0021 (p = 0.46), and adaptive weights lack two active component
  models and enough test selections. The equal ensemble remains in production.

### Not yet claimed

- Persisted automatic refresh/rollback of calibrated models (Stage 8)
- Uncertainty-aware value thresholds, staking and accumulators (Stage 9)
- Full intelligence dashboard and final walk-forward report (Stages 10–11)

## 2.4.0 — Stage 6: sequence and pattern specialists

- Added `lib/sequence.js`: a low-dimensional round-transition model that learns
  the next round's conditional scoring level from the previous round's class,
  shrinks sparse cells toward the competition mean, and falls back explicitly.
- Added `lib/patterns.js`: interpretable association-rule discovery over
  competition, favourite state, previous-round scoring and recent form/over
  rates, with support, Wilson CI, p, BH q and an internal out-of-sample
  direction.
- Added `lib/specialists.js`: walk-forward comparison of both specialists
  against the Stage 5 equal ensemble, paired bootstrap differences, BH
  correction, leakage checks and automatic enable/disable decisions.
- Added `research/specialists.cjs` and the Specialists dashboard tab.
- Disabled specialists are excluded from the ensemble, ledger and decision
  path; discovery is not activation.
- Added 3 specialist tests; suite is now 48 tests.
- On the current 104-match sample both specialists are disabled: sequence is
  worse by 0.1041 log loss (95% interval [-0.0337, +0.2343], p = q = 0.12) and
  0 of 105 pattern rules validate.

### Not yet claimed

- Adaptive model weights, calibration and formal uncertainty (Stage 7)
- Autonomous learning pipeline (Stage 8)
- Uncertainty-aware value and accumulator optimisation (Stage 9)
- Full intelligence dashboard and final walk-forward report (Stages 10–11)

## 2.3.0 — Stage 5: upgraded probability models

- Upgraded team fitting: season-aware selection, hour/round decay, weighted
  iterative fitting, per-team sample/reliability/uncertainty fields.
- Added Dixon-Coles low-score dependence with fitted rho and normalised score
  matrices.
- Added Bayesian-smoothed empirical score distributions with inner
  walk-forward window selection.
- Added proportional, power and additive margin-removal methods.
- Added an equal-weight ensemble of available market/DC/empirical/team models.
- Added `lib/modelEval.js` and `research/models.cjs` for chronological
  walk-forward model comparison against historical and market baselines, with
  leakage checks and paired bootstrap comparisons.
- Ledger version is now `stage5-models-v1`; it records `dc` and `emp`
  probabilities and settles their metrics.
- Dashboard engine selectors expose DC, empirical and equal ensemble.
- Added 6 model tests and 2 model-evaluation tests; suite is now 45 tests.

### Not yet claimed

- Adaptive model weights and calibration (Stage 7)
- Autonomous learning pipeline (Stage 8)
- Uncertainty-aware value and accumulator optimisation (Stage 9)
- Full intelligence dashboard and final walk-forward report (Stages 10–11)

## 2.2.0 — Stage 4: statistical research laboratory

- Added `lib/stats.js`: entropy/MI, normal and chi-square approximations,
  Wilson intervals, chi-square/Kruskal-Wallis/runs/Ljung-Box, permutation and
  bootstrap tests, Benjamini-Hochberg, CUSUM/Page-Hinkley, KL divergence and
  Brier/log-loss.
- Added `lib/research.js` testing H1–H8 with sample thresholds, effect sizes,
  multiple-testing correction, conditional patterns and out-of-sample direction.
- Added a Research tab running H1–H8 on the latest 2,000 matches with explicit
  `insufficient` / `exploratory` / `supported` labels.
- Added `research/report.cjs` generating reproducible JSON + Markdown reports
  from the collector or an extension backup.
- Added eight statistical tests and two synthetic research tests; suite is now
  37 tests.
- Research is observational and not a betting strategy. H6 only tests market
  information beyond historical frequencies.

### Not yet claimed

- Model upgrades and specialised models (Stages 5–6)
- Adaptive weights, calibration and regimes (Stage 7)
- Autonomous learning pipeline (Stage 8)
- Uncertainty-aware value and accumulator optimisation (Stage 9)
- Full intelligence dashboard and walk-forward report (Stages 10–11)

## 2.1.0 — Stage 3: immutable prediction ledger

- Added `lib/ledger.js` with immutable prediction rows and separate settlement rows.
- Ledger records fixture/time/checkpoint, model and ensemble versions, frozen
  catalogue, odds/implied probability, individual model probabilities, baseline
  ensemble, uncalibrated model range, EV, candidate, decision and training cutoff.
- Automatic recording in background capture; manual record/settle actions in the
  new Ledger tab.
- Settlement records tri-state outcomes and per-model Brier/log-loss metrics.
- Strict no-leakage rules: `asOf < betClose`; training matches `ts < asOf`; future
  results excluded from training (tested).
- Every Stage 3 decision is deliberately NO BET pending calibration and formal
  confidence bounds.
- Background loads `lib/model.js` and `lib/ledger.js`; backup v2 already includes
  prediction and settlement stores.
- Added six ledger tests; suite is now 27 tests.
- Dashboard Ledger tab with coverage, recent predictions, settlement status and
  recent model metrics.

### Not yet claimed

- Randomness/conditional-probability research (Stage 4)
- Model upgrades and specialised models (Stages 5–6)
- Adaptive weights, calibration and regimes (Stage 7)
- Autonomous learning pipeline (Stage 8)
- Uncertainty-aware value and accumulator optimisation (Stage 9)
- Full intelligence dashboard and walk-forward report (Stages 10–11)

## 2.0.0 — Stage 2: data integrity and provenance

- IndexedDB schema v3 with additive stores for rounds, frozen catalogues,
  snapshots, quality logs, conflicts and reserved ledger/model stores.
- Immutable writes for matches, snapshots, catalogues and future ledger rows;
  different content is kept out and logged as a conflict.
- Frozen per-round catalogue versions; historical settlement uses the version
  active at capture.
- Round-aware capture: one alarm per game at result time and at a pre-close
  check, plus a 10-minute fallback. Old v1 30-second polling alarm is cleared.
- Immutable odds snapshots with open/close/result provenance and hashes.
- Data-quality engine: team parsing, scores, timestamps, competition/round
  identity, odds validity/alignment, unknown selections, timeline completeness,
  partial rounds and round gaps.
- Settlement fixes: 4:4/5:5 Goal Up draws, incomplete-timeline refusal, unknown
  markets return unsettled, normalised score matrices.
- Fair-odds structural handling: exclusive, pair, overlapping and singleton
  markets; correct-score incomplete partition flagged.
- Resumable v1 migration; scores, goals and odds are never changed.
- Backup v2 with gzip, immutable merge, transient-metadata filtering, newer-
  catalogue protection and v1 backup import.
- Data-quality dashboard tab with capture schedule, quality issues, conflicts,
  full audit, backup/import/export.
- Optional research collector (`research/collect.cjs`) and 21-test Node suite.

### Not yet claimed

- Prediction ledger (Stage 3)
- Randomness/conditional-probability research (Stage 4)
- Model upgrades and specialised models (Stages 5–6)
- Adaptive weights, calibration and regimes (Stage 7)
- Autonomous learning pipeline (Stage 8)
- Uncertainty-aware value and accumulator optimisation (Stage 9)
- Full intelligence dashboard and walk-forward report (Stages 10–11)
