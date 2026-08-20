# Mindset v1 Audit and v1.1 Research

Status: completed investigation; not a real-money recommendation. Updated 2026-08-20.

## 1. Frozen strategy and recovered Pine configuration

`mindset_v1` remains version `1.0.0`, status `forward-paper`, and was not changed. Its state conditions are:

- LONG: SMA-seeded EMA20 > EMA50 and RSI14 strictly between 50 and 75.
- SHORT: SMA-seeded EMA20 < EMA50 and RSI14 strictly between 25 and 50.
- Equal EMAs or RSI exactly on a boundary is FLAT.

The original Pine wrapper was recovered from the local Downloads folder (SHA-256 `96DE8BCB769D7ED78A222043AFDE8EF370CA910CB321ED1E81BD8AB0D2452B84`). It uses $10,000 initial capital, dynamic 1% equity risk, `pyramiding=0`, orders on close, zero commission, 1% long/short margin, a 50-bar readiness threshold, a 1.5 ATR stop, TP1 at 1.5R, TP2 at 2.5R, 50% off at TP1, and a breakeven runner after TP1.

The Pine file does not encode its chart symbol, venue, timeframe, visible history, or Strategy Tester date filter, and no open TradingView chart retained those values. The closest repository configuration is `BTCUSDT.P` on `15m`, mapped by this project to Bitget USDT perpetuals. The reproduction below therefore makes the context inference explicit: BTCUSDT on 15m, using public Binance spot candles as the repo's documented price-action proxy, from 2021-01-01 through the last fully closed candle at 2026-08-20 15:59:59 UTC. The recovered Pine parameters themselves are exact; venue fills are not claimed to be exact.

The instrumented Pine copy is `scripts/tradingview/mindset-v1-signal-execution-parity.pine`. The local repeatable audit is `npm run diagnose:mindset-pine -- BTCUSDT 15m 2021-01-01T00:00:00Z 2026-08-20T15:59:59.999Z`.

## 2. Pine signal/execution diagnosis

“Distinct opportunity” means a false-to-true transition into a LONG or SHORT condition. “Entry request” means the condition was true while the one-position Pine strategy was flat. “Actual entry” is a filled round trip or the one trade still open at the end.

| Measure | BTCUSDT 15m result |
|---|---:|
| Bars | 197,466 |
| LONG-condition bars | 70,650 |
| SHORT-condition bars | 65,993 |
| Distinct LONG opportunities | 8,356 |
| Distinct SHORT opportunities | 8,056 |
| LONG entry requests / actual entries | 5,840 / 5,840 |
| SHORT entry requests / actual entries | 5,806 / 5,806 |
| Actual entries | 11,646 |
| Closed trades | 11,645 |
| Trades open at end | 1 |
| Sizing failures | 0 |
| Capital/margin rejected entries | 0 |
| Condition bars blocked while a position was open | 124,997 |
| Median / maximum closed-trade duration | 8 / 617 bars |
| Longest LONG / SHORT condition run | 75 / 76 bars |
| Maximum entry margin required | 33.40% of equity |

The local emulator follows TradingView's documented historical open/extreme/extreme/close path and only applies the TP1 breakeven change on the next bar. Small fill differences remain possible versus TradingView, but no reasonable fill ordering can turn 11,646 accepted entries into approximately two.

### Timeframe sensitivity

The same recovered parameters and 2021-01-01 through 2026-08-20 window produce:

| Timeframe | Bars | Condition bars | Distinct opportunities | Actual entries | Closed | Open at end |
|---|---:|---:|---:|---:|---:|---:|
| 15m | 197,466 | 136,643 | 16,412 | 11,646 | 11,645 | 1 |
| 1h | 49,370 | 34,148 | 3,991 | 2,828 | 2,828 | 0 |
| 4h | 12,346 | 8,531 | 917 | 664 | 664 | 0 |
| 1d | 2,057 | 1,371 | 133 | 104 | 104 | 0 |
| 1w | 293 | 159 | 17 | 14 | 13 | 1 |
| 1M | 67 | 11 | 1 | 2 | 2 | 0 |

### Cause of the reported approximately two trades

The evidence rules out genuinely having only two signals, continuous signal state as the sole cause, generally long-lived positions, quantity/capital restrictions, and ordinary TradingView order processing on the inferred 15m configuration. The median position lasted eight 15m bars, sizing and margin rejected nothing, and thousands of entries filled.

