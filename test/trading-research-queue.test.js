"use strict";

// Stage one of the Trading Lab workflow:
//
//   Market Research  →  Backtest  →  Demo Account  →  Promotion Decision
//
// Research produces BACKTEST candidates and nothing else. These tests hold that
// boundary: no candidate can open a position, credit a demo account, or change
// a lifecycle status.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ResearchQueue, candidateKey } = require("../src/services/trading/research-queue");
const {
  discoverMarkets,
  discoverRegimes,
  generateExperiments,
  experimentsFromDecisionPlans,
  planResearch,
  suitsRegime,
} = require("../src/services/trading/research-planner");
const { listStrategies } = require("../src/services/trading/strategies");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");

const QUIET = { log() {}, warn() {}, error() {} };

function tempQueue() {
  return new ResearchQueue({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "research-queue-")),
    logger: QUIET,
  });
}

// A screener stand-in: scores per symbol, and candles that read as a clean
// range so the regime engine has something definite to say.
function fakeScreener({ scores = {}, failing = [] } = {}) {
  const rangeCandles = Array.from({ length: 200 }, (_, i) => {
    const close = 100 + Math.sin(i / 2) * 2.4;
    return {
      openTime: i * 3600000,
      closeTime: (i + 1) * 3600000 - 1,
      open: close,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000,
    };
  });
  return {
    async scanToken(symbol) {
      if (failing.includes(symbol)) throw new Error(`no data for ${symbol}`);
      return { symbol, score: scores[symbol] ?? 50, signal: "FLAT", adx: 15, trendRegime: "MIXED" };
    },
    async getCandles() {
      return rangeCandles;
    },
  };
}

/* ── The queue ────────────────────────────────────────────── */

test("a candidate needs a strategy, a symbol and a timeframe", () => {
  const queue = tempQueue();
  for (const bad of [{ symbol: "ETHUSDT", timeframe: "1h" }, { strategy: "smc_v1", timeframe: "1h" }, { strategy: "smc_v1", symbol: "ETHUSDT" }]) {
    assert.throws(() => queue.enqueue(bad), (err) => err.statusCode === 400);
  }
});

test("queuing the same outstanding candidate twice does not duplicate it", () => {
  // Discovery runs on a schedule; without this it would pile up a fresh copy of
  // every candidate on every pass.
  const queue = tempQueue();
  const first = queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h", origin: "market-discovery" });
  const second = queue.enqueue({ strategy: "smc_v1", symbol: "ethusdt", timeframe: "1h", origin: "market-discovery" });

  assert.equal(second.id, first.id, "case differences are the same experiment");
  assert.equal(second.deduped, true);
  assert.equal(queue.count(), 1);
});

test("a completed candidate does not block re-testing the same pair", () => {
  // Re-running a pair once new candles exist is the research loop, not a
  // duplicate.
  const queue = tempQueue();
  const first = queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" });
  queue.update(first.id, { status: "done", experimentId: "exp_1" });

  const again = queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" });
  assert.notEqual(again.id, first.id);
  assert.equal(again.deduped, undefined);
  assert.equal(queue.count(), 2);
});

test("status transitions carry the answer or the reason", () => {
  const queue = tempQueue();
  const item = queue.enqueue({ strategy: "vwap_reversion_v1", symbol: "SOLUSDT", timeframe: "1h" });

  const running = queue.update(item.id, { status: "running" });
  assert.ok(running.startedAt, "a running item records when it started");

  const done = queue.update(item.id, { status: "done", experimentId: "exp_42" });
  assert.equal(done.experimentId, "exp_42", "a finished candidate links to its experiment");
  assert.ok(done.completedAt);

  const failed = queue.update(queue.enqueue({ strategy: "smc_v1", symbol: "ADAUSDT", timeframe: "4h" }).id, {
    status: "failed",
    error: "not enough candles",
  });
  assert.equal(failed.error, "not enough candles");
  assert.ok(failed.completedAt);

  assert.throws(() => queue.update(item.id, { status: "nonsense" }), (err) => err.statusCode === 400);
  assert.throws(() => queue.update("rq_missing", { status: "done" }), (err) => err.statusCode === 404);
});

