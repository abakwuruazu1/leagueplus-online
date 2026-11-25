# Research collector

This optional tool collects a continuous, chronological dataset for backtests
and model research. It is **not** required by the Chrome extension; the
extension records its own history in IndexedDB.

## Run

```bash
node research/collect.cjs
node research/collect.cjs --once
node research/collect.cjs --games=3,4,6,7
```

No npm packages are required. Stop with Ctrl+C; state is written after each
pass and the tool resumes safely.

## What it writes

`research/data/`

| File | Contents |
|---|---|
| `init.json` | latest `/game/init` response (market definitions) |
| `state.json` | per-game last result/upcoming round, next due time and betting windows |
| `raw-YYYY-MM-DD.jsonl` | raw `/game/{id}/round` responses |
| `parsed-YYYY-MM-DD.jsonl` | parsed results, upcoming fixtures, invalid rows and selection sets |

Each parsed line contains the result round and the upcoming round from the same
API response. For a backtest, the **upcoming** record is the pre-match snapshot
for a future round; the later **results** record supplies its outcome. This
avoids using a completed-round price retrospectively unless it is explicitly
labelled.

The collector schedules itself from the same round-aware function as the
extension: result time and a closing-price check, with a fallback.

## Notes

- The API only exposes the last finished and upcoming round. The collector must
  run at least once per round to avoid gaps.
- Raw data is intentionally kept; parsing rules can be re-run later. Expect
  roughly 100–300 MB/day of raw JSONL depending on round cadence and the number
  of games. Compress or archive old days if disk space matters.
- `parsed` records have `catalogueVersion: null`; build the catalogue from
  `init.json` when analysing them. The extension, by contrast, freezes and
  versions the catalogue for every round.
- Do not treat collector data as live-extension predictions. It is a research
  dataset; the live prediction ledger is the authoritative record for
  no-hindsight evaluation.

## Generate a report

```bash
node research/report.cjs
node research/report.cjs --min-matches=30 --min-rounds=10 --min-teams=4 --permutations=99
node research/report.cjs --backup="C:\path\leagueplus-backup.json"
```

Reports are written to `research/reports/research-YYYY-MM-DD.json` and `.md`.
They contain H1–H8, test detail, conditional-probability patterns, information
theory and explicit sample-size warnings. `supported` requires a raw p < 0.05,
BH q < 0.10, an effect threshold and, where applicable, a consistent
out-of-sample direction; otherwise findings stay `exploratory` or
`insufficient`.

The report analyses observed structure, not profitability. H6, for example,
tests whether margin-adjusted market probabilities carry information beyond
historical frequencies; it does not prove a positive edge after the bookmaker's
margin.

## Model comparison report

```bash
node research/models.cjs --min-train-rounds=2 --min-comp-matches=10 --max-test-rounds=20
```

This is a chronological walk-forward comparison of historical frequencies,
market fair odds, market Poisson, team ratings, Dixon-Coles, empirical/Bayesian
and the equal ensemble. It writes `models-YYYY-MM-DD.json/.md` under
`research/reports/`. It reports per-market Brier/log loss, paired 1X2 differences
against the market, multiple-testing-adjusted q-values and explicit leakage
checks. A model difference is provisional until the sample is large enough and
the market margin/value thresholds are applied in later stages.

## Specialist evaluation report

```bash
node research/specialists.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
```

This compares the Stage 6 sequence and pattern specialists with the Stage 5
equal ensemble and market fair odds on a chronological walk-forward split. It
writes `specialists-YYYY-MM-DD.json/.md` under `research/reports/`.

The decision is automatic and conservative. A specialist is enabled only if its
paired 1X2 log-loss difference is negative, p < 0.05, BH q < 0.10 and it has
enough usable observations. Pattern rules must additionally survive their own
temporal hold-out. Discovery is not activation: disabled specialists are
excluded from the ensemble, ledger and decision path.

A small sample normally disables both specialists, which is the correct
outcome. On the current 104-match sample the sequence model was significantly
worse than the Stage 5 ensemble and no pattern rule validated, so both are
disabled.

## Calibration and adaptive-weight report

```bash
node research/calibration.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
```

This writes `calibration-YYYY-MM-DD.json/.md` under `research/reports/`.

It regenerates model probabilities chronologically, then fits Platt/isotonic
calibrators and adaptive model weights only on earlier selections. The report
contains:

- reliability bins, ECE/MCE and Brier decomposition;
- calibration activation decisions with paired bootstrap intervals and BH q;
- active and unshrunk weights for market/Dixon-Coles/empirical/team models;
- global and per-market weight comparisons;
- explicit warnings when fewer than two component models are available.

On the current sample calibration and adaptive weights are disabled. The equal
ensemble remains the production model.

## Decision and staking report

```bash
node research/decision.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
```

This writes `decision-YYYY-MM-DD.json/.md` under `research/reports/`.

It applies a lower-confidence-bound value rule to the out-of-sample selections,
chooses a threshold on an earlier window and scores it on a later holdout. A
policy is activated only with enough holdout bets, positive flat ROI and a
positive bootstrap lower bound. The report includes:

- market-specific lower-bound edge thresholds;
- fractional-Kelly staking rules and caps;
- policy variants with train/holdout bets and ROI;
- explicit warnings when no policy qualifies.

On the current 104-match sample the holdout produces zero qualifying bets, so no
policy is active and decisions remain NO BET.

## Final consolidated report

```bash
node research/final.cjs --min-train-rounds=3 --min-comp-matches=10 --permutations=99
node research/final.cjs --backup="C:\path\leagueplus-backup.json"
```

This writes `final-YYYY-MM-DD.json/.md` under `research/reports/`.

It combines the model leaderboard, calibration gate, adaptive-weight gate,
specialist gates, decision-policy holdout and — with `--backup` — ledger
bankroll, ROI, exposure, drawdown and closing-line value. The final verdict
explicitly reports NO BET when no policy passed.
