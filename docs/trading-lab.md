# Trading Lab — TraderClaw migration

The Mindset v1 audit, Pine signal/execution diagnostic, experimental v1.1 ablations, and preliminary chronological results are documented in [Mindset v1 Audit and v1.1 Research](mindset-v1-research.md).

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
| — | `src/services/trading/strategy-accounts.js` | New: one isolated paper ledger per registered strategy, derived from the registry. |
| — | `src/services/trading/live-research-runner.js` | Continuous closed-candle demo research, one failure-isolated runner and persisted intent state per compatible strategy. |
| — | `src/services/trading/regime.js` | New: the market regime engine. Measures the environment; decides nothing. |
| — | `src/services/trading/regime-metrics.js` | New: the strategy × regime evidence table. |
| — | `src/services/trading/regime-router.js` | New: advisory strategy selection from that evidence. |
| — | `src/services/trading/strategies/` | New: the strategy registry, its research lifecycle metadata, and the shared mindset_v1 rules the scanner and backtester both run. |
| — | `src/services/trading/experiment-record.js` | New: turns a finished run into a research record. Pure. |
| — | `src/services/trading/experiment-store.js` | New: where experiments are persisted. The seam a database would replace. |
| `shadow_trader.py`, `alts_trader.py` | archived ledgers in `trading-lab.js` | Main / Shadow SMC / Alts remain readable as unattributed legacy history, but are read-only and receive no new positions, marks, closes or resets. |
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
`BACKTEST_TAKER_FEE_RATE`, `BACKTEST_SLIPPAGE_RATE`, and
`BACKTEST_FUNDING_RATE_8H` as decimal rates. Cost-model v1 treats every fill as
a taker fill, which is conservative for market-style backtest entries. Each
fill records its fee, funding charge or credit, requested price, and
slippage-adjusted fill price, so expectancy and R-multiple are net of costs
rather than a cosmetic summary adjustment.

All three rates default to **zero**, so an unconfigured deployment produces
frictionless results. Every backtest and comparison payload therefore carries
the `costs` it ran under, and the Backtest and Strategy Comparison cards print
them beneath the numbers — a zero-cost run is labelled as such rather than
quietly passing for a realistic one. Costs are charged per fill, so they weigh
most on whichever strategy trades most often; that is a real difference between
strategies, and it belongs in the comparison rather than outside it.

### Cost scenarios

Named friction assumptions, so an experiment records **which** assumption
produced it rather than three loose decimals a reader has to interpret:

| `costScenario` | Taker fee | Slippage | Funding |
| --- | ---: | ---: | ---: |
| `baseline` | 0.06% | 0.02% | excluded |
| `stress` | 0.10% | 0.05% | excluded |
| `frictionless` | 0 | 0 | 0 |

`baseline` is the research default: a standard, undiscounted perp taker tier
with modest slippage — conservative enough that a strategy has to survive
realistic friction, without being so harsh that it discards strategies that
would work in practice.

`stress` is a **second run, not a stricter first one**. A strategy that looks
good under `baseline` *and* survives `stress` is far stronger evidence than one
tuned around cheap execution; starting at `stress` would reject strategies that
are fine in reality.

```js
service.run({ symbol: "BTCUSDT", candles, costScenario: "baseline" });
```

Omitting `costScenario` uses the deployment's own configured rates, which is
what every caller got before scenarios existed, and identifies as `null` — a
custom assumption, honestly labelled rather than mislabelled as a named one.

#### Funding is excluded, and says so

A zero rate is an **excluded** cost, not a neutral one. Printing `funding 0%`
beside two real rates reads as "funding was accounted for and came to nothing",
which is the opposite of the truth: no funding feed is wired up, so charging a
rate would mean inventing one. Every run therefore carries an explicit caveat
naming each excluded cost, and the cards render it as a tag rather than a
decimal.

#### Two different things called "funding"

| | What it is | Where it acts |
| --- | --- | --- |
| `BACKTEST_FUNDING_RATE_8H` / `costScenario.fundingRate8h` | An **execution cost** charged against P&L while a position is open | `fundingCost()` in the paper trader |
| `marketContext.fundingRate` | **Market evidence** used for scoring | `scoreSetup()` and the funding kill switch |

Setting the first makes P&L more realistic. It does **not** restore the
checklist's +5 funding points — only a real current/historical funding feed
does that. They share a word and nothing else.

#### Configuring a deployment

`BACKTEST_TAKER_FEE_RATE`, `BACKTEST_SLIPPAGE_RATE` and
`BACKTEST_FUNDING_RATE_8H` are read by `PaperTradingService` for **every** book,
forward paper included — the `BACKTEST_` prefix is historical. Changing them
re-prices live paper accounting mid-flight, so it is a deployment decision, not
a research one. Scenarios exist so a research run can be priced without
touching it.

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
- Backtests run against a **throwaway in-memory ledger**. Persistent strategy
  accounts and archived legacy ledgers are never touched, and the run's edge gate sees only the trades that run
  produced. A test asserts the run performs *zero* filesystem writes, which is
  a stronger claim than the temp directory it replaced: there is nothing to
  clean up and no window in which a crash could strand a ledger.
- Refused candidates are recorded with the reasons they were refused, so a
  strategy that never trades is distinguishable from one with no signals.

### Replay time

A backtest's account is kept on **replayed time, not wall-clock time**. This
matters more than it sounds. The daily and weekly loss limits, and the
consecutive-loss breaker, all read buckets that reset on a UTC day and an ISO
week — and those buckets used to roll over according to the date the backtest
was *run*. A run replaying six months of candles therefore accumulated every
loss in the sample into one day and one week, tripped `DAILY_LOSS_LIMIT` within
a few trades, and refused everything after it. Its headline numbers described
the first days of the sample and its skip rate described nothing at all.

`PaperTradingService` is now parameterised over time. Every accounting entry
point — `getAccount`, `applyRollover`, `creditAccount`, `getRiskState`,
`getStats`, `reset` — takes an optional `at`, and the backtester passes the
closing timestamp of the bar being replayed. Forward paper trading passes
nothing and keeps wall-clock behaviour exactly as before.

The service also accepts a `clock`, which the backtester sets once per bar. It
is a backstop rather than the interface: a call site that forgets its `at` under
a set clock is merely redundant, whereas the same omission without one silently
rolls a historical book onto today's date.

### Storage adapters

`PaperTradingService` is parameterised over storage the same way. `FileStorage`
(the default) is the on-disk ledger every forward book uses; `MemoryStorage` is
what a backtest gets. Reads hand back a deep copy with JSON's semantics —
including dropping `undefined` values, as a round trip through the filesystem
would — so the two adapters are interchangeable rather than merely similar. A
test runs the same sequence of fills through both and asserts identical
accounts, histories and metrics.

