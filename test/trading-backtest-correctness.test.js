"use strict";

// Research-correctness regressions for the Trading Lab.
//
// These are not tests of whether a strategy makes money. They are tests of
// whether the lab is capable of answering that question — four ways it was
// previously giving confident answers to a slightly different question than the
// one asked:
//
//   1. A replay's risk state was kept on wall-clock time, so every historical
//      loss in a multi-month run accumulated into ONE day and ONE week.
//   2. The tested timeframe's own EMA trend was handed downstream as
//      higher-timeframe context, and paid for as such.
//   3. The consecutive-loss breaker was an absorbing state: no trade could
//      open, so no trade could win, so the streak never cleared.
//   4. A comparison requested as "native" reported itself as native even when
//      no row in it had used a native level.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BacktestService,
  appliedExecution,
  contextAtBar,
  stateFromContext,
} = require("../src/services/trading/backtest");
const { PaperTradingService, MemoryStorage } = require("../src/services/trading/paper-trader");
const { makeTradingConfig } = require("../src/services/trading/config");
const {
  scoreSetup,
  marketState,
  runChecklist,
  runKillSwitches,
} = require("../src/services/trading/checklist");

const DAY_MS = 86400000;

// Market context a caller has once a higher-timeframe and funding feed exist.
// Supplied by the fixtures below that are exercising the BREAKER and the
// EXECUTION MODES, neither of which is about whether the checklist sizes a
// candles-only setup — that restriction has its own tests further down.
const FED_LONG = Object.freeze({
  htfTrendUp: true,
  usdtDominanceSignal: "RISK_ON",
  btcDominanceRising: false,
  bearMarket: false,
  fundingRate: 0,
});

function makeTrader(configOverrides = {}, opts = {}) {
  return new PaperTradingService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-")),
    book: "main",
    config: makeTradingConfig(configOverrides),
    ...opts,
  });
}

// A 1 BTC long at 100 risking $10, stop 90 — a $10 loss when it stops out.
function openLong(trader, overrides = {}) {
  return trader.openPosition({
    symbol: "BTCUSDT",
    direction: "LONG",
    size: 1,
    entryPrice: 100,
    stopLoss: 90,
    tp1: 115,
    tp2: 125,
    riskUsd: 10,
    signalSource: "test",
    ...overrides,
  });
}

// Open at `at` and stop out at `at`, booking a $10 loss on that simulated day.
async function loseAt(trader, at) {
  openLong(trader, { openedAt: at });
  await trader.updatePositions({ BTCUSDT: 90 }, { at });
}

/* ── Phase 1: replay time ─────────────────────────────────── */

test("historical losses land on the historical day, not on today", async () => {
  const trader = makeTrader();
  const day1 = Date.UTC(2024, 2, 4, 12); // Monday
  await loseAt(trader, day1);

  const account = trader.getAccount({ at: day1 });
  assert.equal(account.dailyDate, "2024-03-04");
  assert.equal(account.dailyPnl, -10);
  assert.equal(account.weekStart, "2024-W10");
  assert.equal(account.weeklyPnl, -10);
});

test("a loss on historical day 1 does not count toward day 2's daily limit", async () => {
  const trader = makeTrader();
  const day1 = Date.UTC(2024, 2, 4, 12);
  const day2 = Date.UTC(2024, 2, 5, 12);

  await loseAt(trader, day1);
  assert.equal(trader.getRiskState({ at: day1 }).dailyLossPct, 0.1);

  // Same week, next day. The daily bucket rolls; the weekly one does not.
  const day2State = trader.getRiskState({ at: day2 });
  assert.equal(day2State.dailyLossPct, 0);
  assert.equal(day2State.weeklyLossPct, 0.1);
});

test("same-day historical losses still accumulate", async () => {
  const trader = makeTrader();
  const morning = Date.UTC(2024, 2, 4, 1);
  const evening = Date.UTC(2024, 2, 4, 23);

  await loseAt(trader, morning);
  await loseAt(trader, evening);

  // Two $10 losses inside one UTC day is a 0.2% day, and the kill switch has
  // to see both of them — rolling per-trade rather than per-day would defeat
  // the limit entirely, which is the opposite failure to the one above.
  assert.equal(trader.getRiskState({ at: evening }).dailyLossPct, 0.2);
});

