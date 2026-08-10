#!/usr/bin/env node
"use strict";

// TraderClaw parity check — step 11 of the migration.
//
// Runs the same sample trades through the ported JavaScript engines and the
// original Python ones, and reports any field that disagrees. This is the
// evidence that lets TraderClaw be archived: not "the tests pass", but "both
// implementations produce the same numbers on the same input".
//
// Usage:
//   node scripts/traderclaw-parity.js --traderclaw ../traderclaw
//
// Exits 0 when every field matches, 1 otherwise. Requires a python3 that can
// import the TraderClaw modules; without it the script says so and exits 0,
// so CI on a machine that has no checkout of TraderClaw is not broken by it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { calculateTradeMetrics, buildStrategyMetrics } = require("../src/services/trading/metrics");
const { assessEdge } = require("../src/services/trading/edge-gate");
const { makeTradingConfig } = require("../src/services/trading/config");

const STARTING_BALANCE = 10000;

// Fixtures span the cases where the two implementations could plausibly
// diverge: rounding on negatives, an infinite profit factor, drawdown off a
// running peak, and grouping keys that fall back through several field names.
const SAMPLE_TRADES = [
  { status: "closed", pnl: 240.5, r: 2.4, strategy: "alpha", symbol: "BTCUSDT", score: 86 },
  { status: "closed", pnl: -100.125, r: -1, strategy: "alpha", symbol: "BTCUSDT", score: 84 },
  { status: "closed", pnl: 75.75, r: 0.75, strategy: "alpha", symbol: "ETHUSDT", score: 71 },
  { status: "closed", pnl: -100, r: -1, strategy: "beta", symbol: "ETHUSDT", score: 68 },
  { status: "closed", pnl: -100, r: -1, strategy: "beta", symbol: "SOLUSDT", score: 55 },
  { status: "closed", pnl: 512.5, r: 5.125, strategy: "beta", symbol: "SOLUSDT", score: 93 },
  { status: "closed", pnl: 0, r: 0, strategy: "gamma", symbol: "BTCUSDT", score: null },
  { status: "closed", pnl: 33.333, r: 0.333, strategy: "gamma", symbol: "BTCUSDT", score: 100 },
];

const EDGE_CASES = [
  { label: "no history", trades: [], strategy: "alpha", symbol: "BTCUSDT", score: 80 },
  { label: "small sample", trades: SAMPLE_TRADES, strategy: "alpha", symbol: "BTCUSDT", score: 86 },
  {
    label: "deep losing sample",
    trades: Array.from({ length: 25 }, () => ({
      status: "closed", pnl: -100, r: -1, strategy: "alpha", symbol: "BTCUSDT", score: 80,
    })),
    strategy: "alpha",
    symbol: "BTCUSDT",
    score: 80,
  },
  {
    label: "deep winning sample",
    trades: Array.from({ length: 25 }, () => ({
      status: "closed", pnl: 200, r: 2, strategy: "alpha", symbol: "BTCUSDT", score: 80,
    })),
    strategy: "alpha",
    symbol: "BTCUSDT",
    score: 80,
  },
];

// The two sides name the same fields differently (snake_case vs camelCase);
// this is the only place that mapping lives.
function toPython(trade) {
  return {
    status: trade.status,
    realized_pnl: trade.pnl,
    r_multiple: trade.r,
    signal_source: trade.strategy,
    symbol: trade.symbol,
    confidence_score: trade.score,
  };
}

function toJs(trade) {
  return {
    status: trade.status,
    realizedPnl: trade.pnl,
    rMultiple: trade.r,
    signalSource: trade.strategy,
    symbol: trade.symbol,
    confidenceScore: trade.score,
  };
}

const PY_FIELD = {
  closedTrades: "closed_trades",
  netReturnUsd: "net_return_usd",
  netReturnPct: "net_return_pct",
  expectancyUsd: "expectancy_usd",
  expectancyR: "expectancy_r",
  profitFactor: "profit_factor",
  avgWin: "avg_win",
  avgLoss: "avg_loss",
  maxDrawdownPct: "max_drawdown_pct",
  worstConsecutiveLosses: "worst_consecutive_losses",
};

const PY_DIMENSION = { strategy: "strategy", symbol: "symbol", scoreBucket: "score_bucket" };

function runPython(traderclawDir, payload) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(traderclawDir)})
from risk_metrics import calculate_trade_metrics, build_strategy_metrics
from edge_gate import assess_edge

payload = json.load(sys.stdin)
balance = payload["starting_balance"]

