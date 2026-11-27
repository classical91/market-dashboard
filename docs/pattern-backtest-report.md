# Pattern Scanner backtest

Generated 2026-11-27T15:02:07.307Z by `node scripts/pattern-backtest.js`. Evidence only: the live `DEFAULTS` in `src/services/pattern-scanner.js` are unchanged.

## Method

- **Data:** Binance spot klines (`data-api.binance.vision`), closed candles only. 10 symbols × 1h / 4h / 1D.
- **Walk-forward:** at every bar the detectors get the same 80 closed candles the live scanner would have had at that close, and nothing later. Pattern window 36, impulse window 20, pivot order 3, minR2 0.35.
- **Look-ahead checks:** 280,120 bar views were checked to end on the current bar with 80 ordered bars, and 65,924 divergence detections were checked to have a second pivot at least 3 bars old (fully confirmed). None failed. The unit tests also check that changing future bars never changes past events.
- **Events:** what `signal-bot.js` logs into the pattern tracker: a flag/wedge on the bar its close first crosses the trendline (`breakoutCrossed`), scored in the breakout direction; an RSI divergence the first time its second pivot is newer than the last one seen for that type.
- **Scoring:** same as `pattern-tracker.js`. Entry at the detection close; exit at the close 24h after (1h), 96h after (4h), 240h after (1D); hit ≥ +2%, miss ≤ −2% in the bias direction, otherwise flat. **Hit rate = hits / (hits + misses)**, as on the tracker page. MFE/MAE come from candle highs and lows over the horizon, signed in the bias direction.
- **Variants:** `default` is the live set (impulseMin 0.04, breakoutBuffer 0.002). ATR variants set impulseMin = k × ATR14% and/or breakoutBuffer = k × ATR14% at each bar; `fixed` keeps that one parameter at its live value. Divergence ignores both parameters, so it has no variants.
- **Out-of-sample:** each series is split by bar at 70%. The ATR variant is picked per timeframe (all symbols pooled) by the best in-sample average directional return with at least 30 in-sample events. In-sample events must also resolve before the split. All tables report the last 30% unless they say otherwise.
- **Caveats:** cells marked ⚠ have fewer than 30 samples and are **inconclusive**. Events close together share forward bars, so samples are not independent and the effective sample size is lower than `n`. No fees or slippage.

## Data coverage

| Symbol | TF | Bars | From | To | OOS from | Median ATR% | 4% impulse in ATRs | 0.2% buffer in ATRs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 0.58% | 6.9 | 0.35 |
| BTCUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 1.25% | 3.2 | 0.16 |
| BTCUSDT | 1D | 2920 | 2018-11-29 | 2026-11-26 | 2024-07-03 | 4.11% | 1.0 | 0.05 |
| ETHUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 0.89% | 4.5 | 0.23 |
| ETHUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 1.69% | 2.4 | 0.12 |
| ETHUSDT | 1D | 2920 | 2018-11-29 | 2026-11-26 | 2024-07-03 | 5.58% | 0.7 | 0.04 |
| SOLUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.05% | 3.8 | 0.19 |
| SOLUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 2.41% | 1.7 | 0.08 |
| SOLUSDT | 1D | 2299 | 2020-08-11 | 2026-11-26 | 2025-01-06 | 7.68% | 0.5 | 0.03 |
| XRPUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 0.96% | 4.2 | 0.21 |
| XRPUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 1.89% | 2.1 | 0.11 |
| XRPUSDT | 1D | 2920 | 2018-11-29 | 2026-11-26 | 2024-07-03 | 5.94% | 0.7 | 0.03 |
| DOGEUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.12% | 3.6 | 0.18 |
| DOGEUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 2.37% | 1.7 | 0.08 |
| DOGEUSDT | 1D | 2702 | 2019-07-05 | 2026-11-26 | 2024-09-07 | 6.92% | 0.6 | 0.03 |
| AVAXUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.18% | 3.4 | 0.17 |
| AVAXUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 2.47% | 1.6 | 0.08 |
| AVAXUSDT | 1D | 2257 | 2020-09-22 | 2026-11-26 | 2025-01-18 | 7.68% | 0.5 | 0.03 |
| LINKUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.17% | 3.4 | 0.17 |
| LINKUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 2.34% | 1.7 | 0.09 |
| LINKUSDT | 1D | 2872 | 2019-01-16 | 2026-11-26 | 2024-07-18 | 7.45% | 0.5 | 0.03 |
| INJUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.55% | 2.6 | 0.13 |
| INJUSDT | 4h | 8760 | 2022-11-28 | 2026-11-27 | 2025-09-15 | 3.37% | 1.2 | 0.06 |
| INJUSDT | 1D | 2228 | 2020-10-21 | 2026-11-26 | 2025-01-27 | 9.91% | 0.4 | 0.02 |
| WIFUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.73% | 2.3 | 0.12 |
| WIFUSDT | 4h | 5982 | 2024-03-05 | 2026-11-27 | 2026-02-01 | 4.00% | 1.0 | 0.05 |
| WIFUSDT | 1D | 997 | 2024-03-05 | 2026-11-26 | 2026-01-31 | 10.79% | 0.4 | 0.02 |
| PEPEUSDT | 1h | 17520 | 2024-11-27 | 2026-11-27 | 2026-04-22 | 1.59% | 2.5 | 0.13 |
| PEPEUSDT | 4h | 7811 | 2023-05-05 | 2026-11-27 | 2025-11-01 | 3.70% | 1.1 | 0.05 |
| PEPEUSDT | 1D | 1302 | 2023-05-05 | 2026-11-26 | 2025-11-01 | 9.80% | 0.4 | 0.02 |

A fixed threshold means a different thing on every row: the last two columns show the live impulseMin and breakoutBuffer in units of each series' median ATR.

## Headline: defaults vs tuned ATR variant (out-of-sample)

| TF | Set | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1h | default | 695 | 44.9% | 56% | -0.19% | 2.65% | -2.83% |
| 1h | tuned: atr imp=fixed buf=0.25x | 694 | 44.1% | 57% | -0.19% | 2.59% | -2.79% |
| 1h | baseline: long every bar | 52320 | 45.7% | 56% | -0.01% | 2.77% | -2.74% |
| 1h | divergence (all types) | 1610 | 52.1% | 52% | 0.04% | 2.86% | -2.88% |
| 4h | default | 360 | 41.0% | 30% | -1.22% | 5.58% | -6.36% |
| 4h | tuned: atr imp=6x buf=fixed | 286 | 40.5% | 30% | -1.20% | 5.75% | -6.22% |
| 4h | baseline: long every bar | 24923 | 41.0% | 29% | -0.69% | 5.78% | -6.38% |
| 4h | divergence (all types) | 894 | 50.0% | 30% | 0.12% | 6.08% | -5.91% |
| 1D | default | 144 | 52.0% | 15% | 0.34% | 11.03% | -9.65% |
| 1D | tuned: atr imp=fixed buf=0.25x | 139 | 52.5% | 14% | 0.52% | 10.93% | -8.91% |
| 1D | baseline: long every bar | 6932 | 44.9% | 15% | 0.08% | 10.69% | -10.15% |
| 1D | divergence (all types) | 233 | 49.5% | 15% | -0.62% | 10.68% | -10.36% |