This is a storage choice only. There is deliberately **no second fill engine**:
the same `PaperTradingService` executes both a backtest and a forward run,
which is the entire reason a backtest is evidence about forward paper trading.

The load-bearing test is `a trend strategy finds no edge in a driftless random
walk`: across four seeds, the built-in trend-breakout strategy must not show
expectancy above 0.15R or a profit factor above 1.5. There is no trend to
follow in a random walk, so if that test ever starts passing with a healthy
edge, the backtester has developed a lookahead or an optimistic fill — far
likelier than the strategy having become good. A companion test on a strongly
trending series checks the opposite failure: that the pessimistic fills have
not simply made *every* strategy lose.

### Higher-timeframe context is not the tested timeframe

A candle backtest has **one** timeframe of data. It therefore does not have a
higher-timeframe trend read, and the context it builds says so rather than
substituting one.

The context object carries two separately named facts:

| Field | What it is |
| --- | --- |
| `timeframeTrendUp` | The EMA trend of the timeframe being tested |
| `htfTrendUp` | A genuine higher-timeframe read, or `null` when there is none |

These used to be a single field called `trendUp`, filled in from the tested
timeframe's own EMA cross, and two consumers downstream read it as
higher-timeframe context and paid for it:

- **`smc_v1`** treated a supplied `trendUp` as higher-timeframe confirmation,
  reported `trendSource: "context"`, and added **+10 confidence**. It now reads
  `htfTrendUp` only, so a candle backtest falls through to its own EMA read and
  earns nothing for agreeing with itself. A caller with real higher-timeframe
  data supplies `htfTrendUp` and gets the original behaviour.
- **The checklist's daily-bias block**, worth **30 of 100 points** and labelled
  "HTF: Daily bias", was scored from that same EMA cross. It is now `NEUTRAL`
  unless a genuine `htfTrendUp` is supplied.

`NEUTRAL` is a deliberate research fallback, not a neutral-sounding zero: the
checklist already has a defined "no opinion" branch worth **+15**, and using it
distinguishes "we do not know the daily trend" from a fabricated answer.

The consequence is real and is the point. Fifteen points is the difference
between a setup scoring 65 (`TAKE_HALF`) and 50 (`TAKE_QUARTER`), or between 50
and `SKIP`. Backtests run before this change credited every with-trend
candidate with a higher-timeframe alignment nobody had established, and traded
more, and larger, than the evidence supported. Expect fewer setups to clear the
floor; that is the corrected number, not a regression.

`regime` still follows the tested timeframe. That one is coherent — a 4h
strategy refusing 4h counter-trend entries is a rule about the chart it trades.

### Unavailable data is unavailable, not favourable

`marketState()` fills anything the caller omits with `null`, and **null never
earns points**. That sentence used to be a comment above defaults that did the
opposite:

| Field | Old default | Read literally |
| --- | --- | --- |
| `usdtDominanceSignal` | `"NEUTRAL"` | "dominance is flat" |
| `btcDominanceRising` | `false` | "BTC dominance is not rising" |
| `bearMarket` | `false` | "this is not a bear market" |
| `fundingRate` | `0` | "funding is flat" |

Those are **observations**, and for a LONG all four are favourable. A long
candidate with no macro feed at all collected the macro block's full **+20**
plus the funding block's **+5**. A short under identical no-data conditions
collected **+0** macro, because the same defaults read as unfavourable for it.

A candle backtest has none of these feeds, so it scored every long 25 points
above the evidence and put longs and shorts **20 points apart** — long 57
(`TAKE_QUARTER`) against short 37 (`SKIP`) on identical, entirely absent data.
A backtest that systematically prefers one direction because of what it does
*not* know cannot be used to judge a strategy.

The macro block is now scored over the inputs that were actually measured, with
the same 2.5-of-3 and 2-of-3 thresholds expressed as a fraction of what was
available. With all three present it is arithmetically identical to before — a
sweep of all 46,656 fully-specified states produces byte-identical decisions,
scores and size multipliers. Only the absent-data case changes.

A measured `NEUTRAL` or a measured `0` still scores. "We looked and it is flat"
is evidence; "we never looked" is not.

#### The calibration consequence

Removing invented credit does not make the thresholds right, it makes the
shortfall visible. Every checklist result now carries `availablePoints`:

| Run | Reachable | Floor |
| --- | ---: | ---: |
| Fully-fed live candidate | 100 | 50 |
| Candle backtest (no macro, funding or daily read) | 60 | 50 |

A candle backtest must therefore clear **83% of the evidence available to it**
where a fully-fed live candidate clears 50%. That is a real mis-calibration, it
is now measurable rather than hidden, and **it has deliberately not been
"fixed"** — normalising the thresholds against `availablePoints` would make the
live scanner materially more aggressive, and setting thresholds is exactly the
promotion-policy decision that does not exist yet.

#### Supplying context you actually have

`run()`, `backtestSymbol()` and `compare()` take an optional `marketContext`:

```js
service.run({
  symbol: "BTCUSDT",
  candles,
  marketContext: {
    htfTrendUp: true,           // a real daily read
    usdtDominanceSignal: "RISK_ON",
    btcDominanceRising: false,
    bearMarket: false,
    fundingRate: 0.0001,        // a real funding history
  },
});
```

Omitted fields stay unmeasured. This is **not** a knob for making a backtest
trade more — it is the only way to give a run evidence it genuinely has instead
of letting the checklist invent it. Whatever is supplied is recorded on the
result as `marketContextFields`, so a run scored with macro context is never
mistaken for a candles-only one. In a comparison it is applied identically to
every row, because a row scored with macro context beside one scored without it
would not be a comparison.

#### What this changed outside the lab

Two forward-path behaviours follow from the same fix, both deliberate:

- **A decision-engine outage no longer trades.** `stateForInterval` returns an
  empty state when the engine is unreachable; that state used to score a long
  at 57 and open positions on invented macro. It now scores too low to trade. A
  bot that keeps buying precisely when it has lost sight of the market is not
  degrading gracefully, it is degrading silently.
- **Live candidates lose the funding block's 5 points**, because no funding
  feed is wired up. A candidate that scored 67 (`TAKE_HALF`) now scores 62
  (`TAKE_QUARTER`). Wiring a real funding feed restores it.

### The consecutive-loss breaker

`MAX_CONSECUTIVE_LOSSES` (default 3) blocks new entries once a streak reaches
it. What it *means* after that is now a stated policy rather than an accident:

| `CONSECUTIVE_LOSS_COOLOFF` | Behaviour |
| --- | --- |
| `next-day` (default) | A cooling-off period. Entries stay blocked for the rest of the UTC day the streak completed on; the streak clears at the next day boundary. |
| `never` | The streak clears only on a winning trade. |

