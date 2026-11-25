LEAGUE PLUS STATS & PREDICTION ENGINE  (Bet9ja League Plus – all leagues)
Version 2.9.0 – Remote phone access through Netlify
========================================================================

INSTALL (2 minutes, no technical knowledge needed)
1. Unzip "leagueplus-engine.zip". You get a folder called "leagueplus-engine".
2. Open Google Chrome and type  chrome://extensions  in the address bar, press Enter.
3. Switch ON "Developer mode" (top-right corner).
4. Click "Load unpacked" (top-left) and choose the "leagueplus-engine" folder.
5. Click the puzzle-piece icon next to the address bar and pin "League Plus Stats & Prediction Engine".
6. Click the orange "L+" icon any time to open the dashboard.

That's it. It starts recording straight away - you don't even need the League Plus site open.

REMOTE PHONE ACCESS (OPTIONAL NETLIFY SITE)
The extension can push a compact, read-only snapshot to a Netlify site. Your
phone can then open a PIN-protected page from anywhere and see the latest round,
Ledger decisions, bankroll/ROI/CLV and an online slip builder built from the
snapshot odds.

The extension stays on your PC and remains the only thing that records data.
The phone cannot activate models, change settings or place bets. The PC must be
awake and Chrome open, or the phone will show a stale snapshot.

Public slip builder:      https://YOUR-SITE.netlify.app/
Private phone view:       https://YOUR-SITE.netlify.app/remote

Setup:
1. Deploy with Git + Netlify using the included `netlify.toml`.
2. Set the Netlify environment variables `LP_WRITE_TOKEN`,
   `LP_SESSION_SECRET`, and `LP_PIN` (or `LP_PIN_HASH`).
3. In the extension Settings, enter the endpoint
   `https://YOUR-SITE.netlify.app/api/snapshot`, the write token, and enable
   Cloud sync.
4. Click "Sync now"; then open `/remote` on the phone and enter the PIN.

Full instructions, secret generation and troubleshooting are in `NETLIFY.md`.
Local public preview:

    npm run web

Then open http://localhost:8124.

WHAT CHANGED IN 2.0 (STAGE 2)
- IndexedDB schema v3 with add-only history. A result or odds value can never
  silently overwrite an existing historical row. Conflicts are recorded in the
  Data quality tab.
- Frozen market catalogues. Every round points at the catalogue version that
  was active when it was captured; settlement never depends on today's market
  definitions.
- Immutable odds snapshots with provenance: opening, closing and result hashes.
- Round-aware capture. Instead of polling every game every 30 seconds, the
  extension schedules one alarm per game at the result time and one before the
  betting close. A 10-minute fallback alarm recovers from missed one-shots or a
  suspended service worker.
- A data-quality engine checks scores, timestamps, team parsing, odds/selection
  alignment, timeline completeness, unknown selections, partial rounds and
  missing round IDs.
- Resumable migration from the v1 database. Scores, goals and odds are never
  altered; only new provenance/quality fields are added.
- Backup v2: all stores, compressed JSON (.json.gz), immutable merge on import
  and conflict reporting. Old v1 backups ({matches, meta}) are also accepted.

WHAT CHANGED IN 2.1 (STAGE 3)
- An immutable prediction ledger. Every prediction is written before the match
  closes and settled in a separate immutable row after the result exists.
- Ledger rows record the fixture, prediction time, checkpoint (open / mid /
  pre-close), model version, frozen catalogue version, odds, implied market
  probability, each individual model probability, the baseline ensemble,
  lower/upper model range, EV, candidate selection, decision and training
  cutoff/sample size.
- Predictions are recorded automatically by capture, plus a manual "record
  open-round predictions" action in the Ledger tab.
- Settlement records per-selection outcomes and Brier/log-loss metrics for
  every model, so calibration work in later stages has real out-of-sample data.
- Every Stage 3 decision is deliberately NO BET: calibration, formal confidence
  intervals and the final decision/value engine are later stages.
- The Ledger tab shows coverage, recent predictions, settlement status and
  recent model metrics.

WHAT CHANGED IN 2.2 (STAGE 4)
- Added a statistical research library (`lib/stats.js`) with entropy, mutual
  information, autocorrelation, Ljung-Box, runs, chi-square, Kruskal-Wallis,
  permutation tests, bootstrap intervals, Benjamini-Hochberg correction,
  CUSUM/Page-Hinkley change points, KL divergence and proper scoring rules.