- **1h:** selected `atr imp=fixed buf=0.25x` on in-sample avg -0.21% (n 1754) vs default -0.27% (n 1813).
- **4h:** selected `atr imp=6x buf=fixed` on in-sample avg 0.73% (n 609) vs default 0.03% (n 773).
- **1D:** selected `atr imp=fixed buf=0.25x` on in-sample avg 2.27% (n 256) vs default 3.10% (n 250): **no ATR variant beat the defaults in-sample**.

Breakout rows pool every pattern and symbol. The baseline is the forward return from going long at every bar. Short-side drift is its negative, so a pattern needs to beat it in its own direction to show an edge.

## Variant grid (in-sample → out-of-sample)

### 1h

| Variant | IS n | IS hit | IS avg | OOS n | OOS hit | OOS avg | OOS MFE | OOS MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 1813 | 47.0% | -0.27% | 695 | 44.9% | -0.19% | 2.65% | -2.83% |
| atr imp=fixed buf=0.1x | 1843 | 46.4% | -0.34% | 729 | 45.4% | -0.19% | 2.59% | -2.75% |
| atr imp=fixed buf=0.25x **← selected** | 1754 | 47.0% | -0.21% | 694 | 44.1% | -0.19% | 2.59% | -2.79% |
| atr imp=fixed buf=0.5x | 1642 | 48.0% | -0.22% | 606 | 44.4% | -0.21% | 2.60% | -2.81% |
| atr imp=2x buf=fixed | 1960 | 46.8% | -0.28% | 769 | 44.5% | -0.16% | 2.59% | -2.78% |
| atr imp=2x buf=0.1x | 1992 | 46.5% | -0.34% | 806 | 45.5% | -0.17% | 2.54% | -2.71% |
| atr imp=2x buf=0.25x | 1887 | 46.7% | -0.25% | 762 | 43.7% | -0.19% | 2.52% | -2.74% |
| atr imp=2x buf=0.5x | 1761 | 47.3% | -0.26% | 661 | 44.6% | -0.15% | 2.57% | -2.75% |
| atr imp=3x buf=fixed | 1831 | 46.8% | -0.30% | 724 | 45.0% | -0.17% | 2.60% | -2.78% |
| atr imp=3x buf=0.1x | 1860 | 46.3% | -0.35% | 758 | 45.5% | -0.17% | 2.55% | -2.71% |
| atr imp=3x buf=0.25x | 1776 | 46.6% | -0.25% | 723 | 44.0% | -0.18% | 2.53% | -2.74% |
| atr imp=3x buf=0.5x | 1662 | 47.4% | -0.25% | 628 | 44.4% | -0.20% | 2.54% | -2.75% |
| atr imp=4x buf=fixed | 1743 | 46.2% | -0.32% | 698 | 44.5% | -0.19% | 2.60% | -2.79% |
| atr imp=4x buf=0.1x | 1774 | 46.0% | -0.37% | 733 | 45.4% | -0.18% | 2.57% | -2.71% |
| atr imp=4x buf=0.25x | 1691 | 46.3% | -0.27% | 697 | 43.6% | -0.19% | 2.54% | -2.75% |
| atr imp=4x buf=0.5x | 1586 | 47.1% | -0.27% | 606 | 44.9% | -0.18% | 2.58% | -2.75% |
| atr imp=6x buf=fixed | 1658 | 46.1% | -0.34% | 665 | 44.7% | -0.21% | 2.60% | -2.83% |
| atr imp=6x buf=0.1x | 1686 | 45.9% | -0.39% | 702 | 45.4% | -0.20% | 2.55% | -2.75% |
| atr imp=6x buf=0.25x | 1612 | 46.4% | -0.27% | 665 | 44.1% | -0.20% | 2.54% | -2.79% |
| atr imp=6x buf=0.5x | 1517 | 47.2% | -0.27% | 580 | 45.2% | -0.19% | 2.58% | -2.80% |
| atr imp=8x buf=fixed | 1624 | 45.8% | -0.36% | 659 | 44.3% | -0.22% | 2.59% | -2.84% |
| atr imp=8x buf=0.1x | 1651 | 45.6% | -0.41% | 693 | 45.0% | -0.21% | 2.54% | -2.76% |
| atr imp=8x buf=0.25x | 1582 | 46.1% | -0.29% | 658 | 43.7% | -0.21% | 2.54% | -2.80% |
| atr imp=8x buf=0.5x | 1497 | 46.9% | -0.29% | 573 | 44.7% | -0.21% | 2.57% | -2.81% |

### 4h

| Variant | IS n | IS hit | IS avg | OOS n | OOS hit | OOS avg | OOS MFE | OOS MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 773 | 47.3% | 0.03% | 360 | 41.0% | -1.22% | 5.58% | -6.36% |
| atr imp=fixed buf=0.1x | 775 | 46.7% | -0.06% | 366 | 40.8% | -1.32% | 5.50% | -6.38% |
| atr imp=fixed buf=0.25x | 742 | 45.5% | -0.17% | 343 | 40.2% | -1.43% | 5.39% | -6.22% |
| atr imp=fixed buf=0.5x | 712 | 45.4% | -0.11% | 305 | 35.6% | -1.63% | 5.42% | -6.51% |
| atr imp=2x buf=fixed | 748 | 48.3% | 0.28% | 361 | 39.9% | -1.20% | 5.50% | -6.17% |
| atr imp=2x buf=0.1x | 750 | 47.6% | 0.20% | 365 | 39.7% | -1.28% | 5.42% | -6.17% |
| atr imp=2x buf=0.25x | 719 | 46.5% | 0.09% | 343 | 39.2% | -1.37% | 5.31% | -6.07% |
| atr imp=2x buf=0.5x | 688 | 46.5% | 0.11% | 303 | 35.4% | -1.52% | 5.37% | -6.33% |
| atr imp=3x buf=fixed | 682 | 49.1% | 0.51% | 327 | 40.8% | -1.19% | 5.60% | -6.32% |
| atr imp=3x buf=0.1x | 681 | 48.3% | 0.43% | 332 | 40.5% | -1.29% | 5.51% | -6.32% |
| atr imp=3x buf=0.25x | 661 | 47.3% | 0.27% | 311 | 40.5% | -1.37% | 5.41% | -6.21% |
| atr imp=3x buf=0.5x | 636 | 47.7% | 0.24% | 277 | 37.1% | -1.45% | 5.55% | -6.39% |
| atr imp=4x buf=fixed | 641 | 49.8% | 0.64% | 302 | 41.5% | -1.09% | 5.77% | -6.18% |
| atr imp=4x buf=0.1x | 641 | 49.0% | 0.58% | 305 | 41.6% | -1.18% | 5.69% | -6.18% |
| atr imp=4x buf=0.25x | 625 | 48.1% | 0.47% | 287 | 41.5% | -1.28% | 5.58% | -6.20% |
| atr imp=4x buf=0.5x | 601 | 47.7% | 0.34% | 260 | 37.6% | -1.40% | 5.66% | -6.37% |
| atr imp=6x buf=fixed **← selected** | 609 | 49.8% | 0.73% | 286 | 40.5% | -1.20% | 5.75% | -6.22% |
| atr imp=6x buf=0.1x | 609 | 49.1% | 0.68% | 290 | 40.4% | -1.31% | 5.65% | -6.24% |
| atr imp=6x buf=0.25x | 595 | 47.8% | 0.45% | 277 | 40.4% | -1.41% | 5.53% | -6.30% |
| atr imp=6x buf=0.5x | 577 | 47.9% | 0.36% | 251 | 36.9% | -1.51% | 5.65% | -6.45% |
| atr imp=8x buf=fixed | 605 | 49.9% | 0.72% | 281 | 40.9% | -1.20% | 5.82% | -6.26% |
| atr imp=8x buf=0.1x | 606 | 49.2% | 0.67% | 285 | 40.8% | -1.30% | 5.72% | -6.28% |
| atr imp=8x buf=0.25x | 592 | 47.9% | 0.44% | 272 | 40.8% | -1.41% | 5.60% | -6.34% |
| atr imp=8x buf=0.5x | 575 | 47.8% | 0.34% | 247 | 37.3% | -1.51% | 5.71% | -6.49% |

