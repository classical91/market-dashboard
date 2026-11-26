# Gann Intelligence

`/gann.html` (alias `/tradehunter/gann`) and `/api/gann/*`. **Experimental.** Nothing on this
page or in its API is a prediction, a signal or an order. It shows where Gann's arithmetic places
levels and time windows, how many independent methods agree, and — in the backtest — whether that
agreement has done better than chance on the loaded history.

## Data

- Candles come from `SignalScreenerService.getCandles` — the same cached Binance spot klines
  (500 bars) the screeners already pull. No new provider, key or paid API.
- Only **closed** candles are analysed (`dropUnclosedCandle`). The live candle's close is returned
  as `livePrice` for display only.
- Symbols are limited to the shared `TOP_TOKENS` universe so the page never widens what the app
  fetches. Timeframes: `15m`, `1h`, `4h`, `1D`, `1W`.
- When the candle source fails the API answers `502` with the reason, and the page draws nothing.
  Fixtures in `test/helpers/gann-fixtures.js` are synthetic and used only by tests.

## Caching and recalculation

Results are cached in the shared `MemoryCache` under
`gann:<kind>:<symbol>:<timeframe>:<last closed openTime>:<normalised settings>`. A new closed
candle changes the key, so automated results recalculate exactly on confirmed closes and never in
between. Two viewers with the same settings share one computation. Freshness uses
`src/services/data-freshness.js` (FRESH / STALE / UNAVAILABLE) on the last closed candle and the
computation time.

## Formulas

All geometry lives in `public/assets/js/gann-math.js`, loaded by both the server and the page, and
works in **bar index × price** — never pixels — so zoom and resize cannot change a value.

| Tool | Formula |
| --- | --- |
| Square of Nine | level at θ degrees from base `p`: `(√p + θ/180)²`. One 360° rotation adds 2 to `√p`. Wheel position: `((√p − 1)·180) mod 360`. |
| SQ9 normalisation | price × 10ᵏ into [100, 1000) before the square root, levels scaled back. Reported as `factor`; can be turned off. |
| Swing pivots | bar `i` is a pivot high/low if it is the strict extreme of `left` bars before and `right` bars after (ties go to the earlier bar). `confirmedIndex = i + right`. |
| Auto anchor | most extreme confirmed pivot high and low in the last `lookback` bars (150); the more recent of the two, or the requested side. |
| Price-to-time scale (1x1) | `atr`: mean true range of the last 14 bars; `range`: (highest high − lowest low) / bars over 100 bars; `manual`: the value given. |
| Gann Fan | line `price(i) = anchor + dir · ratio · scale · (i − anchorIndex)`, `dir` = +1 from a low, −1 from a high; ratios 8, 4, 3, 2, 1, ½, ⅓, ¼, ⅛ (8x1 … 1x8). |
| Gann Box | between anchor and counter-swing (most extreme opposite pivot in the lookback): price and time at 0, ⅛, ¼, ⅓, ⅜, ½, ⅝, ⅔, ¾, ⅞, 1, repeated two box-widths forward. |
| Gann Square | `squareBars = |anchor − counter| / scale`; time marks at ¼, ½, ¾, 1, 1½, 2, 3, 4 × squareBars from the anchor. |
| Square of 144 | price `anchor ± d · scale`, time `anchorIndex + d`, for d ∈ {18, 36, 48, 54, 72, 90, 96, 108, 126, 144}. |
| Time cycles | bar counts {30, 45, 60, 90, 120, 144, 180, 270, 360} and calendar days {same} from the anchor and the counter-swing, each a window of ± `cycleTolerance` (2) bars. |
| Fibonacci | retracements 0–100% of the counter-swing ↔ anchor leg. |
| Anchored VWAP | Σ(typical price · volume) / Σ volume from the anchor bar. |
| Volume profile | last 200 bars, 40 bins, each bar's volume spread evenly over the bins its range covers; POC and 70% value area. |
| RSI / MACD | `rsi(14)`, `macd(12, 26, 9)` from `signal-screener.js` (unchanged). |