The two-trade result is reproduced exactly when the same multi-year BTC window is run on the monthly timeframe: 11 LONG-condition bars form one distinct LONG state and produce two completed entries. **Timeframe choice is therefore the strongest explanation.** Because the original chart context cannot be recovered, this is a high-confidence diagnosis rather than proof of the exact screenshot. If the screenshot was not monthly, its chart date filter/history depth or a different implementation/settings context was not the recovered Pine configuration.

## 3. Trading Lab suppression versus raw Pine

Across the same six 1,000-bar A–F datasets and the same 60/20/20 split boundaries, the ungated recovered Pine logic produced 3,415 condition bars, 418 distinct state transitions, and 328 entries. Frozen v1 inside Trading Lab recorded 3,263 signal-state bars, but executed only 207 trades/open positions: 122 development trades, 47 validation trades/open positions, and 38 OOS trades. It skipped 3,056 signal-state candidates.

This confirms that Trading Lab's position/risk limits, checklist/refusal flow, kill switches, and historical edge gate materially suppress a larger raw signal set. It does not rescue the strategy's edge: the trades that survived the gates were still broadly negative after costs.

## 4. A–F methodology

`mindset_v1_1` remains a separate experimental, backtest-only strategy. A is frozen v1; B is a fresh RSI trigger; C requires normalized EMA separation; D requires an EMA20 pullback and restore; E confirms MACD direction; F confirms relative volume. Each experiment changes one entry feature. No exit was tuned.

Data is exactly 1,000 fully closed public Binance spot candles per BTCUSDT, ETHUSDT, and SOLUSDT on 1h and 4h, ending 2026-08-20 15:59:59 UTC. Each dataset is split chronologically 60% development, 20% validation, and 20% untouched OOS; every split starts a fresh in-memory account and pays its own 60-bar warmup. Baseline costs are 0.06% taker fee plus 0.02% slippage per fill; stress costs are 0.10% plus 0.05%. “Baseline OOS” and “Stress OOS” below are net P&L. OOS expectancy, profit factor, and drawdown are baseline-cost results.

