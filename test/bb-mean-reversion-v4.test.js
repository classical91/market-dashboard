"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  bbMeanReversionV4,
  aggregateClosedHtf,
} = require("../src/services/trading/strategies/bb-mean-reversion-v4");
const { describe } = require("../src/services/trading/strategies");
const fs = require("node:fs");
const path = require("node:path");

const H4 = 4 * 60 * 60 * 1000;

function candles(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 2;
    out.push({
      openTime: i * H4,
      closeTime: (i + 1) * H4,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    });
  }
  return out;
}

test("BB v4 is a selectable backtest-only BTC 4h/1W strategy with UI inputs", () => {
  const meta = describe("bb_mean_reversion_v4");
  assert.equal(meta.supportsBacktest, true);
  assert.equal(meta.supportsLiveScanner, false);
  assert.deepEqual(meta.supportedIntervals, ["4h", "1W"]);
  assert.ok(meta.optionSchema.some((field) => field.key === "htfTimeframe"));
  assert.equal(meta.defaultOptions.maxBarsInTrade, 16);
});

test("higher-timeframe aggregation excludes the active candle (lookahead off)", () => {
  const bars = candles(7); // one full UTC day plus the first bar of day two
  const closes = aggregateClosedHtf(bars, "1D");
  assert.deepEqual(closes, [bars[5].close]);
});

test("the converted entry preserves trend, band, volume, range and HTF filters", () => {
  const bars = candles(130);
  const i = bars.length - 1;
  // Sharp pullback after a long trend: below the short Bollinger lower band,
  // still above/rising EMA96, with a volume spike. Exhaustion is disabled in
  // this isolated condition test; its own option is still preserved/defaulted.
  bars[i] = { ...bars[i], open: 345, high: 346, low: 315, close: 318, volume: 5000 };
  const result = bbMeanReversionV4.evaluate(bars, i, {
    interval: "4h",
    options: { bbMult: 1, htfEmaLen: 2, adxThreshold: 101, useExhaustion: false },
    strategyRuntime: { lastStopBarByDirection: {} },
  });
  assert.equal(result.signal, "LONG");
  assert.ok(result.stopHint < result.price);
  assert.ok(result.targetHint > result.price);
  assert.equal(result.indicators.volumeSpike, true);
  assert.equal(result.indicators.htf, "1D");
});

test("native management refreshes ATR/BB exits and applies the bar-count stop", () => {
  const bars = candles(130);
  const position = {
    direction: "LONG",
    requestedEntryPrice: bars[110].close,
    meta: { entryBarIndex: 110 },
  };
  const update = bbMeanReversionV4.managePosition(bars, 125, position, {
    interval: "4h",
    options: { maxBarsInTrade: 16 },
  });
  assert.equal(update.closeAtMarket, true);
  assert.equal(update.closeReason, "TIME_STOP");
  assert.ok(Number.isFinite(update.stopLoss));
  assert.ok(Number.isFinite(update.target));
});

test("invalid Pine input ranges are rejected", () => {
  assert.match(bbMeanReversionV4.validateOptions({ wickRatioMin: 0.9 }), /at most 0.7/);
  assert.match(bbMeanReversionV4.validateOptions({ htfTimeframe: "60" }), /htfTimeframe/);
  assert.match(bbMeanReversionV4.validateOptions({ allowShorts: "yes" }), /true or false/);
});

test("the paper trader has one atomic moving-exit implementation", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "trading", "paper-trader.js"), "utf8");
  assert.equal((source.match(/replaceExitLevels\(positionId/g) || []).length, 1);
});
