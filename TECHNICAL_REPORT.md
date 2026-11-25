# League Plus Engine — Stages 2–11 Technical Report

**Version:** 2.9.0  
**Scope:** data integrity, immutable history, frozen market catalogue, odds provenance, data-quality auditing, round-aware capture, migration and backup v2; immutable prediction ledger; statistical research (H1–H8); upgraded Dixon-Coles, empirical/Bayesian, adaptive team and market models; chronological model evaluation; gated sequence and pattern specialists; probability calibration, adaptive model weights and approximate uncertainty intervals; a persisted autonomous learning, activation, rollback and audit pipeline; lower-bound value decisions, fractional-Kelly staking, accumulator correlation limits, consolidated bankroll/CLV intelligence; and a read-only, PIN-protected phone snapshot hosted separately on Netlify.  
**Status:** implemented and covered by a 76-test Node suite; live API, dashboard and public/remote Netlify pages smoke-tested, including Chrome DevTools Protocol runs of the Learning, Decision and Intelligence tabs.

This report does not claim predictive performance. Stage 2 builds the data foundation that later research and modelling stages depend on.

---

## 1. Why Stage 2 came first

The original extension recorded the last-finished and upcoming rounds correctly for a short run, but it had no protection against:

- a re-capture or import overwriting a historical result;
- historical settlement changing when Bet9ja changed a market definition;
- partial rounds, missing scores or incomplete goal timelines being used as if valid;
- round IDs colliding across games;
- an old backup clobbering the current betting window or catalogue;
- 30-second polling of every game, which is unnecessary and can still miss rounds when Chrome is suspended.

Those are data-integrity problems. No amount of modelling can repair them after the fact, so they were fixed before the prediction ledger and models.

---

## 2. Live API observations used in the design

A read-only probe of the live API on 2026-11-24 established:

| Observation | Detail |
|---|---|
| Games | `3` Premier/Championship, `4` Liga, `6` Serie A, `7` Sonic |
| Cadence | about 6 minutes for games 3/4/6; about 3.5 minutes for game 7 |
| Match duration | 60 seconds (`liveRoundDuration`) |
| Betting window | `round.startDate` → `round.endDate`; `noBetDate` is 1 second before `endDate`; `liveStartDate` of the result equals the close |
| Round IDs | per game, not global (e.g. game 3 `441470`, game 4 `441469`) |
| Selections | 143 definitions across 15 markets; 125 selections per match in the sampled rounds |
| Odds movement | 14 consecutive 30-second samples over a full 6-minute window were identical; completed-round odds matched the pre-close snapshot for game 3 and game 7 |
| Margins | about 6.2–6.8% on 1X2, GG/NG and O/U; about 18.8% on correct score |
| Market consistency | a Poisson fit to 1X2/O-U/BTTS had RMSE about `0.003`; market 15 (Goal Up) overlap probabilities matched the fitted model |

The engine still records opening/closing/result snapshots and will report movement if it ever appears. It does **not** assume movement exists.

---

## 3. Database schema v3

IndexedDB `leaguePlusDB` is upgraded from v1 to v3. Existing `matches` and `meta` data is preserved; new stores are additive.

| Store | Key | Purpose |
|---|---|---|
| `meta` | `key` | init, current catalogue pointer, selection sets, standings, per-game sync checkpoints |
| `matches` | `key` | immutable finished matches and odds |
| `rounds` | `key` (`game:roundId`) | timetable, competitions, seasons, weeks, expected/captured counts, quality |
| `catalogues` | `version` | frozen market definitions and hash |
| `snapshots` | `key` | append-only odds observations with phase/hash/provenance |
| `predictions` | `predictionId` | immutable pre-match ledger rows (Stage 3) |
| `settlements` | `predictionId` | immutable ledger settlement rows (Stage 3) |
| `modelStates` | `version` | reserved for versioned model parameters (later stages) |
| `modelPerf` | `key` | reserved for rolling out-of-sample performance |
| `patterns` | `id` | reserved for validated/exploratory patterns |
| `learningLog` | auto id | reserved for the learning pipeline |
| `jobs` | `id` | resumable background jobs |
| `aggregates` | `key` | reserved for dashboard-scale aggregates |
| `conflicts` | auto id | immutable-write conflicts |
| `qualityLog` | `key` | grouped data-quality issues |

Indexes were added for the query paths the dashboard and future backtests need: competition, game, round, season, week, fixture, timestamp, status, model version, market and quality status.

### Immutability rules

- `matches`, `snapshots`, `catalogues`, `predictions`, `settlements`, `modelStates` and `patterns` are add-only.
- An identical content hash is skipped.
- A different content hash keeps the original row and writes a conflict record with both hashes and timestamps.
- Round rows are metadata: they may be updated, but `status` cannot move backwards (`finished` cannot become `open`), and existing betting windows/catalogue versions are preserved.
- Odds snapshots are deduplicated by hash; repeated observations increment an observation counter without changing the historical odds.

---

## 4. Frozen catalogue and settlement

`LPCat.buildMap(init)` turns the current `/game/init` response into a catalogue map. A deterministic hash of the market definitions produces a version such as `cat-07f2f6b6efd9`; the full definitions are stored once in `catalogues`.

Every match and round stores the catalogue version active at capture. Historical settlement uses `catFor(match)` and therefore the frozen definition, not today's market list.

Settlement fixes in this stage:

- Market 15 `X - 1UP` now correctly wins on **any** draw, including 4:4 and 5:5.
- Goal Up settlement returns `null` when the goal timeline is incomplete (`tlOk === false`) instead of guessing.
- Unknown market definitions return `null` instead of falling back to `alwaysWin`.
- Markets without explicit winning-score definitions fall through to semantic settlement; they are not silently paid from an incomplete score universe.
- The score matrix is normalised over a 13×13 grid, so derived markets sum correctly.
- Fair-odds handling distinguishes exclusive, pair, overlapping and singleton markets; overlapping markets (Multigoal, Goal Up) are flagged rather than forced to sum to 1.

---

## 5. Round-aware capture

The v1 background worker polled every game every 30 seconds. v2 uses one alarm per game:

- at the expected result time (`liveEndDate + 25s`), and
- at a closing-price check (`betClose - 65s`).

The earlier of the two future times is scheduled. A 10-minute fallback alarm recovers from suspended service workers, browser restarts or missed one-shots. The old v1 `lpSync` alarm is cleared on startup.

Each capture writes, in one transaction:

1. the result round and its matches;
2. the upcoming round and its fixtures;
3. odds snapshots for both;
4. selection sets, standings and sync checkpoints;
5. quality issues.

The operation is idempotent: running the same response twice adds nothing and creates no conflicts.

---

## 6. Data-quality rules

