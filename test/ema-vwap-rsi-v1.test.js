"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { emaVwapRsiV1 } = require("../src/services/trading/strategies/ema-vwap-rsi-v1");
const { describe, getStrategy } = require("../src/services/trading/strategies");
const { backtestStrategy } = require("../src/services/strategy-engine");

const H4 = 4 * 60 * 60 * 1000;

// Deterministic random walk with trending stretches so every check fires.
function walk(count, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const drift = Math.sin(i / 40) * 0.4;
    const open = price;
    price = Math.max(5, price + drift + (rand() - 0.5) * 3);
    const high = Math.max(open, price) + rand() * 1.5;
    const low = Math.min(open, price) - rand() * 1.5;
    out.push({ openTime: i * H4, closeTime: (i + 1) * H4 - 1, open, high, low, close: price, volume: 500 + rand() * 1000 });
  }
  return out;
}

test("EMA/VWAP/RSI v1 is a registered, backtest-only strategy with lab inputs", () => {
  const meta = describe("ema_vwap_rsi_v1");
  assert.ok(meta);
  assert.equal(getStrategy("ema_vwap_rsi_v1"), emaVwapRsiV1);
  assert.equal(meta.status, "backtest");
  assert.equal(meta.supportsBacktest, true);
  assert.equal(meta.supportsLiveScanner, false);
  assert.equal(meta.scannerEligible, false);
  assert.deepEqual(meta.optionSchema.map((f) => f.key), Object.keys(meta.defaultOptions));
});

test("EMA/VWAP/RSI v1 enters on the same bars and levels as the old Terminal Suite engine", () => {
  const candles = walk(900);
  const old = backtestStrategy(candles, "4h", { maxTrades: 200, feePct: 0 });
  assert.ok(old.summary.trades >= 5, `expected trades from the old engine, got ${old.summary.trades}`);

  const byOpen = new Map(candles.map((c, i) => [new Date(c.openTime).toISOString(), i]));
  // The old engine reports only its last 10 trades; each must be a signal here too.
  for (const trade of old.trades) {
    const index = byOpen.get(trade.openedAt);
    const signal = emaVwapRsiV1.evaluate(candles, index, {});
    assert.equal(signal.signal, trade.side, `bar ${index}`);
    assert.ok(Math.abs(signal.stopHint - trade.stop) < 1e-4);
    assert.ok(Math.abs(signal.targetHint - trade.target) < 1e-4);
    assert.ok(Math.abs(signal.targetHint - signal.price) / Math.abs(signal.price - signal.stopHint) - 2 < 1e-9);
  }
});

test("EMA/VWAP/RSI v1 reads nothing past the decided bar and rejects bad options", () => {
  const candles = walk(400);
  const truncated = candles.slice(0, 301);
  for (let i = 150; i <= 300; i += 1) {
    assert.deepEqual(emaVwapRsiV1.evaluate(candles, i, {}), emaVwapRsiV1.evaluate(truncated, i, {}));
  }
  assert.match(emaVwapRsiV1.evaluate(candles, 20, {}).error, /Need at least/);
  assert.match(emaVwapRsiV1.validateOptions({ trendEmaLen: 1 }), /trendEmaLen/);
  assert.match(emaVwapRsiV1.validateOptions({ useVwap: "yes" }), /useVwap/);
  assert.equal(emaVwapRsiV1.validateOptions({ rr: 3, allowShort: false }), null);
});
