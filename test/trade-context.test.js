"use strict";

// My Trades aggregates three engines onto one card. These cover the contract
// that matters: every tracked pair gets all three contexts on its own
// timeframe, disagreement is surfaced as disagreement rather than collapsed
// into an instruction, a dead engine degrades one section instead of the
// card, and nothing here re-derives an indicator or scans the universe.
const test = require("node:test");
const assert = require("node:assert");

const { TradeContextService, buildCard, classifyContext } = require("../src/services/trade-context");

function screenerRow({ symbol = "APTUSDT", signal = "LONG", score = 67, dominant = "top", state = "CONFIRMED", bottom = 15, top = 100, trendRegime = "TREND_UP", trend = "UPTREND" } = {}) {
  return {
    symbol,
    signal,
    score,
    price: 0.727,
    rsi: 58,
    adx: 30,
    trendRegime,
    extreme: {
      dominant,
      state,
      bottom: { score: bottom, reasons: [{ label: "Swing low swept" }] },
      top: { score: top, reasons: [{ label: "Swing high swept" }, { label: "Upper BB excursion" }, { label: "RSI overbought" }, { label: "Volume climax 2.1x" }] },
      context: { trend, setupType: "reversal top" },
    },
  };
}

function patternRow({ symbol = "APTUSDT", interval = "4h", pattern = "Rising Wedge", bias = "bearish", status = "forming", divergence = "Regular Bearish", divergenceBias = "bearish" } = {}) {
  return {
    symbol,
    label: symbol.replace(/USDT$/, ""),
    interval,
    pattern: pattern ? { pattern, bias, status, score: 71 } : null,
    divergence: divergence ? { type: divergence, bias: divergenceBias, barsAgo: 3 } : null,
    chart: null,
  };
}

/**
 * Records every engine call so a test can assert the aggregation never
 * reaches for a full-universe scan.
 */
function stubEngines({ screener = screenerRow(), pattern = patternRow() } = {}) {
  const calls = { screenerScanToken: [], patternScanToken: [], scanAll: 0 };
  return {
    calls,
    signalScreenerService: {
      async scanToken(symbol, interval, minChecks, opts) {
        calls.screenerScanToken.push({ symbol, interval, minChecks, opts });
        return typeof screener === "function" ? screener(symbol, interval) : { ...screener, symbol };
      },
      async scanAll() { calls.scanAll += 1; throw new Error("scanAll must not be used by the aggregation layer"); },
    },
    patternScannerService: {
      async scanToken(symbol, interval, opts) {
        calls.patternScanToken.push({ symbol, interval, opts });
        return typeof pattern === "function" ? pattern(symbol, interval) : { ...pattern, symbol, interval };
      },
      async scanAll() { calls.scanAll += 1; throw new Error("scanAll must not be used by the aggregation layer"); },
    },
  };
}

function serviceWith(items, engines = stubEngines()) {
  return {
    service: new TradeContextService({
      watchlistService: { list: () => items },
      signalScreenerService: engines.signalScreenerService,
      patternScannerService: engines.patternScannerService,
    }),
    engines,
  };
}

test("a tracked pair receives all three contexts on one card", async () => {
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h", label: "APT" }]);
  const { cards } = await service.list();

  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.symbol, "APTUSDT");
  assert.equal(card.interval, "4h");
  assert.equal(card.price, 0.727);

  assert.equal(card.directionalBias.bias, "BULLISH");
  assert.equal(card.directionalBias.score, 67);
  assert.equal(card.directionalBias.trendRegime, "TREND_UP");

  assert.equal(card.extremes.bottomScore, 15);
  assert.equal(card.extremes.topScore, 100);
  assert.equal(card.extremes.state, "CONFIRMED");
  assert.equal(card.extremes.dominant, "top");

  assert.equal(card.patterns.pattern, "Rising Wedge");
  assert.equal(card.patterns.status, "forming");
  assert.equal(card.patterns.divergence, "Regular Bearish");

  assert.ok(card.evidence.length, "the card carries supporting observations");
});