`LPQuality` records grouped issues with severity, count, first/last timestamp and a small sample.

Critical (`invalid`):

- unparseable team names;
- missing/invalid scores;
- invalid timestamps;
- missing odds;
- odds/selection length mismatch;
- missing catalogue version;
- round mismatch;
- duplicate fixture.

Warnings (`warn`):

- incomplete/invalid goal timeline;
- no available odds (all `0.0`);
- missing season/week;
- legacy records;
- unknown selection;
- partial round;
- round gap;
- missing betting times.

Invalid records are stored (so the evidence is not lost) but are intended to be excluded from training. Stage 3 will enforce that filter in the prediction ledger.

---

## 7. Migration and backup

### Migration

`LPDB.ready()` runs an idempotent, resumable migration:

- derives `game`, `fixtureId`, `roundKey`, live/bet timestamps and catalogue version for v1 matches;
- computes a canonical content hash;
- validates each match;
- creates missing round rows without overwriting live-captured rounds;
- records progress in `meta:migration:v3`.

Only metadata is added. Scores, goals and odds are not changed.

### Backup v2

`LPBackup.exportAll()` includes all stores except transient `up:`/`sync:` metadata. The dashboard writes a gzipped `.json.gz` when `CompressionStream` is available.

`LPBackup.importAll()`:

- rejects newer schemas;
- uses immutable merge for matches/snapshots/catalogues/predictions/settlements/model states/patterns;
- merges quality issues by key;
- imports `init`, `cat:current` and standings only when the backup is newer;
- keeps the local round record when it is newer;
- returns counts of added, skipped and conflicted rows.

---

## 8. Verification performed

### Automated

```
node --test tests/core.test.js tests/db.test.js tests/sync.test.js tests/ledger.test.js tests/stats.test.js tests/research.test.js tests/models.test.js tests/modelEval.test.js tests/specialists.test.js tests/calibration.test.js tests/learn.test.js tests/decision.test.js tests/performance.test.js tests/cloud.test.js tests/auth.test.js
```

76 tests pass, covering:

- 143-selection catalogue completeness;
- exclusive/pair market audits;
- Goal Up 4:4 and incomplete-timeline settlement;
- correct score / O/U / unknown-market settlement;
- fair-odds normalisation, pair groups, overlaps, singletons and incomplete correct-score partitions;
- normalised score matrices and derived-market sums;
- market-fit quality reporting;
- parsing counts and provenance;
- match/round quality flags;
- immutable add/skip/conflict behaviour;
- atomic round commit idempotence;
- v1 migration;
- backup/restore, including transient metadata filtering, newer-catalogue protection and the v1 backup shape;
- live-response sync idempotence;
- changed-result conflict logging;
- partial-round detection;
- round-gap detection;
- future-only scheduling;
- immutable open/pre-close ledger rows;
- ledger idempotence and no settlement before a result;
- settlement outcomes and per-model Brier/log-loss metrics;
- ledger training-cutoff exclusion of future results;
- statistical primitives (entropy, MI, chi-square, Kruskal-Wallis, permutation, bootstrap, BH, CUSUM);
- structured synthetic research data recovering H1/H2/H3/H6 and an insufficient-sample run returning no claims;
- Dixon-Coles matrix/tau normalisation, margin methods, empirical normalisation/window selection, season-aware ratings and model exposure;
- chronological model evaluation with leakage checks and a too-short-history guard;
- sequence-model conditional scoring states with a clean fallback;
- pattern discovery support/CI/FDR reporting without unsupported validation claims;
- specialist walk-forward comparison, automatic disablement and leakage checks;
- Platt and isotonic calibration with monotonicity and bounded output;
- reliability bins, ECE/MCE and Brier decomposition;
- walk-forward calibration gating, including a tiny-sample refusal;
- Wilson uncertainty intervals with the expected width behaviour;
- adaptive-weight fitting, shrinkage toward equal and chronological gating;
- weighted/calibrated/uncertainty fields in the probability engine;
- learning config bounds, rejected-state persistence and audit logging;
- autonomous refresh, gate-respecting activation and immediate rollback;
- applying the active learned state through the real `LPSync.syncGame` ledger path;
- specialist re-evaluation against a calibrated ensemble when calibration activates;
- lower-bound edge gating, odds bands, wide-uncertainty blocking and stake caps;
- chronological decision-policy holdout activation;
- accumulator target search, lower-bound joint probability and same-fixture rejection;
- recording and settling a policy BET with stake and profit units;
- ledger bankroll, ROI, exposure, drawdown, model-leaderboard and CLV aggregation;
- explicit unevaluable warnings when no BET rows exist;
- compact cloud snapshot construction and token-authenticated upload/throttling;
- PIN hashing, signed sessions, cookie flags and tamper rejection.

### Live smoke tests

- `LPSync.syncGame(3)` against the live API stored 22 matches, 2 rounds, 44 snapshots, 1 catalogue and 0 conflicts.
- `node research/collect.cjs --once` fetched all four games and wrote raw + parsed data.
- The dashboard was loaded in Chromium with a seeded database: Overview, Next round, Results, Tables, Slip builder, Value finder, Data quality, Ledger, Research, Specialists, Calibration and Settings rendered with no console errors.
- The full audit action revalidated 22 matches and reported 0 invalid / 0 warnings.
- A seeded ledger produced 44 predictions (open + pre-close), 44 settlements, 100% settlement coverage and finite per-model Brier/log-loss metrics.
- A live `LPSync.syncGame(3)` with the ledger enabled recorded 22 pre-close/mid predictions and 0 conflicts.
- A seeded dashboard Research tab ran H1–H8 on 44 matches and correctly returned `insufficient` for every hypothesis, with no console errors.
- `research/report.cjs` generated a JSON and Markdown report from the 104-match collector sample; H6 and one market-confidence H8 stratum were supported, while H1–H5 and H7 were insufficient or unsupported — exactly the honest small-sample outcome.
- `research/models.cjs` generated a chronological model report on the 104-match sample with deliberately low thresholds; only 4 test rounds / 52 matches were evaluable, so the leaderboard is explicitly provisional. Team/DC/empirical models lacked sufficient per-competition history.
- `research/specialists.cjs` generated the Stage 6 report on the same sample. On 52 test matches the sequence model was worse than the Stage 5 ensemble (difference +0.1041 log loss, 95% interval crossing zero) and the pattern model produced no validated rules (0 of 105). Both were therefore disabled automatically, which is the honest outcome for this sample.
- `research/calibration.cjs` generated the Stage 7 report on the same sample: 364 selection observations, 140 walk-forward calibration test selections. Platt scaling changed log loss by -0.0021 (p = 0.46), so calibration was disabled. Adaptive weights were disabled because fewer than two component models were available in the training windows and the 140-selection sample was below the 200-selection activation floor. The equal ensemble remains in use.
- The Calibration tab was loaded in Chromium and run on the seeded two-round database. It correctly reported insufficient evidence, rendered the decision and reliability sections, and produced no console errors. The Ledger tab rendered the new weighted/calibrated and Wilson-interval columns.
- Stage 8 learning was validated with Node integration tests against a fake IndexedDB: refresh -> gate -> state persistence -> activation -> rollback, backup/restore, plus `LPSync.syncGame` applying an active calibrator/weight state to real ledger rows.
- The Learning tab was smoke-tested through the Chrome DevTools Protocol against a local dashboard with a seeded active state. It rendered the active model, refresh policy, stored states and audit section with no console errors.
- `research/decision.cjs` generated the Stage 9 report on the 104-match sample: 364 selections, 140 holdout selections, zero qualifying bets and no active policy. The ledger therefore remains NO BET.
- The Decision tab was smoke-tested through the Chrome DevTools Protocol with a seeded active policy: it rendered the policy thresholds, staking rules, holdout metrics and accumulator controls with no JavaScript errors.
- `research/final.cjs` generated the consolidated final report on the 104-match sample: all model/calibration/weight/specialist/decision gates disabled and the final verdict was NO BET.
- The Intelligence tab was smoke-tested through the Chrome DevTools Protocol with a seeded active state; it rendered data health, active components, model leaderboard, bankroll/exposure, CLV and rollback controls with no JavaScript errors.
- The public Netlify slip builder was tested against the live Bet9ja round: 52 fixtures from 4 games, no console errors, and a 5-selection slip was built.
- The private `/remote` page was tested locally with a sample snapshot: 22 fixtures, PIN-session path, dashboard cards and a 5-selection slip built with no console errors.
- Cloud snapshot/upload tests and PIN/session helper tests pass.

