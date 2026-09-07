"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { listStrategies } = require("../src/services/trading/strategies");

test("every candle-backtest strategy has a copyable TradingView strategy", () => {
  for (const strategy of listStrategies({ supportsBacktest: true })) {
    const file = path.join(__dirname, "..", "public", "pine", `${strategy.id}.pine`);
    assert.ok(fs.existsSync(file), `${strategy.id} has no Pine Script`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /^\/\/@version=5/m, strategy.id);
    assert.match(source, /strategy\(/, strategy.id);
    assert.match(source, /strategy\.(entry|order)\(/, strategy.id);
    assert.match(source, /strategy\.(exit|close)\(/, strategy.id);
  }
});