test("an unknown origin is refused rather than stored", () => {
  const queue = tempQueue();
  assert.throws(
    () => queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h", origin: "vibes" }),
    (err) => err.statusCode === 400,
  );
});

test("clearing completed work keeps the outstanding queue", () => {
  const queue = tempQueue();
  const done = queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" });
  queue.update(done.id, { status: "done" });
  queue.enqueue({ strategy: "vwap_reversion_v1", symbol: "SOLUSDT", timeframe: "1h" });

  assert.equal(queue.clearCompleted(), 1);
  assert.equal(queue.list({}).total, 1);
  assert.equal(queue.list({ status: "queued" }).total, 1);
});

test("a corrupt queue file degrades to empty rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-corrupt-"));
  fs.mkdirSync(path.join(dir, "research"), { recursive: true });
  fs.writeFileSync(path.join(dir, "research", "queue.json"), "{not json", "utf8");

  const queue = new ResearchQueue({ dataDir: dir, logger: QUIET });
  assert.deepEqual(queue.list({}).items, []);
  // And the next write repairs it.
  queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" });
  assert.equal(queue.count(), 1);
});

/* ── The three research jobs ──────────────────────────────── */

test("market discovery ranks pairs by the screener's own score", async () => {
  const screener = fakeScreener({ scores: { BTCUSDT: 40, ETHUSDT: 90, SOLUSDT: 70 } });
  const found = await discoverMarkets(screener, { symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], limit: 2 });

  assert.deepEqual(found.markets.map((m) => m.symbol), ["ETHUSDT", "SOLUSDT"]);
  assert.equal(found.scanned, 3);
});

test("an unreadable pair is reported, not silently dropped from the universe", async () => {
  const screener = fakeScreener({ scores: { BTCUSDT: 60 }, failing: ["ETHUSDT"] });
  const found = await discoverMarkets(screener, { symbols: ["BTCUSDT", "ETHUSDT"], limit: 5 });

  assert.deepEqual(found.markets.map((m) => m.symbol), ["BTCUSDT"]);
  assert.deepEqual(found.unavailable.map((u) => u.symbol), ["ETHUSDT"]);
});

test("regime discovery uses the shared engine, not the screener's coarse read", async () => {
  const screener = fakeScreener({ scores: { ETHUSDT: 80 } });
  const [market] = await discoverRegimes(screener, [{ symbol: "ETHUSDT", score: 80 }]);

  // The candles are a clean range, so the shared engine should say so.
  assert.ok(["RANGE", "ACCUMULATION", "DISTRIBUTION", "LOW_COMPRESSION"].includes(market.regime), market.regime);
  assert.equal(typeof market.regimeConfidence, "number");
  assert.ok("preferredMode" in market);
});

test("the regime prior separates mean-reversion from trend-following", () => {
  const byId = new Map(listStrategies({ supportsBacktest: true }).map((s) => [s.id, s]));

  assert.equal(suitsRegime(byId.get("vwap_reversion_v1"), "RANGE"), true);
  assert.equal(suitsRegime(byId.get("vwap_reversion_v1"), "TREND_UP"), false);
  assert.equal(suitsRegime(byId.get("donchian_breakout_v1"), "TREND_UP"), true);
  assert.equal(suitsRegime(byId.get("donchian_breakout_v1"), "RANGE"), false);
  // Nothing is obviously suited to an unreadable market, so everything is a
  // fair question rather than nothing being one.
  assert.equal(suitsRegime(byId.get("vwap_reversion_v1"), "TRANSITION"), true);
});

test("experiment generation records why each candidate is worth running", () => {
  const candidates = generateExperiments(
    [{ symbol: "ETHUSDT", regime: "RANGE", regimeConfidence: 82, regimeActionable: true }],
    { timeframes: ["1h"] },
  );

  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.ok(candidate.rationale, "a candidate without a rationale is a guess");
    assert.equal(candidate.regime.regime, "RANGE");
    assert.equal(candidate.suitedToRegime, true);
  }
  // A range only generates the mean-reversion strategy by default.
  assert.deepEqual([...new Set(candidates.map((c) => c.strategy))], ["vwap_reversion_v1"]);
});