test("no combined score, and no buy/sell instruction, anywhere on the card", async () => {
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h" }]);
  const { cards } = await service.list();
  const card = cards[0];

  assert.ok(!("tradeScore" in card), "the three engines must not be averaged into one number");
  assert.ok(!("combinedScore" in card));
  assert.ok(!("recommendation" in card));
  assert.ok(!("action" in card));
  // The three scores stay independently visible instead.
  assert.equal(card.directionalBias.score, 67);
  assert.equal(card.extremes.topScore, 100);
  assert.equal(card.patterns.patternScore, 71);

  const serialized = JSON.stringify(card.context);
  assert.doesNotMatch(serialized, /\b(BUY|SELL|LONG|SHORT|ENTER|ENTRY)\b/i);
});

test("BULLISH bias with a confirmed top is a CONFLICT, not a long instruction", async () => {
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h" }]);
  const { cards } = await service.list();
  const { context } = cards[0];

  assert.equal(context.state, "CONFLICT");
  assert.match(context.summary, /bullish/i);
  assert.match(context.summary, /top-side extreme is confirmed/i);
});

test("BEARISH bias with a confirmed bottom is the mirror case", async () => {
  const engines = stubEngines({
    screener: screenerRow({ signal: "SHORT", score: 72, dominant: "bottom", state: "CONFIRMED", bottom: 91, top: 8, trendRegime: "TREND_DOWN", trend: "DOWNTREND" }),
    pattern: patternRow({ pattern: null, divergence: null }),
  });
  const { service } = serviceWith([{ symbol: "ETHUSDT", interval: "4h" }], engines);
  const { cards } = await service.list();
  const { context } = cards[0];

  assert.equal(context.state, "CONFLICT");
  assert.match(context.summary, /bearish/i);
  assert.match(context.summary, /bottom-side extreme is confirmed/i);
});

test("agreement reads as ALIGNED on both sides", async () => {
  const bullish = stubEngines({
    screener: screenerRow({ signal: "LONG", dominant: "bottom", state: "CONFIRMED", bottom: 88, top: 10 }),
    pattern: patternRow({ pattern: "Falling Wedge", bias: "bullish", status: "breakout", divergence: "Regular Bullish", divergenceBias: "bullish" }),
  });
  const bullishCards = (await serviceWith([{ symbol: "SOLUSDT", interval: "4h" }], bullish).service.list()).cards;
  assert.equal(bullishCards[0].context.state, "ALIGNED");
  assert.match(bullishCards[0].context.summary, /Bullish across/);

  const bearish = stubEngines({
    screener: screenerRow({ signal: "SHORT", dominant: "top", state: "CONFIRMED", bottom: 5, top: 92 }),
    pattern: patternRow({ pattern: "Rising Wedge", bias: "bearish", status: "breakout", divergence: "Regular Bearish", divergenceBias: "bearish" }),
  });
  const bearishCards = (await serviceWith([{ symbol: "XRPUSDT", interval: "4h" }], bearish).service.list()).cards;
  assert.equal(bearishCards[0].context.state, "ALIGNED");
  assert.match(bearishCards[0].context.summary, /Bearish across/);
});

test("a weak disagreement is MIXED rather than CONFLICT", () => {
  // A candidate extreme has exhaustion evidence but no confirmation trigger,
  // so it is not the hard stop a confirmed one is.
  const mixed = classifyContext({
    directionalBias: { bias: "BULLISH", signal: "LONG" },
    extremes: { dominant: "top", state: "CANDIDATE" },
    patterns: { patternBias: null, divergenceBias: null },
  });
  assert.equal(mixed.state, "MIXED");

  const conflict = classifyContext({
    directionalBias: { bias: "BULLISH", signal: "LONG" },
    extremes: { dominant: "top", state: "CONFIRMING" },
    patterns: { patternBias: null, divergenceBias: null },
  });
  assert.equal(conflict.state, "CONFLICT");
});

