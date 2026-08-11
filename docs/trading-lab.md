# Trading Lab — TraderClaw migration

The Trading Lab is TraderClaw's trading-laboratory layer rebuilt as native
JavaScript inside Market Dashboard: paper execution, risk sizing, historical
edge gating and expectancy metrics, running on one runtime, one deployment,
one config system and one test stack.

This is a **feature migration, not a repository copy**. The Python files were
read and re-implemented; nothing is shelled out to at runtime. The only place
Python still appears is `scripts/traderclaw-parity.js`, a development-time
check that compares the two implementations.

## The pipeline

```
market data → regime → setup → edge gate → risk sizing → paper trade → result
                                                              ↓
                                                   strategy statistics
```

The Decision Engine answers "does this setup look good right now". The Trading
Lab answers "have setups like this actually made money", sizes the trade that
follows, and records what happened so the next answer is better informed.

## Module map

| TraderClaw (Python) | Market Dashboard (JS) | Notes |
| --- | --- | --- |
| `config.py` | `src/services/trading/config.js` | Same env var names, same validation, same two-gate live-trading rule. |
| `risk_metrics.py` | `src/services/trading/metrics.js` | Expectancy, profit factor, drawdown, R-multiples, grouped leaderboards. |
| `edge_gate.py` | `src/services/trading/edge-gate.js` | ALLOW / REDUCE / BLOCK over closed-trade history. |
| `checklist.py` | `src/services/trading/checklist.js` | Kill switches, regime gates, 0-100 scoring. |
| `executor.py` (sizing half) | `src/services/trading/risk.js` | ATR sizing and stop/target geometry. Order placement deliberately excluded. |
| `paper_trader.py` | `src/services/trading/paper-trader.js` | TP1/TP2 scale-outs, breakeven stop, gap-aware stop fills, daily/weekly rollover. |
| — | `src/services/trading/backtest.js` | New: bar replay over the same paper-trading engine. |
| `shadow_trader.py`, `alts_trader.py` | *books* in `trading-lab.js` | Main / Shadow / Alts are named books over one engine rather than three near-duplicate services. |
| `app.py`, `dashboard.py`, Flask routes | `src/routes/trading-lab.js`, `public/trading-lab.html` | Retired; Market Dashboard's Express + vanilla JS replaces them. |

### Behaviour deliberately preserved

These are the details that make paper results honest, and each has a test:

- **Real scale-outs.** TP1 closes `TP1_CLOSE_FRACTION` of the *initial* size,
  banks that P&L, and moves the stop to breakeven on the remainder. The
  archived trade carries the summed realized P&L across every exit, so
  expectancy describes the strategy that actually ran.
- **Asymmetric fills.** Stops fill at the *worse* of the stop level and the
  observed price, because prices gap. Targets fill at the target itself, so a
  favourable overshoot is never credited.
- **One win per trade.** Win/loss is counted once on total realized P&L, not
  once per partial fill.
- **Closed trades only.** Open P&L belongs in equity, never in the edge
  calculation.
- **Kill switches read the real ledger.** Callers can pass market state, but
  open positions, loss streaks and daily/weekly drawdown always come from the
  account itself and override whatever was passed.
- **Paper by default.** `TRADING_MODE=live` requires `ALLOW_LIVE_TRADING=true`
  as a second gate. No live order path exists in this code at all yet.

## Backtesting

`backtest.js` replays historical candles through the **same**
`PaperTradingService` that live paper trading uses. It does not reimplement
fills, so a backtest and a forward paper run agree by construction — same TP1
scale-out, same breakeven move, same gap-aware stop, same metrics.

Backtests can include execution costs through the same paper ledger. Configure
`BACKTEST_MAKER_FEE_RATE`, `BACKTEST_TAKER_FEE_RATE`,
`BACKTEST_SLIPPAGE_RATE`, `BACKTEST_FUNDING_RATE_8H`, and
`BACKTEST_EXECUTION_LATENCY_MS` as decimal rates or milliseconds. Each fill
records its fee, funding charge or credit, requested price, and
slippage-adjusted fill price, so expectancy and R-multiple are net of costs
rather than a cosmetic summary adjustment.

Two things make a backtest lie, and both are addressed explicitly:

- **Lookahead.** Indicators and signals at bar *i* are computed from bars
  `0..i` only, and entries fill at bar *i*'s close — never at a price the
  strategy could not have known when it decided. Tested directly: the strategy
  callback's window is asserted to grow by exactly one bar per call.