The Chrome build available in this environment no longer supports `--load-extension` (Chrome removed that command-line switch for branded builds), so the final unpacked-extension install must be done through `chrome://extensions` as described in `README.txt`. The manifest and service-worker entry point are valid, and the data layer was exercised in Node with the same scripts.

---

## 9. Stage 3: immutable prediction ledger

### Purpose

Stage 3 records what the engine believed **before** the outcome, so later calibration and model selection cannot use hindsight. The ledger is intentionally separate from the result store.

### Ledger row

`LPLedger.recordFixtures()` writes one row per fixture/checkpoint/model/odds-hash to the `predictions` store. Each row contains:

- `predictionId`, `fixtureId`, `roundKey`, `game`, `comp`, season/week, teams;
- `asOf`, `betOpen`, `betClose`, `checkpoint` (`open`, `mid`, `preclose`);
- `modelVersion` (version at capture; `stage5-models-v1` in the Stage 5 sample, now `stage7-calibrated-v1`), `ensembleVersion`, `calibrationVersion`;
- frozen `catalogueVersion`, selection hash and odds hash;
- arrays: `ids`, `odds`, `implied`, `fair`, `mkt`, `team`, `blend`, `ensemble`, `plow`, `phigh`, `ev`, `edgeVsFair`;
- uncalibrated model-range confidence method/class, `pCalibrated` (null);
- `decision` = `NO_BET`, `selectedId` = null, reason;
- candidate selection (highest lower-bound probability), its probability and lower-bound EV;
- training cutoff, training sample count and half-life;
- settlement status, content hash and creation timestamp.

Rows are append-only. The same fixture/checkpoint/odds hash is skipped; different content for the same key is recorded as a conflict rather than overwriting.

### Checkpoints

- `open`: capture close to the betting-window opening.
- `mid`: first capture when opening was missed and the fixture is not yet near close. It is not labelled "opening" unless it really was.
- `preclose`: capture around 65 seconds before the close.
- `asOf < betClose` is enforced. A row is never written after the match starts.

### No-leakage rules

- Upcoming features use only matches with `ts < asOf`.
- The training cutoff is stored and tested to be earlier than the prediction time.
- The prediction uses the frozen catalogue active at capture.
- Settlement is a separate row written after the result; predictions are never updated.
- A future synthetic match inserted for testing is excluded from the training sample.

### Baseline ensemble and decision

Stage 3 records the existing engines rather than pretending to have a calibrated intelligence layer:

- `fair`: margin-adjusted Bet9ja odds;
- `mkt`: Poisson model fitted to Bet9ja's main markets;
- `team`: independent time-decayed team ratings when enough evidence exists;
- `blend`: mean of `mkt` and `team`, falling back to `mkt`;
- `ensemble`: the same transparent baseline;
- `plow`/`phigh`: the range of `mkt`/`team`, explicitly uncalibrated;
- `pCalibrated`: null.

Every decision is **NO BET** because a calibrated probability and a validated lower confidence bound are not yet available. This is intentional, not a hidden claim.

### Settlement

`LPLedger.settleRound()` is called for the result round during capture. `LPLedger.settleAll()` is available in the dashboard. Each settlement row contains:

- the result score and goals;
- a tri-state outcome for every selection (`1` win, `0` lose, `null` unsettleable);
- per-model `n`, wins, Brier, log loss and average probability;
- model/catalogue version, candidate, decision and a content hash;
- `settlementStatus: 'settled'`.

Settlement is idempotent and refuses predictions that were recorded at or after the close. Invalid-quality matches, missing catalogues and missing results are counted and skipped rather than silently mixed into metrics.

### Integration

- `background.js` loads `lib/model.js` and `lib/ledger.js` and configures `LPSync` with the ledger.
- `LPSync.syncGame()` records upcoming predictions after the atomic round commit and settles the result round.
- The dashboard loads `lib/ledger.js`, adds a **Ledger** tab, and offers manual record/settle actions.
- Backup v2 already includes the `predictions` and `settlements` stores, so ledger rows survive export/import.

### Stage 3 tests

Six additional tests cover open-row recording, checkpoint idempotence, no settlement before results, settlement metrics and outcomes, coverage statistics, and exclusion of future results from training.

---

## 10. Stage 4: statistical research laboratory

### Purpose

Stage 4 tests the data-generating process before fitting specialised models. It does not assume that League Plus behaves like ordinary football, and it does not treat a discovered pattern as a prediction rule without correction and out-of-sample evidence.

### `lib/stats.js`

Pure statistical primitives used by both the dashboard and the report:

- descriptive statistics, quantiles, normal/chi-square approximations;
- Wilson intervals, entropy and bias-corrected mutual information;
- chi-square contingency tests, Cramér's V and Kruskal-Wallis;
- runs test, autocorrelation, partial autocorrelation and Ljung-Box;
- Pearson correlation and correlation permutation tests;
- mean-difference permutation tests, bootstrap intervals and paired bootstrap differences;
- Benjamini-Hochberg q-values;
- CUSUM, CUSUM permutation, Page-Hinkley and KL divergence;
- Brier and log-loss scoring.