test("weekly P&L resets when the simulated ISO week changes", async () => {
  const trader = makeTrader();
  const friday = Date.UTC(2024, 2, 8, 12); // 2024-W10
  const nextMonday = Date.UTC(2024, 2, 11, 12); // 2024-W11

  await loseAt(trader, friday);
  assert.equal(trader.getRiskState({ at: friday }).weeklyLossPct, 0.1);

  const rolled = trader.getRiskState({ at: nextMonday });
  assert.equal(rolled.weeklyLossPct, 0);
  assert.equal(trader.getAccount({ at: nextMonday }).weekStart, "2024-W11");
});

test("a months-long replay does not pile every loss into one day", async () => {
  // The bug this pins: with rollover on wall-clock time, a run replaying six
  // months of candles booked every loss in the sample into the same daily and
  // weekly bucket, tripped DAILY_LOSS_LIMIT within the first few trades, and
  // then refused everything after it. The headline numbers described the first
  // few days of the sample and the skip rate described nothing at all.
  const trader = makeTrader();
  const start = Date.UTC(2024, 0, 1, 12);

  for (let day = 0; day < 60; day += 1) {
    await loseAt(trader, start + day * DAY_MS);
  }

  const account = trader.getAccount({ at: start + 59 * DAY_MS });
  assert.equal(account.totalTrades, 60);
  assert.equal(account.realizedPnl, -600); // every loss is in the P&L
  assert.equal(account.dailyPnl, -10); // but only one of them is in today's
  assert.equal(trader.getRiskState({ at: start + 59 * DAY_MS }).dailyLossPct, 0.1);
});

test("forward paper trading still keeps its buckets on the wall clock", async () => {
  // No `at`, no clock: the current-time path has to behave exactly as before.
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 });

  const account = trader.getAccount();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(account.dailyDate, today);
  assert.equal(account.dailyPnl, -10);
  assert.equal(trader.getRiskState().dailyLossPct, 0.1);
});

test("the service clock is a backstop for a call site that forgets its `at`", async () => {
  const trader = makeTrader({}, { clock: Date.UTC(2024, 2, 4, 12) });
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 });

  // Neither call above passed `at`. Under wall-clock time this would have been
  // booked today; under the replay clock it lands where the replay is.
  assert.equal(trader.getAccount().dailyDate, "2024-03-04");
  assert.equal(trader.getHistory()[0].closedAt, new Date(Date.UTC(2024, 2, 4, 12)).toISOString());
});

/* ── Phase 3: consecutive-loss semantics ──────────────────── */

test("three consecutive losses trip the breaker and block the same session", async () => {
  const trader = makeTrader({ maxConsecutiveLosses: 3 });
  const day = Date.UTC(2024, 2, 4, 1);

  for (let i = 0; i < 3; i += 1) await loseAt(trader, day + i * 3600000);

  const state = trader.getRiskState({ at: day + 4 * 3600000 });
  assert.equal(state.consecutiveLosses, 3);

  // Still blocked later the same UTC day: the cool-off is a session, not a
  // cooldown timer that a few bars can outrun.
  const later = trader.getRiskState({ at: Date.UTC(2024, 2, 4, 23, 59) });
  assert.equal(later.consecutiveLosses, 3);
});

test("the breaker clears at the next simulated day so a replay is not absorbed", async () => {
  const trader = makeTrader({ maxConsecutiveLosses: 3 });
  const day1 = Date.UTC(2024, 2, 4, 1);
  for (let i = 0; i < 3; i += 1) await loseAt(trader, day1 + i * 3600000);

  const nextDay = trader.getRiskState({ at: Date.UTC(2024, 2, 5, 0, 1) });
  assert.equal(nextDay.consecutiveLosses, 0);
});