### Confluence

Levels within ±8 ATR of the last close are grouped when they sit within `confluenceAtr · ATR`
(¼ ATR) of a cluster's lowest member. A cluster's **count is the number of distinct methods**
(Square of Nine, Gann Fan, Gann Box, Square of 144, Fibonacci, VWAP, Volume Profile) — five SQ9
levels in one zone are still one. Time windows are grouped the same way within the cycle
tolerance. The count measures agreement only; it is not a probability, and the page shows no
confidence score.

## Backtest (`/api/gann/backtest`)

Walk-forward over the loaded closed candles with fixed settings (nothing is optimised). The first
`max(lookback, 60)` bars are warm-up; the remainder is split 70% in-sample / 30% out-of-sample by
time.

**No look-ahead / repaint:** at bar `t` the anchor uses only pivots with `confirmedIndex ≤ t`, ATR
and scale are computed through `t`, fan values for bar `t+1` come from that state, and strategy
entries fill at the next bar's open. `test/gann-backtest.test.js` checks that the state at `t` is
identical whether or not later candles exist.

1. **Level reactions.** A touch is bar `t+1`'s range crossing a level from the state at `t`. The
   outcome is decided by closes within 10 bars: *reaction* if price closes 1 ATR away on the
   approach side first, *break* (a false signal) if it closes 1 ATR through first, otherwise
   unresolved. Touches too close to the end of data are dropped (censored). **Baseline:** the
   midpoints between the same Gann levels — same count and spacing, no Gann meaning.
2. **Cycle reversals.** Share of confirmed swing pivots that fall inside a bar-cycle window
   projected from the anchor known at `pivot − tolerance − 1`. **Baseline:** the share of all bars
   those windows cover (what randomly timed pivots would score). `lift = hit rate / baseline`.
3. **Strategy comparison.** RSI(14) reversal (long on a cross up through 30, short on a cross down
   through 70; exit at RSI 50, a 1.5 ATR stop, or 20 bars), unfiltered vs. only when the close is
   within ½ ATR of a Gann level vs. of a control level. Costs are a named scenario from
   `src/services/trading/cost-scenarios.js` (taker fee + slippage, charged on entry and exit;
   funding is not charged and is flagged).
4. **Historical cycles.** Distribution of bar counts between successive same-type pivots, and how
   often they land within the tolerance of a Gann bar number versus the share of lengths that would.

Every result carries the dataset span, split, settings, cost scenario and a SHA-256 `fingerprint`
of candles + settings, so it can be reproduced exactly.

## TraderClaw (`GET /api/gann/observations?symbol=&timeframe=`)

Schema `gann-observations/v1`: nearest three support and resistance clusters (price, distance,
sources, count), upcoming cycle windows, the anchor, and higher-timeframe structure. Always
`experimental: true`, `validated: false`, `readOnly: true`. It has no action, side, size or
confidence field and the route has no write method. With site login enabled it is reachable with
`x-admin-key` (`ADMIN_API_KEY`) and no session; nothing else under `/api/gann` is. Nothing in this
feature touches paper or live execution. Treat its observations as unvalidated until a paper-trading
study shows otherwise.

## Assumptions and limitations

- Gann methods have no agreed canonical definition; choices above (angle set, SQ9 normalisation,
  ATR as the 1x1 unit, cycle numbers) are conventional but arbitrary, and results depend on them.
- The Square of Nine depends on price units. Normalisation makes assets comparable but is itself
  an assumption; turn it off to use raw prices.
- 500 bars per series is a short history. Low touch/pivot counts are reported as caveats; treat
  every backtest number as exploratory.
- Cycles are counted in bars of the selected timeframe and in calendar days; exchange downtime or
  missing bars shift bar counts relative to calendar time.
- Spot Binance candles only; no funding, no order-book effects.