All randomisation is seeded for reproducibility.

### `lib/research.js`

`LPResearch.analyze()` tests:

| ID | Question | Primary method |
|---|---|---|
| H1 | Serial information in historical results | Ljung-Box and lag-1 autocorrelation of round totals |
| H2 | Persistent team identity | Split-half attack/defence correlation with permutation p |
| H3 | Competition differences | Kruskal-Wallis on goals; chi-square on outcomes |
| H4 | Round sequence patterns | Transition chi-square plus bias-corrected mutual information |
| H5 | Time-varying scoring | CUSUM permutation and Page-Hinkley; before/after KL |
| H6 | Market information beyond scores | Walk-forward historical base rate vs margin-adjusted market probabilities, paired Brier bootstrap |
| H7 | History + market combination | Chronological 60/40 split; weight chosen on train, evaluated on test |
| H8 | Conditional predictability | Market-confidence strata; market vs base Brier |

Every test reports `n`, effect, uncertainty where available, raw p, BH q and a status. `supported` requires p < 0.05, q < 0.10, an effect threshold and, where applicable, a consistent out-of-sample direction. Otherwise the status is `exploratory`, `not_supported` or `insufficient`.

### Conditional-probability discovery

Round transitions are analysed for:

- previous total-goal category → next total-goal category;
- previous outcome → next outcome.

Each reported pattern includes support, baseline rate, observed rate, Wilson interval, raw p, BH q and an out-of-sample direction on the last 40% of rounds. A pattern is only `validated` when it has enough support, q < 0.10 and the out-of-sample direction agrees. Otherwise it remains exploratory or unsupported.

### Information theory

The report and dashboard show outcome entropy, total-goal entropy, round-transition mutual information, conditional entropy and a permutation null p-value. This distinguishes genuine dependence from the expected mutual information of a finite sample.

### Report and dashboard

- `research/report.cjs` reads collector JSONL or an extension backup and writes JSON + Markdown under `research/reports/`.
- The dashboard **Research** tab runs the tests on the most recent 2,000 matches and displays hypothesis status, test detail, conditional patterns and information diagnostics.
- The UI warns explicitly that these are statistical investigations, not betting instructions.

### Honest small-sample result

On the current 104-match collector sample:

- H6 was supported: margin-adjusted market probabilities had lower Brier loss than a walk-forward historical frequency baseline;
- H8 was supported descriptively in a market-confidence stratum;
- H1, H2, H3, H4, H5 and H7 were insufficient or not supported.

That is the intended behaviour. It does **not** imply a positive betting edge after margin; H6 only shows that the market carries information beyond the historical base rate. Calibration, confidence bounds and value thresholds are later stages.

### Stage 4 tests

Eight statistical-primitive tests and two research tests cover the mathematics, a structured synthetic dataset with known serial/team/competition/market effects, and a tiny sample that must return `insufficient` rather than a false claim.

---

## 11. Stage 5: upgraded probability models

### Dixon-Coles / adaptive team ratings

`fitTeams()` now:

- filters to matches strictly before the reference time;
- supports `seasonMode: all | current | auto`, with the current season used only when it has enough matches;
- supports hour-based or round-based exponential decay;
- fits attack/defence by weighted iterative proportional fitting with a prior;
- returns per-team sample counts, effective weight, reliability and approximate uncertainty;
- excludes invalid-quality records.

`fitDC()` adds Dixon-Coles low-score dependence. The rho parameter is fitted by weighted likelihood on the four low-score cells, with the score matrix normalised after applying tau. The model exposes rho and the likelihood for diagnostics.

### Empirical / Bayesian score distribution

`fitEmpirical()` builds a 13×13 home/away score matrix:

- raw counts from the selected history;
- a Poisson prior derived from the selected competition means;
- Dirichlet-style smoothing with a configurable prior strength;
- normalisation over the retained grid.

When no window is supplied, `selectEmpiricalWindow()` performs an **inner chronological split**: candidate windows (100, 250, 500, 1000, 2000) are fitted on the earlier part and compared by 1X2 log loss on the later part. The chosen window is recorded. The default is not assumed to be 10/20/50.

### Market intelligence

`fair()` supports:

- proportional margin removal;
- power margin removal (solve the exponent so exclusive groups sum to 1 and pair groups sum to 2);
- additive margin removal;
- singleton and overlapping-market flags.

`fitMarket()` fits a Poisson score model to 1X2, GG/NG, main O/U lines, home/away O/U and selected combined markets.

### Ensemble

The Stage 5 ensemble is deliberately transparent:

`equal mean of available mkt / DC / empirical / team probabilities`.

The market probability itself remains a separate model. There are no adaptive weights yet; those are Stage 7.

### Chronological evaluation harness

`lib/modelEval.js` runs an expanding-window, round-by-round comparison:

- train only on matches strictly before the test round;
- compare historical base frequency, market fair odds, market Poisson, team, Dixon-Coles, empirical, blend and equal ensemble;
- score 1X2, O/U 2.5 and BTTS with Brier/log loss;
- pair 1X2 losses against the market and bootstrap the difference;
- apply BH correction across model comparisons;
- record training-cutoff leakage checks.

`research/models.cjs` writes the JSON + Markdown report.

### Current Stage 5 sample

On the 104-match collector sample, with deliberately low thresholds
(`min-train-rounds=2`, `min-comp-matches=10`), only four test rounds and 52 matches were evaluable. The report’s leaderboard was:

- market Poisson `0.8032`
- blend `0.8032`
- equal ensemble `0.8032`
- market fair `0.8033`
- historical base `0.8268`

Team/DC/empirical models were not evaluable because each competition had only two recorded rounds (10–24 matches). The report marks the sample as **provisional**. This is not evidence of a betting edge; the differences are tiny and the market margin is not removed in the betting simulation.

### Ledger and dashboard integration

- At Stage 5, `LPLedger` version became `stage5-models-v1`; Stage 7 supersedes it with `stage7-calibrated-v1`.
- Ledger rows include `dc` and `emp` arrays alongside fair/mkt/team/blend/ensemble.
- Settlement computes per-model Brier/log loss for all recorded models.
- Dashboard engine selectors expose market, fair, team, Dixon-Coles, empirical, blend and equal ensemble.
- Value finder and slip backtests use the upgraded fitting path while preserving no-leakage training cutoffs.

### Stage 5 tests

Six model tests cover DC matrix normalisation, tau, margin methods, empirical normalisation/window selection, seasonal filtering, uncertainty fields and model exposure. Two model-evaluation tests cover chronological evaluation, leakage checks, all-model exposure and the too-short-history guard.