- Added a research engine (`lib/research.js`) testing H1-H8: serial dependence,
  team persistence, competition differences, round transitions, change points,
  market information beyond scores, market+history blending and conditional
  predictability.
- Conditional-probability discovery reports sample size, baseline, observed
  rate, Wilson interval, p, BH q-value and an out-of-sample direction. Patterns
  that do not survive are marked exploratory or unsupported.
- Added a Research tab that runs the tests on the most recent 2,000 recorded
  matches and shows hypotheses, test detail, patterns and information theory.
- Added `research/report.cjs` to generate a reproducible JSON + Markdown report
  from collector data or an extension backup.
- No result is called a betting edge. Market-information and descriptive tests
  are labelled as such; calibration and value thresholds remain later stages.

WHAT CHANGED IN 2.3 (STAGE 5)
- Upgraded team ratings: round/hour decay, season-aware selection, per-team
  sample counts, reliability and approximate parameter uncertainty.
- Added Dixon-Coles low-score dependence on top of the team model; the rho
  parameter is fitted by weighted likelihood.
- Added a Bayesian-smoothed empirical score distribution. Its history window is
  selected by an inner chronological validation, not assumed to be 10/20/50.
- Margin removal now supports proportional, power and additive methods; the
  active method is recorded with the probabilities.
- The ensemble is the equal mean of available market/DC/empirical/team models;
  adaptive weights and calibration are later stages.
- The ledger now records `dc` and `emp` probabilities and settles their Brier/
  log-loss alongside the existing models.
- Added `research/models.cjs`, a chronological walk-forward model comparison
  report against historical-frequency and market baselines.
- The dashboard engine selector now includes Dixon-Coles, empirical and equal
  ensemble, in addition to market, fair, team and blend.

WHAT CHANGED IN 2.4 (STAGE 6)
- Added a sequence/transition specialist: it learns the next round's conditional
  per-match scoring level from the previous round and prices 1X2/O-U/BTTS from
  that adjusted Poisson level.
- Added a pattern specialist: interpretable association rules over competition,
  market-favourite state, previous-round scoring, recent team form and recent
  over-rates. Every rule reports support, baseline, observed rate, Wilson CI,
  p, BH q and an out-of-sample direction.
- Stage 6 is an evaluation gate: a specialist may be considered for production
  only if it beats the Stage 5 equal ensemble out-of-sample (negative paired
  log-loss difference, p < 0.05, BH q < 0.10 and enough usable observations).
  Discovery is not activation.
- Added `lib/specialists.js` and `research/specialists.cjs`, with leakage checks
  and a visible enable/disable decision.
- Added a Specialists tab showing the automatic decisions, model metrics and
  top discovered rules.
- Both specialists fail the gate on the current sample, so they are disabled and
  the production ensemble, ledger and decision path remain exactly Stage 5.

WHAT CHANGED IN 2.5 (STAGE 7)
- Added Platt scaling and isotonic calibration with a chronological
  walk-forward gate: calibration is enabled only when it improves out-of-sample
  log loss, with paired bootstrap uncertainty and BH correction.
- Added reliability tables, ECE/MCE and the Brier reliability/resolution/
  uncertainty decomposition.
- Added adaptive model weights for market, Dixon-Coles, empirical and team
  models. Weights are learned walk-forward and shrunk toward equal weights.
  A weight vector is enabled only when it beats the equal ensemble after paired
  correction and a minimum sample floor.
- Added an approximate Wilson uncertainty interval to every evaluated
  selection. The ledger records pLow, pHigh, effective n and a narrow /
  moderate / wide label.
- Ledger version is now `stage7-calibrated-v1`. It records weighted and
  calibrated probability arrays when a validated calibrator/weight vector is
  supplied, and metrics are settled for those series too.
- Added `lib/calibration.js`, `lib/weights.js`, `research/calibration.cjs` and a
  Calibration tab with reliability, decomposition, decisions and weights.
- On the current 104-match sample both calibration and adaptive weights are
  disabled: calibration changes log loss by -0.0021 (p = 0.46) and the weight
  gate has too few component models / test selections. The equal ensemble
  remains the production model.
- Every ledger decision is still deliberately NO BET; final value thresholds
  and staking are Stage 9.

WHAT CHANGED IN 2.6 (STAGE 8)
- Added `lib/learn.js`, an autonomous learning pipeline that:
  - refreshes only after enough new matches and a minimum interval;
  - reuses the Stage 7 calibration and weight gates;
  - stores every candidate, including rejected states, in IndexedDB;
  - activates a passing state by pointer swap;
  - supports immediate rollback to any stored candidate or the equal ensemble;
  - writes an append-only learning audit log.