### 1D

| Variant | IS n | IS hit | IS avg | OOS n | OOS hit | OOS avg | OOS MFE | OOS MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 250 | 55.0% | 3.10% | 144 | 52.0% | 0.34% | 11.03% | -9.65% |
| atr imp=fixed buf=0.1x | 253 | 54.0% | 2.25% | 139 | 52.5% | 0.55% | 11.22% | -9.37% |
| atr imp=fixed buf=0.25x **← selected** | 256 | 54.3% | 2.27% | 139 | 52.5% | 0.52% | 10.93% | -8.91% |
| atr imp=fixed buf=0.5x | 226 | 53.0% | 1.60% | 116 | 51.0% | -0.93% | 9.86% | -9.68% |
| atr imp=2x buf=fixed | 205 | 52.3% | 1.97% | 131 | 52.3% | 0.28% | 10.82% | -9.67% |
| atr imp=2x buf=0.1x | 210 | 51.1% | 1.09% | 125 | 52.3% | 0.27% | 11.00% | -9.44% |
| atr imp=2x buf=0.25x | 216 | 52.0% | 1.39% | 123 | 51.9% | 0.05% | 10.36% | -9.06% |
| atr imp=2x buf=0.5x | 190 | 51.0% | 0.62% | 103 | 50.0% | -1.68% | 9.24% | -9.99% |
| atr imp=3x buf=fixed | 183 | 51.9% | 1.58% | 114 | 50.5% | -0.07% | 10.52% | -9.77% |
| atr imp=3x buf=0.1x | 188 | 51.3% | 0.83% | 111 | 50.0% | -0.30% | 10.65% | -9.75% |
| atr imp=3x buf=0.25x | 198 | 52.2% | 1.03% | 114 | 51.0% | -0.12% | 10.49% | -9.18% |
| atr imp=3x buf=0.5x | 174 | 50.7% | 0.13% | 99 | 49.4% | -1.77% | 9.27% | -10.11% |
| atr imp=4x buf=fixed | 172 | 52.4% | 1.86% | 108 | 51.1% | -0.12% | 10.73% | -10.00% |
| atr imp=4x buf=0.1x | 177 | 51.7% | 1.09% | 107 | 51.1% | -0.21% | 10.89% | -9.84% |
| atr imp=4x buf=0.25x | 186 | 52.3% | 1.15% | 110 | 52.1% | -0.03% | 10.71% | -9.24% |
| atr imp=4x buf=0.5x | 165 | 51.5% | 0.31% | 95 | 50.6% | -1.74% | 9.48% | -10.22% |
| atr imp=6x buf=fixed | 162 | 52.2% | 1.54% | 103 | 51.7% | -0.12% | 10.88% | -10.11% |
| atr imp=6x buf=0.1x | 167 | 51.1% | 0.85% | 102 | 51.7% | -0.21% | 11.05% | -9.95% |
| atr imp=6x buf=0.25x | 175 | 51.7% | 0.99% | 106 | 52.2% | -0.18% | 10.81% | -9.40% |
| atr imp=6x buf=0.5x | 157 | 51.6% | 0.23% | 92 | 50.0% | -1.85% | 9.69% | -10.35% |
| atr imp=8x buf=fixed | 159 | 52.6% | 1.59% | 102 | 52.3% | 0.03% | 10.95% | -10.02% |
| atr imp=8x buf=0.1x | 165 | 51.4% | 0.89% | 101 | 52.3% | -0.06% | 11.13% | -9.85% |
| atr imp=8x buf=0.25x | 174 | 52.1% | 1.01% | 106 | 52.2% | -0.18% | 10.81% | -9.40% |
| atr imp=8x buf=0.5x | 156 | 52.0% | 0.26% | 92 | 50.0% | -1.85% | 9.69% | -10.35% |

The selection uses only the IS columns. The OOS columns for variants that were not selected are shown for transparency; picking the best of them afterwards would bring back the overfitting the split exists to avoid.

## By pattern × timeframe (out-of-sample)

A pattern can break either way (a Bull Flag can break down), and the event is scored in the breakout direction, so each pattern is split by breakout direction.