---

## 12. Stage 6: sequence and pattern specialists

### Purpose and gate

Stage 6 adds two deliberately narrow specialists. Neither is assumed to work: each must beat the Stage 5 equal ensemble on paired out-of-sample 1X2 log loss, with bootstrap uncertainty and Benjamini–Hochberg correction, before it may enter the ensemble, ledger or decision path. Discovery is not activation.

### Sequence model (`lib/sequence.js`)

- Groups settled matches into rounds per competition.
- Classifies each round by mean goals per match (`low ≤ 2.2`, `mid ≤ 3.2`, `high`).
- Learns the next round's mean total conditional on the previous round's class.
- Shrinks sparse cells toward the competition mean with a configurable prior strength.
- Scales the competition home/away means by the predicted total and prices the market selections from that adjusted Poisson level.
- Falls back explicitly to the league scoring level when the conditional cell is too sparse.
- Exposes the cell counts, chosen class, fallback reason and `usable` flag.

This is a low-dimensional transition model on purpose. A per-team or per-fixture sequence model would have far too little data in the current API and would overfit immediately.

### Pattern model (`lib/patterns.js`)

- Builds chronological rows from pre-match features: competition, market-favourite bucket, previous-round scoring class, last-five form and last-five over-rate for both teams.
- Enumerates single features and pairs.
- For every target (1X2, O/U 2.5, BTTS) and class, reports support, baseline rate, observed rate, difference, lift, Wilson interval, two-sided p, BH q and an internal temporal hold-out direction.
- Classifies rules as `validated`, `exploratory`, `not_supported` or `insufficient`.
- `predict()` does nothing unless at least one rule is validated, and even then applies a support- and effect-size-limited adjustment.

A rule requires `p < 0.05`, `q < 0.10`, an absolute difference of at least 5 percentage points, the same direction in the temporal hold-out, and at least twice the minimum support. These are deliberately strict because the rule search space is large.

### Specialist evaluator (`lib/specialists.js`)

- Expanding-window walk-forward from the initial training rounds.
- Trains sequence and pattern state strictly before each test round.
- Compares Stage 5 ensemble, market fair, sequence and pattern on 1X2, O/U 2.5 and BTTS.
- Pairs 1X2 losses and bootstraps the mean difference versus the Stage 5 ensemble.
- Applies BH correction across the two specialist comparisons.
- Records training-cutoff leakage checks.
- Sets `sequence.enabled` / `patterns.enabled` only when the corrected evidence is positive.
- Reports disabled specialists explicitly; they never silently enter the model.

### Current Stage 6 sample

`research/specialists.cjs` produced, on the 104-match collector sample:

- test matches: 52;
- sequence: disabled, difference **+0.1041** log loss versus Stage 5 (worse), 95% interval `[-0.0337, +0.2343]`, p = 0.12, q = 0.12;
- patterns: disabled, **0 validated** rules out of 105 discovered.

The sequence model was worse on this sample but the interval still crosses zero, so there is no evidence of incremental value. The pattern search found no rule that survived the out-of-sample gate. Both are therefore excluded from production. This is a valid and useful negative result: it prevents a plausible-looking but unsupported model from influencing bets.

### Dashboard

The new **Specialists** tab shows the automatic decisions, paired differences with intervals and q-values, per-model metrics, the top discovered rules with support/CI/FDR/OOS direction, and leakage-check status. It runs synchronously on the most recent 2,000 matches.

### Stage 6 tests

Three tests cover the conditional sequence states and fallback, pattern support/CI/FDR reporting without false validation, and the specialist evaluator's chronology, leakage checks and automatic disablement.

---

## 13. Stage 7: calibration, adaptive weights and uncertainty

### Design rule

Stage 7 does not assume that calibration or learned weights help. Each component has a chronological walk-forward gate. A component is enabled only if it reduces out-of-sample log loss, its paired bootstrap interval excludes no improvement, its BH-adjusted q is below 0.10, and it has at least 200 test selections. Otherwise it is explicitly disabled and the equal Stage 5 ensemble remains the production model.

### Calibration (`lib/calibration.js`)

- **Platt scaling** fits `q = sigmoid(a * logit(p) + b)` by regularised gradient descent, initialised at the identity map.
- **Isotonic regression** uses pool-adjacent-violators with a minimum block size and enforces a monotone map.
- **Reliability reports** include fixed-width bins, predicted versus observed rates, ECE, MCE, Brier score and the Brier decomposition into uncertainty, reliability and resolution.
- **Walk-forward gate** groups observations by round, trains on earlier rounds, tests on later blocks, pools out-of-sample predictions, pairs selection-level log losses and applies a paired bootstrap plus BH correction.
- A calibrator is returned for production only when the gate passes. The final map is then fitted on all available observations.

### Adaptive weights (`lib/weights.js`)

- Models: market Poisson, Dixon-Coles, empirical/Bayesian and team ratings.
- Weights are non-negative and fitted by projected gradient descent on selection-level log loss.
- A component model is active only when it has at least 20 observations.
- Learned weights are shrunk toward equal weights (`shrink = 0.5` by default), so the result is not a brittle unconstrained fit.
- The evaluator expands chronologically, refits weights on prior out-of-sample selections, and compares global and per-market weight vectors with the equal ensemble.
- Global activation requires a negative paired difference, p < 0.05, q < 0.10, at least 200 test selections and at least two active component models. Per-market activation has its own BH-corrected gate.

### Uncertainty

Every evaluated selection now carries:

- `pLow` and `pHigh` from a Wilson interval;
- `nEff`, the effective evidence size (weakest team sample, training count or market fit);
- `uncertaintyClass` (`narrow`, `moderate`, `wide`);
- `modelLow` and `modelHigh`, the model-member range.

The interval is explicitly approximate. It treats the model probability as a proportion with `nEff` effective observations; selections from the same fixture are correlated, so it must not be read as a formal coverage guarantee. It is recorded in the ledger and used to choose the candidate with the highest lower bound, but it does not place a bet.

### Ledger integration

- Ledger version is `stage7-calibrated-v1` and the CI method is `wilson-effective-n-approx-v1`.
- Rows record `weighted`, `calibrated`, `pLow`, `pHigh`, `nEff`, `uncertainty`, `weightedVersion` and `calibrationVersion`.
- Settlement computes metrics for `weighted` and `calibrated` alongside the Stage 5 models.
- When no validated calibrator/weight vector is supplied, the `calibrated`/`weighted` arrays contain null entries and `pCalibrated` is null. This prevents an uncalibrated equal ensemble from being displayed as if it had been calibrated.
- Every decision remains `NO_BET` until the Stage 9 value and staking rules exist.

### Dashboard and report