test("the cool-off clears only a TRIPPED streak, not an ordinary one", async () => {
  // Two losses is not a breach, so a day boundary must not quietly forgive
  // them — that would make the third loss on a new day the first again and the
  // limit unreachable across a day boundary.
  const trader = makeTrader({ maxConsecutiveLosses: 3 });
  await loseAt(trader, Date.UTC(2024, 2, 4, 1));
  await loseAt(trader, Date.UTC(2024, 2, 4, 2));

  assert.equal(trader.getRiskState({ at: Date.UTC(2024, 2, 5, 1) }).consecutiveLosses, 2);
});

test('CONSECUTIVE_LOSS_COOLOFF="never" keeps the absorbing behaviour on request', async () => {
  const trader = makeTrader({ maxConsecutiveLosses: 3, consecutiveLossCooloff: "never" });
  const day1 = Date.UTC(2024, 2, 4, 1);
  for (let i = 0; i < 3; i += 1) await loseAt(trader, day1 + i * 3600000);

  // A defensible policy for real money, and a stated one rather than an
  // accident of which code path ran.
  assert.equal(trader.getRiskState({ at: Date.UTC(2024, 3, 4, 1) }).consecutiveLosses, 3);
});

test("a winning trade still clears the streak immediately", async () => {
  const trader = makeTrader({ maxConsecutiveLosses: 3 });
  const day = Date.UTC(2024, 2, 4, 1);
  await loseAt(trader, day);
  await loseAt(trader, day + 3600000);

  openLong(trader, { openedAt: day + 2 * 3600000 });
  await trader.updatePositions({ BTCUSDT: 130 }, { at: day + 3 * 3600000 });

  assert.equal(trader.getAccount({ at: day + 3 * 3600000 }).consecutiveLosses, 0);
});

test("a replay is not absorbed by the consecutive-loss breaker", async () => {
  // The end-to-end version. Under the absorbing breaker, once a run's streak
  // reached the limit EVERY later signal came back as a CONSECUTIVE_LOSSES
  // kill switch — the checklist never got as far as scoring another setup, so
  // the run's skip rate was really just "the breaker, forever" and its
  // headline numbers described whatever happened before it tripped.
  //
  // Run the same candles under both policies and compare. Asserting on trade
  // counts alone would not isolate this: the edge gate blocks this fixture
  // later on too, for its own good reasons, and that is a different gate.
  const candles = choppyCandles(600);
  const strategy = ({ bars }) => (bars.length % 3 === 0 ? "LONG" : null);

  async function replayUnder(cooloff) {
    const service = new BacktestService({
      config: makeTradingConfig({ consecutiveLossCooloff: cooloff }),
    });
    const result = await service.run({
      symbol: "BTCUSDT",
      candles,
      warmupBars: 60,
      strategy,
      marketContext: FED_LONG,
    });
    const trippedAt = result.skipped.findIndex((s) =>
      s.reasons.some((r) => r.includes("CONSECUTIVE_LOSSES")),
    );
    const after = trippedAt === -1 ? [] : result.skipped.slice(trippedAt + 1);
    return {
      trippedAt,
      // Later evaluations that got PAST the kill switches to be scored. Under
      // an absorbing breaker there are none.
      scoredAfter: after.filter((s) => s.reasons.some((r) => /^Score \d+\/100/.test(r))).length,
      trades: result.trades.length,
    };
  }

  const absorbing = await replayUnder("never");
  const cooling = await replayUnder("next-day");

  assert.ok(absorbing.trippedAt >= 0, "the fixture has to actually trip the breaker");
  assert.equal(absorbing.scoredAfter, 0, "under 'never' the breaker should absorb, by definition");

  assert.ok(cooling.trippedAt >= 0);
  assert.ok(
    cooling.scoredAfter > 50,
    `the cooled-off replay should keep scoring setups, saw ${cooling.scoredAfter}`,
  );
  assert.ok(
    cooling.trades > absorbing.trades,
    `cooled-off ${cooling.trades} trades vs absorbed ${absorbing.trades}`,
  );
});