`never` was the old behaviour, by omission, and it is an **absorbing state**: no
trade can open, so no trade can win, so the streak never clears. Forward, a
paper book quietly stops trading forever after three losses. In a replay, every
bar after the third loss is refused, and the run's headline numbers describe
however many bars it took to lose three times rather than the sample requested.

The cool-off clears only a streak that has actually reached the limit — two
losses either side of a day boundary still add up to two, so the limit stays
reachable across days. A winning trade still clears the streak immediately,
under either policy. `never` remains available because it is defensible for
real money; it is simply no longer the default nobody chose.

## Strategies

The backtester takes a **strategy** from a small registry
(`src/services/trading/strategies/`), so several strategies can be replayed
over the same candles through the same execution engine and compared on equal
terms.

A strategy is a plain object:

```js
{
  id, name, version, description,
  status,                           // research lifecycle — see below
  supportsBacktest,                 // may be replayed
  supportsLiveScanner,              // may be run forward on live candles
  requiredWarmupBars,               // floor the run cannot undercut
  evaluate(candles, index, context) // -> signal object
}
```

`evaluate` must read nothing past `index` — that contract is what keeps a
backtest honest, and the backtester enforces it by handing over a slice that
ends at the decided bar. The signal it returns always carries `reasons[]` and
`indicators{}`, so the UI can explain why a strategy fired *or* why it stayed
flat, plus optional `confidence`, `stopHint` and `targetHint`.

### Execution modes

A strategy signal carries `stopHint` and `targetHint` — where the strategy
itself says the trade should be stopped and taken. Which of those the backtest
**uses** is a choice, because the two answer different questions:

| `executionMode` | Stop and targets from | The question it answers |
| --- | --- | --- |
| `shared` (default) | `planTrade()` — 1.5×ATR stop, TP1 1.5R, TP2 2.5R | "Which strategy produces the best ENTRY signals, when every one of them uses the same execution?" |
| `native` | The strategy's own `stopHint` / `targetHint` | "How does this strategy perform AS DESIGNED?" |

Neither is the correct one, and the distinction is load-bearing.
`vwap_reversion_v1` targeting VWAP is a different trade from
`vwap_reversion_v1` targeting 2.5R; only `native` tests the former. But a
comparison table under `native` is no longer apples-to-apples, because each row
is using different exit rules — that is what `shared` is for. Conflating them
is the mistake, which is why the mode is recorded on the result, on the
experiment record, and on every individual trade's `meta`.

Under `native` the position size is recomputed from the strategy's own stop
distance so the **dollar risk per trade is identical to `shared`**. Without
that, a mode comparison would be measuring position size rather than exit
rules: a wider native stop buys a smaller position, not more risk.

Two guards keep the mode honest:

- A hint that is not a finite number, or that sits on the wrong side of the
  entry (a long stop above it), is refused and the trade falls back to shared
  levels. Opening it anyway would book an instant fill and call it a result.
- Every fallback is **counted and reported**. `mindset_v1` publishes no hints
  at all, so a `native` run of it is really a shared run — and a result
  labelled `native` that quietly used `planTrade`'s levels throughout is the
  single most misreadable outcome in this module. The run reports
  `nativeFallbacks` and adds a caveat naming the strategy.

#### Requested mode vs applied execution

`executionMode` is what was **asked for**. `executionApplied` is what the run
actually **used**, and they are different facts:

| `executionApplied` | Meaning |
| --- | --- |
| `shared` | Shared execution was requested and used |
| `native` | Native requested; every trade used the strategy's own levels |
| `shared-fallback` | Native requested; **no** trade could use native levels |
| `mixed` | Native requested; some trades could and some fell back |
| `none` | No trade opened, so there is nothing to characterise |

They come apart in the case a reader is least equipped to notice: a comparison
run with `executionMode=native` containing a row for a strategy that publishes
no hints. Its trades fall back one by one, the run completes, and the row sits
under a header reading "native strategy exits" while describing a
shared-execution result. Every number is correct and the sentence above it is
not.

So the comparison table carries an **Execution** column per row, the facet
cards repeat it, and the single-run card prints the applied value beside the
requested one. `nativeTrades` and `sharedTrades` ride on the payload for
callers that want the counts. `nativeFallbacks` is unchanged.

| id | version | research status | live demo research | What it is |
| --- | --- | --- | --- | --- |
| `mindset_v1` | 1.0.0 | `forward-paper` | candle runner | The live scanner's strategy — EMA20/EMA50 trend with an RSI band filter. Scanner eligible, **not** real-money eligible. The default. |
| `mindset_v1_1` | 1.1.0-experimental.1 | `experimental` | candle runner | Backtest-only A–F entry-quality ablations against the frozen v1 benchmark. Not scanner eligible. |
| `smc_v1` | 1.0.0 | `backtest` | candle runner | Mechanical Smart Money Concepts approximation. Live demo evidence collection does not promote it. |
| `donchian_breakout_v1` | 1.0.0 | `backtest` | candle runner | The unoptimised N-bar breakout baseline. Live demo evidence collection does not promote it. |
| `vwap_reversion_v1` | 1.0.0 | `backtest` | candle runner | The low-ADX mean-reversion counterweight. Live demo evidence collection does not promote it. |
| `shadow_bananagun_v1` | 1.0.0 | `experimental` | event data required | Banana Gun-style on-chain candidate replay. Historical/live point-in-time candidate and safety snapshots are required; candle execution is refused. |

### Strategy options and warmup

Callers may override a strategy's parameters through the `options` body field.
Two things follow, and neither used to hold:

- **Options are validated before anything runs**, against the strategy that
  will receive them, and a bad value is a 400 naming the parameter. Previously
  `{"channelLength": 5000}` reached the arithmetic and surfaced as a 500.
- **Warmup is computed from the effective options**, not from the defaults. A
  strategy opts in with `warmupFor(options)`; `requiredWarmupBars` is only the
  right answer for a run at defaults, and a 400-bar channel needs 402 bars
  reserved rather than the default 102 — short of that, the channel loop reads
  off the front of the array.

Both are opt-in per strategy (`validateOptions`, `warmupFor`), so a strategy
without them behaves exactly as before.

### Ranking a comparison

Rows are ordered by expectancy, then profit factor, then the smaller drawdown —
but only rows with at least `minRankedTrades` closed trades are ranked at all.

This matters because a null profit factor means two different things. "Wins
and no losses" is genuinely infinite and should sort to the top; "no trades"
has no profit factor because there is no evidence, and the old comparator
substituted 999 for both — floating a strategy that never traded above every
strategy that did. Unranked rows are kept, at the end, flagged with the reason:
a strategy that ran and refused every setup is a finding, not an absence.

The default threshold is 1, which only excludes strategies that never traded. A
real statistical minimum is a promotion-policy decision and belongs with the
rest of that policy, which does not exist yet.

