# Cross-Market Open Interest — accuracy audit

Scope: `/cross-market-oi.html`, `GET /api/cross-market-oi`, `src/services/cross-market-oi/`,
`src/config/cross-market-oi.js`. The crypto OI screener (`/open-interest.html`) is a separate
feature and was not part of this audit.

The only acceptance criterion: every value shown is traceable to a known market-data observation,
calculated from comparable observations by a documented method, correctly dated and labelled, and
never fabricated when reliable data is unavailable.

## 1. What each displayed number is

| Display | Provider | Provider symbol | Exchange | Contract queried | Scope |
|---|---|---|---|---|---|
| BTC | CFTC COT Legacy, Futures Only (`6dca-aqww`) | code `133741` (BITCOIN) | CME | the 5-BTC contract market (not Micro Bitcoin) | all listed expiries |
| DXY | same | `098662` (USD INDEX) | ICE Futures U.S. | contract market | all listed expiries |
| GC | same | `088691` (GOLD) | COMEX | contract market (not Micro Gold) | all listed expiries |
| NG | same | `023651` (NAT GAS NYME) | NYMEX | Henry Hub NG contract market | all listed expiries |
| ES | same | `13874A` (E-MINI S&P 500) | CME | E-mini only (not Micro, not the "S&P 500 Consolidated" line) | all listed expiries |
| RTY | same | `239742` (RUSSELL E-MINI) | CME | E-mini only (not Micro) | all listed expiries |

- **Raw value**: `open_interest_all` from the report dated `report_date_as_yyyy_mm_dd`
  (positions as of Tuesday; published Friday 3:30pm ET).
- **Expiration**: none — `open_interest_all` sums every listed expiry. It is neither front-month
  nor a continuous-contract series. The API now says so on every row (`contractScope:
  "ALL_EXPIRIES"`, `expiration: null`).
- **Comparison value**: the report exactly 1 or 4 weeks earlier (±2 days for holiday-shifted
  reports). Nothing further back is substituted.
- **Calculation**: `((currentOI − previousOI) / previousOI) × 100`, rounded to 2 dp. Only when a
  comparable previous report exists and its OI is > 0.
- **Daily (optional, Databento)**: `statistics` schema, `stat_type` 9 (open interest), by parent
  symbol (`ES.FUT`, …; DXY from `IFUS.IMPACT` `DX.FUT`), summed across outright expiries per
  trading date. Same all-expiry scope as the weekly figure.
- **Caching**: in-memory 1 h for a live fetch, 5 min after a failure; last good copy persisted to
  `DATA_DIR/cross-market-oi.json` and served as `CACHED` / `STALE` (never `LIVE`) when the source
  fails.

## 2. ES: +18.08% on the page vs ≈ −0.15% on the TradingView reference

The two numbers measure different things; the page's number was not changed.

| | Market Dashboard | TradingView reference |
|---|---|---|
| Series | CFTC `13874A`, all ES expiries combined | a chart OI series, normally the continuous front contract (`ES1!`) |
| Cadence | weekly report, Tuesday positions | daily session OI |
| Dates | e.g. 15 Sep 2026 vs 8 Sep 2026 | the chart's last bar vs the one before |
| Roll handling | none needed for the level (all expiries summed); flagged ROLL | continuous contract switches expiry at its roll rule |

Why the all-expiry total jumps in that particular week: the September 2026 ES contract expired on
Friday 18 Sep (third Friday). In the roll week, traders open December positions before closing
September ones, so for a few days both contracts carry large open interest and the combined total
swells; it falls back when September expires. A week-over-week change measured into that bulge
(8 Sep → 15 Sep) is large and positive while a single contract's daily change can be near zero.
The same effect shows on RTY and DXY (also quarterly).

What the page does about it: the value stays as the correct CFTC all-expiry change; the metric is
now labelled **"OI change, all expiries"**; every row shows both dates; the ROLL badge and the
detail panel say the change spans the 18 Sep expiry and is mostly the roll.

**Not independently verified in this session**: the container's network policy blocks
`publicreporting.cftc.gov` and the production host, so the actual 8 Sep / 15 Sep `13874A` values
could not be pulled. The explanation above is the mechanism consistent with the page's inputs;
confirm it with `node scripts/oi-diagnostics.js --url <prod> --cftc` (below). If the direct CFTC
recomputation does not match the page, that is a bug; if the dates are not 15 Sep vs 8 Sep, the
screenshot and the page were reading different reports.