// Oscillating candles: enough movement to produce both winners and losers, so
// a run cannot trivially avoid tripping the loss breaker.
function choppyCandles(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + Math.sin(i / 9) * 6 + i * 0.05;
    bars.push({
      openTime: i * 3600000,
      closeTime: (i + 1) * 3600000,
      open: close,
      high: close + 1.2,
      low: close - 1.2,
      close,
      volume: 1000 + (i % 11) * 150,
    });
  }
  return bars;
}

/* ── Phase 2: HTF context ─────────────────────────────────── */

test("a candle backtest reports the timeframe's trend and no HTF trend", () => {
  const candles = choppyCandles(200);
  const options = { trendFast: 21, trendSlow: 55, macdFast: 12, macdSlow: 26, macdSignal: 9 };
  const context = contextAtBar(candles, options);

  assert.ok("timeframeTrendUp" in context, "the timeframe's own trend is still available");
  assert.notEqual(context.timeframeTrendUp, null);
  // There is one timeframe of data here, so there is no higher-timeframe read
  // to be had, and the context says so rather than substituting one.
  assert.equal(context.htfTrendUp, null);
  assert.ok(!("trendUp" in context), "the ambiguous `trendUp` name is gone");
});

test("same-timeframe trend does not become the checklist's daily bias", () => {
  const upContext = { timeframeTrendUp: true, htfTrendUp: null, macdBullish: true, atrRatio: 1, volumeRatio: 1 };
  const downContext = { ...upContext, timeframeTrendUp: false };

  // Regime still follows the tested timeframe — the regime gate is written
  // against the chart being traded and that is coherent.
  assert.equal(stateFromContext(upContext).regime, "TREND_UP");
  assert.equal(stateFromContext(downContext).regime, "TREND_DOWN");

  // Daily bias does not. It is the checklist's higher-timeframe block, and a
  // 4h EMA cross is not a daily read however convenient it would be.
  assert.equal(stateFromContext(upContext).dailyBias, "NEUTRAL");
  assert.equal(stateFromContext(downContext).dailyBias, "NEUTRAL");
});

test("genuine higher-timeframe context still drives the daily bias", () => {
  const base = { timeframeTrendUp: false, macdBullish: true, atrRatio: 1, volumeRatio: 1 };
  assert.equal(stateFromContext({ ...base, htfTrendUp: true }).dailyBias, "BULLISH");
  assert.equal(stateFromContext({ ...base, htfTrendUp: false }).dailyBias, "BEARISH");
});

test("a candle backtest cannot collect the checklist's full HTF credit", () => {
  const config = makeTradingConfig();
  const context = { timeframeTrendUp: true, htfTrendUp: null, macdBullish: true, atrRatio: 1, volumeRatio: 1 };
  const state = marketState(stateFromContext(context));

  const withTrend = scoreSetup({ direction: "LONG" }, state, config);
  const htfReason = withTrend.reasons.find((r) => r.startsWith("HTF:"));

  // +15 for "no opinion", not +30 for an alignment nobody established. The 15
  // points are the difference between a setup scoring 65 (HALF SIZE) and 50
  // (QUARTER), or between 50 and SKIP — which is to say, the difference
  // between two different backtests.
  assert.equal(htfReason, "HTF: Daily bias NEUTRAL (+15)");

  const genuine = marketState(stateFromContext({ ...context, htfTrendUp: true }));
  const withHtf = scoreSetup({ direction: "LONG" }, genuine, config);
  assert.equal(withHtf.score - withTrend.score, 15);
  assert.ok(withHtf.reasons.includes("HTF: Daily bias BULLISH (+30)"));
});

/* ── Unavailable macro/funding is unavailable, not favourable ───── */