test("mismatched pairings are generated only when asked for", () => {
  const market = [{ symbol: "ETHUSDT", regime: "TREND_UP", regimeConfidence: 75, regimeActionable: true }];

  const suited = generateExperiments(market, { timeframes: ["1h"] });
  assert.ok(!suited.some((c) => c.strategy === "vwap_reversion_v1"));

  const challenged = generateExperiments(market, { timeframes: ["1h"], includeMismatched: true });
  const vwap = challenged.find((c) => c.strategy === "vwap_reversion_v1");
  assert.ok(vwap, "deliberately testing a strategy against a hostile regime is a real question");
  assert.equal(vwap.suitedToRegime, false);
  assert.match(vwap.rationale, /not expected to suit/i);
});

test("event-replay strategies never become candle experiment candidates", () => {
  const candidates = generateExperiments(
    [{ symbol: "ETHUSDT", regime: "RANGE", regimeConfidence: 80 }],
    { timeframes: ["1h"], includeMismatched: true },
  );
  assert.ok(
    !candidates.some((c) => c.strategy === "shadow_bananagun_v1"),
    "BananaGun cannot be replayed on candles, so it has nothing to answer here",
  );
});

test("generation covers every requested timeframe", () => {
  const candidates = generateExperiments(
    [{ symbol: "ETHUSDT", regime: "RANGE", regimeConfidence: 80 }],
    { timeframes: ["1h", "4h"] },
  );
  assert.deepEqual([...new Set(candidates.map((c) => c.timeframe))].sort(), ["1h", "4h"]);
});

test("the full plan produces queueable candidates end to end", async () => {
  const screener = fakeScreener({ scores: { BTCUSDT: 55, ETHUSDT: 88 } });
  const plan = await planResearch(screener, { symbols: ["BTCUSDT", "ETHUSDT"], limit: 2, timeframes: ["1h"] });

  assert.ok(plan.markets.length > 0);
  assert.ok(plan.candidates.length > 0);

  const queue = tempQueue();
  const result = queue.enqueueMany(plan.candidates);
  assert.equal(result.added.length, plan.candidates.length);
  // Re-planning the same market does not re-queue the same work.
  assert.equal(queue.enqueueMany(plan.candidates).added.length, 0);
});

/* ── Decision Engine plans are seeds, not trades ──────────── */

test("a Decision Engine plan seeds experiments without carrying its direction", () => {
  const candidates = experimentsFromDecisionPlans(
    [{ symbol: "SOLUSDT", signal: "LONG" }],
    { timeframes: ["1h"], regimeBySymbol: { SOLUSDT: { regime: "TREND_UP", confidence: 70, actionable: true } } },
  );

  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(candidate.origin, "decision-engine");
    assert.equal(candidate.symbol, "SOLUSDT");
    // A backtest asks "does this strategy work on this pair", not "was this one
    // long correct" — the plan's direction must not survive into the candidate.
    assert.ok(!("direction" in candidate));
    assert.ok(!("signal" in candidate));
  }
});

test("a queued candidate cannot credit a strategy demo account", async () => {
  // The property the whole research stage rests on: research proposes
  // backtests, and only a strategy's own runner can write to its ledger.
  const lab = new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "research-lab-")),
    config: makeTradingConfig(),
  });
  const queue = tempQueue();
  queue.enqueue({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h", origin: "decision-engine" });

  // Nothing in the queue is an execution path, and execute() still refuses
  // anything without a registered strategy identity behind it.
  await assert.rejects(
    () => lab.execute({ symbol: "ETHUSDT", direction: "LONG", entryPrice: 100, atr: 2, state: {} }),
    (err) => err.statusCode === 400 && /registered strategy identity/i.test(err.message),
  );
  assert.equal(lab.strategyLedger("smc_v1").getOpenPositions().length, 0);
  assert.equal(lab.strategyLedger("smc_v1").getHistory().length, 0);
});

test("candidateKey is the identity of one experiment", () => {
  assert.equal(
    candidateKey({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" }),
    candidateKey({ strategy: "SMC_V1", symbol: "ethusdt", timeframe: "1H" }),
  );
  assert.notEqual(
    candidateKey({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "1h" }),
    candidateKey({ strategy: "smc_v1", symbol: "ETHUSDT", timeframe: "4h" }),
  );
});