| TF | Pattern / breakout | Set | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1h | Bull Flag ↑ | default | 19 ⚠ | 66.7% | 53% | 0.81% | 4.04% | -2.71% |
| 1h | Bull Flag ↑ | tuned | 20 ⚠ | 62.5% | 60% | 0.47% | 3.77% | -2.63% |
| 1h | Bull Flag ↓ | default | 3 ⚠ | – | 100% | 0.70% | 2.60% | -1.91% |
| 1h | Bull Flag ↓ | tuned | 3 ⚠ | – | 100% | 0.70% | 2.60% | -1.91% |
| 1h | Bear Flag ↑ | default | 2 ⚠ | – | 100% | 0.04% | 5.52% | -0.67% |
| 1h | Bear Flag ↑ | tuned | 2 ⚠ | – | 100% | 0.04% | 5.52% | -0.67% |
| 1h | Bear Flag ↓ | default | 16 ⚠ | 50.0% | 63% | 0.24% | 3.09% | -2.54% |
| 1h | Bear Flag ↓ | tuned | 14 ⚠ | 50.0% | 71% | -0.07% | 2.95% | -2.44% |
| 1h | Rising Wedge ↑ | default | 66 | 30.3% | 50% | -0.26% | 3.55% | -2.91% |
| 1h | Rising Wedge ↑ | tuned | 64 | 36.7% | 53% | -0.04% | 3.44% | -2.68% |
| 1h | Rising Wedge ↓ | default | 248 | 51.0% | 58% | -0.30% | 2.31% | -2.85% |
| 1h | Rising Wedge ↓ | tuned | 247 | 49.5% | 60% | -0.30% | 2.27% | -2.81% |
| 1h | Falling Wedge ↑ | default | 277 | 47.3% | 53% | 0.19% | 2.75% | -2.64% |
| 1h | Falling Wedge ↑ | tuned | 279 | 45.5% | 52% | 0.11% | 2.68% | -2.69% |
| 1h | Falling Wedge ↓ | default | 64 | 13.6% | 66% | -1.74% | 1.96% | -3.69% |
| 1h | Falling Wedge ↓ | tuned | 65 | 10.0% | 69% | -1.51% | 2.02% | -3.46% |
| 4h | Bull Flag ↑ | default | 34 | 11.5% | 24% | -4.67% | 2.85% | -9.98% |
| 4h | Bull Flag ↑ | tuned | 5 ⚠ | 0.0% | 60% | -1.68% | 1.66% | -4.16% |
| 4h | Bull Flag ↓ | default | 9 ⚠ | 50.0% | 56% | 0.27% | 3.62% | -5.10% |
| 4h | Bull Flag ↓ | tuned | 0 ⚠ | – | – | – | – | – |
| 4h | Bear Flag ↑ | default | 6 ⚠ | 80.0% | 17% | 1.43% | 5.23% | -2.92% |
| 4h | Bear Flag ↑ | tuned | 0 ⚠ | – | – | – | – | – |
| 4h | Bear Flag ↓ | default | 30 | 72.2% | 40% | 1.45% | 7.13% | -4.30% |
| 4h | Bear Flag ↓ | tuned | 0 ⚠ | – | – | – | – | – |
| 4h | Rising Wedge ↑ | default | 15 ⚠ | 23.1% | 13% | -3.45% | 4.94% | -6.46% |
| 4h | Rising Wedge ↑ | tuned | 15 ⚠ | 23.1% | 13% | -3.45% | 4.94% | -6.46% |
| 4h | Rising Wedge ↓ | default | 71 | 60.4% | 32% | 0.62% | 6.57% | -4.87% |
| 4h | Rising Wedge ↓ | tuned | 71 | 60.4% | 32% | 0.62% | 6.57% | -4.87% |
| 4h | Falling Wedge ↑ | default | 165 | 31.4% | 28% | -2.10% | 5.51% | -6.98% |
| 4h | Falling Wedge ↑ | tuned | 165 | 31.4% | 28% | -2.10% | 5.51% | -6.98% |
| 4h | Falling Wedge ↓ | default | 30 | 63.2% | 37% | 0.61% | 6.18% | -5.46% |
| 4h | Falling Wedge ↓ | tuned | 30 | 63.2% | 37% | 0.61% | 6.18% | -5.46% |
| 1D | Bull Flag ↑ | default | 11 ⚠ | 12.5% | 27% | -8.74% | 4.09% | -16.27% |
| 1D | Bull Flag ↑ | tuned | 7 ⚠ | 20.0% | 29% | -7.38% | 3.72% | -14.22% |
| 1D | Bull Flag ↓ | default | 10 ⚠ | 80.0% | 0% | 6.97% | 14.29% | -5.14% |
| 1D | Bull Flag ↓ | tuned | 7 ⚠ | 100.0% | 0% | 11.97% | 15.91% | -2.17% |
| 1D | Bear Flag ↑ | default | 4 ⚠ | 25.0% | 0% | 4.91% | 18.27% | -10.53% |
| 1D | Bear Flag ↑ | tuned | 4 ⚠ | 25.0% | 0% | 4.91% | 18.27% | -10.53% |
| 1D | Bear Flag ↓ | default | 17 ⚠ | 60.0% | 12% | 3.12% | 12.39% | -5.65% |
| 1D | Bear Flag ↓ | tuned | 15 ⚠ | 50.0% | 20% | 2.66% | 10.81% | -5.70% |
| 1D | Rising Wedge ↑ | default | 7 ⚠ | 71.4% | 0% | 7.94% | 17.92% | -6.73% |
| 1D | Rising Wedge ↑ | tuned | 9 ⚠ | 75.0% | 11% | 5.53% | 16.78% | -6.98% |
| 1D | Rising Wedge ↓ | default | 21 ⚠ | 53.3% | 29% | -3.63% | 6.86% | -10.13% |
| 1D | Rising Wedge ↓ | tuned | 22 ⚠ | 58.8% | 23% | -2.63% | 5.42% | -9.32% |
| 1D | Falling Wedge ↑ | default | 59 | 45.1% | 14% | -0.37% | 10.68% | -10.61% |
| 1D | Falling Wedge ↑ | tuned | 61 | 42.9% | 8% | -0.90% | 10.97% | -9.81% |
| 1D | Falling Wedge ↓ | default | 15 ⚠ | 69.2% | 13% | 3.07% | 14.51% | -9.09% |
| 1D | Falling Wedge ↓ | tuned | 14 ⚠ | 72.7% | 21% | 3.18% | 14.79% | -9.27% |

## By symbol × timeframe, all patterns (out-of-sample)