test("absent macro data scores the same for a long and a short", () => {
  const config = makeTradingConfig();
  // Exactly what a candle backtest supplies: regime, bias, MACD, ATR, volume.
  // No dominance feed, no bear-market read, no funding history.
  const state = marketState(
    stateFromContext({ timeframeTrendUp: true, htfTrendUp: null, macdBullish: null, atrRatio: 1, volumeRatio: 1 }),
  );

  const long = scoreSetup({ direction: "LONG" }, state, config);
  const short = scoreSetup({ direction: "SHORT" }, state, config);

  // The bug: the macro defaults were OBSERVATIONS, not absences. "Dominance
  // flat, BTC dominance not rising, not a bear market" is a favourable reading
  // for a long and an unfavourable one for a short, so a long collected +20
  // and a short +0 — twenty points of directional bias produced entirely by
  // the absence of data. With SKIP at 50, that gap alone decided whether a
  // setup traded: long 57 (TAKE_QUARTER) against short 37 (SKIP).
  assert.equal(long.score, short.score);
  assert.ok(long.reasons.includes("Macro: no data (+0)"));
  assert.ok(short.reasons.includes("Macro: no data (+0)"));
  assert.ok(long.reasons.includes("Funding: no data (+0)"));
});

test("a measured neutral still scores; only an absent one does not", () => {
  const config = makeTradingConfig();
  const measured = marketState({
    usdtDominanceSignal: "NEUTRAL",
    btcDominanceRising: false,
    bearMarket: false,
    fundingRate: 0,
  });
  const absent = marketState({});

  const withData = scoreSetup({ direction: "LONG" }, measured, config);
  const without = scoreSetup({ direction: "LONG" }, absent, config);

  // "We looked, and funding is flat" is evidence. "We never looked" is not.
  // Collapsing the two is what produced the bias above.
  assert.ok(withData.reasons.some((r) => r.startsWith("Macro: All green")));
  assert.ok(withData.reasons.includes("Funding: Neutral (+5)"));
  assert.equal(withData.score - without.score, 25);
});

test("the funding kill switch cannot fire, or decline to fire, on data nobody has", () => {
  const config = makeTradingConfig();
  // A measured breach still kills.
  assert.match(runKillSwitches(marketState({ fundingRate: 0.002 }), config), /FUNDING_BLOCK/);
  // An absent rate is not a breach and is not a pass — there is simply no
  // funding evidence, and the other switches are unaffected.
  assert.equal(runKillSwitches(marketState({}), config), "");
});

test("a checklist result says how many points were actually reachable", () => {
  const config = makeTradingConfig();
  const candlesOnly = marketState(
    stateFromContext({ timeframeTrendUp: true, htfTrendUp: null, macdBullish: true, atrRatio: 1, volumeRatio: 1 }),
  );
  const result = runChecklist({ symbol: "BTCUSDT", direction: "LONG", price: 100, atr: 1 }, candlesOnly, config);

  // 15 daily bias (NEUTRAL) + 0 macro + 20 triggers + 15 volume + 10
  // volatility + 0 funding. A candle backtest is scored against 60, not 100,
  // while the SKIP floor stays at 50 — so it has to clear 83% of the evidence
  // available to it where a fully-fed live candidate clears 50%. That is a
  // calibration question for the promotion framework, and reporting it is how
  // it stops being invisible.
  assert.equal(result.availablePoints, 60);
  assert.ok(result.confidenceScore <= result.availablePoints);

  const fullyFed = marketState({
    dailyBias: "BULLISH",
    usdtDominanceSignal: "RISK_ON",
    btcDominanceRising: false,
    bearMarket: false,
    fundingRate: 0,
    macdBullish: true,
    stochSignal: "OVERSOLD_CROSS",
  });
  assert.equal(
    runChecklist({ symbol: "BTCUSDT", direction: "LONG", price: 100, atr: 1 }, fullyFed, config).availablePoints,
    100,
  );
});

test("supplied market context is recorded on the run, so a fed run is never mistaken for a bare one", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = choppyCandles(400);
  const strategy = ({ bars }) => (bars.length % 3 === 0 ? "LONG" : null);

  const bare = await service.run({ symbol: "BTCUSDT", candles, warmupBars: 60, strategy });
  const fed = await service.run({ symbol: "BTCUSDT", candles, warmupBars: 60, strategy, marketContext: FED_LONG });

  assert.deepEqual(bare.marketContextFields, []);
  assert.deepEqual(fed.marketContextFields, [
    "bearMarket",
    "btcDominanceRising",
    "fundingRate",
    "htfTrendUp",
    "usdtDominanceSignal",
  ]);
  // And it is not cosmetic: the fed run has evidence the bare one does not.
  assert.ok(fed.trades.length > bare.trades.length);
});