test("nothing to say on any engine is QUIET, not a false ALIGNED", () => {
  const quiet = classifyContext({
    directionalBias: { bias: "NEUTRAL", signal: "FLAT" },
    extremes: { dominant: null, state: "NONE" },
    patterns: { patternBias: null, divergenceBias: null },
  });
  assert.equal(quiet.state, "QUIET");
});

test("a missing Pattern Scanner result leaves the rest of the card intact", async () => {
  const engines = stubEngines({ pattern: patternRow({ pattern: null, divergence: null }) });
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h" }], engines);
  const { cards } = await service.list();

  assert.equal(cards[0].patterns.pattern, null);
  assert.equal(cards[0].patterns.divergence, null);
  assert.equal(cards[0].directionalBias.bias, "BULLISH");
  assert.equal(cards[0].extremes.topScore, 100);
  assert.deepEqual(cards[0].errors, [], "no pattern is not an error");
});

test("one upstream engine failing still renders the rest of the card", async () => {
  const engines = stubEngines();
  engines.signalScreenerService.scanToken = async () => { throw new Error("Binance klines HTTP 451"); };
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h" }], engines);
  const { cards } = await service.list();
  const card = cards[0];

  assert.equal(card.directionalBias.bias, null);
  assert.match(card.directionalBias.error, /451/);
  assert.match(card.extremes.error, /451|unavailable/i);
  // The engine that answered is still fully rendered.
  assert.equal(card.patterns.pattern, "Rising Wedge");
  assert.equal(card.patterns.divergence, "Regular Bearish");
  assert.ok(card.errors.length >= 1);
});

test("an engine returning its own error row degrades that section only", async () => {
  const engines = stubEngines({ screener: { symbol: "APTUSDT", error: "Not enough candle history for a stable signal yet" } });
  const { service } = serviceWith([{ symbol: "APTUSDT", interval: "4h" }], engines);
  const { cards } = await service.list();

  assert.match(cards[0].directionalBias.error, /Not enough candle history/);
  assert.equal(cards[0].patterns.pattern, "Rising Wedge");
});

test("each pair is scanned on its own tracked timeframe", async () => {
  const { service, engines } = serviceWith([
    { symbol: "APTUSDT", interval: "4h" },
    { symbol: "BTCUSDT", interval: "1D" },
    { symbol: "ETHUSDT", interval: "1h" },
  ]);
  const { cards } = await service.list();

  assert.deepEqual(cards.map((c) => `${c.symbol}:${c.interval}`), ["APTUSDT:4h", "BTCUSDT:1D", "ETHUSDT:1h"]);
  assert.deepEqual(
    engines.calls.screenerScanToken.map((c) => `${c.symbol}:${c.interval}`).sort(),
    ["APTUSDT:4h", "BTCUSDT:1D", "ETHUSDT:1h"],
  );
  assert.deepEqual(
    engines.calls.patternScanToken.map((c) => `${c.symbol}:${c.interval}`).sort(),
    ["APTUSDT:4h", "BTCUSDT:1D", "ETHUSDT:1h"],
  );
});

test("an empty watchlist costs no engine calls at all", async () => {
  const { service, engines } = serviceWith([]);
  const { cards, items } = await service.list();

  assert.deepEqual(cards, []);
  assert.deepEqual(items, []);
  assert.equal(engines.calls.screenerScanToken.length, 0);
  assert.equal(engines.calls.patternScanToken.length, 0);
});