The **Calibration** tab shows the activation decisions, calibration method metrics, reliability table, Brier decomposition, active and unshrunk weights, paired comparisons and per-market weight decisions. `research/calibration.cjs` produces the same evidence in JSON + Markdown.

### Current Stage 7 sample

On the 104-match collector sample:

- 364 walk-forward selection observations; 140 calibration test selections.
- Platt: -0.0021 log loss, 95% interval `[-0.0091, +0.0053]`, p = q = 0.46 → **disabled**.
- Isotonic: +0.1945 log loss → worse.
- Adaptive weights: fewer than two component models were available in the training windows, and 140 test selections are below the 200-selection floor → **disabled**.

The equal ensemble remains the production model. This is the intended honest outcome for a sample this small.

### Stage 7 tests

Seven calibration/weight tests plus a model-integration test and a ledger active-series test cover Platt improvement, isotonic monotonicity, reliability/decomposition, walk-forward gating, Wilson intervals, weight shrinkage, chronological weight evaluation and recording weighted/calibrated arrays only when supplied.

---

## 14. Stage 8: autonomous learning and activation

### Purpose

Stage 8 turns the Stage 7 research components into a persisted runtime pipeline without weakening the gates. It answers four operational questions:

1. When should the engine retrain?
2. Where is the learned state stored?
3. Which state is allowed to affect live predictions?
4. How can an operator inspect, roll back or disable it?

### Refresh policy

`lib/learn.js` uses a meta configuration (`learn:config`) with these defaults:

- enabled: true;
- auto-activate candidates that pass the gate: true;
- minimum new matches: 40;
- minimum interval: 6 hours;
- minimum selections: 500;
- minimum training selections: 200;
- minimum test selections: 100;
- minimum training rounds: 3;
- minimum competition matches: 10;
- maximum test rounds: 20;
- maximum matches loaded: 3,000;
- permutations: 199;
- weight shrinkage: 0.5;
- re-evaluate specialists when calibration activates: true.

A refresh is skipped when:

- learning is disabled;
- the minimum interval has not elapsed;
- fewer than the configured minimum matches are recorded;
- the latest stored state was trained on the same match count and last timestamp.

`learn:lastAttempt` records the last attempt separately, so a failed fit does not cause a tight retry loop.

### Stored state

Each run creates a new `modelStates` row with:

- a unique `learn-<timestamp>-<hash>` version;
- status `candidate` or `rejected`;
- training counts and first/last timestamps;
- the full calibrated state (Platt coefficients or isotonic knots);
- the adaptive weight vector and raw/unshrunk weights;
- calibration/weight metrics, reliability and warnings;
- a specialist re-evaluation summary when calibration activated;
- a content hash.

Rejected states are stored rather than discarded. This preserves the evidence that the engine considered a model and refused to activate it. State rows are written with `putImmutable`, so a version cannot be silently overwritten.

### Activation and rollback

The active state is a pointer in `meta` (`learn:active`). Activation never mutates a model state and never rewrites history:

- `activate(version)` checks that the state exists and is not rejected;
- the pointer is swapped and a `learningLog` event records `from`, `to`, reason and actor;
- `rollback(version|null)` restores an older candidate or the equal ensemble;
- the previous pointer is retained in the event and in the active row.

`learningLog` is append-only by convention and records config changes, skips, rejects, candidate creation, activation, deactivation and rollback. The dashboard Learning tab reads the same state.

### Applying the active model

`LPSync.syncGame()` asks `LPLearn.activeOpts()` for the current state before calling `LPLedger.recordFixtures()`:

- if calibration is active, `pCalibrated`, the calibrated array and the calibration version are applied;
- if weights are active, the weighted array and weight version are applied;
- uncertainty fields are always computed;
- if no state is active, the Stage 5 equal ensemble remains in use.

The background service worker creates an hourly `lpLearn` alarm with a five-minute initial delay. It also exposes messages for manual refresh, config changes, activation and rollback. All heavy fitting stays outside the round-capture path; capture reads only the current pointer.

### Specialist re-evaluation

When a candidate calibration passes its gate and the policy allows it, the pipeline re-evaluates the Stage 6 sequence/pattern specialists against a calibrated ensemble. The specialist evaluator now accepts `calibrationSamples`; for each test round it fits a calibrator only on earlier selections and applies it to the Stage 5/specialist probability vectors. This avoids using the final calibrator on its own training outcomes.

No specialist is activated by this re-evaluation; it only updates the evidence stored with the model state.

### Current sample

The default 500-selection and 40-match minimums mean the current 104-match sample produces a rejected state (364 selections) rather than an active model. A forced run would still be gated: on the current data calibration is disabled and adaptive weights lack two active component models. The equal ensemble therefore remains active. The pipeline is deliberately capable of storing a rejected state and leaving production unchanged.

### Storage and backup

`modelStates` is exported/imported with content-hash protection. `learningLog` is included in the backup/export order. A backup therefore contains both the active pointer and the historical states needed for rollback.

### Stage 8 tests

Five learning tests cover:

- config bounds and audit logging;
- insufficient-sample rejection without activation;
- refresh -> candidate -> auto-activation -> active options -> rollback;
- backup/restore of model states and the audit log;
- `LPSync.syncGame` applying an active calibration/weight state to real ledger rows.

An additional specialist test verifies that calibration samples are fitted only on earlier selections per test round and that the comparison uses the calibrated Stage 5 label.

---

## 15. Stage 9: uncertainty-aware decisions and staking

### Decision rule

Stage 9 replaces the informal "value" comparison with a lower-confidence-bound rule:

- a selection is eligible only when `pLow × odds − 1` clears a market-specific threshold;
- the point estimate must also be non-negative;
- odds and probabilities must stay inside configured bands;
- wide uncertainty can be blocked explicitly;
- no selection is eligible unless the required minimum stake is positive.

Default thresholds are 3.0% for 1X2, 2.5% for O/U 2.5 and 2.5% for BTTS, with a 4.0% default for other markets. These are starting policies, not claims of edge.

### Staking

Stake size is fractional Kelly using the lower bound:

```
kelly = (pLow × odds − 1) / (odds − 1)
stake = kellyFraction × kelly × uncertaintyMultiplier
```

with `kellyFraction = 0.25`, a 2-unit cap and uncertainty multipliers of 1.0 / 0.75 / 0.5 for narrow / moderate / wide intervals. The minimum recorded stake is 0.01 units. This is conservative by construction; it is not a bankroll guarantee.

### Walk-forward policy gate

`LPDecision.walkForward()`:

1. groups selections by fixture so at most one bet is taken per fixture;
2. splits rounds chronologically into train and holdout groups;
3. evaluates threshold variants on the earlier window and chooses one;
4. scores that policy on the later holdout;
5. bootstraps the holdout per-bet returns;
6. enables the policy only when:
   - holdout bets ≥ 100;
   - train ROI > 0;
   - holdout ROI > 0;
   - the 95% bootstrap lower bound of holdout ROI is positive.