| Variant | Symbol | TF | Dev trades | Val trades | OOS trades | OOS Exp R | OOS PF | Max DD | Baseline OOS | Stress OOS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | BTCUSDT | 1h | 21 | 10 | 6 | -1.252 | 0.300 | 2.70% | -$187.55 | -$269.46 |
| B | BTCUSDT | 1h | 2 | 0 | 0 | 0.000 | 0.000 | 0.00% | $0.00 | $0.00 |
| C | BTCUSDT | 1h | 20 | 9 | 6 | -1.252 | 0.300 | 2.70% | -$187.55 | -$269.46 |
| D | BTCUSDT | 1h | 3 | 1 | 4 | -1.645 | 0.200 | 2.05% | -$164.31 | -$225.57 |
| E | BTCUSDT | 1h | 21 | 10 | 6 | -1.252 | 0.300 | 2.70% | -$187.55 | -$269.46 |
| F | BTCUSDT | 1h | 21 | 10 | 6 | -1.252 | 0.300 | 2.70% | -$187.55 | -$269.46 |
| A | BTCUSDT | 4h | 21 | 7 | 7 | -1.260 | 0.000 | 2.21% | -$220.63 | -$239.99 |
| B | BTCUSDT | 4h | 0 | 1 | 0 | 0.000 | 0.000 | 0.00% | $0.00 | $0.00 |
| C | BTCUSDT | 4h | 20 | 6 | 6 | -1.265 | 0.000 | 1.90% | -$189.81 | -$205.67 |
| D | BTCUSDT | 4h | 5 | 4 | 2 | -1.315 | 0.000 | 0.66% | -$65.82 | -$71.16 |
| E | BTCUSDT | 4h | 21 | 7 | 7 | -1.260 | 0.000 | 2.21% | -$220.63 | -$239.99 |
| F | BTCUSDT | 4h | 21 | 7 | 7 | -1.260 | 0.000 | 2.21% | -$220.63 | -$239.99 |
| A | ETHUSDT | 1h | 20 | 8 | 6 | -0.827 | 0.520 | 2.56% | -$124.11 | -$172.98 |
| B | ETHUSDT | 1h | 2 | 2 | 1 | 1.770 | ∞ | 0.00% | +$44.21 | +$39.15 |
| C | ETHUSDT | 1h | 20 | 8 | 4 | 1.005 | 4.200 | 0.31% | +$100.55 | +$79.62 |
| D | ETHUSDT | 1h | 6 | 2 | 3 | -1.693 | 0.260 | 1.71% | -$127.06 | -$155.90 |
| E | ETHUSDT | 1h | 20 | 8 | 6 | -0.827 | 0.520 | 2.56% | -$124.11 | -$172.98 |
| F | ETHUSDT | 1h | 20 | 8 | 6 | -0.827 | 0.520 | 2.56% | -$124.11 | -$172.98 |
| A | ETHUSDT | 4h | 20 | 7 | 8 | -0.619 | 0.430 | 2.17% | -$123.71 | -$142.95 |
| B | ETHUSDT | 4h | 0 | 0 | 0 | 0.000 | 0.000 | 0.00% | $0.00 | $0.00 |
| C | ETHUSDT | 4h | 20 | 7 | 4 | -0.742 | 0.390 | 1.21% | -$74.34 | -$83.17 |
| D | ETHUSDT | 4h | 9 | 2 | 3 | -0.170 | 0.790 | 0.59% | -$12.77 | -$19.86 |
| E | ETHUSDT | 4h | 20 | 7 | 8 | -0.619 | 0.430 | 2.17% | -$123.71 | -$142.95 |
| F | ETHUSDT | 4h | 20 | 7 | 8 | -0.619 | 0.430 | 2.17% | -$123.71 | -$142.95 |
| A | SOLUSDT | 1h | 20 | 6 | 4 | -0.850 | 0.330 | 1.26% | -$84.97 | -$110.79 |
| B | SOLUSDT | 1h | 2 | 0 | 0 | 0.000 | 0.000 | 0.00% | $0.00 | $0.00 |
| C | SOLUSDT | 1h | 20 | 5 | 6 | 0.578 | 1.930 | 0.93% | +$86.68 | +$51.64 |
| D | SOLUSDT | 1h | 6 | 1 | 2 | 1.845 | ∞ | 0.00% | +$92.25 | +$82.45 |
| E | SOLUSDT | 1h | 20 | 6 | 4 | -0.850 | 0.330 | 1.26% | -$84.97 | -$110.79 |
| F | SOLUSDT | 1h | 20 | 6 | 4 | -0.850 | 0.330 | 1.26% | -$84.97 | -$110.79 |
| A | SOLUSDT | 4h | 20 | 7 | 7 | 0.271 | 1.430 | 0.95% | +$47.28 | +$32.74 |
| B | SOLUSDT | 4h | 0 | 0 | 1 | 1.930 | ∞ | 0.00% | +$48.17 | +$45.47 |
| C | SOLUSDT | 4h | 21 | 7 | 4 | -0.115 | 0.850 | 0.75% | -$11.52 | -$18.52 |
| D | SOLUSDT | 4h | 5 | 3 | 3 | 0.843 | 2.950 | 0.32% | +$63.16 | +$56.32 |
| E | SOLUSDT | 4h | 20 | 7 | 7 | 0.271 | 1.430 | 0.95% | +$47.28 | +$32.74 |
| F | SOLUSDT | 4h | 20 | 7 | 7 | 0.271 | 1.430 | 0.95% | +$47.28 | +$32.74 |

Positive cells are not promotion evidence: the apparent winners have only one to seven OOS trades, often conflict with their development/validation result, and do not establish robustness across symbols. E and F changed raw signal eligibility but produced the same executed trades as A in every row, so their default filters added no realized entry value in this sample.

## 5. Conclusion and recommendation

The evidence supports a combination of **A + B + C**:

- **A — no demonstrated entry edge:** frozen v1 is negative after baseline costs in five of six OOS rows; its one positive row has only seven trades. E and F do not improve executed outcomes.
- **B — too few independent opportunities to evaluate the filtered variants:** every row has at most eight OOS trades, and B has only two OOS trades across all six rows.
- **C — Trading Lab gating suppresses a larger raw signal set:** on aligned splits, raw Pine produced 418 distinct opportunities and 328 entries, while Trading Lab executed/opened 207 and skipped 3,056 repeated signal-state candidates.

Keep v1 frozen as a forward-paper benchmark, keep v1.1 experimental/backtest-only, do not tune exits, and do not promote any A–F candidate. The research branch is suitable to commit as an audit/research tooling change if the full validation suite passes; it is not evidence for real-money readiness.