test("aggregation never triggers a full-universe scan and never re-derives an indicator", async () => {
  const { service, engines } = serviceWith([
    { symbol: "APTUSDT", interval: "4h" },
    { symbol: "BTCUSDT", interval: "4h" },
  ]);
  await service.list();

  // Two tracked pairs: exactly one cached lookup per engine per pair, and no
  // scanAll — which would pull 25 symbols to display two.
  assert.equal(engines.calls.scanAll, 0);
  assert.equal(engines.calls.screenerScanToken.length, 2);
  assert.equal(engines.calls.patternScanToken.length, 2);

  // The service owns no indicator maths of its own.
  const source = require("node:fs").readFileSync(require.resolve("../src/services/trade-context.js"), "utf8");
  assert.doesNotMatch(source, /function (rsi|ema|sma|macd|bollinger|adx)/i);
  assert.doesNotMatch(source, /Math\.sqrt|BINANCE|fetch\(/);
});

test("buildCard composes without any service or network", () => {
  // The card model is pure, so the page's rendering contract can be tested
  // without engines at all.
  const card = buildCard({
    item: { symbol: "APTUSDT", interval: "4h", label: "APT" },
    screenerRow: screenerRow(),
    patternRow: patternRow(),
  });
  assert.equal(card.label, "APT");
  assert.equal(card.context.state, "CONFLICT");
  assert.ok(card.evidence.includes("Swing high swept"));
});

test("a surviving engine is not agreement: a broken one reads PARTIAL, never ALIGNED", async () => {
  // A silent pattern scan and a failed one must not look alike — claiming
  // alignment off one read would turn an outage into false confidence.
  const engines = stubEngines();
  engines.signalScreenerService.scanToken = async () => { throw new Error("Binance klines HTTP 451"); };
  const { service } = serviceWith([{ symbol: "ETHUSDT", interval: "4h" }], engines);
  const { cards } = await service.list();

  assert.equal(cards[0].context.state, "PARTIAL");
  assert.match(cards[0].context.summary, /only the pattern scan has a read/i);
  assert.match(cards[0].context.summary, /unavailable/i);
});

test("every engine down is PARTIAL, not QUIET", () => {
  const partial = classifyContext({
    directionalBias: { bias: null, error: "down" },
    extremes: { dominant: null, state: null, error: "down" },
    patterns: { patternBias: null, divergenceBias: null, error: "down" },
  });
  assert.equal(partial.state, "PARTIAL");
  assert.match(partial.summary, /Nothing to compare/);
});

test("a single read from healthy engines still counts as ALIGNED", () => {
  // Nothing erroring, nothing disagreeing — "nothing reads the other way" is
  // literally true here, unlike the outage case above.
  const aligned = classifyContext({
    directionalBias: { bias: "BULLISH", signal: "LONG" },
    extremes: { dominant: null, state: "NONE" },
    patterns: { patternBias: null, divergenceBias: null },
  });
  assert.equal(aligned.state, "ALIGNED");
});

test("evidence and errors do not repeat themselves", async () => {
  const engines = stubEngines({
    screener: {
      symbol: "SOLUSDT", signal: "LONG", score: 83, price: 110, rsi: 41, adx: 27, trendRegime: "TREND_UP",
      extreme: {
        dominant: "bottom", state: "CONFIRMED",
        bottom: { score: 88, reasons: [{ label: "Regular bullish divergence" }, { label: "Swing low swept" }] },
        top: { score: 10, reasons: [] },
        context: { trend: "UPTREND", setupType: "trend-pullback bottom" },
      },
    },
    pattern: patternRow({ pattern: null, divergence: "Regular Bullish", divergenceBias: "bullish" }),
  });
  const { service } = serviceWith([{ symbol: "SOLUSDT", interval: "1D" }], engines);
  const { cards } = await service.list();

  // Both engines report the same divergence; the card says it once.
  const divergenceLines = cards[0].evidence.filter((line) => /regular bullish divergence/i.test(line));
  assert.equal(divergenceLines.length, 1, "the same observation must not appear twice");

  const failing = stubEngines();
  failing.signalScreenerService.scanToken = async () => { throw new Error("Binance klines HTTP 451"); };
  const failedCards = (await serviceWith([{ symbol: "ETHUSDT", interval: "4h" }], failing).service.list()).cards;
  // One outage reaches both the bias and extremes sections, but reads once.
  assert.equal(failedCards[0].errors.length, 1);
});
