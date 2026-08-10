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

Still to do, in order:

8. **TradingView webhook ingestion** — port `signal_handler.py` and
   `security.py`. Needs HMAC verification and a replay window before any
   endpoint is exposed; do not ship the route without them.
9. **Backtesting** — the paper trader already accepts an explicit price map in
   `updatePositions()`, which is the seam a bar-replay backtester plugs into.
10. **Bitget integration** — port `bitget_client.py` as an isolated exchange
    adapter behind the existing two-gate safety model. Last, and separately
    reviewed.
11. **Archive TraderClaw** once 8-10 land and parity still passes. Archive
    first; delete only after a period of confidence that nothing was missed.

The `TRADERCLAW_BASE_URL` HTTP bridge on the Decision Engine page still works
and is untouched by this change. It should be removed only once the running
TraderClaw deployment is retired, since it is what currently surfaces that
deployment's live history.
