# League Plus Calibration & Adaptive Weights

- Generated: 2026-11-24T16:32:57.886Z
- Engine: stage7-calibration-v1 / stage7-weights-v1
- Source: collector (1 parsed files)
- Matches: 104 · rounds: 8 · test fixtures: 52
- Walk-forward selections: 364 · calibration test selections: 140
- Minimum training rounds: 3 · minimum competition matches: 10 · permutations: 99 · seed: 20261124

## Warnings
- Small evaluation sample (4 test rounds, 52 matches); treat model differences as provisional.
- No calibration method improved out-of-sample log loss after paired correction; calibration is disabled.
- Calibration test sample is small (140 selections); the decision is provisional.
- Fewer than two component models were available in the weight-training windows; adaptive weights cannot differ from the available model.
- Every adaptive-weight fit was insufficient; the equal ensemble remains in use.
- No adaptive weight vector beat the equal ensemble out-of-sample after paired correction; adaptive weights are disabled.
- Adaptive-weight test sample is small (140 selections); the decision is provisional.

## Decisions

| Component | Status | Method | n | Difference vs raw/equal | 95% interval | p | q |
|---|---|---|---:|---:|---|---:|---:|
| Calibration | disabled | – | 140 | -0.0021 | [-0.0091, 0.0053] | 0.4600 | 0.4600 |
| Adaptive weights | disabled | not fitted (insufficient components) | 140 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 |

A disabled component is not applied. Negative differences mean the component improved log loss; activation also requires p < 0.05, q < 0.10 and enough test selections.

## Calibration metrics

| Series | n | Brier | Log loss | Uncertainty | Reliability | Resolution | ECE | MCE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw | 140 | 0.2327 | 0.6577 | 0.2449 | 0.0071 | 0.0207 | 0.0679 | 0.2742 |

| Method | n | Brier | Log loss | Difference | 95% interval | p | q |
|---|---:|---:|---:|---:|---|---:|---:|
| platt | 140 | 0.2319 | 0.6556 | -0.0021 | [-0.0091, 0.0053] | 0.4600 | 0.4600 |
| isotonic | 140 | 0.2395 | 0.8522 | 0.1945 | [0.0006, 0.5826] | 0.0800 | 0.1600 |

## Reliability

| Bin | Raw n | Raw predicted | Raw observed | Cal n | Cal predicted | Cal observed |
|---|---:|---:|---:|---:|---:|---:|
| 0–10% | 1 | 9.4% | 0.0% | – | – | – |
| 10–20% | 10 | 16.2% | 30.0% | – | – | – |
| 20–30% | 24 | 24.3% | 25.0% | – | – | – |
| 30–40% | 13 | 36.7% | 23.1% | – | – | – |
| 40–50% | 40 | 45.9% | 52.5% | – | – | – |
| 50–60% | 40 | 54.0% | 50.0% | – | – | – |
| 60–70% | 10 | 63.0% | 50.0% | – | – | – |
| 70–80% | 2 | 72.6% | 100.0% | – | – | – |
| 80–90% | 0 | – | – | – | – | – |
| 90–100% | 0 | – | – | – | – | – |

## Adaptive weights

No adaptive weight vector was activated.

| Series | n | Brier | Log loss |
|---|---:|---:|---:|
| equal | 140 | 0.2327 | 0.6577 |
| market | 140 | 0.2325 | 0.6573 |
| global | 140 | 0.2327 | 0.6577 |
| perMarket | 140 | 0.2327 | 0.6577 |
| market Poisson (single) | 140 | 0.2327 | 0.6577 |
| Dixon-Coles (single) | 0 | – | – |
| empirical/Bayesian (single) | 0 | – | – |
| team ratings (single) | 0 | – | – |

| Weighting | n | Difference vs equal | 95% interval | p | q |
|---|---:|---:|---|---:|---:|
| global | 140 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 |
| perMarket | 140 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 |

| Market | n | Difference | 95% interval | p | q | Status |
|---|---:|---:|---|---:|---:|---|
| 1X2 | 60 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 | disabled |
| OU2.5 | 40 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 | disabled |
| BTTS | 40 | 0.0000 | [0.0000, 0.0000] | 1.0000 | 1.0000 | disabled |

## Leakage checks

- Training windows checked: 5
- Failures: 0

## Interpretation limits

- The calibration and weight samples are selections, not independent matches. Selections from the same fixture are correlated, so the bootstrap intervals are optimistic.
- Activation is deliberately conservative: no component is applied unless it improves out-of-sample loss after paired correction and sample gates.
- A calibration map corrects the average probability scale; it does not create an edge over the bookmaker.
- Calibration targets the equal ensemble. It is not jointly re-fitted on the adaptive-weight output; the series are reported separately.
- The Wilson interval in the ledger is an approximate effective-sample interval, not a formal guarantee.
- The final value thresholds, staking and accumulator optimisation are Stage 9.