| Symbol | TF | Set | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 1h | default | 63 | 61.1% | 71% | 0.16% | 1.58% | -1.49% |
| BTCUSDT | 1h | tuned | 68 | 52.9% | 75% | 0.06% | 1.44% | -1.56% |
| BTCUSDT | 4h | default | 40 | 50.0% | 40% | 0.53% | 4.35% | -3.18% |
| BTCUSDT | 4h | tuned | 37 | 50.0% | 41% | 0.49% | 4.35% | -3.10% |
| BTCUSDT | 1D | default | 17 ⚠ | 78.6% | 18% | 4.08% | 8.29% | -3.90% |
| BTCUSDT | 1D | tuned | 16 ⚠ | 76.9% | 19% | 3.14% | 7.39% | -4.39% |
| ETHUSDT | 1h | default | 55 | 35.3% | 69% | -0.14% | 1.92% | -2.25% |
| ETHUSDT | 1h | tuned | 57 | 37.5% | 72% | -0.07% | 2.03% | -2.21% |
| ETHUSDT | 4h | default | 35 | 45.8% | 31% | -1.53% | 4.18% | -6.09% |
| ETHUSDT | 4h | tuned | 24 ⚠ | 38.5% | 46% | -1.69% | 4.00% | -5.69% |
| ETHUSDT | 1D | default | 14 ⚠ | 38.5% | 7% | -6.41% | 8.08% | -14.86% |
| ETHUSDT | 1D | tuned | 12 ⚠ | 63.6% | 8% | 0.46% | 10.32% | -7.95% |
| SOLUSDT | 1h | default | 73 | 50.0% | 62% | -0.28% | 1.85% | -2.16% |
| SOLUSDT | 1h | tuned | 77 | 51.7% | 62% | -0.03% | 1.93% | -1.94% |
| SOLUSDT | 4h | default | 38 | 35.7% | 26% | -1.76% | 5.25% | -6.77% |
| SOLUSDT | 4h | tuned | 27 ⚠ | 23.8% | 22% | -2.99% | 4.93% | -7.91% |
| SOLUSDT | 1D | default | 20 ⚠ | 60.0% | 50% | 0.77% | 7.61% | -8.99% |
| SOLUSDT | 1D | tuned | 22 ⚠ | 53.8% | 41% | 0.37% | 7.43% | -10.01% |
| XRPUSDT | 1h | default | 66 | 55.6% | 59% | -0.16% | 2.26% | -2.25% |
| XRPUSDT | 1h | tuned | 61 | 52.0% | 59% | -0.15% | 2.22% | -2.27% |
| XRPUSDT | 4h | default | 28 ⚠ | 52.6% | 32% | -0.26% | 5.68% | -5.00% |
| XRPUSDT | 4h | tuned | 23 ⚠ | 52.9% | 26% | -0.23% | 5.80% | -5.05% |
| XRPUSDT | 1D | default | 12 ⚠ | 66.7% | 0% | 4.02% | 15.98% | -6.45% |
| XRPUSDT | 1D | tuned | 10 ⚠ | 70.0% | 0% | 5.02% | 14.82% | -4.71% |
| DOGEUSDT | 1h | default | 53 | 27.3% | 58% | -0.99% | 1.83% | -2.91% |
| DOGEUSDT | 1h | tuned | 52 | 26.1% | 56% | -1.01% | 1.86% | -2.91% |
| DOGEUSDT | 4h | default | 24 ⚠ | 26.7% | 38% | -2.39% | 5.04% | -6.51% |
| DOGEUSDT | 4h | tuned | 18 ⚠ | 36.4% | 39% | -1.73% | 5.77% | -6.06% |
| DOGEUSDT | 1D | default | 18 ⚠ | 64.7% | 6% | 6.01% | 17.13% | -8.11% |
| DOGEUSDT | 1D | tuned | 18 ⚠ | 61.1% | 0% | 6.66% | 19.23% | -6.62% |
| AVAXUSDT | 1h | default | 66 | 52.4% | 68% | -0.00% | 2.55% | -2.58% |
| AVAXUSDT | 1h | tuned | 69 | 54.5% | 68% | 0.02% | 2.52% | -2.52% |
| AVAXUSDT | 4h | default | 31 | 52.0% | 19% | -0.48% | 5.24% | -6.19% |
| AVAXUSDT | 4h | tuned | 25 ⚠ | 54.5% | 12% | -0.00% | 5.39% | -5.98% |
| AVAXUSDT | 1D | default | 17 ⚠ | 33.3% | 12% | -5.16% | 8.96% | -14.23% |
| AVAXUSDT | 1D | tuned | 18 ⚠ | 31.3% | 11% | -7.11% | 6.93% | -14.82% |
| LINKUSDT | 1h | default | 66 | 46.2% | 61% | 0.12% | 2.65% | -2.29% |
| LINKUSDT | 1h | tuned | 66 | 46.2% | 61% | 0.09% | 2.63% | -2.30% |
| LINKUSDT | 4h | default | 44 | 18.5% | 39% | -3.49% | 4.01% | -7.96% |
| LINKUSDT | 4h | tuned | 35 | 19.0% | 40% | -3.11% | 4.48% | -6.63% |
| LINKUSDT | 1D | default | 17 ⚠ | 20.0% | 12% | -5.13% | 8.09% | -15.33% |
| LINKUSDT | 1D | tuned | 13 ⚠ | 25.0% | 8% | -3.81% | 7.50% | -12.23% |
| INJUSDT | 1h | default | 81 | 47.3% | 32% | 0.08% | 4.34% | -4.20% |
| INJUSDT | 1h | tuned | 74 | 40.8% | 34% | -0.53% | 3.88% | -4.62% |
| INJUSDT | 4h | default | 33 | 35.7% | 15% | -3.01% | 6.31% | -9.13% |
| INJUSDT | 4h | tuned | 26 ⚠ | 36.4% | 15% | -3.18% | 6.67% | -8.45% |
| INJUSDT | 1D | default | 16 ⚠ | 60.0% | 6% | 2.29% | 11.64% | -6.77% |
| INJUSDT | 1D | tuned | 17 ⚠ | 56.3% | 6% | 1.01% | 11.59% | -8.84% |
| WIFUSDT | 1h | default | 70 | 21.6% | 47% | -1.58% | 2.75% | -4.46% |
| WIFUSDT | 1h | tuned | 70 | 26.3% | 46% | -1.40% | 2.89% | -4.34% |
| WIFUSDT | 4h | default | 42 | 40.6% | 24% | -0.61% | 6.13% | -6.32% |
| WIFUSDT | 4h | tuned | 34 | 40.0% | 26% | -0.48% | 6.41% | -6.64% |
| WIFUSDT | 1D | default | 6 ⚠ | 33.3% | 0% | 1.54% | 17.57% | -9.79% |
| WIFUSDT | 1D | tuned | 7 ⚠ | 28.6% | 0% | -0.19% | 16.44% | -9.92% |
| PEPEUSDT | 1h | default | 102 | 51.9% | 47% | 0.46% | 3.58% | -3.06% |
| PEPEUSDT | 1h | tuned | 100 | 54.0% | 50% | 0.60% | 3.63% | -2.90% |
| PEPEUSDT | 4h | default | 45 | 51.7% | 36% | 0.38% | 9.02% | -6.38% |
| PEPEUSDT | 4h | tuned | 37 | 50.0% | 30% | 0.09% | 9.01% | -7.06% |
| PEPEUSDT | 1D | default | 7 ⚠ | 66.7% | 14% | 3.87% | 14.37% | -6.20% |
| PEPEUSDT | 1D | tuned | 6 ⚠ | 50.0% | 33% | 0.10% | 14.09% | -6.77% |

## RSI divergence (out-of-sample)

| TF | Type | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1h | Regular Bullish | 374 | 45.9% | 48% | -0.16% | 2.57% | -3.14% |
| 1h | Hidden Bullish | 438 | 47.6% | 57% | 0.10% | 2.98% | -2.60% |
| 1h | Regular Bearish | 347 | 59.2% | 48% | 0.00% | 2.93% | -3.30% |
| 1h | Hidden Bearish | 451 | 55.9% | 55% | 0.18% | 2.92% | -2.60% |
| 4h | Regular Bullish | 240 | 34.7% | 29% | -1.48% | 5.09% | -7.60% |
| 4h | Hidden Bullish | 203 | 40.3% | 32% | -0.60% | 5.77% | -5.70% |
| 4h | Regular Bearish | 158 | 55.9% | 30% | 0.29% | 5.63% | -6.05% |
| 4h | Hidden Bearish | 293 | 66.0% | 30% | 1.83% | 7.36% | -4.60% |
| 1D | Regular Bullish | 54 | 34.8% | 15% | -3.54% | 9.27% | -11.09% |
| 1D | Hidden Bullish | 62 | 42.9% | 21% | -2.07% | 8.97% | -9.80% |
| 1D | Regular Bearish | 49 | 58.1% | 12% | 0.86% | 11.17% | -10.86% |
| 1D | Hidden Bearish | 68 | 60.0% | 12% | 1.98% | 12.99% | -9.93% |

