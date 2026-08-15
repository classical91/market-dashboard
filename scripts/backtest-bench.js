"use strict";

// Backtest benchmark. Deterministic synthetic candles, no network, so a
// before/after comparison measures the backtester rather than the exchange.
//
//   node scripts/backtest-bench.js [bars] [repeats]
//
// Reports wall time per scenario. Numbers are only comparable against another
// run of this same script on the same machine.

const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");
const { listStrategies } = require("../src/services/trading/strategies");

// A seeded random walk with enough drift and volatility clustering that
// strategies actually find setups — a flat line benchmarks nothing.
function makeCandles(count, seed = 42) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = [];
  let price = 30000;
  let drift = 0;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i += 1) {
    drift = drift * 0.97 + (rand() - 0.5) * 0.004;
    const step = price * (drift + (rand() - 0.5) * 0.006);
    const open = price;
    const close = Math.max(1, price + step);
    const wick = Math.abs(step) + price * 0.002 * rand();
    out.push({
      openTime: start + i * 14400000,
      closeTime: start + (i + 1) * 14400000 - 1,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 100 + rand() * 200,
    });
    price = close;
  }
  return out;
}

async function time(label, fn) {
  const started = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${label.padEnd(46)} ${ms.toFixed(0).padStart(8)} ms   ${result || ""}`);
  return ms;
}

async function main() {
  const bars = Number(process.argv[2]) || 2000;
  const repeats = Number(process.argv[3]) || 1;
  const candles = makeCandles(bars);
  const config = makeTradingConfig();
  const service = new BacktestService({
    config,
    signalScreenerService: { getCandles: async () => candles },
  });

  const candleStrategies = listStrategies({ supportsBacktest: true }).map((s) => s.id);
  console.log(`bars=${bars} repeats=${repeats} strategies=${candleStrategies.join(",")}\n`);

  let total = 0;
  for (let r = 0; r < repeats; r += 1) {
    for (const id of candleStrategies) {
      total += await time(`run ${id}`, async () => {
        const result = await service.run({ symbol: "BTCUSDT", candles, strategy: id });
        return `${result.signals.length} signals, ${result.trades.length} trades`;
      });
    }
    total += await time("compare (all candle strategies)", async () => {
      const result = await service.compare({ symbol: "BTCUSDT", strategies: candleStrategies });
      return `${result.results.length} rows`;
    });
  }

  console.log(`\ntotal${" ".repeat(41)} ${total.toFixed(0).padStart(8)} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