- **Optimistic intra-bar ordering.** A candle gives open/high/low/close but not
  the path between them. When a stop and a target both sit inside one bar's
  range, assuming the target came first inflates every result. Each bar is
  therefore replayed as a *sequence* — open, then the **adverse** extreme, then
  the favourable one, then close — so the paper trader fires the stop first
  whenever both were reachable. Results are pessimistic by design.

That second point is why the module drives the paper trader with a price
sequence rather than a single price per bar: the pessimism is expressed purely
as the order the extremes are fed in, with no duplicated fill logic.

Other honesty properties, each with a test:

- A position still open when the candles run out is **reported, not
  force-closed**. Force-closing would invent an exit the strategy never
  signalled and pollute expectancy.
- Backtests run against a **throwaway ledger in a temp directory**, deleted in
  a `finally`. The live books are never touched, and the run's edge gate sees
  only the trades that run produced.
- Refused candidates are recorded with the reasons they were refused, so a
  strategy that never trades is distinguishable from one with no signals.

The load-bearing test is `a trend strategy finds no edge in a driftless random
walk`: across four seeds, the built-in trend-breakout strategy must not show
expectancy above 0.15R or a profit factor above 1.5. There is no trend to
follow in a random walk, so if that test ever starts passing with a healthy
edge, the backtester has developed a lookahead or an optimistic fill — far
likelier than the strategy having become good. A companion test on a strongly
trending series checks the opposite failure: that the pessimistic fills have
not simply made *every* strategy lose.

## Strategies

The backtester takes a **strategy** from a small registry
(`src/services/trading/strategies/`), so several strategies can be replayed
over the same candles through the same execution engine and compared on equal
terms.

A strategy is a plain object:

```js
{
  id, name, description,
  requiredWarmupBars,               // floor the run cannot undercut
  evaluate(candles, index, context) // -> signal object
}
```

`evaluate` must read nothing past `index` — that contract is what keeps a
backtest honest, and the backtester enforces it by handing over a slice that
ends at the decided bar. The signal it returns always carries `reasons[]` and
`indicators{}`, so the UI can explain why a strategy fired *or* why it stayed
flat, plus optional `confidence`, `stopHint` and `targetHint`.

Stop and target hints are **recorded, not applied**: sizing and exits stay with
`planTrade()` and the paper trader, so two strategies are compared on the same
execution model rather than on who guessed a better stop.

| id | What it is |
| --- | --- |
| `mindset_v1` | The live scanner's strategy, imported unchanged from `live-scanner.js` — EMA20/EMA50 trend with an RSI band filter. The default. |
| `smc_v1` | Backtest-only Smart Money Concepts approximation (below). |

### smc_v1

Not "SMC done properly" — discretionary SMC reads liquidity, sessions and
inducement, none of which is here. It takes the four ideas that *can* be
written as replayable rules and requires all four to agree:

1. **Trend alignment.** Higher-timeframe context when the caller supplies one,
   otherwise EMA21/EMA50 on the traded chart. No counter-trend fades.
2. **Break of structure.** A *close* beyond the most recent confirmed fractal
   swing. Pivots are only used once bars have closed on both sides of them, so
   there is no edge-of-chart pivot to peek at.
3. **Displacement.** The break must leave a fair value gap — a three-bar
   imbalance — delivered by a candle whose range is at least 1.2× ATR.
4. **Retest.** Entry is a pullback *into* that gap, on a bar after the gap has
   fully formed. Entering on the displacement candle itself is the commonest
   way an SMC backtest flatters itself, and two tests exist to stop it.

Anything short of all four is `FLAT` **with the reason it fell short**.

smc_v1 is deliberately **backtest-only**. `LIVE_SCANNER_STRATEGY` still resolves
against the live scanner's own registry, which contains `mindset_v1` alone;
promoting a strategy is a separate, explicit change.

### One intentional divergence

`round.js` implements Python's half-to-even rounding rather than JS's
`Math.round`. Without it the two engines disagreed by a cent on every exact
tie, and rounding half-up would slowly bias net P&L upward over a long
history. The parity check found this; it is why the check exists.

## Parity

```bash
npm run parity -- --traderclaw ../traderclaw
```

Runs identical inputs through both engines and fails on any disagreeing field.
It currently reports **exact agreement on all 486 compared fields**.