- The background service worker now runs an hourly learning alarm and applies
  the active calibrator/weight vector to ledger capture. If no state is active,
  the Stage 5 equal ensemble is used.
- Added a Learning tab showing the active model, refresh policy, stored states,
  activation controls, rollback and audit history.
- Candidate states now include a specialist re-evaluation when calibration
  activates, comparing the sequence/pattern specialists against the calibrated
  ensemble.
- All automatic activation still requires the Stage 7 gates. The default policy
  waits for at least 40 new matches, 6 hours and 500 selections; the current
  104-match sample therefore does not auto-activate anything.
- Added 5 learning tests plus a chronological specialist-calibration test.
  Suite is now 63 tests.

WHAT CHANGED IN 2.7 (STAGE 9)
- Added `lib/decision.js`: a lower-confidence-bound value rule with
  market-specific minimum edges, odds/probability bands, wide-uncertainty
  blocking and fractional-Kelly staking. Stakes are capped and reduced for
  uncertainty.
- Added a chronological policy evaluator: threshold variants are chosen on an
  earlier window and scored on a later holdout. A policy is activated only with
  enough holdout bets, positive flat ROI and a positive bootstrap lower bound.
- Added `lib/accumulator.js`: target-odds search using lower-bound joint
  probability, one leg per fixture by default, and a correlation penalty when
  multiple legs from one fixture are explicitly allowed.
- Ledger rows now record decision, selected selection, lower-bound edge, stake
  units and policy version. Settlement records bet outcome and profit units.
- Added a Decision tab with policy evidence, staking rules, variants and an
  accumulator builder for the open round.
- Added `research/decision.cjs` and 5 decision/accumulator tests. Suite is now
  68 tests.
- On the current 104-match sample no policy passes: the holdout produces zero
  qualifying bets. Every ledger decision therefore remains NO BET.

WHAT CHANGED IN 2.8 (STAGE 10)
- Added `lib/performance.js`: consolidated decision, bankroll, ROI, exposure,
  drawdown, model-leaderboard, calibration and CLV reporting from the immutable
  ledger.
- Added an Intelligence tab with data health, active learning components, model
  performance, bankroll/exposure, recent BET rows, CLV and stored-policy
  activation/rollback in one view.
- Added `research/final.cjs`, which combines the model, calibration, weight,
  specialist and decision gates plus optional ledger performance into
  `final-YYYY-MM-DD.json/.md`.
- Added 3 performance tests. Suite is now 71 tests.
- The final report on the current 104-match sample recommends NO BET: no gate
  activated and the decision holdout had zero qualifying bets.

WHAT CHANGED IN 2.9 (REMOTE ACCESS)
- Added `lib/cloud.js`: builds a compact read-only snapshot and uploads it to a
  Netlify Function with a separate write token.
- Added the Settings "Cloud sync for phone" controls: endpoint, token, interval,
  enable/disable and Sync now.
- Added Netlify Functions for snapshot upload/download, PIN login, session check
  and logout, using Netlify Blobs.
- Added `/remote`: a PIN-protected, mobile-first page showing the latest
  snapshot, active model, current decisions, bankroll/ROI/CLV and a slip builder
  fed by the snapshot odds.
- The phone view is read-only: no activation, settings changes or bets.
- Added 5 tests for snapshot building/upload and PIN/session helpers. Suite is
  now 76 tests.
- Full setup is in `NETLIFY.md`.

IMPORTANT
- Bet9ja's League Plus feed only shows the round that is about to start and the
  one that just finished. There is NO history to download, so the engine records
  every round itself (Premier/Championship, Liga, Serie A and Sonic).
- Rounds are about 6 minutes in the main games and about 3.5 minutes in Sonic;
  each match lasts 60 seconds. Keep Chrome open (it can be minimised).
- Live probing found that the round odds were identical across the full betting
  window and the completed-round payload carried the same prices. The engine
  still stores snapshots and will report any movement it observes; it does not
  assume movement exists.
- Make a backup now and then: Settings -> "Export full backup (JSON.gz)".

THE TABS
- Overview      : what has been recorded, data-quality status, countdowns and tables.
- Next round    : every open match with Bet9ja's odds for any market, the engine's
                  chance and its edge. "Value picks" lists selections where the
                  engine thinks Bet9ja's price is too high.