/* ── Phase 4: applied execution ───────────────────────────── */

test("appliedExecution separates what was asked for from what was used", () => {
  assert.equal(appliedExecution({ executionMode: "shared", sharedTrades: 9 }), "shared");
  assert.equal(appliedExecution({ executionMode: "native", nativeTrades: 9 }), "native");
  assert.equal(appliedExecution({ executionMode: "native", sharedTrades: 9 }), "shared-fallback");
  assert.equal(appliedExecution({ executionMode: "native", nativeTrades: 4, sharedTrades: 5 }), "mixed");
  assert.equal(appliedExecution({ executionMode: "native" }), "none");
  assert.equal(appliedExecution({ executionMode: "shared" }), "none");
});

test("a native run of a strategy with no hints reports shared fallback", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = choppyCandles(600);

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: 60,
    executionMode: "native",
    marketContext: FED_LONG,
    // Stands in for mindset_v1: signals, publishes no levels.
    strategy: ({ bars }) => (bars.length % 3 === 0 ? "LONG" : null),
  });

  assert.ok(result.trades.length > 0, "the fixture has to actually trade");
  assert.equal(result.executionMode, "native");
  assert.equal(result.executionApplied, "shared-fallback");
  assert.equal(result.nativeTrades, 0);
  assert.equal(result.sharedTrades, result.trades.length + result.openAtEnd.length);
  assert.ok(result.caveats.some((c) => /SHARED execution despite executionMode=native/.test(c)));
});

test("a native run of a strategy with valid hints reports native", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = choppyCandles(600);

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: 60,
    executionMode: "native",
    marketContext: FED_LONG,
    strategy: hintingStrategy(() => true),
  });

  assert.ok(result.trades.length > 0);
  assert.equal(result.executionApplied, "native");
  assert.equal(result.sharedTrades, 0);
  assert.equal(result.nativeFallbacks, 0);
});

test("a strategy whose hints are only sometimes usable reports mixed", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = choppyCandles(600);
  let n = 0;

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: 60,
    executionMode: "native",
    marketContext: FED_LONG,
    // Every other signal publishes no levels, so half the fills fall back.
    strategy: hintingStrategy(() => (n += 1) % 2 === 0),
  });

  assert.ok(result.nativeTrades > 0 && result.sharedTrades > 0, "the fixture must produce both");
  assert.equal(result.executionApplied, "mixed");
  assert.equal(result.nativeFallbacks, result.sharedTrades);
});

test("shared mode still reports shared, whatever hints a strategy publishes", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = choppyCandles(600);

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: 60,
    strategy: hintingStrategy(() => true),
    marketContext: FED_LONG,
  });

  assert.ok(result.trades.length > 0);
  assert.equal(result.executionApplied, "shared");
  assert.equal(result.nativeTrades, 0);
});

test("a comparison carries applied execution onto every row", async () => {
  const candles = choppyCandles(600);
  const service = new BacktestService({
    config: makeTradingConfig(),
    signalScreenerService: { getCandles: async () => candles },
  });

  const comparison = await service.compare({
    symbol: "BTCUSDT",
    strategies: ["mindset_v1", "donchian_breakout_v1"],
    executionMode: "native",
    marketContext: FED_LONG,
  });

  // The header says "native" because that is what was requested. Each row says
  // what it actually ran on, and a reader is never left inferring the second
  // from the first.
  assert.equal(comparison.executionMode, "native");
  comparison.results.forEach((row) => {
    assert.ok(
      ["native", "shared", "shared-fallback", "mixed", "none"].includes(row.executionApplied),
      `row ${row.strategy} has no applied execution`,
    );
  });

  const mindset = comparison.results.find((r) => r.strategy === "mindset_v1");
  // mindset_v1 publishes no stop/target hints at all, so a "native" run of it
  // is a shared run and the row is required to say so.
  assert.notEqual(mindset.executionApplied, "native");
  assert.equal(mindset.nativeTrades, 0);
});