What it covers:

| Area | Cases | Compared |
| --- | --- | --- |
| Summary metrics | 8 trades | Every field of `calculate_trade_metrics`, over fixtures chosen for negative-value rounding, an infinite profit factor, drawdown off a running peak, and grouping-key fallbacks. |
| Grouped leaderboards | 3 dimensions | Row-by-row metrics *and* the ranking order, which is its own logic. |
| Edge gate | 4 | Decision and size multiplier at no history, a small sample, a deep losing sample and a deep winning one. |
| Checklist | 23 | Decision, score, size multiplier and kill-switch flag — one scenario per rule that can change the verdict, so a divergence names the rule that broke. |
| Sizing and levels | 7 | Stop, both targets, stop distance, resolved ATR and position size, both directions, with and without an ATR on the signal. |
| Paper-trade lifecycles | 8 | Position state, every individual exit (reason/price/size/P&L), archived history and account totals, across the TP1 scale-out, the breakeven stop, gapped fills and both targets in one mark. |

Reason strings are prose and are allowed to differ; decisions, size
multipliers, and every numeric field are not.

**What it does not cover**, because those modules are not ported: TradingView
webhook ingestion, the Bitget client, Polymarket, and Telegram notifications.
Parity on the engines above is not parity on those — the archive decision needs
them ported first.

Running the checklist, sizing and lifecycle comparisons needs `python-dotenv`
and `requests` importable, since those TraderClaw modules load `config.py` at
import time. The metrics and edge-gate comparisons have no such dependency.

## API

Reads are public (like the other scanner reads); everything that writes to the
ledger is admin-gated via `x-admin-key`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/trading-lab` | — | Overview: mode, config, per-book stats and open positions. |
| GET | `/api/trading-lab/books` | — | Available books. |
| GET | `/api/trading-lab/positions?book=` | — | All positions for a book. |
| GET | `/api/trading-lab/history?book=&limit=` | — | Closed trades, newest first. |
| GET | `/api/trading-lab/metrics?book=&min_trades=` | — | Grouped expectancy leaderboards. |
| GET | `/api/trading-lab/decision-candidates?interval=&book=` | — | Every Decision Engine plan scored through the Lab. |
| POST | `/api/trading-lab/evaluate` | — | Dry run a hypothetical trade. Opens nothing. |
| POST | `/api/trading-lab/positions` | admin | Evaluate, then open if every gate agrees. |
| POST | `/api/trading-lab/positions/:id/close` | admin | Close the remainder manually. |
| POST | `/api/trading-lab/mark` | admin | Mark to market; fires any stop/target reached. |
| GET | `/api/trading-lab/strategies` | — | The backtestable strategy catalogue and the default id. Static, so the UI selector can render before a key is entered. |
| POST | `/api/trading-lab/backtest` | admin | Replay a symbol's candles. Body: `symbol`, `interval`, `strategy` (defaults to `mindset_v1`; an unknown id is a 400). Admin-gated despite being read-only: it replays hundreds of bars and pulls candles per call, so it should not be spinnable by anonymous visitors. Writes only to a temp ledger. |
| POST | `/api/trading-lab/backtest/compare` | admin | Replay several strategies over **one** candle fetch and reduce each to the promotion numbers: bars, signals, closed trades, net P&L, expectancy R, profit factor, max drawdown, win rate, worst loss streak. Defaults to every registered strategy. |
| POST | `/api/trading-lab/reset` | admin | Wipe a book back to its starting balance. |

## Migration status

Done:

1. Trading Lab section created.
2. Paper-trading data model migrated.
3. Risk sizing and SL/TP logic integrated.
4. Expectancy, drawdown, win rate, profit factor and R-multiple analytics.
5. Decision Engine connected to the paper trader.
6. Main / Shadow / Alts modelled as named books.
7. Parity check against the Python engines passing.
8. Backtesting — bar replay over the same paper-trading engine.
9. Signal-bot bridge — signal transitions feed the Lab, replacing TradingView
   alert ingestion. See "Signal source" below.
10. Auto-marking on the signal-bot interval.

Still to do, in order:

11. **Bitget integration** — port `bitget_client.py` as an isolated exchange
    adapter behind the existing two-gate safety model. Last, and separately
    reviewed.
12. **Archive TraderClaw** once 11 lands and parity still passes. Archive
    first; delete only after a period of confidence that nothing was missed.

Note that parity passing on metrics and the edge gate is not parity on Bitget,
which is not ported — the archive decision needs it in place first.

## Signal source

TradingView alert webhooks are **not** the signal source. The subscription that
produced them is gone, so alert delivery is not something to build on, and
`signal_handler.py` / `security.py` are deliberately not ported.

The Signal Bot supplies entries instead. It already re-scans the confluence
screener on a timer and detects transitions on *closed* candles, which is the
same "on bar close" semantics the alerts had, with no subscription and no
inbound endpoint to authenticate.

    SignalBot (FLAT -> LONG/SHORT)  ->  SignalTradeBridge  ->  TradingLab.execute()

`src/services/trading/signal-bridge.js`, wired into the bot's interval loop:

- **Dry run by default.** Every entry transition is scored through the whole
  checklist -> edge gate -> risk sizing pipeline and logged with its verdict,
  but nothing is opened until `SIGNAL_BOT_PAPER_TRADE_ENABLED=true`. The
  decision trail exists before anything is allowed to act on it.
- **Paper only.** It goes through `TradingLabService.execute()`, the same path
  the dashboard uses. No live-order code is reachable from the bridge, and it
  never touches `TRADING_MODE` / `ALLOW_LIVE_TRADING`.
- **Entries only, once each.** Only `FLAT -> LONG/SHORT` opens anything; flips
  and exits do not. A symbol with a position already open in the target book is
  skipped, including when it transitions on two timeframes in one scan.
- **Entry price is the signal's price**, carried on the transition rather than
  re-fetched, so the fill matches the bar the signal confirmed on. ATR comes
  from the screener's cached klines; if those fail, sizing falls back to
  `ATR_FALLBACK_PCT` rather than skipping the setup.
- **Degrades quietly.** An unreachable decision engine costs the setup its
  trend/macro points and evaluation continues; any bridge failure is caught so
  that a paper-trading fault never costs the deploy its Telegram alerts.
- **Auto-marking** runs first in each cycle, over *every* book — so hand-opened
  positions are managed too — letting stops and targets fire without the page
  open. It updates the ledger the kill switches read before that cycle's
  entries are judged.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGNAL_BOT_PAPER_TRADE_ENABLED` | `false` | Opt in, by exact value `true`, to opening paper positions. Otherwise log-only. |