### Lifecycle

A strategy's `status` is a claim about **evidence**, not a switch. Changing it
makes nothing happen; it records what has actually been demonstrated.

| status | Meaning |
| --- | --- |
| `experimental` | Being developed. May change shape without notice. |
| `backtest` | Historical testing. |
| `validated` | Historical evidence has passed the promotion criteria. Has never met a live candle. |
| `forward-paper` | Running against live market data with **paper** execution. |
| `real-money-eligible` | Has completed validation and could *potentially* be approved for real-money execution later. |
| `retired` | No longer active. Kept to reproduce old experiments. |

#### Research status, live demo research and real money are separate

These are different questions and the codebase keeps them apart, because the
word "live" answers both and therefore neither:

| computed field/state | The question it answers | Today |
| --- | --- | --- |
| `scannerEligible` | May the **live scanner** run this forward, on live candles, against a **paper** ledger? | `true` for `mindset_v1` |
| `liveResearchEligible` | May an isolated demo account collect simulated evidence from newly closed candles, without promotion? | `true` for Mindset, SMC, Donchian and VWAP |
| `realMoneyEligible` | Has this completed validation such that real-money execution could later be approved? | `false` for everything |

A strategy being scanner eligible says **nothing** about real money — that is
the normal state of affairs, and it is exactly what `forward-paper` means.
`mindset_v1` runs on live Bitget candles every 60 seconds and has never placed
a real order; no code path in this repository can.

```js
scannerEligible   = supportsLiveScanner === true &&
                    ["forward-paper", "real-money-eligible"].includes(status)
liveResearchEligible = supportsLiveResearch === true && supportsBacktest === true
realMoneyEligible = status === "real-money-eligible"
```

`liveResearchEligible` is a capability, not a promotion claim. Its runner calls
the registered strategy's existing `evaluate()` contract on fully closed
candles, persists the last processed close for restart de-duplication, and may
write only to that strategy's demo ledger through `executeLiveResearch()`.
`getScannerStrategy()` and ordinary `execute()` keep their lifecycle checks,
so a `backtest` strategy collecting live demo evidence is still rejected by the
production scanner path.

Note what is missing from the scanner list: `validated`. Passing the historical
criteria earns a strategy the right to *be promoted* to `forward-paper`; it is
not the promotion itself. And `realMoneyEligible` is not conditioned on
`supportsLiveScanner`, because whether the scanner can run something is a
different question from whether its evidence would justify real money. Even a
`real-money-eligible` strategy would still face a human decision plus the two
exchange-side gates (`TRADING_MODE=live` **and** `ALLOW_LIVE_TRADING=true`)
that this repo never flips.

**Registry metadata is not promotion.** Being in the registry means a strategy
can be *named*; it says nothing about what may run it. Both fields are
**computed** in `strategies/lifecycle.js`, never declared — a strategy object
that sets `scannerEligible: true` or `realMoneyEligible: true` on itself is
ignored.

#### Runtime enforcement

The live scanner resolves `LIVE_SCANNER_STRATEGY` through
`getScannerStrategy()` **at construction**. An id that is unknown, does not
support the scanner, or is not scanner eligible throws a configuration error
naming what is actually allowed — the scanner refuses to start rather than
falling back to something else, because a scanner quietly running a different
strategy than the one configured is worse than one that will not start.

This used to be a test that read the scanner's source for a hard-coded table.
It is now a real refusal, which was made possible by extracting the mindset_v1
rules into `strategies/mindset-v1-rules.js`: the scanner and the registry both
depend on that leaf, so the scanner can depend on the registry without a
require cycle. The scanner then runs the registry entry's own `evaluate()`, so
the forward path and the backtest path cannot drift apart.

The promotion *policy* — how many closed trades, what expectancy, what profit
factor and drawdown justify a status change — is deliberately not implemented
yet, and neither is any endpoint that could change a status.

### Two scores, kept apart

The checklist produces one number and the Lab now records two:

| | What it is | Who uses it |
| --- | --- | --- |
| **Operational score** | The raw 0-100 score and the 50/65/80 cuts | Production and forward paper. Unchanged. |
| **Evidence ratio** | `score / availablePoints` | Research only. Recorded, not acted on. |

They are kept apart on purpose. A candle backtest reaches 60 of 100 points, so
its 50-point floor demands **83%** of the evidence available to it where a
fully-fed live candidate needs 50% — and it can never reach `TAKE_HALF` (65) or
`TAKE_FULL` (80) at all. Backtest trade selection is therefore deliberately
more conservative than forward-paper selection, and **not directly equivalent
to it**.

The fix for that is not to rescale 50/65/80 into 30/39/48. It is to find out,
from evidence, whether 70% or 80% or 85% of available evidence actually
predicts out-of-sample performance, and set a backtest-specific promotion
criterion from the answer. Recording the ratio now is what makes that study
possible later without re-running anything.

Every opened position carries its own `confidenceScore` and
`meta.availablePoints`, so the run-level `evidence` aggregate can always be
recomputed from the ledger rather than trusted.

### Comparing experiments across rule changes

An expectancy figure measures the rules that selected the trades behind it, so
experiments from either side of a scoring change measure different things.
`gitCommit` records which code ran, but a commit is far too fine-grained to
group by — hundreds share one set of scoring rules. Two coarse versions answer
the question a researcher actually has, which is *may I pool these?*

| Field | Versions | Bump when |
| --- | --- | --- |
| `scoringVersion` | The scoring RULES | Major, whenever a change could move a candidate across a decision boundary |
| `researchSchemaVersion` | The record SHAPE | A field is added or changed |

`scoringVersion` is at **2.0.0**. 1.x is everything before the corrections
above: same-timeframe EMA trend scored as higher-timeframe daily bias (up to
30 points), and absent macro/funding scored as favourable observations (up to
25, of which 20 was asymmetric between longs and shorts). Both changed which
setups trade, so nothing scored under 1.x can be pooled with anything scored
under 2.0.0.

Records written before versioning existed carry no `scoringVersion` at all and
are identified by its absence. They are **kept, not deleted** — destroying
research because it is superseded destroys the record of what was believed and
when. `store.list()` labels every row with `comparable` and a
`comparabilityNote`, and a promotion check asks for `{ comparableOnly: true }`.
The default stays inclusive so no existing reader silently loses rows.

`marketContextFields` is recorded too: a run given a real daily or funding feed
is not comparable with a candles-only one even when both scored under the same
rules.

### Experiments

A backtest is ephemeral; an **experiment** is the record that it happened.
Recording is opt-in (`record: true` on the backtest request), so exploring a
symbol does not fill the research log with noise, and a developer or test run
leaves no trace. When a run is recorded, the response carries `experimentId`.

