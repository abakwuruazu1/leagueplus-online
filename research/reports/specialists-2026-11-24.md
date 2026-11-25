# League Plus Specialist Evaluation

- Generated: 2026-11-24T15:03:56.580Z
- Engine: stage6-specialists-v1
- Source: collector (1 parsed files)
- Matches: 104 · rounds: 8 · test matches: 52
- Minimum training rounds: 3 · min competition matches: 10 · min pattern support: 20

## Warnings
- Small specialist sample (52 matches); enable/disable decisions are provisional.
- Sequence model disabled: it did not beat the Stage 5 ensemble after paired correction or had insufficient usable state.
- Pattern model disabled: no validated rules or no out-of-sample improvement over the Stage 5 ensemble.

## Decisions

| Specialist | Enabled | Reason | n | Log-loss difference vs Stage 5 | 95% interval | p | q |
|---|---|---|---:|---:|---|---:|---:|
| Sequence | disabled | no validated incremental gain | 52 | 0.1041 | [-0.0337, 0.2343] | 0.1200 | 0.1200 |
| Patterns | disabled | no validated rules | 0 | – | – | – | – |

A disabled specialist is not part of the ensemble, ledger or decision path. Discovery is not activation.

## Model metrics

| Model | Selections | Brier | Log loss |
|---|---:|---:|---:|
| stage5 | 156 | 0.5411 | 0.8032 |
| market | 156 | 0.5411 | 0.8033 |
| sequence | 156 | 0.5580 | 0.8309 |

## Pattern rules

- Discovered rules: 105
- Validated rules: 0

| Rule | n | Baseline | Observed | Difference | 95% CI | p | q | OOS same direction | Status |
|---|---:|---:|---:|---:|---|---:|---:|---|---|
| homeForm=none → 1X2=H | 27 | 0.5000 | 0.4444 | -0.0556 | [0.2759, 0.6269] | 0.5637 | 1.0000 | no | not_supported |
| homeOver=none → 1X2=H | 27 | 0.5000 | 0.4444 | -0.0556 | [0.2759, 0.6269] | 0.5637 | 1.0000 | no | not_supported |
| prevTotal=none & homeForm=none → 1X2=H | 27 | 0.5000 | 0.4444 | -0.0556 | [0.2759, 0.6269] | 0.5637 | 1.0000 | no | not_supported |
| prevTotal=none & homeOver=none → 1X2=H | 27 | 0.5000 | 0.4444 | -0.0556 | [0.2759, 0.6269] | 0.5637 | 1.0000 | no | not_supported |
| homeForm=none & homeOver=none → 1X2=H | 27 | 0.5000 | 0.4444 | -0.0556 | [0.2759, 0.6269] | 0.5637 | 1.0000 | no | not_supported |
| homeForm=none & awayForm=none → BTTS=GG | 26 | 0.3333 | 0.3846 | 0.0513 | [0.2243, 0.5747] | 0.5791 | 1.0000 | yes | not_supported |
| homeForm=none & awayOver=none → BTTS=GG | 26 | 0.3333 | 0.3846 | 0.0513 | [0.2243, 0.5747] | 0.5791 | 1.0000 | yes | not_supported |
| awayForm=none & homeOver=none → BTTS=GG | 26 | 0.3333 | 0.3846 | 0.0513 | [0.2243, 0.5747] | 0.5791 | 1.0000 | yes | not_supported |
| homeOver=none & awayOver=none → BTTS=GG | 26 | 0.3333 | 0.3846 | 0.0513 | [0.2243, 0.5747] | 0.5791 | 1.0000 | yes | not_supported |
| homeForm=none & awayForm=none → BTTS=NG | 26 | 0.6667 | 0.6154 | -0.0513 | [0.4253, 0.7757] | 0.5791 | 1.0000 | yes | not_supported |
| homeForm=none & awayOver=none → BTTS=NG | 26 | 0.6667 | 0.6154 | -0.0513 | [0.4253, 0.7757] | 0.5791 | 1.0000 | yes | not_supported |
| awayForm=none & homeOver=none → BTTS=NG | 26 | 0.6667 | 0.6154 | -0.0513 | [0.4253, 0.7757] | 0.5791 | 1.0000 | yes | not_supported |
| homeOver=none & awayOver=none → BTTS=NG | 26 | 0.6667 | 0.6154 | -0.0513 | [0.4253, 0.7757] | 0.5791 | 1.0000 | yes | not_supported |
| homeForm=none & awayForm=none → 1X2=H | 26 | 0.5000 | 0.4615 | -0.0385 | [0.2876, 0.6454] | 0.6949 | 1.0000 | no | not_supported |
| homeForm=none & awayOver=none → 1X2=H | 26 | 0.5000 | 0.4615 | -0.0385 | [0.2876, 0.6454] | 0.6949 | 1.0000 | no | not_supported |
| awayForm=none & homeOver=none → 1X2=H | 26 | 0.5000 | 0.4615 | -0.0385 | [0.2876, 0.6454] | 0.6949 | 1.0000 | no | not_supported |
| homeOver=none & awayOver=none → 1X2=H | 26 | 0.5000 | 0.4615 | -0.0385 | [0.2876, 0.6454] | 0.6949 | 1.0000 | no | not_supported |
| homeForm=none → 1X2=A | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeOver=none → 1X2=A | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| prevTotal=none & homeForm=none → 1X2=A | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| prevTotal=none & homeOver=none → 1X2=A | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeForm=none & homeOver=none → 1X2=A | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeForm=none → BTTS=GG | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeOver=none → BTTS=GG | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| prevTotal=none & homeForm=none → BTTS=GG | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| prevTotal=none & homeOver=none → BTTS=GG | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeForm=none & homeOver=none → BTTS=GG | 27 | 0.3333 | 0.3704 | 0.0370 | [0.2153, 0.5577] | 0.6831 | 1.0000 | no | not_supported |
| homeForm=none → BTTS=NG | 27 | 0.6667 | 0.6296 | -0.0370 | [0.4423, 0.7847] | 0.6831 | 1.0000 | no | not_supported |
| homeOver=none → BTTS=NG | 27 | 0.6667 | 0.6296 | -0.0370 | [0.4423, 0.7847] | 0.6831 | 1.0000 | no | not_supported |
| prevTotal=none & homeForm=none → BTTS=NG | 27 | 0.6667 | 0.6296 | -0.0370 | [0.4423, 0.7847] | 0.6831 | 1.0000 | no | not_supported |

## Leakage checks

- Checks: 5
- Failures: 0

## Interpretation limits

- Specialists are disabled unless they improve paired out-of-sample loss after multiple-testing correction.
- The pattern seed is discovered once on the initial training window; its own temporal split is used for rule validation.
- This is not a betting strategy. The market margin, calibration and final decision thresholds are separate later stages.
- A small sample makes the enable/disable decision provisional.