### By symbol × timeframe, all divergence types

| Symbol | TF | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 1h | 155 | 44.7% | 70% | -0.10% | 1.64% | -1.64% |
| BTCUSDT | 4h | 106 | 53.2% | 42% | 0.26% | 4.05% | -3.65% |
| BTCUSDT | 1D | 26 ⚠ | 55.6% | 31% | 0.99% | 7.09% | -4.63% |
| ETHUSDT | 1h | 165 | 51.6% | 62% | 0.08% | 2.25% | -2.21% |
| ETHUSDT | 4h | 106 | 43.1% | 32% | -0.80% | 4.49% | -5.75% |
| ETHUSDT | 1D | 27 ⚠ | 40.9% | 19% | -3.50% | 6.52% | -9.70% |
| SOLUSDT | 1h | 151 | 48.4% | 58% | -0.11% | 2.37% | -2.45% |
| SOLUSDT | 4h | 97 | 47.1% | 28% | -0.08% | 5.31% | -5.15% |
| SOLUSDT | 1D | 22 ⚠ | 41.2% | 23% | -0.95% | 10.22% | -11.50% |
| XRPUSDT | 1h | 146 | 40.3% | 54% | -0.48% | 2.09% | -2.78% |
| XRPUSDT | 4h | 80 | 54.0% | 38% | 0.42% | 5.51% | -4.73% |
| XRPUSDT | 1D | 28 ⚠ | 64.0% | 11% | -0.04% | 12.92% | -10.68% |
| DOGEUSDT | 1h | 153 | 53.8% | 58% | 0.07% | 2.45% | -2.64% |
| DOGEUSDT | 4h | 85 | 47.8% | 21% | -0.30% | 5.64% | -6.50% |
| DOGEUSDT | 1D | 31 | 60.9% | 26% | 0.66% | 11.51% | -8.66% |
| AVAXUSDT | 1h | 163 | 54.1% | 48% | 0.10% | 3.08% | -2.96% |
| AVAXUSDT | 4h | 91 | 56.5% | 32% | 0.64% | 7.43% | -6.37% |
| AVAXUSDT | 1D | 23 ⚠ | 35.0% | 13% | -4.42% | 8.17% | -13.37% |
| LINKUSDT | 1h | 155 | 61.8% | 56% | 0.29% | 2.56% | -2.49% |
| LINKUSDT | 4h | 91 | 48.5% | 27% | 0.58% | 5.63% | -5.64% |
| LINKUSDT | 1D | 24 ⚠ | 45.8% | 0% | -1.73% | 11.60% | -13.66% |
| INJUSDT | 1h | 189 | 45.1% | 35% | -0.32% | 4.12% | -4.40% |
| INJUSDT | 4h | 92 | 45.2% | 21% | -0.90% | 8.12% | -8.67% |
| INJUSDT | 1D | 27 ⚠ | 58.3% | 11% | 4.27% | 16.19% | -10.33% |
| WIFUSDT | 1h | 160 | 57.6% | 47% | 0.23% | 3.34% | -3.42% |
| WIFUSDT | 4h | 63 | 57.8% | 29% | 0.50% | 8.02% | -6.39% |
| WIFUSDT | 1D | 13 ⚠ | 30.8% | 0% | -3.78% | 11.09% | -11.23% |
| PEPEUSDT | 1h | 173 | 60.4% | 42% | 0.62% | 4.19% | -3.40% |
| PEPEUSDT | 4h | 83 | 52.5% | 29% | 1.23% | 7.90% | -6.83% |
| PEPEUSDT | 1D | 12 ⚠ | 50.0% | 0% | 0.33% | 11.31% | -12.56% |

## Appendix: full period, live defaults, by pattern × timeframe × symbol

Covers all bars (in-sample + out-of-sample), so nothing here was tuned. Use it for sample sizes, not as an out-of-sample result.