## 3. Findings and fixes

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | ROLL flag looked only at the newest report date | A 4W change measured from inside the roll window (e.g. 13 Oct vs 15 Sep) showed the roll collapse with no flag | Flag when **either end** of the comparison touches a quarterly roll window; row carries `rollExpiry` |
| 2 | Label "Open interest" for a % change of an all-expiry total | Read as absolute OI, or as front-month / continuous OI | Metric labelled "OI change, all expiries"; button "OI change"; row sub-line "All expiries · N contracts on <date> · Δ vs <date>"; value shows `%` |
| 3 | No check that a contract code is the market it is labelled as | A wrong code (e.g. Micro E-mini) would plot another market under the ES label | `cftcName` pattern per market; a mismatch is an error row (`IDENTITY_MISMATCH`); older reports under another name are never a comparison base |
| 4 | A market absent from the latest report showed its older change with no marker (until 11 days) | Older data plotted as if concurrent with the other five | Any row older than the newest report (±2 days weekly; any session daily) is `STALE`, with the dates in the reason |
| 5 | Daily 1D/5D took the Nth entry back without checking the calendar | A missing session silently stretched "1D" over several days | Comparison refused when the span exceeds a weekend + holidays (1D ≤ 4 days, 5D ≤ 10) |
| 6 | Databento `update_action = delete` was skipped, not applied | A withdrawn expiry figure stayed in the sum | Delete removes that expiry's value for the day |
| 7 | Databento parent symbol also covers calendar spreads | Any spread OI would double-count positions | `map_symbols=true`; spread/UD symbols are excluded; each day records how many expiries it sums (`contracts`) |
| 8 | Missing comparison produced a blank value with no reason; coverage counted it as data | "Insufficient history" indistinguishable from a bug | `valueStatus` (`OK`, `INSUFFICIENT_HISTORY`, `ZERO_BASE`, `IDENTITY_MISMATCH`, `UNAVAILABLE`) + `statusReason`; `coverage.withData` counts plotted values, `coverage.reported` counts markets in the source |
| 9 | Fallback copy flagged only at source level | Row consumers couldn't tell | `isFallback`, `retrievedAt` (original fetch time) on each row |

Checked and found correct: the % formula; zero/NaN/missing handling (never 0); previous-report
lookup (no nearest-older substitution); CFTC outage → last good copy labelled CACHED/STALE, or
UNAVAILABLE with nulls; no hard-coded fallback values; no silent contract substitution.

## 4. Row metadata now served

`observationDate`, `comparisonDate` (`previousDate` kept for compatibility), `retrievedAt`,
`source`, `contract`, `reportName`, `contractScope`, `expiration` (null — aggregate),
`isPreliminary` (null — neither source flags it; unknown, not asserted), `isFallback`, `isStale`,
`identityVerified` (true / false / null = no pattern configured), `rollWindow`, `rollExpiry`,
`valueStatus`, `statusReason`, and on Daily `contractsCounted` / `previousContractsCounted`.

## 5. Validation table

Run against a deployment that can reach the CFTC:

```bash
node scripts/oi-diagnostics.js --url https://<host> --cftc          # weekly Δ1W, with direct CFTC recomputation
node scripts/oi-diagnostics.js --url https://<host> --lookback 4w --cftc
node scripts/oi-diagnostics.js --url https://<host> --timeframe D   # Daily, if DATABENTO_API_KEY is set
node scripts/oi-diagnostics.js --url https://<host> --cftc --json   # machine-readable
```

It prints, per market: contract, reported name and identity check, scope, OI and date, previous
OI and date, the served % and an independent recomputation, roll/stale/fallback flags, and with
`--cftc` the CFTC's own figures for the same two dates with the difference and MATCH / MISMATCH.

| Instrument | Symbol | Contract | Our OI | Obs. date | Prev. OI | Cmp. date | Δ | Reference | Diff | Explanation | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Bitcoin | BTC | 133741 | run script | | | | | CFTC direct | | | pending |
| U.S. Dollar Index | DXY | 098662 | run script | | | | | CFTC direct | | | pending |
| Gold | GC | 088691 | run script | | | | | CFTC direct | | | pending |
| Natural Gas | NG | 023651 | run script | | | | | CFTC direct | | | pending |
| E-mini S&P 500 | ES | 13874A | run script | | | | +18.08 (page) | TradingView ≈ −0.15 | n/a | different series: all-expiry weekly vs front-contract daily; roll week (expiry 18 Sep) | explained; raw values pending |
| E-mini Russell 2000 | RTY | 239742 | run script | | | | | CFTC direct | | | pending |

## 6. Open items (not changed; need live data to settle)

- **Databento OI date**: the daily date comes from `ts_ref`, falling back to `ts_event`. If CME
  OI records carry no `ts_ref`, the date would be the publication morning, one session after the
  session the OI describes. Check a raw `GLBX.MDP3` `statistics` record before relying on Daily.
- **Databento DXY**: `IFUS.IMPACT` `DX.FUT` availability and its OI stat type are unverified.
- **Treasury roll timing** (ZN/ZT/ZB, not in the default six): positions roll before first notice
  day at the end of the prior month; the third-Friday window only partly covers it.
- **Unpatterned markets** (NQ, ETH, 6E, 6J, SI, HG, CL, ZN, ZT, ZB): identity shows
  "Not checked"; add a `cftcName` pattern once each report name is confirmed.

## 7. Tests

`test/cross-market-oi-accuracy.test.js` covers positive / negative / zero change, missing current,
missing previous, zero previous OI, stale observation, a market behind the others, contract
expiration (aggregation across expiries), contract roll (4W spanning the window), symbol mapping
and identity mismatch, provider failure, cached/fallback data, weekly and daily date boundaries,
spreads and deletes, and the ES +18.08% regression.
