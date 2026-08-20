"use strict";

// Usage:
//   node scripts/mindset-research.js path/to/datasets.json > results.json
//
// Input shape:
//   { "datasets": [{ "symbol": "BTCUSDT", "timeframe": "4h", "candles": [...] }] }
//
// Output is JSON on stdout. Nothing is persisted to Trading Lab ledgers or the
// experiment store; redirect it to a reviewed research artifact deliberately.

const fs = require("node:fs");
const path = require("node:path");
const { runMindsetResearch } = require("../src/services/trading/mindset-research");

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error("Usage: node scripts/mindset-research.js <datasets.json>");
  }
  const file = path.resolve(argv[0]);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const report = await runMindsetResearch({ datasets: payload.datasets });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