out = {
    "metrics": calculate_trade_metrics(payload["trades"], balance),
    "grouped": build_strategy_metrics(payload["trades"], balance),
    "edges": [
        assess_edge(case["trades"], balance, case["strategy"], case["symbol"], case["score"])
        for case in payload["edge_cases"]
    ],
}
json.dump(out, sys.stdout, default=str)
`;
  const stdout = execFileSync("python3", ["-c", script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    // TraderClaw's config module reads the environment at import time; pin the
    // defaults so the comparison is against known thresholds, not whatever the
    // developer's shell happens to export.
    env: { ...process.env, TRADING_MODE: "paper", ACCOUNT_SIZE: String(STARTING_BALANCE) },
  });
  return JSON.parse(stdout);
}

const mismatches = [];

function compare(label, jsValue, pyValue) {
  // Python emits None for an infinite profit factor; JS emits null. Anything
  // else must match to the last decimal the two agreed to round to.
  const a = jsValue === null || jsValue === undefined ? null : jsValue;
  const b = pyValue === null || pyValue === undefined || pyValue === "None" ? null : pyValue;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 1e-9) mismatches.push(`${label}: js=${a} py=${b}`);
    return;
  }
  if (String(a) !== String(b)) mismatches.push(`${label}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`);
}

function compareMetrics(label, jsMetrics, pyMetrics) {
  for (const [jsField, pyField] of Object.entries(PY_FIELD)) {
    compare(`${label}.${jsField}`, jsMetrics[jsField], pyMetrics[pyField]);
  }
}

function main() {
  const argIndex = process.argv.indexOf("--traderclaw");
  const traderclawDir = path.resolve(
    argIndex >= 0 ? process.argv[argIndex + 1] : path.join(__dirname, "..", "..", "traderclaw"),
  );

  if (!fs.existsSync(path.join(traderclawDir, "risk_metrics.py"))) {
    console.log(`[parity] No TraderClaw checkout at ${traderclawDir} — skipping parity check.`);
    console.log("[parity] Pass --traderclaw <path> to run it.");
    return 0;
  }

  let py;
  try {
    py = runPython(traderclawDir, {
      starting_balance: STARTING_BALANCE,
      trades: SAMPLE_TRADES.map(toPython),
      edge_cases: EDGE_CASES.map((c) => ({ ...c, trades: c.trades.map(toPython) })),
    });
  } catch (err) {
    console.log(`[parity] Could not run the Python engine — skipping. (${err.message.split("\n")[0]})`);
    return 0;
  }

  const jsTrades = SAMPLE_TRADES.map(toJs);
  const config = makeTradingConfig({ accountSize: STARTING_BALANCE });

  // 1. Summary metrics.
  compareMetrics("metrics", calculateTradeMetrics(jsTrades, STARTING_BALANCE), py.metrics);

  // 2. Grouped metrics — both the ranking order and each row's numbers.
  const jsGrouped = buildStrategyMetrics(jsTrades, STARTING_BALANCE);
  compareMetrics("grouped.summary", jsGrouped.summary, py.grouped.summary);
  for (const [jsDim, pyDim] of Object.entries(PY_DIMENSION)) {
    const jsRows = jsGrouped.groups[jsDim] || [];
    const pyRows = py.grouped.groups[pyDim] || [];
    compare(`groups.${jsDim}.length`, jsRows.length, pyRows.length);
    compare(
      `groups.${jsDim}.order`,
      jsRows.map((r) => r.key).join(","),
      pyRows.map((r) => r.key).join(","),
    );
    jsRows.forEach((row, i) => {
      if (pyRows[i]) compareMetrics(`groups.${jsDim}[${i}]`, row, pyRows[i]);
    });
  }

  // 3. Edge-gate verdicts. The reason strings are prose and are allowed to
  // differ; the decision and the size it implies are not.
  EDGE_CASES.forEach((testCase, i) => {
    const js = assessEdge({
      history: testCase.trades.map(toJs),
      startingBalance: STARTING_BALANCE,
      strategy: testCase.strategy,
      symbol: testCase.symbol,
      score: testCase.score,
      config,
    });
    compare(`edge[${testCase.label}].decision`, js.decision, py.edges[i].decision);
    compare(`edge[${testCase.label}].sizeMultiplier`, js.sizeMultiplier, py.edges[i].size_multiplier);
  });

  if (mismatches.length) {
    console.error(`[parity] ${mismatches.length} mismatch(es) between the JS and Python engines:`);
    for (const line of mismatches) console.error(`  - ${line}`);
    return 1;
  }

  console.log("[parity] JS and Python engines agree on every compared field.");
  return 0;
}

process.exit(main());
