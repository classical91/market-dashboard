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

### One intentional divergence

`round.js` implements Python's half-to-even rounding rather than JS's
`Math.round`. Without it the two engines disagreed by a cent on every exact
tie, and rounding half-up would slowly bias net P&L upward over a long
history. The parity check found this; it is why the check exists.

## Parity

```bash
npm run parity -- --traderclaw ../traderclaw
```

Runs identical sample trades — chosen to cover negative-value rounding, an
infinite profit factor, drawdown off a running peak, and grouping-key
fallbacks — through both engines and fails on any disagreeing field. It
currently reports exact agreement on every compared field.

Reason strings are prose and are allowed to differ; decisions, size
multipliers and every numeric metric are not.

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
| POST | `/api/trading-lab/backtest` | admin | Replay a symbol's candles. Admin-gated despite being read-only: it replays hundreds of bars and pulls candles per call, so it should not be spinnable by anonymous visitors. Writes only to a temp ledger. |
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

Still to do, in order:

9. **TradingView webhook ingestion** — port `signal_handler.py` and
   `security.py`. Needs HMAC verification and a replay window before any
   endpoint is exposed; do not ship the route without them.
10. **Auto-marking** — positions currently only mark to market on demand.
    Hooking `updatePositions()` into the existing signal-bot interval loop
    would let stops and targets fire without the page being open.
11. **Bitget integration** — port `bitget_client.py` as an isolated exchange
    adapter behind the existing two-gate safety model. Last, and separately
    reviewed.
12. **Archive TraderClaw** once 9-11 land and parity still passes. Archive
    first; delete only after a period of confidence that nothing was missed.

Note that parity passing on metrics and the edge gate is not parity on
webhooks or Bitget, since those are not ported — the archive decision needs
those in place first.

The `TRADERCLAW_BASE_URL` HTTP bridge on the Decision Engine page still works
and is untouched by this change. It should be removed only once the running
TraderClaw deployment is retired, since it is what currently surfaces that
deployment's live history.