| TF | Pattern | Symbol | n | Hit rate | Flat | Avg dir. return | Avg MFE | Avg MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1h | Bull Flag | BTCUSDT | 0 ⚠ | – | – | – | – | – |
| 1h | Bull Flag | ETHUSDT | 8 ⚠ | 100.0% | 50% | 3.91% | 7.76% | -1.09% |
| 1h | Bull Flag | SOLUSDT | 8 ⚠ | 75.0% | 50% | 1.24% | 3.14% | -1.94% |
| 1h | Bull Flag | XRPUSDT | 6 ⚠ | 100.0% | 67% | 1.29% | 3.74% | -2.22% |
| 1h | Bull Flag | DOGEUSDT | 7 ⚠ | 60.0% | 29% | 0.30% | 4.67% | -3.62% |
| 1h | Bull Flag | AVAXUSDT | 24 ⚠ | 46.7% | 38% | -0.72% | 3.06% | -4.07% |
| 1h | Bull Flag | LINKUSDT | 15 ⚠ | 50.0% | 47% | 0.81% | 4.25% | -3.09% |
| 1h | Bull Flag | INJUSDT | 19 ⚠ | 50.0% | 16% | -0.72% | 4.07% | -4.85% |
| 1h | Bull Flag | WIFUSDT | 15 ⚠ | 60.0% | 33% | 0.67% | 5.87% | -4.67% |
| 1h | Bull Flag | PEPEUSDT | 21 ⚠ | 61.5% | 38% | 0.62% | 6.16% | -5.32% |
| 1h | Bear Flag | BTCUSDT | 0 ⚠ | – | – | – | – | – |
| 1h | Bear Flag | ETHUSDT | 6 ⚠ | 50.0% | 67% | 0.39% | 3.24% | -1.80% |
| 1h | Bear Flag | SOLUSDT | 9 ⚠ | 60.0% | 44% | -0.75% | 2.60% | -4.62% |
| 1h | Bear Flag | XRPUSDT | 4 ⚠ | 100.0% | 75% | 1.56% | 3.85% | -1.96% |
| 1h | Bear Flag | DOGEUSDT | 12 ⚠ | 66.7% | 50% | 0.55% | 3.50% | -4.13% |
| 1h | Bear Flag | AVAXUSDT | 12 ⚠ | 42.9% | 42% | -0.31% | 2.95% | -3.21% |
| 1h | Bear Flag | LINKUSDT | 20 ⚠ | 60.0% | 50% | 0.33% | 3.40% | -3.03% |
| 1h | Bear Flag | INJUSDT | 15 ⚠ | 44.4% | 40% | -1.76% | 2.89% | -4.76% |
| 1h | Bear Flag | WIFUSDT | 27 ⚠ | 40.0% | 44% | 1.78% | 6.39% | -4.28% |
| 1h | Bear Flag | PEPEUSDT | 15 ⚠ | 55.6% | 40% | 0.82% | 5.11% | -3.87% |
| 1h | Rising Wedge | BTCUSDT | 95 | 63.0% | 72% | 0.20% | 1.71% | -1.46% |
| 1h | Rising Wedge | ETHUSDT | 92 | 42.1% | 59% | -0.32% | 2.30% | -2.84% |
| 1h | Rising Wedge | SOLUSDT | 133 | 57.7% | 47% | 0.33% | 2.81% | -2.62% |
| 1h | Rising Wedge | XRPUSDT | 84 | 52.5% | 52% | 0.10% | 2.86% | -2.59% |
| 1h | Rising Wedge | DOGEUSDT | 101 | 42.6% | 47% | -0.41% | 3.50% | -3.49% |
| 1h | Rising Wedge | AVAXUSDT | 109 | 50.8% | 42% | 0.09% | 3.46% | -3.11% |
| 1h | Rising Wedge | LINKUSDT | 115 | 42.4% | 43% | -0.20% | 2.80% | -2.90% |
| 1h | Rising Wedge | INJUSDT | 81 | 50.0% | 33% | -0.57% | 3.71% | -4.23% |
| 1h | Rising Wedge | WIFUSDT | 111 | 56.5% | 38% | 0.42% | 4.80% | -4.32% |
| 1h | Rising Wedge | PEPEUSDT | 123 | 38.8% | 35% | -0.86% | 3.89% | -4.55% |
| 1h | Falling Wedge | BTCUSDT | 89 | 51.7% | 67% | 0.05% | 1.76% | -1.64% |
| 1h | Falling Wedge | ETHUSDT | 77 | 48.5% | 57% | -0.13% | 3.04% | -2.82% |
| 1h | Falling Wedge | SOLUSDT | 112 | 42.0% | 55% | -0.41% | 2.66% | -3.16% |
| 1h | Falling Wedge | XRPUSDT | 129 | 46.0% | 61% | -0.18% | 2.51% | -2.59% |
| 1h | Falling Wedge | DOGEUSDT | 103 | 37.3% | 50% | -0.73% | 2.73% | -3.69% |
| 1h | Falling Wedge | AVAXUSDT | 108 | 47.0% | 39% | -0.38% | 3.20% | -4.04% |
| 1h | Falling Wedge | LINKUSDT | 132 | 50.8% | 54% | 0.08% | 3.52% | -2.75% |
| 1h | Falling Wedge | INJUSDT | 152 | 37.9% | 32% | -0.71% | 4.11% | -4.77% |
| 1h | Falling Wedge | WIFUSDT | 161 | 35.6% | 35% | -1.46% | 4.24% | -6.01% |
| 1h | Falling Wedge | PEPEUSDT | 159 | 42.6% | 41% | -0.55% | 3.70% | -4.45% |
| 4h | Bull Flag | BTCUSDT | 7 ⚠ | 0.0% | 57% | -1.68% | 2.19% | -4.05% |
| 4h | Bull Flag | ETHUSDT | 11 ⚠ | 57.1% | 36% | -1.27% | 4.86% | -5.55% |
| 4h | Bull Flag | SOLUSDT | 11 ⚠ | 33.3% | 45% | -0.74% | 5.36% | -5.58% |
| 4h | Bull Flag | XRPUSDT | 15 ⚠ | 41.7% | 20% | 1.14% | 5.71% | -5.43% |
| 4h | Bull Flag | DOGEUSDT | 13 ⚠ | 50.0% | 54% | -0.05% | 5.87% | -5.73% |
| 4h | Bull Flag | AVAXUSDT | 16 ⚠ | 25.0% | 25% | -3.04% | 4.81% | -9.23% |
| 4h | Bull Flag | LINKUSDT | 16 ⚠ | 30.8% | 19% | -1.91% | 5.98% | -10.17% |
| 4h | Bull Flag | INJUSDT | 18 ⚠ | 23.1% | 28% | -2.71% | 7.26% | -11.31% |
| 4h | Bull Flag | WIFUSDT | 13 ⚠ | 58.3% | 8% | 3.53% | 10.95% | -7.12% |
| 4h | Bull Flag | PEPEUSDT | 14 ⚠ | 23.1% | 7% | -8.72% | 9.69% | -14.90% |
| 4h | Bear Flag | BTCUSDT | 3 ⚠ | 100.0% | 33% | 4.76% | 7.47% | -1.36% |
| 4h | Bear Flag | ETHUSDT | 13 ⚠ | 50.0% | 23% | 0.77% | 4.60% | -4.69% |
| 4h | Bear Flag | SOLUSDT | 20 ⚠ | 35.3% | 15% | -3.71% | 6.26% | -8.17% |
| 4h | Bear Flag | XRPUSDT | 11 ⚠ | 66.7% | 45% | -0.51% | 7.08% | -5.43% |
| 4h | Bear Flag | DOGEUSDT | 9 ⚠ | 16.7% | 33% | -1.63% | 5.62% | -5.79% |
| 4h | Bear Flag | AVAXUSDT | 12 ⚠ | 22.2% | 25% | -3.61% | 5.30% | -8.36% |
| 4h | Bear Flag | LINKUSDT | 6 ⚠ | 75.0% | 33% | 0.58% | 5.99% | -4.50% |
| 4h | Bear Flag | INJUSDT | 14 ⚠ | 50.0% | 29% | -2.19% | 7.05% | -10.24% |
| 4h | Bear Flag | WIFUSDT | 11 ⚠ | 36.4% | 0% | -11.52% | 11.85% | -22.58% |
| 4h | Bear Flag | PEPEUSDT | 21 ⚠ | 50.0% | 24% | -0.57% | 10.17% | -7.80% |
| 4h | Rising Wedge | BTCUSDT | 44 | 40.7% | 39% | -0.52% | 3.63% | -3.60% |
| 4h | Rising Wedge | ETHUSDT | 50 | 48.7% | 22% | -0.71% | 4.48% | -4.48% |
| 4h | Rising Wedge | SOLUSDT | 35 | 46.2% | 26% | -0.02% | 6.79% | -6.03% |
| 4h | Rising Wedge | XRPUSDT | 31 | 52.6% | 39% | 0.47% | 5.09% | -5.03% |
| 4h | Rising Wedge | DOGEUSDT | 35 | 52.2% | 34% | 0.84% | 7.51% | -6.97% |
| 4h | Rising Wedge | AVAXUSDT | 37 | 43.3% | 19% | -1.28% | 6.94% | -7.04% |
| 4h | Rising Wedge | LINKUSDT | 45 | 58.6% | 36% | 1.92% | 8.46% | -5.30% |
| 4h | Rising Wedge | INJUSDT | 43 | 68.4% | 12% | 1.76% | 10.31% | -7.90% |
| 4h | Rising Wedge | WIFUSDT | 21 ⚠ | 70.6% | 19% | 7.23% | 14.43% | -5.41% |
| 4h | Rising Wedge | PEPEUSDT | 37 | 60.6% | 11% | 2.63% | 11.77% | -7.69% |
| 4h | Falling Wedge | BTCUSDT | 45 | 59.4% | 29% | 0.56% | 4.53% | -3.55% |
| 4h | Falling Wedge | ETHUSDT | 43 | 39.3% | 35% | -1.06% | 4.50% | -5.64% |
| 4h | Falling Wedge | SOLUSDT | 42 | 38.7% | 26% | -0.99% | 5.68% | -6.77% |
| 4h | Falling Wedge | XRPUSDT | 47 | 40.6% | 32% | -1.23% | 4.86% | -6.03% |
| 4h | Falling Wedge | DOGEUSDT | 44 | 51.9% | 39% | -0.34% | 6.30% | -5.88% |
| 4h | Falling Wedge | AVAXUSDT | 60 | 50.0% | 20% | 0.68% | 8.46% | -6.03% |
| 4h | Falling Wedge | LINKUSDT | 53 | 28.9% | 28% | -1.75% | 5.38% | -6.84% |
| 4h | Falling Wedge | INJUSDT | 56 | 36.2% | 16% | -1.58% | 8.29% | -9.45% |
| 4h | Falling Wedge | WIFUSDT | 46 | 26.3% | 17% | -1.26% | 9.56% | -10.91% |
| 4h | Falling Wedge | PEPEUSDT | 67 | 47.9% | 28% | 0.95% | 12.09% | -8.28% |
| 1D | Bull Flag | BTCUSDT | 6 ⚠ | 100.0% | 17% | 10.12% | 13.56% | -2.30% |
| 1D | Bull Flag | ETHUSDT | 5 ⚠ | 40.0% | 0% | 1.85% | 12.72% | -8.97% |
| 1D | Bull Flag | SOLUSDT | 10 ⚠ | 0.0% | 30% | -9.27% | 5.14% | -16.72% |
| 1D | Bull Flag | XRPUSDT | 9 ⚠ | 55.6% | 0% | 5.78% | 20.68% | -9.96% |
| 1D | Bull Flag | DOGEUSDT | 9 ⚠ | 11.1% | 0% | -6.88% | 4.33% | -14.41% |
| 1D | Bull Flag | AVAXUSDT | 5 ⚠ | 75.0% | 20% | 8.90% | 25.51% | -12.73% |
| 1D | Bull Flag | LINKUSDT | 5 ⚠ | 50.0% | 20% | -2.46% | 11.35% | -12.82% |
| 1D | Bull Flag | INJUSDT | 5 ⚠ | 60.0% | 0% | 0.78% | 16.67% | -13.04% |
| 1D | Bull Flag | WIFUSDT | 2 ⚠ | 100.0% | 0% | 21.04% | 54.55% | -13.60% |
| 1D | Bull Flag | PEPEUSDT | 3 ⚠ | 100.0% | 0% | 39.14% | 56.53% | -12.09% |
| 1D | Bear Flag | BTCUSDT | 5 ⚠ | 0.0% | 40% | -1.88% | 2.85% | -6.35% |
| 1D | Bear Flag | ETHUSDT | 7 ⚠ | 50.0% | 43% | 0.24% | 7.14% | -3.72% |
| 1D | Bear Flag | SOLUSDT | 8 ⚠ | 80.0% | 38% | 7.44% | 16.24% | -9.24% |
| 1D | Bear Flag | XRPUSDT | 12 ⚠ | 62.5% | 33% | 10.43% | 23.20% | -8.47% |
| 1D | Bear Flag | DOGEUSDT | 7 ⚠ | 83.3% | 14% | 2.53% | 10.24% | -8.38% |
| 1D | Bear Flag | AVAXUSDT | 8 ⚠ | 83.3% | 25% | 5.60% | 13.10% | -9.32% |
| 1D | Bear Flag | LINKUSDT | 9 ⚠ | 37.5% | 11% | 1.63% | 12.97% | -10.33% |
| 1D | Bear Flag | INJUSDT | 10 ⚠ | 80.0% | 0% | 12.28% | 23.22% | -7.62% |
| 1D | Bear Flag | WIFUSDT | 4 ⚠ | 50.0% | 0% | 2.36% | 13.20% | -9.97% |
| 1D | Bear Flag | PEPEUSDT | 5 ⚠ | 80.0% | 0% | 4.69% | 16.42% | -14.47% |
| 1D | Rising Wedge | BTCUSDT | 22 ⚠ | 68.8% | 27% | 3.46% | 9.07% | -5.35% |
| 1D | Rising Wedge | ETHUSDT | 13 ⚠ | 72.7% | 15% | 1.77% | 12.67% | -10.93% |
| 1D | Rising Wedge | SOLUSDT | 9 ⚠ | 85.7% | 22% | 7.34% | 14.94% | -4.06% |
| 1D | Rising Wedge | XRPUSDT | 4 ⚠ | 66.7% | 25% | 4.19% | 7.27% | -6.03% |
| 1D | Rising Wedge | DOGEUSDT | 10 ⚠ | 44.4% | 10% | 3.23% | 17.60% | -12.53% |
| 1D | Rising Wedge | AVAXUSDT | 4 ⚠ | 25.0% | 0% | -13.13% | 8.26% | -19.76% |
| 1D | Rising Wedge | LINKUSDT | 8 ⚠ | 37.5% | 0% | -1.68% | 9.15% | -12.64% |
| 1D | Rising Wedge | INJUSDT | 9 ⚠ | 22.2% | 0% | -11.57% | 13.39% | -22.53% |
| 1D | Rising Wedge | WIFUSDT | 3 ⚠ | 100.0% | 0% | 15.55% | 31.39% | -4.47% |
| 1D | Rising Wedge | PEPEUSDT | 3 ⚠ | 50.0% | 33% | 0.16% | 6.56% | -6.87% |
| 1D | Falling Wedge | BTCUSDT | 13 ⚠ | 30.0% | 23% | -1.40% | 5.65% | -7.35% |
| 1D | Falling Wedge | ETHUSDT | 16 ⚠ | 46.2% | 19% | -2.13% | 9.57% | -12.06% |
| 1D | Falling Wedge | SOLUSDT | 17 ⚠ | 50.0% | 41% | 0.42% | 8.76% | -9.76% |
| 1D | Falling Wedge | XRPUSDT | 14 ⚠ | 75.0% | 14% | 4.62% | 13.05% | -3.84% |
| 1D | Falling Wedge | DOGEUSDT | 27 ⚠ | 45.8% | 11% | 5.79% | 17.82% | -9.54% |
| 1D | Falling Wedge | AVAXUSDT | 31 | 41.4% | 6% | -3.19% | 11.22% | -12.23% |
| 1D | Falling Wedge | LINKUSDT | 15 ⚠ | 16.7% | 20% | -7.36% | 7.52% | -15.96% |
| 1D | Falling Wedge | INJUSDT | 17 ⚠ | 60.0% | 12% | 3.54% | 16.96% | -7.75% |
| 1D | Falling Wedge | WIFUSDT | 13 ⚠ | 69.2% | 0% | 5.94% | 24.05% | -10.94% |
| 1D | Falling Wedge | PEPEUSDT | 13 ⚠ | 69.2% | 0% | 4.07% | 17.89% | -10.30% |