The policy is disabled otherwise. Variant selection on the train window is still a source of selection bias; the holdout is the main protection.

### Accumulator optimiser

`lib/accumulator.js` searches combinations for a target total odds:

- uses lower-bound probabilities for the joint estimate;
- maximises lower-bound joint probability among slips reaching the target;
- defaults to one leg per fixture;
- applies a configurable correlation penalty (0.85) if multiple legs from one fixture are allowed;
- requires positive lower-bound EV and a minimum joint probability;
- returns an explicit `NO_BET` when no combination qualifies.

The correlation penalty is a heuristic, not a joint score model.

### Ledger integration

`LPLedger.recordFixtures()` accepts a validated `policy`:

- applies `LPDecision.evaluateFixture()` to the priced selections;
- records `decision`, `selectedId`, `stakeUnits`, `edgeLow`, `edgePoint`, selected market/uncertainty and policy version;
- keeps `NO_BET` when no policy is active or no selection passes;
- settlement records `bet` with odds, stake, won/lost and profit units.

The Stage 8 learning state can include a validated decision policy; `activeOpts()` passes it to the background ledger path.

### Current Stage 9 sample

On the 104-match collector sample:

- 364 walk-forward selections;
- 140 holdout selections;
- **zero** qualifying bets at every tested threshold;
- no policy passed the holdout gate.

Every ledger decision therefore remains **NO BET**. This is the expected outcome for efficient prices and a small sample.

### Stage 9 tests

Five decision/accumulator tests cover lower-bound gating, odds/uncertainty/stake caps, fixture selection, chronological policy activation, accumulator target search and same-fixture rejection, plus ledger recording and settlement of a BET.

---

## 16. Stage 10: consolidated intelligence and final report

### Consolidated performance — `lib/performance.js`

The performance layer reads the immutable ledger and produces:

- prediction/settlement counts and coverage;
- per-model Brier/log-loss leaderboard;
- per-model reliability/ECE from recorded predictions and outcomes;
- settled BET counts, wins, stake, profit, ROI and flat ROI;
- bankroll path with configurable start and unit value;
- maximum drawdown in units and percent;
- exposure by market, competition, checkpoint and policy version;
- closing-line value by matching open/candidate rows with pre-close rows for the same selection.

These are descriptive statistics. A positive ROI on a small ledger is not evidence of an edge, and the report says so.

### Intelligence tab

The dashboard now has one consolidated view:

- data health and settlement coverage;
- active calibration, weight, decision and specialist components;
- ledger model leaderboard;
- bankroll, ROI, exposure and drawdown;
- recent BET rows with settlement profit;
- closing-line value;
- stored policy history with activation and rollback controls.

The tab loads up to 1,500 recent ledger rows and refreshes on demand.

### Final walk-forward report — `research/final.cjs`

The final report runs every gate on the same sample:

1. chronological model evaluation;
2. calibration walk-forward;
3. adaptive-weight walk-forward;
4. decision-policy holdout;
5. specialist re-evaluation;
6. optional ledger performance when `--backup=` is supplied.

It writes `final-YYYY-MM-DD.json/.md` with a final verdict. The verdict explicitly names the active learned state, whether a decision policy passed, and whether the ledger verdict is NO BET.

### Current Stage 10 sample

On the 104-match collector sample:

- models evaluated: 5;
- calibration, adaptive weights, decision policy, sequence specialist and pattern specialist: all disabled;
- final verdict: **NO BET**;
- no ledger predictions were included in the collector-only run, so bankroll/CLV sections are explicitly marked unavailable.

A backup run adds live ledger performance; the same small-sample warnings still apply.

### Stage 10 tests

Three performance tests cover bet/ROI/bankroll/drawdown/exposure aggregation, open-versus-pre-close CLV and the explicit no-bets warning.

---

## 17. Stage 11: remote phone access through Netlify

### Purpose

The extension runs on a PC and owns the IndexedDB history. Stage 11 adds a
read-only, phone-friendly view while keeping the PC as the only writer.

It is not a hosted extension. Netlify cannot call into Chrome. The extension
pushes a compact snapshot to a Netlify Function; the phone reads that snapshot
after a PIN login.

### Snapshot contract — `lib/cloud.js`

The snapshot includes only what the phone needs:

- raw market catalogue definitions;
- current fixtures and their selection sets;
- active calibration/weight/decision/specialist summary;
- recent compact ledger rows;
- performance summary (bankroll, ROI, exposure, drawdown, CLV, model leaderboard);
- data counts and warnings.

It deliberately excludes:

- full IndexedDB history;
- full prediction probability arrays;
- the write token;
- the PIN;
- the calibrator knots/coefficients.

The upload uses `POST` with an `x-lp-token` header and is throttled by the
configured interval. Failed uploads are recorded in `cloud:status` and retried
on later captures.

### Netlify Functions

| Function | Purpose |
|---|---|
| `snapshot.js` | Token-authenticated upload; session-authenticated download |
| `login.js` | PIN login and signed HttpOnly session cookie |
| `session.js` | Session check |
| `logout.js` | Clear cookie |

Netlify Blobs stores the latest snapshot and a small metadata row. The snapshot
is rejected unless `schema === 1`, `source === 'leagueplus-extension'` and it
is a valid JSON fixture list under the size cap.

### PIN and secrets

- `LP_WRITE_TOKEN` — extension-only write secret.
- `LP_SESSION_SECRET` — signs the phone session.
- `LP_PIN` or `LP_PIN_HASH` — phone login.
- Five failed attempts trigger a 15-minute per-IP lockout.
- Cookies are HttpOnly, SameSite=Lax and Secure outside localhost.

The write token is never exposed in the static site. Backup export excludes
`cloud:config`, so the token is not copied into a downloadable backup.

### Remote page

`/remote` is a mobile-first page that:

- checks the session;
- loads the latest snapshot;
- shows its age and an offline warning;
- shows active components, current decisions, bankroll and leaderboard;
- mounts the existing slip builder against the snapshot odds;
- supports copy-slip and manual refresh;
- has no activation, settings or bet controls.

### Current behaviour

No remote snapshot exists in the repository, because snapshots are produced by
the extension on the user's PC. The public slip builder can be tested against
the live Bet9ja round; the private page requires a configured Netlify site and
a successful extension upload.

### Stage 11 tests

Two cloud tests cover compact snapshot construction and token-authenticated
upload/throttling. Three auth tests cover PIN/token checks, signed sessions and
cookie flags.

---

## 18. Known limitations