- Slip builder  : type the total odds you want, tick leagues and markets, click
                  "Build my slip". It uses Bet9ja's REAL odds and can backtest.
- Value finder  : checks on recorded rounds which markets / odds ranges made or
                  lost money.
- Results       : every recorded result with goal minutes; click a match to see
                  which bets won and which catalogue version settled it.
- Tables & teams: Bet9ja's league tables plus attack/defence ratings.
- Data quality  : schema, frozen catalogue, capture schedule, quality issues,
                  conflicts, full audit, backup/import/export.
- Ledger        : immutable predictions, checkpoints, settlement status and
                  per-model Brier/log-loss on settled rows.
- Research      : H1-H8 statistical investigations, conditional patterns and
                  information-theory diagnostics on recorded matches.
- Specialists   : sequence/pattern specialists with automatic enable/disable
                  decisions and discovered-rule evidence.
- Calibration   : walk-forward calibration, reliability diagrams, Brier
                  decomposition and adaptive model weights.
- Learning      : autonomous refresh, active model state, stored candidates,
                  activation, rollback and audit history.
- Decision      : lower-bound value policy, staking, holdout evidence and the
                  accumulator optimiser.
- Intelligence  : consolidated data health, active components, model and
                  bankroll performance, exposure, CLV and policy rollback.
- Settings      : team-rating half-life, backup and CSV export.

RESEARCH COLLECTOR (optional, for backtesting)
The extension is self-contained. If you also want a continuous research dataset
that can be used for a chronological backtest, run:

    node research/collect.cjs

It writes raw and parsed JSONL under research/data/. See research/README.md.
No npm packages are needed.

    node research/report.cjs

This writes a reproducible JSON + Markdown research report under
research/reports/. Use --backup=path to analyse an extension backup instead of
the collector directory. Reports clearly mark insufficient samples.

    node research/models.cjs --min-train-rounds=2 --max-test-rounds=20

This writes a chronological model comparison (`models-YYYY-MM-DD.json/.md`)
under research/reports/. It compares historical frequencies, market fair odds,
market Poisson, team, Dixon-Coles, empirical and the equal ensemble. Small
samples are explicitly marked provisional.

    node research/specialists.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99

This writes `specialists-YYYY-MM-DD.json/.md`, including the sequence and
pattern enable/disable decisions, model metrics and discovered rules.

    node research/calibration.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99

This writes `calibration-YYYY-MM-DD.json/.md`, including the calibration
decision, reliability table, Brier decomposition, adaptive weights and the
paired comparisons against the raw/equal baselines.

    node research/decision.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99

This writes `decision-YYYY-MM-DD.json/.md`, including the chronological policy
holdout, lower-bound edge thresholds, staking rules and the accumulator limits.

    node research/final.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99

This writes `final-YYYY-MM-DD.json/.md`, combining all model, calibration,
weight, specialist and decision gates. Add `--backup="path"` to include ledger
bankroll, ROI, exposure, drawdown and CLV from an extension backup.

TESTS
    node --test tests/core.test.js tests/db.test.js tests/sync.test.js tests/ledger.test.js tests/stats.test.js tests/research.test.js tests/models.test.js tests/modelEval.test.js tests/specialists.test.js tests/calibration.test.js tests/learn.test.js tests/decision.test.js tests/performance.test.js tests/cloud.test.js tests/auth.test.js

The suite covers catalogue completeness, settlement edge cases (including 4:4
Goal Up and incomplete timelines), probability normalisation, fair-odds
structure, immutable writes, conflict logging, migration, backup/restore,
idempotent capture, partial rounds, round-gap detection, immutable ledger
recording/settlement, statistical primitives, synthetic research scenarios,
Dixon-Coles/empirical/margin methods, chronological model evaluation with
leakage checks, specialist enable/disable behaviour, calibration gating,
reliability/decomposition, Wilson uncertainty, adaptive-weight shrinkage,
learning activation/rollback, applying the active state to ledger capture,
lower-bound decision gating, fractional-Kelly staking, accumulator correlation
limits, ledger bankroll/ROI/drawdown/CLV aggregation, cloud snapshot
building/upload and PIN/session helpers.

HONEST NOTE
League Plus is a computer-generated game and Bet9ja keeps a margin on every
price (about 6.5% on 1X2, GG/NG and over/under; about 19% on correct score).
No engine can guarantee wins. Trust only what the Value finder and backtests
show to work over hundreds of recorded picks, and stake responsibly.