// A strategy in the registry shape that publishes structural levels, gated by
// `usable` so a test can decide per signal whether native execution is
// available. Levels are on the correct side of the entry when published.
function hintingStrategy(usable) {
  return {
    id: "hinting_test",
    name: "Hinting test strategy",
    version: "1.0.0",
    status: "backtest",
    supportsBacktest: true,
    supportsLiveScanner: false,
    requiredWarmupBars: 0,
    evaluate(candles, index) {
      const bar = candles[index];
      if (index % 3 !== 0) {
        return { signal: "FLAT", strategy: "hinting_test", price: bar.close, error: null, reasons: [], indicators: {}, confidence: null, stopHint: null, targetHint: null };
      }
      const ok = usable();
      return {
        signal: "LONG",
        strategy: "hinting_test",
        price: bar.close,
        error: null,
        reasons: [],
        indicators: {},
        confidence: null,
        stopHint: ok ? bar.close - 2 : null,
        targetHint: ok ? bar.close + 4 : null,
      };
    },
  };
}

/* ── Storage adapters ─────────────────────────────────────── */

test("the memory adapter and the file adapter are interchangeable", async () => {
  // The whole shared-engine argument rests on this: a backtest is evidence
  // about forward paper trading only if swapping where the ledger lives
  // changes nothing about what the ledger says.
  async function runBook(storage) {
    const trader = new PaperTradingService({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-")),
      book: "main",
      config: makeTradingConfig({ takerFeeRate: 0.0006, slippageRate: 0.0002 }),
      storage,
    });
    const at = Date.UTC(2024, 2, 4, 12);
    openLong(trader, { openedAt: at });
    await trader.updatePositions({ BTCUSDT: 118 }, { at });   // TP1 partial
    await trader.updatePositions({ BTCUSDT: 130 }, { at });   // TP2 remainder
    openLong(trader, { openedAt: at });
    await trader.updatePositions({ BTCUSDT: 85 }, { at });    // stop, gapped
    return {
      account: trader.getAccount({ at }),
      history: trader.getHistory(),
      stats: await trader.getStats({ at }),
    };
  }

  const onDisk = await runBook(null);
  const inMemory = await runBook(new MemoryStorage());

  // Trade ids embed a timestamp and a random suffix, so they are the one thing
  // that legitimately differs between two runs.
  const strip = (t) => ({ ...t, id: null });
  assert.deepEqual(inMemory.history.map(strip), onDisk.history.map(strip));
  assert.deepEqual(
    { ...inMemory.account, created: null, lastUpdated: null },
    { ...onDisk.account, created: null, lastUpdated: null },
  );
  assert.equal(inMemory.stats.balance, onDisk.stats.balance);
  assert.equal(inMemory.stats.realizedPnl, onDisk.stats.realizedPnl);
  assert.deepEqual(inMemory.stats.riskMetrics, onDisk.stats.riskMetrics);
});

test("the memory adapter hands every reader its own copy", () => {
  const storage = new MemoryStorage();
  storage.write("k", { nested: { list: [1, 2] } });

  const a = storage.read("k", null);
  const b = storage.read("k", null);
  a.nested.list.push(3);

  assert.deepEqual(b.nested.list, [1, 2], "a reader's mutation leaked into another reader");
  assert.deepEqual(storage.read("k", null).nested.list, [1, 2], "and into the store itself");
});

test("the memory adapter drops undefined values, as a JSON round trip would", () => {
  const storage = new MemoryStorage();
  storage.write("k", { present: 1, absent: undefined });
  assert.deepEqual(Object.keys(storage.read("k", null)), ["present"]);
});

/* ── Lookahead: every strategy, not just the ones we remembered ─── */