| `SIGNAL_BOT_BOOK` | `main` | Which book bridged trades land in. |
| `SIGNAL_BOT_AUTO_MARK_ENABLED` | `true` | Mark open positions to market each interval. |

Auto-marking alone does not start the loop — it is a passive add-on to a cycle
that is already happening. The loop runs when Telegram is configured or paper
trading is enabled.

### Live Scanner

The Signal Bot bridge covers 4h/1D confluence signals off Binance *spot*
klines. The Live Scanner is the same idea one timeframe down and on the venue
the strategy actually trades:

    Bitget candles  ->  mindset_v1  ->  TradingLab.execute()

`src/services/trading/live-scanner.js`, started by `server.js` when
`ENABLE_LIVE_SCANNER=true`. It is a separate service rather than another Signal
Bot timeframe because all three of its inputs differ:

- **Venue.** It reads Bitget USDT-perpetuals, so `BTCUSDT.P` is a real
  instrument here instead of being proxied by its spot pair. The `.P` name is
  kept in the ledger so scanner trades never merge with the bot's spot ones.
- **Cadence.** A 60s poll on a 15m bar acts on a close within a minute, rather
  than up to a full bar later.
- **De-dupe contract.** The Signal Bot de-dupes on *state change*
  (`FLAT -> LONG`). The scanner de-dupes on symbol + direction + candle close
  time, persisted to `live-scanner-state.json`, so a restart mid-bar cannot
  re-enter a candle that was already traded. The candle is claimed *before*
  execute() runs: a setup the gates refuse stays refused for that bar instead
  of being retried every 60 seconds.

#### The intent boundary

The scanner's entire decision surface is a raw `TradeIntent`:

```json
{
  "signal": "LONG | SHORT | EXIT_LONG | EXIT_SHORT",
  "symbol": "BTCUSDT.P",
  "price": 12345.6,
  "tf": "15m",
  "source": "live_scanner",
  "strategy": "mindset_v1",
  "candleTs": "2026-08-11T00:15:00.000Z",
  "indicators": { "ema20": …, "rsi": …, "atr": … }
}
```