- The API exposes only the last finished and upcoming round. If Chrome is closed for more than one round, the missed rounds cannot be recovered. The engine records a gap warning.
- Opening odds are normally captured 25–85 seconds after the betting window opens, not at the exact opening millisecond. The engine records the capture timestamp and never labels an unverified price as "opening".
- On a fresh install, the first finished round may have no known `betOpen`; it is flagged `bet_times_missing`.
- Correct-score markets offer only 28 of the possible scorelines; the engine flags the incomplete partition rather than pretending it is a full distribution.
- Multigoal and Goal Up are overlapping markets; their fair probabilities do not sum to 1 and must not be evaluated as if they were exclusive.
- No odds movement was observed in the live probe. If movement exists in other periods or games, the snapshot system will record it; movement-based features are not yet built.
- Ledger probabilities are only calibrated when a walk-forward calibrator passes the Stage 7 gate and a learned state is active. On the current sample it does not, so the `calibrated` array contains null entries and `pCalibrated` is null. Stage 9 is implemented, but no decision policy passed its holdout, so every decision remains NO BET.
- The `pLow`/`pHigh` interval is an approximate Wilson band with an effective sample size, not a formal coverage guarantee. Selections from the same fixture are correlated.
- The ledger is append-only and can grow quickly (two or more rows per fixture). The dashboard loads a recent window; full aggregation is a later-stage job.
- Settlement metrics are per selection and per model. Reliability diagrams are produced by the Calibration tab and the calibration report, not by the ledger settlement table itself.
- Stage 4 research is observational. It tests structure, not causality, and does not produce a betting strategy.
- H6 tests whether the market carries information beyond historical frequencies; it does not remove the bookmaker's margin or prove positive expected value.
- The dashboard research run uses the most recent 2,000 matches synchronously. Full-history research and a dedicated worker are later-stage work.
- Stage 5 uses an equal-weight ensemble. Stage 7 implements adaptive weights and calibration, but both are disabled on the current sample, so production still uses equal weights.
- Dixon-Coles low-score dependence and empirical window selection are fitted on the available sample; their benefit must still be demonstrated on a larger walk-forward history.
- The current Stage 5 evaluation sample is too small to compare team/DC/empirical models fairly. The report marks it provisional.
- Bivariate Poisson and formal market-margin-method selection by walk-forward loss are not yet claimed as implemented.
- Stage 6 specialists are currently disabled on the available sample. The sequence model is a simple conditional scoring level, not a full Markov chain, and the pattern model is association-rule based rather than a shallow tree or gradient model.
- Pattern discovery is run once on the initial training window; later rounds only test whether the validated set improves predictions. This keeps runtime bounded but means rules and their feature context cannot adapt within a single evaluation run.
- A disabled specialist is not re-tested automatically per prediction. Re-evaluation is a manual/periodic dashboard action.
- The Stage 6 report is based on 52 test matches and is explicitly provisional; a larger history may change the enable/disable decision in either direction.
- Stage 7 calibration and weights are selection-level binary models, not a joint multi-class calibration. A 1X2 vector is calibrated selection by selection and then renormalised only when a vector helper is used.
- Calibration targets the equal ensemble; it is not jointly re-fitted on the adaptive-weight output. If both gates ever pass, the weighted and calibrated series are recorded separately.
- Calibration and weight bootstrap intervals treat selections as independent; selections from the same fixture are correlated, so the intervals are optimistic.
- The Stage 7 activation floor is 200 test selections. This is still modest; the report and dashboard mark it provisional below 500.
- The live background capture does not compute a calibrator on every alarm. Stage 8 now provides a persisted active state, but no state is active on the current sample, so the automatic path still uses the equal ensemble.
- Stage 8 learning runs in the extension service worker. A long fit can be interrupted if Chrome suspends the worker; the next hourly alarm retries, and the last completed state remains active.
- Auto-activation is enabled by default but still requires every Stage 7 gate. There is no push notification when a candidate is rejected or activated; the Learning tab and audit log are the source of truth.
- The specialist re-evaluation uses a calibrator fitted on the Stage 5 ensemble and applies it to specialist vectors. It is useful for comparing the calibrated baseline but is not a separately fitted calibration for each specialist.
- Stored states include calibration/weight metrics and reliability bins. The dashboard loads a bounded recent list; very long histories are not paginated.
- Stage 9 decision policies are evaluated on the Stage 5 equal-ensemble selection samples. If calibration or adaptive weights become active, the live lower bound can differ from the policy's training distribution; the policy should be re-evaluated under those transforms before merging them in production.
- The decision holdout chooses among a small set of threshold variants. This is a residual selection-bias risk even with the chronological holdout.
- The current sample produced zero qualifying bets, so the policy path is tested in code but not empirically validated on real positive-edge data.
- The accumulator correlation penalty is a simple fixture-level heuristic; it is not a joint score or copula model.
- Simulated bets assume the recorded price is available for the full stake, with no limits, line movement, account restrictions or settlement delays.
- Stage 9 does not place bets. A BET row only appears if a validated policy is activated through the learning state.
- Stage 10 performance uses up to 1,500 recent predictions and settlements in the dashboard; it is a recent-window view, not a full-history aggregation.
- Bankroll reporting assumes one stake unit equals a fixed currency value. It does not model compounding, currency conversion or account limits.
- CLV is matched only when both an open/candidate and a pre-close row exist for the same selection. The live probe found static odds, so CLV will normally be zero.
- Closing-line value is a price-movement diagnostic, not proof of predictive skill.
- The final report is a snapshot of the current sample. It must be regenerated as more rounds are collected.
- The phone view is only as fresh as the last extension upload. If the PC sleeps or Chrome closes, the phone shows stale data and the slip builder uses stale odds.
- The remote page is read-only. It cannot activate models, change thresholds, trigger a capture or place bets.
- PIN sessions protect the snapshot but the snapshot still contains fixtures, odds and recent ledger rows. Treat the PIN as sensitive.
- Netlify Blobs is the only cloud persistence. It stores one latest snapshot; it is not a full backup.
- A custom Netlify domain needs a matching `host_permissions` entry in the extension manifest.
- The public `/` slip builder and private `/remote` page use different data sources; the public page is a live market-implied builder, while `/remote` uses the extension snapshot.
- The remote slip builder has no online calibration or backtest.

---

## 19. Next: sustained validation

No further architectural stage is required for the current design. The remaining work is empirical:

1. keep the collector and extension running across a substantially larger number of rounds;
2. keep the PC awake and the cloud snapshot fresh enough for phone use;
3. regenerate `research/final.cjs` and compare the gates over time;
4. activate calibration, weights or a decision policy only if they pass repeatedly out-of-sample;
5. monitor bankroll, drawdown, exposure and CLV on the immutable ledger;
6. treat every positive result as provisional until the sample is large enough and the market margin has been overcome.