Each record answers "what produced this number?":

* identity — `id`, `createdAt`, `notes`, `source`
* what ran — `strategy`, `strategyVersion`, `strategyStatus`, `gitCommit`
* what it ran on — `symbol`, `timeframe`, `from`/`to`, `bars`, `warmupBars`
* what happened — `signals`, `closedTrades`, `openAtEnd`, `winRate`,
  `netPnlUsd`, `netReturnPct`, `expectancyR`, `profitFactor`,
  `maxDrawdownPct`, `worstLossStreak`
* under what assumptions — `options` and `costs`

Every metric comes from `summarizeRun()` — the same reduction the comparison
table uses, which reads the paper trader's own metrics. Nothing is
recalculated: a stored experiment that disagreed with the table it came from
would be worse than no experiment at all.

**Why the cost assumptions are part of the record.** All three cost rates
default to zero, and they are set per deployment. The same strategy over the
same bars at 0% and at 0.06% taker fees produces different expectancy — so an
experiment without its `costs` is not reproducible, and two experiments are
only comparable if their `costs` match. `gitCommit` plays the same role for the
rules themselves: without it, a stored number cannot be traced back to the code
that produced it. It is read from the platform's build metadata
(`GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, …), falling back to `git rev-parse
HEAD`, and is recorded as `null` rather than guessed when neither is available.

**Persistence.** `ExperimentStore` (`experiment-store.js`) writes newest-first
JSON to `<dataDir>/research/experiments.json` using the same write-then-rename
the paper trader uses, so a crash mid-write leaves the previous file intact. A
corrupt or wrongly-shaped file degrades to an empty list and is repaired by the
next write — research history is not load-bearing for trading, and must never
take the dashboard down.

Two separations are deliberate:

* **From the ledger.** Experiments live under `<dataDir>/research/`, never
  under `<dataDir>/trading-lab/<book>/`. Resetting a paper book cannot touch
  the record of what was tested.
* **Behind an interface.** Routes and the backtester speak only
  `record` / `get` / `list` / `count`. Moving this to SQLite or Postgres later
  is a swap of one file, not a rewrite of the backtester.

## Strategy accounts and archived legacy ledgers

Two data surfaces that must not be confused:

```text
Strategy account       Active isolated paper state for ONE registered strategy.
Legacy paper history   Read-only evidence from the retired Main / Shadow SMC / Alts ledgers.
```

Originally only the second existed. The three books — Main, Shadow SMC, Alts — are a port
of TraderClaw's three Python bot services (`shadow_trader.py`, `alts_trader.py`),
so one of them is *named after a strategy* while containing whatever happened to
be written to it. That is where the confusion starts, and it is why the top
dropdown looked like a strategy selector.

Strategy accounts replace those books as the active execution and reporting
surface. The old IDs and historical files are preserved exactly as recorded,
with unknown attribution left unknown, but the service exposes them through a
read-only facade. No execution path may fall back to them.

### Attribution comes first

A strategy account is meaningless if trades cannot be attributed, and until
recently they could not be. `intent-handler` knew which strategy fired, spent it
as an edge-gate key, and dropped it — so a forward-paper trade landed as:

```text
signalSource : live-scanner:15m        <- a timeframe, not a strategy
meta         : { edgeDecision, sizeMultiplier }
```

Every strategy-level figure about forward trades was really a figure about a
timeframe, and the regime matrix on a live book read 100% `UNTAGGED` because the
regime work tagged backtests only.

`execute()` now records `strategy`, `strategyVersion`, `timeframe`, `regime` and
`regimeConfidence`. Like the backtester's regime tag, **nothing in the gauntlet
reads them** — a strategy × regime table is only evidence about a strategy if the
tag played no part in selecting the trades it summarises.

### Two keys, deliberately not one

| Dimension | Keyed by | Used for |
| --- | --- | --- |
| `strategy` | `signalSource` | **The edge gate's index.** `edge-gate.js` finds a group by the exact string its caller passed (`live:mindset_v1:15m`). |
| `strategyId` | recorded attribution | "Which strategy earned this?" — what the regime table groups by. |

`strategy` looks like a report and is actually a lookup index. Repointing it at
strategy identity would stop those lookups matching, dropping the edge gate to
symbol-level or account-level evidence — a change to how positions are **sized**,
disguised as a reporting improvement.

Records without explicit attribution are `UNATTRIBUTED`. `signalSource` is never
parsed to recover a strategy: its format was never a contract, and for forward
trades it does not contain one.

### Accounts are derived, and are not permissions

`listStrategyAccounts()` reads the strategy registry, so a new strategy gets an
account with no second list to update — a test asserts the derivation rather than
trusting it.

Every registered strategy gets an account. The cards show two independent
states: research lifecycle and live demo runner intent.

| Strategy | Research status | Live demo |
| --- | --- | --- |
| `mindset_v1` | forward-paper | closed-candle runner |
| `mindset_v1_1` | experimental | closed-candle runner |
| `smc_v1`, `donchian_breakout_v1`, `vwap_reversion_v1` | backtest | closed-candle runner |
| `shadow_bananagun_v1` | experimental | event replay only / waiting for live event data |

BananaGun gets its own label because it cannot even be replayed on candles
(`supportsBacktest: false`) — "backtest only" would overstate what it can do.

An account and a running demo confer nothing. The live scanner still resolves
what it may run through `getScannerStrategy`, which checks lifecycle status.
The separate live-research resolver checks candle compatibility only and cannot
place exchange orders or set scanner/real-money eligibility.

Live research also has a single-writer rule. Every persistent position records
an `executionOwner` independently from its strategy identity. Only the live
research runner may mark `live-research` positions; Signal Bot and Live Scanner
skip them. If a paper-trading Live Scanner and Live Research are configured for
the same strategy account, startup refuses the configuration instead of mixing
two experiments in one wallet.

Account and stats GETs use `readAccount()` / `readStats()`. Those snapshots do
not fetch a price or run SL/TP, so opening the dashboard cannot change positions,
history, balance or P&L. Mutation remains an explicit execution-loop action.

Before accepting a newly closed Binance bar, the runner bypasses the raw-kline
cache with a coalesced forced refresh. On restart, missed bars replay only the
SL/TP contract for a position that was already open; they cannot create
retroactive entries using present-time context. Entry evaluation resumes on
the newest freshly finalized bar. Live research adds no generic trend-flip
exit: like the historical backtester, positions leave through their configured
SL/TP execution contract.

### One resolver, because the gauntlet must read what it writes

`ledgerFor({ strategyId })` decides where a trade lives. A registered strategy
always resolves to its own account. Forward scanner execution requires a
lifecycle status that permits forward paper trading; live research execution
requires the separate candle capability. Both refuse ineligible or unattributed
execution rather than redirecting it to Main, Shadow SMC or Alts.

There is exactly one of these on purpose. `evaluate()` reads risk state and
closed-trade history to run kill switches and the edge gate; `execute()` opens the
position. If those resolved differently — scoring against Main's loss limits while
writing to a strategy account — the kill switches would be guarding the wrong
book. That is a safety failure, not a reporting one. A test fills a strategy
account to its position cap and asserts the cap binds while Main sits empty.

The intent handler resolves the same way for exits and for its
one-position-per-symbol check: searching a legacy ledger for a position held in
a strategy account would silently leave it open.

Ledgers are namespaced `strategy-<id>`. A prefix rather than a nested path,
because `PaperTradingService` sanitises its book name to `[a-z0-9_-]` and
`strategies/mindset_v1` would silently flatten to `strategiesmindset_v1` —
isolated by accident, with the separator carrying the guarantee deleted.

### Endpoints

* `GET /api/trading-lab/strategy-accounts` — every account with equity and
  lifecycle state.
* `GET /api/trading-lab/strategy-accounts/:id` — one account's metrics, regime
  breakdown, open positions, history, structured current intent, decision trail,
  rules and activity timeline from its own isolated ledger/runner.
* `GET /api/trading-lab/live-research` — health and state for every demo runner.
* `GET /api/trading-lab/books` — archived legacy ledger descriptors for
  compatibility and historical reads only.

## Market regime

`market data → regime → setup → …` was in the pipeline diagram before anything
implemented the second box. Regime-shaped behaviour existed — the checklist's
counter-trend gate, `vwap_reversion_v1` standing down above ADX 22, the decision
engine's `Choppy` / `Volatile` labels translated in `trading-lab.js` — but as
three vocabularies with three sets of thresholds and no shared answer.

`regime.js` is the shared answer. It reads candles and returns a structured
read: the label, the confidence behind it, the measurements it rests on, and the
mode of trading the environment favours.

### The vocabulary

The five labels the checklist already reasoned over, plus three that name
situations the old vocabulary got **wrong** rather than merely left unnamed:

| Label | Meaning |
| --- | --- |
| `TREND_UP` / `TREND_DOWN` | ADX has established a trend *and* the moving averages agree on the side. |
| `RANGE` | No trend worth naming. |
| `ACCUMULATION` / `DISTRIBUTION` | A quiet range with real volume in it, worked from one edge of its own structure with higher lows (or lower highs). Previously both were `RANGE`, which is true and useless. |
| `VOLATILE_EXPANSION` | ATR well above its own average. A size problem, not a direction problem. |
| `LOW_COMPRESSION` | Coiled. The checklist already refuses entries here. |
| `TRANSITION` | Trend strength has left the range zone but has not established a trend. |
| `UNKNOWN` | Not enough data. Distinct from `TRANSITION`: `UNKNOWN` is our ignorance, `TRANSITION` is the market's. |

`TRANSITION` is the most valuable addition. Without it, bars between characters
are forced into `RANGE` or `TREND` and traded as though they were one — and a
router with no way to say "I don't know" flips between strategies precisely
while the market is changing, which is when its recommendations are least
reliable. The gap between `adxRangeMax` (20) and `adxTrendMin` (25) is not
slack; it is that zone, and it exists on purpose.

### Trend is not the EMA ordering

In a range the fast EMA still sits on one side of the slow one — it has to sit
somewhere. Reporting that as a direction beside a `RANGE` label would state a
trend the engine has just finished measuring the absence of, so the read carries
both: `direction` is the raw EMA ordering, and `trend` is `NEUTRAL` outside a
trend regime. The dashboard shows `trend`.

### Measurement first, routing second, gating not at all

The engine **decides nothing**, and this is the load-bearing property rather
than an unfinished edge:

* The checklist's `state.regime` still comes from the same EMA-cross read it
  always did. Feeding the richer labels in would change which setups trade —
  `ACCUMULATION` is not `TREND_DOWN`, so the counter-trend gate would stop
  firing on bars where it fires today — and that is a change to
  `SCORING_VERSION` semantics, not an improvement to reporting. Every stored
  experiment would become non-comparable, in exchange for a hypothesis nobody
  has measured yet. `toChecklistRegime()` exists for the day that changes.
* Trades **record** the regime they were opened in (`meta.regime`,
  `meta.regimeConfidence`) and nothing in the gauntlet consults the tag. That is
  what makes the resulting table evidence about the *strategy* rather than
  evidence about a filter that was just added. A test hands `tryOpen` three
  different reads — including a `TRANSITION` — and asserts the decision and the
  reasoning are byte-identical, differing only in what lands on the record.

Reads are prefix-safe: `classifyAt(bars, i)` equals `classifyRegime` over bars
`0..i`, held by a test that feeds two candle sets with identical pasts and
different futures.

### The evidence table

`regime-metrics.js` breaks each strategy's expectancy out by the environment its
trades were opened in. Pooling hides the useful fact: a strategy making +0.4R in
ranges and losing -0.3R in trends shows up in `metrics.js` as a mediocre +0.05R,
and that it *has a regime it belongs in* is averaged away.

Two honesty rules, because a per-regime cell is a small sample:

1. Cells below `minTrades` are marked `sufficient: false` rather than dropped.
   Dropping them would hide that the strategy traded there at all; showing them
   unmarked would invite a decision built on nineteen trades.
2. Untagged trades are counted and reported separately, never pooled into a
   regime. History predating regime tagging is untagged, and folding it into
   `RANGE` would manufacture evidence.

`verdictFor()` is three-valued for the same reason. `INSUFFICIENT` is not
`UNFAVOURABLE`: a strategy that has never traded in a regime has not failed
there, and merging the two would suppress every new strategy.

### The router is advisory, structurally

`regime-router.js` turns a read plus that evidence into `preferred` / `eligible`
/ `suppressed` / `unproven`. It cannot promote anything: the live scanner
resolves what it may run through `getScannerStrategy`, which checks lifecycle
status independently and is never handed a routing result. Every response
carries `enforced: false`, and every candidate carries its own
`scannerEligible`, so `Preferred: VWAP Reversion v1` never reads as "it is
running" — that strategy is `backtest` status and the card says so.

The evidence scope is deliberately different from the selected account view.
Each account's Regime Analysis is built only from that account's history, but
the advisory router combines the histories of **all strategy accounts** before
comparing strategies. Selecting VWAP or Donchian in the UI therefore changes
the account detail, never the market recommendation. Legacy ledgers are not
included because their historical trades have no trustworthy strategy identity.

A non-actionable read (`TRANSITION`, `UNKNOWN`, anything under the confidence
floor, or an environment where size rather than direction is the problem)
selects nothing at all and reports every candidate as *held* — not suppressed,
because nothing about those strategies failed.

### Endpoints

* `GET /api/trading-lab/regime?symbol=&interval=&strategyId=&min_trades=` — the
  market read and aggregate cross-strategy routing, returned side by side. The
  optional strategy id is display context and cannot change routing evidence.
* `GET /api/trading-lab/regime-matrix?strategyId=&min_trades=` — one selected
  strategy account's isolated table, with no candles fetched.

Backtest runs also return `regimeMetrics` (the same table over that run's
trades) and `regimeCounts` (which environments the run's signals occurred in — a
strategy that only ever fired in one regime has not been tested against the
others, and that is a fact about the *run*).

### smc_v1

Not "SMC done properly" — discretionary SMC reads liquidity, sessions and
inducement, none of which is here. It takes the four ideas that *can* be
written as replayable rules and requires all four to agree:

1. **Trend alignment.** Genuine higher-timeframe context when the caller
   supplies `htfTrendUp`, otherwise EMA21/EMA50 on the traded chart. No
   counter-trend fades. A candle backtest supplies no `htfTrendUp`, so it takes
   the EMA path and does not collect the +10 higher-timeframe confidence bonus
   — see "Higher-timeframe context is not the tested timeframe" above.
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

### donchian_breakout_v1

The deliberately dumb one. Every other candle strategy here is trying to be
clever, which means none of them had a denominator: "is `mindset_v1` any good?"
has no answer without something plain to compare it against. This is that
something.

1. **Channel.** Highest high / lowest low of the 20 bars *before* the decided
   bar. Excluding the decided bar is the point — include it and the level
   becomes partly a function of the break itself.
2. **Break.** The bar must **close** beyond the level. A wick through is the
   level holding, not breaking.
3. **Freshness.** The previous bar must not have already closed beyond its own
   channel. Without this the strategy re-signals every bar of a trend, and the
   refusal log can no longer distinguish "no setup" from "same setup, still
   true".
4. **Trend filter.** Longs only above the SMA100, shorts only below. It is the
   single concession to cleverness and can be turned off with
   `useTrendFilter: false` to measure exactly what it is worth.

Stops are 2× ATR, targets 3× the risk. There is deliberately no volume filter,
no momentum confirmation and no regime gate: each would be another parameter to
fit, and a baseline's value is inversely proportional to how tuned it is. For
the same reason it reports no `confidence` — a baseline that ranked its own
setups would be tuning itself.

### vwap_reversion_v1

The counterweight. `mindset_v1`, `smc_v1` and `donchian_breakout_v1` all buy
strength and sell weakness, so they win and lose together and the comparison
card ends up ranking three views of the same trade. This one is built to fail
at different times.

Mean reversion is the easiest thing in trading to fake a backtest of, so the
rules are organised around the three ways it usually cheats:

1. **Regime gate.** ADX must be **below** 22. Fading a trend is how a reversion
   equity curve dies, so in a trending market the strategy declines to have an
   opinion rather than taking the other side.
2. **Stretch in ATR, not percent.** A fixed percentage band is a different
   trade at different volatilities; 1.8× ATR from VWAP means the same thing in
   every regime.
3. **A stall, not a catch.** The close must have come back toward VWAP relative
   to the previous close. Entering while the stretch is still widening is
   catching a knife, and it is the biggest single source of flattering
   reversion results.

The target is VWAP itself — the thesis is complete when price has reverted, so
there is nothing to hold for beyond it. The stop sits beyond the entry bar's
extreme, which means **risk is often larger than reward**, so the setup is
refused outright unless reward/risk clears 1.0. Without that floor the strategy
would take a long series of small wins funded by rare large losses: excellent
on a backtest summary, worth nothing.

The strategy stays flat for the first few bars after each VWAP reset — on the
first bar of a session, VWAP *is* that bar.

#### The anchor is inferred, not configured

The VWAP anchor defaults to `"auto"` and is chosen from the median candle
spacing: a daily anchor when the interval gives at least 12 bars per session,
monthly below that. This is not a nicety. On the lab's default 4h interval a
daily anchor gives **six** bars per session, and after the minimum accumulation
this strategy requires, essentially no bar is ever eligible — measured on five
900-bar random walks, a daily anchor produced **0 signals** and a monthly one
**189**. A hand-set parameter whose wrong value produces silence rather than an
error is a parameter that should not be hand-set. `"day"` and `"month"` still
force it, and the resolved anchor is reported in `indicators`.

#### The counter-trend waiver

The checklist's regime gate forbids longs in `TREND_DOWN` and shorts in
`TREND_UP`. That is a trend-following house rule, and a reversion strategy is
counter-trend *by definition* — so applying it unconditionally does not make
reversion strategies safe, it makes them **untestable**: every signal is
refused before it can become evidence. Before this was addressed,
`vwap_reversion_v1` produced 12 valid signals on a sample run and closed zero
trades.

A strategy may therefore set `tradesCounterTrend: true`, which the backtester
passes to the checklist as `allowCounterTrend`. It waives **only** those two
directional checks. Kill switches, `LOW_COMPRESSION`, position caps and total
risk limits all still bind, and the setup is still scored — including the
30-point trend-alignment block, which a counter-trend entry simply does not
earn. A waived trade clears the 50-point floor on its other merits or it does
not trade, and the waiver is written into `reasons` so no result is ambiguous
about which rules produced it. Callers cannot set the flag themselves: it is
read from the strategy definition, so it stays a property of the strategy
rather than of whoever ran the backtest.

### shadow_bananagun_v1

Banana Gun setups are not candle strategies. They depend on event-time inputs:
candidate discovery time, contract safety data, liquidity, holder concentration,
taxes, sellability, failed transactions and the later exit outcome. Replaying
only OHLCV candles would invent both the entry universe and the safety gates.

The Market Dashboard therefore exposes Banana Gun in the research catalogue and
comparison table with `supportsEventReplay: true` and `supportsBacktest: false`.
Production looks for point-in-time snapshots at:

```
<DATA_DIR>/trading-lab/event-replay/shadow_bananagun_v1/candidates.jsonl
```

When that dataset is absent or empty, `/api/trading-lab/backtest` and
`/api/trading-lab/backtest/compare` return `status: "insufficient-data"` for
`shadow_bananagun_v1` rather than fake candle performance. Tests use fixture
events to keep the replay engine exercised until real historical snapshots
exist.

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
| GET | `/api/trading-lab` | — | Overview: five strategy accounts plus archived legacy summaries. |
| GET | `/api/trading-lab/books` | — | Archived Main / Shadow SMC / Alts descriptors. Read-only compatibility. |
| GET | `/api/trading-lab/strategy-accounts` | — | All isolated strategy accounts with lifecycle and equity state. |
| GET | `/api/trading-lab/strategy-accounts/:id` | — | One account's positions, history, metrics and isolated regime table. |
| GET | `/api/trading-lab/live-research` | — | All live demo runner health, candle progress, structured intent and retry state. |
| GET | `/api/trading-lab/positions?strategyId=` | — | Positions for one strategy account. `book=` remains a legacy read alias. |
| GET | `/api/trading-lab/history?strategyId=&limit=` | — | One strategy account's closed trades, newest first. `book=` remains a legacy read alias. |
| GET | `/api/trading-lab/metrics?strategyId=&min_trades=` | — | One strategy account's grouped expectancy leaderboards. |
| GET | `/api/trading-lab/regime?symbol=&interval=&strategyId=&min_trades=` | — | Market read plus aggregate cross-strategy advisory routing. |
| GET | `/api/trading-lab/regime-matrix?strategyId=&min_trades=` | — | Isolated regime evidence for one selected account. |
| GET | `/api/trading-lab/decision-candidates?interval=` | — | Decision Engine plans scored in a process-local unattributed analysis ledger. Opens nothing. |
| POST | `/api/trading-lab/evaluate` | — | Dry run a hypothetical trade. Opens nothing. |
| POST | `/api/trading-lab/positions` | admin | Evaluate, then open in the supplied lifecycle-eligible `strategyId`; unattributed execution is refused. |
| POST | `/api/trading-lab/positions/:id/close` | admin | Close the remainder in the supplied strategy account. |
| POST | `/api/trading-lab/mark` | admin | Mark one supplied strategy account to market; fires any stop/target reached. |
| GET | `/api/trading-lab/strategies` | — | The strategy catalogue with lifecycle metadata, live-research capability, structured rules, dataset availability, and computed `scannerEligible`, `liveResearchEligible` and `realMoneyEligible`. |
| GET | `/api/trading-lab/experiments?strategy=&version=&symbol=&timeframe=&limit=` | — | Research history, newest first. Read-only: there are no promotion mutations. |
| GET | `/api/trading-lab/experiments/:id` | — | One experiment record, or 404. |
| POST | `/api/trading-lab/backtest` | admin | Replay a symbol's candles. Body: `symbol`, `interval`, `strategy` (defaults to `mindset_v1`; an unknown id is a 400), `record` (opt-in experiment, returns `experimentId`), `notes`. Admin-gated despite being read-only: it replays hundreds of bars and pulls candles per call, so it should not be spinnable by anonymous visitors. Writes only to a temp ledger. |
| POST | `/api/trading-lab/backtest/compare` | admin | Replay several strategies over **one** candle fetch for candle strategies and event datasets for event-replay strategies, then reduce each to the promotion numbers: bars/events, signals, closed trades, net P&L, expectancy R, profit factor, max drawdown, win rate, worst loss streak. Defaults to every registered strategy. |
| POST | `/api/trading-lab/reset` | admin | Reset one supplied strategy account. Archived legacy ledgers cannot be reset. |

## Migration status

Done:

1. Trading Lab section created.
2. Paper-trading data model migrated.
3. Risk sizing and SL/TP logic integrated.
4. Expectancy, drawdown, win rate, profit factor and R-multiple analytics.
5. Decision Engine connected to the paper trader.
6. Six isolated accounts derived from the strategy registry; Main / Shadow SMC / Alts retained as archived, read-only legacy history.
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

The Signal Bot supplies research observations and alerts instead. It re-scans
the confluence screener on a timer and detects transitions on *closed* candles,
which preserves the old "on bar close" semantics without an inbound webhook.
It has no registered strategy identity, so it cannot own persistent trades.

    SignalBot (FLAT -> LONG/SHORT)  ->  SignalTradeBridge  ->  TradingLab.evaluate()

`src/services/trading/signal-bridge.js`, wired into the bot's interval loop:

- **Dry run by default.** Every entry transition is scored through the whole
  checklist -> edge gate -> risk sizing pipeline in a process-local,
  unattributed analysis ledger and logged with its verdict.
- **No persistent fallback.** If `SIGNAL_BOT_PAPER_TRADE_ENABLED=true`, the
  bridge records an explicit attribution refusal. It does not invent a strategy
  identity and cannot write to a strategy account or archived legacy ledger.
- **Entry observations only.** Only `FLAT -> LONG/SHORT` transitions are
  evaluated. Flips and exits are not persistent execution instructions.
- **Entry price is the signal's price**, carried on the transition rather than
  re-fetched, so the fill matches the bar the signal confirmed on. ATR comes
  from the screener's cached klines; if those fail, sizing falls back to
  `ATR_FALLBACK_PCT` rather than skipping the setup.
- **Degrades quietly.** An unreachable decision engine costs the setup its
  trend/macro points and evaluation continues; any bridge failure is caught so
  that a paper-trading fault never costs the deploy its Telegram alerts.
- **Alpha Team format.** Telegram alerts are group-facing ops updates, not raw
  bot logs. Screener transitions include tier, symbol/timeframe, pattern label,
  bias, trend regime, indicator evidence, Trading Lab verdict, and concise
  risk framing. Pattern Scanner breakouts/divergences use the same concise
  watch/verdict structure. When `MARKET_DASHBOARD_URL` is configured, group
  alerts link only to available pages such as Signal Screener and Pattern
  Scanner. Those shared links open in Alpha review mode (`?view=alpha`), where
  the requested page renders without the dashboard sidebar/tabs. When
  `ALPHA_TEAM_ACCESS_CODE` is configured, the shared page stays blurred behind
  an Alpha Team access prompt until the code is accepted.
  Unfinished setup sources stay visible as blurred `BETA` dashboard modules
  rather than direct group links.
- **Auto-marking** runs first in each cycle over every strategy account, while
  archived legacy ledgers remain untouched. Positions owned by the live scanner
  or live-research runner are skipped because each execution loop marks its own
  positions on its own venue and timeframe.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGNAL_BOT_PAPER_TRADE_ENABLED` | `false` | When `true`, log explicit attribution refusals; it does not authorize persistent execution. |
| `SIGNAL_BOT_AUTO_MARK_ENABLED` | `true` | Mark registered strategy accounts each interval, excluding archived legacy ledgers plus scanner- and live-research-owned positions. |
| `MARKET_DASHBOARD_URL` | empty | Public dashboard origin for Alpha Team `Visit:` links. Alerts omit links when this is blank. |

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
  kept in the strategy account as the instrument actually evaluated.
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
the account — `intentsFor()` is a pure function of the candles. One bar can
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
| `LIVE_SCANNER_PAPER_TRADE_ENABLED` | `true` | Set `false` to score and log without opening. |

The old `SIGNAL_BOT_BOOK` and `LIVE_SCANNER_BOOK` settings no longer select a
persistent ledger. Registered strategy identity determines the ledger; missing
or ineligible identity is refused rather than routed to a legacy book.

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