A strategy finds setups; the Trading Lab decides whether a setup is worth
taking and how big. So an intent carries *market observations* and nothing
else — no stop, no target, no size, no risk amount, no confidence score. ATR
rides along because it is a volatility measurement, not a stop distance;
`risk.js` is what turns it into levels by applying `SL_ATR_MULTIPLE`.

`trade-intent.js` enforces this at runtime rather than leaving it to reviewer
discipline: `buildTradeIntent()` rejects any of the forbidden fields **on the
caller's object, before destructuring** (validating the constructed intent
would be theatre — it is built from a fixed set of keys, so a smuggled
`stopLoss` would be silently dropped while the rule looked enforced),
whitelists the indicators that may ride along, and freezes the result.
`test/trade-intent.test.js` asserts no emitted intent carries a risk field.

`intent-handler.js` is the one boundary an intent crosses to become an action,
and what happens on the other side is deliberately asymmetric:

    Entry  ->  runChecklist() -> assessEdge() -> planTrade() -> openPosition()
    Exit   ->  closePosition(), no gates

Entries need gates. Exits need **protection**. If the strategy reports its
thesis has broken, a gate that could veto the close would convert a risk
control into a risk — the edge gate would be holding a losing position open on
the grounds that positions like it have done badly, which is exactly backwards.
So an exit consults neither the checklist nor the edge gate and cannot be
blocked by a kill switch, a loss limit or a position cap. It closes with reason
`SCANNER_EXIT`. Exits are also exempt from the per-candle claim: a broken
thesis should be actionable on the bar it breaks, and re-emitting an exit for
an already-closed position is a no-op the handler absorbs.

Exit intents are emitted from the strategy reading alone, without consulting
the book — `intentsFor()` is a pure function of the candles. One bar can
therefore produce both an exit and an entry (trend flipped down: close the
long, then consider the short), returned in that order so the position slot is
freed before the entry is judged. The cycle reports the most consequential
outcome rather than the last, so an executed exit is never masked by the
`already-evaluated` of the entry behind it.

`mindset_v1` is the MVP strategy and deliberately small — EMA20/EMA50 for trend
direction plus an RSI band filter (50-75 long, 25-50 short; the bands are what
stop it entering an exhausted move). It is the scaffolding the real
Mindset-Aligned Trend Entry rules get ported into; SMC belongs in a separate
strategy behind the same `LIVE_SCANNER_STRATEGY` switch.

Safety properties, each covered by a test in `test/live-scanner.test.js`:
disabled unless `ENABLE_LIVE_SCANNER=true`; paper only, with no exchange-order
code reachable from the file; closed candles only; at most one open position
per symbol; at most one entry per candle; and an unreachable exchange recorded
as an error the next tick retries rather than a crash.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENABLE_LIVE_SCANNER` | `false` | Opt in, by exact value `true`. |
| `LIVE_SCANNER_SYMBOL` | `BTCUSDT.P` | `.P` maps to the Bitget `USDT-FUTURES` contract. |
| `LIVE_SCANNER_TIMEFRAME` | `15m` | `1m`…`1d`; an unsupported value fails at boot. |
| `LIVE_SCANNER_STRATEGY` | `mindset_v1` | Strategy switch. |
| `LIVE_SCANNER_INTERVAL_MS` | `60000` | Poll cadence. |
| `LIVE_SCANNER_CONTEXT_INTERVAL` | `4h` | Higher timeframe for regime/daily bias. |
| `LIVE_SCANNER_BOOK` | `main` | Which book scanner trades land in. |
| `LIVE_SCANNER_PAPER_TRADE_ENABLED` | `true` | Set `false` to score and log without opening. |

Positions carrying a `live-scanner:` signal source are skipped by the Signal
Bot bridge's auto-marking: the scanner marks them itself, on its own venue and
timeframe. Marking them in the bridge would price a Bitget perpetual off
Binance spot klines on the wrong interval.

`GET /api/live-scanner/status` reports enabled/running state, last scan, last
candle, last signal with its indicator readings, last action and last error;
the Trading Lab page renders it.

The `TRADERCLAW_BASE_URL` HTTP bridge on the Decision Engine page still works
and is untouched by this change. It should be removed only once the running
TraderClaw deployment is retired, since it is what currently surfaces that
deployment's live history.