// Candles with enough structure that each registered strategy can actually
// reach a decision: a wavy uptrend with volume, swing points and real ranges.
function structuredCandles(count, seed = 11) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.25 + Math.sin(i / 4) * 3 + Math.sin(i / 17) * 6;
    const wick = 0.4 + rnd();
    bars.push({
      openTime: i * 900000,
      closeTime: (i + 1) * 900000 - 1,
      open: close - 0.2,
      high: close + wick,
      low: close - wick,
      close,
      volume: 800 + rnd() * 900,
    });
  }
  return bars;
}

test("no registered strategy can see past the bar it is deciding", async () => {
  // The runner used to enforce this structurally: it handed each strategy an
  // array truncated at the decided bar, so future candles were not merely
  // ignored, they were absent. Precomputing the indicator series changed that
  // — strategies now receive the FULL array plus an index and are trusted to
  // respect it.
  //
  // Every strategy in the registry today does (each slices to 0..index as its
  // first move). This test exists so that the next one has to as well: it is
  // registry-driven, so a Strategy v2 added later is covered the moment it is
  // registered, without anyone remembering to write this test again.
  const { STRATEGIES } = require("../src/services/trading/strategies");
  const candles = structuredCandles(400);
  const backtestable = STRATEGIES.filter((s) => s.supportsBacktest !== false);
  assert.ok(backtestable.length >= 4, "expected the registry to have candle strategies to check");

  // A future that could not be mistaken for noise: every bar after the
  // decision point is tripled, inverted through its own range and given a
  // hundredfold volume. Any indicator, swing scan, channel or VWAP that reads
  // even one bar too far will move.
  function wreckFuture(bars, from) {
    return bars.map((b, i) =>
      i <= from
        ? b
        : {
            ...b,
            open: b.open * 3,
            high: b.high * 3 + 500,
            low: b.low / 3 - 500,
            close: b.close * 3,
            volume: b.volume * 100,
          },
    );
  }

  for (const strategy of backtestable) {
    // Several decision points, including one immediately after warmup where
    // the strategy has the least history and is most likely to over-reach.
    const warmup = Math.max(Number(strategy.requiredWarmupBars) || 0, 130);
    for (const index of [warmup, Math.floor((warmup + 399) / 2), 398]) {
      if (index >= candles.length) continue;

      const clean = strategy.evaluate(candles, index, {});
      const wrecked = strategy.evaluate(wreckFuture(candles, index), index, {});

      assert.deepEqual(
        wrecked,
        clean,
        `${strategy.id} produced a different signal at bar ${index} when only LATER bars changed — it is reading past its index`,
      );
    }
  }
});

test("the future-invariance check would actually catch a peeking strategy", async () => {
  // A test that can only pass is not a test. This is the same comparison run
  // against a strategy that deliberately reads one bar too far, to prove the
  // assertion above has teeth.
  const candles = structuredCandles(400);
  // The realistic version of this bug, and the one the refactor made possible:
  // a strategy that computes an indicator over `bars` instead of over
  // `bars.slice(0, index + 1)`. It looks completely ordinary.
  const peeker = {
    id: "peeker_v0",
    evaluate(bars, index) {
      const closes = bars.map((b) => b.close); // <- the whole array, not the prefix
      const average = closes.reduce((a, b) => a + b, 0) / closes.length;
      return {
        signal: bars[index].close > average ? "LONG" : "FLAT",
        strategy: "peeker_v0",
        price: bars[index].close,
        error: null,
        reasons: [],
        indicators: { average },
        confidence: null,
        stopHint: null,
        targetHint: null,
      };
    },
  };

  const wrecked = candles.map((b, i) =>
    i <= 200 ? b : { ...b, open: b.open * 3, high: b.high * 3 + 500, low: b.low / 3 - 500, close: b.close * 3, volume: b.volume * 100 },
  );

  assert.notDeepEqual(
    peeker.evaluate(wrecked, 200, {}),
    peeker.evaluate(candles, 200, {}),
    "the invariance check failed to notice a strategy reading bars[index + 1]",
  );
});
