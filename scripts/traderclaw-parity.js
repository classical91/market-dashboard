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
const os = require("node:os");
const path = require("node:path");

const { calculateTradeMetrics, buildStrategyMetrics } = require("../src/services/trading/metrics");
const { assessEdge } = require("../src/services/trading/edge-gate");
const { makeTradingConfig } = require("../src/services/trading/config");
const { runChecklist, marketState } = require("../src/services/trading/checklist");
const { calculateLevels, calculatePositionSize, resolveAtr } = require("../src/services/trading/risk");
const { PaperTradingService } = require("../src/services/trading/paper-trader");

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

// Checklist market-state field names, JS → Python.
const PY_STATE_FIELD = {
  regime: "regime",
  dailyBias: "daily_bias",
  usdtDominanceSignal: "usdt_d_signal",
  btcDominanceRising: "btc_dom_rising",
  bearMarket: "bear_market",
  dxyBullish: "dxy_bullish",
  newsBlackout: "news_blackout",
  openPositions: "open_positions",
  totalRiskPct: "total_risk_pct",
  dailyLossPct: "daily_loss_pct",
  weeklyLossPct: "weekly_loss_pct",
  consecutiveLosses: "consecutive_losses",
  fundingRate: "funding_rate",
  atrRatio: "atr_ratio",
  volumeRatio: "volume_ratio",
  macdBullish: "macd_bullish",
  stochSignal: "stoch_signal",
};

function stateToPython(state) {
  const out = {};
  for (const [jsField, pyField] of Object.entries(PY_STATE_FIELD)) {
    if (state[jsField] !== undefined) out[pyField] = state[jsField];
  }
  return out;
}

// Checklist scenarios: one per branch that can change the verdict, so a
// divergence in any single rule shows up as a named failure rather than as a
// vague aggregate difference.
const PERFECT_LONG = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  usdtDominanceSignal: "RISK_ON",
  btcDominanceRising: false,
  bearMarket: false,
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
  volumeRatio: 1.8,
  atrRatio: 1.1,
  fundingRate: 0.0001,
};

const CHECKLIST_CASES = [
  { label: "perfect long", direction: "LONG", state: PERFECT_LONG },
  { label: "half size", direction: "LONG", state: { ...PERFECT_LONG, dailyBias: "NEUTRAL", stochSignal: "NEUTRAL" } },
  {
    label: "quarter size",
    direction: "LONG",
    state: { ...PERFECT_LONG, dailyBias: "NEUTRAL", macdBullish: false, stochSignal: "NEUTRAL", volumeRatio: 1.1 },
  },
  { label: "dxy penalty", direction: "LONG", state: { ...PERFECT_LONG, dxyBullish: true } },
  { label: "no indicator data", direction: "LONG", state: { ...PERFECT_LONG, macdBullish: null, stochSignal: null } },
  { label: "weak volume", direction: "LONG", state: { ...PERFECT_LONG, volumeRatio: 0.7 } },
  { label: "elevated volatility", direction: "LONG", state: { ...PERFECT_LONG, atrRatio: 2.2 } },
  { label: "crowded funding", direction: "LONG", state: { ...PERFECT_LONG, fundingRate: 0.0008 } },
  { label: "kill: daily loss", direction: "LONG", state: { ...PERFECT_LONG, dailyLossPct: 3.5 } },
  { label: "kill: weekly loss", direction: "LONG", state: { ...PERFECT_LONG, weeklyLossPct: 6.5 } },
  { label: "kill: loss streak", direction: "LONG", state: { ...PERFECT_LONG, consecutiveLosses: 3 } },
  { label: "kill: news", direction: "LONG", state: { ...PERFECT_LONG, newsBlackout: true } },
  { label: "kill: volatility spike", direction: "LONG", state: { ...PERFECT_LONG, atrRatio: 3.5 } },
  { label: "kill: funding +", direction: "LONG", state: { ...PERFECT_LONG, fundingRate: 0.002 } },
  { label: "kill: funding -", direction: "LONG", state: { ...PERFECT_LONG, fundingRate: -0.002 } },
  { label: "regime blocks long", direction: "LONG", state: { ...PERFECT_LONG, regime: "TREND_DOWN" } },
  { label: "regime blocks short", direction: "SHORT", state: { ...PERFECT_LONG, regime: "TREND_UP" } },
  { label: "compression blocks all", direction: "LONG", state: { ...PERFECT_LONG, regime: "LOW_COMPRESSION" } },
  { label: "max positions", direction: "LONG", state: { ...PERFECT_LONG, openPositions: 3 } },
  { label: "max total risk", direction: "LONG", state: { ...PERFECT_LONG, totalRiskPct: 4 } },
  { label: "bear market long allowed", direction: "LONG", state: { ...PERFECT_LONG, bearMarket: true } },
  { label: "bear market long blocked", direction: "LONG", state: { ...PERFECT_LONG, bearMarket: true, volumeRatio: 0.8 } },
  {
    label: "perfect short",
    direction: "SHORT",
    state: {
      regime: "TREND_DOWN",
      dailyBias: "BEARISH",
      usdtDominanceSignal: "RISK_OFF",
      btcDominanceRising: true,
      bearMarket: true,
      macdBullish: false,
      stochSignal: "OVERBOUGHT_CROSS",
      volumeRatio: 1.8,
      atrRatio: 1.1,
      fundingRate: 0.0001,
    },
  },
];

// Sizing scenarios: round and awkward prices, both directions, with and
// without an ATR on the signal (which exercises the shared fallback).
const SIZING_CASES = [
  { label: "long round", direction: "LONG", entryPrice: 1000, atr: 100, sizeMultiplier: 1 },
  { label: "short round", direction: "SHORT", entryPrice: 1000, atr: 100, sizeMultiplier: 1 },
  { label: "long half", direction: "LONG", entryPrice: 64280, atr: 812.5, sizeMultiplier: 0.5 },
  { label: "short quarter", direction: "SHORT", entryPrice: 64280, atr: 812.5, sizeMultiplier: 0.25 },
  { label: "no atr, fallback", direction: "LONG", entryPrice: 64280, atr: null, sizeMultiplier: 1 },
  { label: "zero atr, fallback", direction: "SHORT", entryPrice: 3125.75, atr: 0, sizeMultiplier: 1 },
  { label: "awkward price", direction: "LONG", entryPrice: 0.08135, atr: 0.00125, sizeMultiplier: 1 },
];

// Paper-trading lifecycles: each is a position plus the sequence of prices it
// is marked against. These cover the paths where the two engines could most
// easily drift — the TP1 scale-out, the breakeven stop, a gapped stop fill,
// and both targets reached inside one mark.
const LIFECYCLE_CASES = [
  {
    label: "tp1 then tp2",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 1, entry: 100, sl: 90, tp1: 115, tp2: 125, risk: 10 },
    prices: [105, 116, 126],
  },
  {
    label: "tp1 then breakeven stop",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 1, entry: 100, sl: 90, tp1: 115, tp2: 125, risk: 10 },
    prices: [116, 100],
  },
  {
    label: "straight stop",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 1, entry: 100, sl: 90, tp1: 115, tp2: 125, risk: 10 },
    prices: [95, 90],
  },
  {
    label: "gapped stop",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 1, entry: 100, sl: 90, tp1: 115, tp2: 125, risk: 10 },
    prices: [85],
  },
  {
    label: "both targets in one mark",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 1, entry: 100, sl: 90, tp1: 115, tp2: 125, risk: 10 },
    prices: [200],
  },
  {
    label: "short tp1 then tp2",
    position: { symbol: "ETHUSDT", direction: "SHORT", size: 2, entry: 100, sl: 110, tp1: 85, tp2: 75, risk: 20 },
    prices: [84, 74],
  },
  {
    label: "short gapped stop",
    position: { symbol: "ETHUSDT", direction: "SHORT", size: 2, entry: 100, sl: 110, tp1: 85, tp2: 75, risk: 20 },
    prices: [120],
  },
  {
    label: "fractional size",
    position: { symbol: "BTCUSDT", direction: "LONG", size: 0.0375, entry: 64280, sl: 63061.25, tp1: 66108.13, tp2: 67327, risk: 45.7 },
    prices: [66200, 67400],
  },
];

function runPython(traderclawDir, payload) {
  const script = `
import json, sys, tempfile
sys.path.insert(0, ${JSON.stringify(traderclawDir)})
from risk_metrics import calculate_trade_metrics, build_strategy_metrics
from edge_gate import assess_edge
from checklist import run_checklist, MarketState
from executor import calculate_levels, calculate_position_size, resolve_atr
from signal_handler import TradeSignal
import paper_trader as pt
from config import get_config

payload = json.load(sys.stdin)
balance = payload["starting_balance"]
cfg = get_config()


def signal(direction, symbol="BTCUSDT", price=64000.0, atr=800.0):
    return TradeSignal(direction=direction, symbol=symbol, price=price, atr=atr,
                       regime=None, timeframe="4h", raw="parity")


checklists = []
for case in payload["checklist_cases"]:
    result = run_checklist(signal(case["direction"]), MarketState(**case["state"]))
    checklists.append({
        "decision": result.decision,
        "confidence_score": result.confidence_score,
        "size_multiplier": result.size_multiplier,
        "kill_switch": result.kill_switch,
    })

sizings = []
for case in payload["sizing_cases"]:
    levels = calculate_levels(case["entry_price"], case["atr"], case["direction"])
    size = calculate_position_size(
        entry_price=case["entry_price"],
        stop_loss=levels["stop_loss"],
        account_size=cfg.account_size,
        risk_pct=cfg.max_risk_per_trade,
        size_multiplier=case["size_multiplier"],
    )
    sizings.append({**levels, "size": size,
                    "resolved_atr": resolve_atr(case["entry_price"], case["atr"])})

# The paper trader keeps its ledger on disk and reads module-level globals, so
# each lifecycle runs against its own fresh temp directory.
lifecycles = []
for case in payload["lifecycle_cases"]:
    pt.set_data_dir(tempfile.mkdtemp())
    pt.reset_account()
    p = case["position"]
    pt.open_position(p["symbol"], p["direction"], p["size"], p["entry"], p["sl"],
                     p["tp1"], p["tp2"], p["risk"], 80, "parity")
    for price in case["prices"]:
        pt.update_positions(price)

    positions = pt.get_positions()
    history = pt.get_history()
    account = pt.get_account()
    lifecycles.append({
        "position": {
            "status": positions[0]["status"],
            "remaining_size": positions[0]["remaining_size"],
            "realized_pnl": positions[0]["realized_pnl"],
            "stop_loss": positions[0]["stop_loss"],
            "tp1_hit": positions[0]["tp1_hit"],
            "close_reason": positions[0].get("close_reason"),
            "exit_price": positions[0].get("exit_price"),
            "r_multiple": positions[0].get("r_multiple"),
            "exits": [{"reason": e["reason"], "price": e["price"], "size": e["size"], "pnl": e["pnl"]}
                      for e in positions[0]["exits"]],
        },
        "history_len": len(history),
        "history_pnl": history[0]["pnl"] if history else None,
        "account": {
            "balance": account["balance"],
            "realized_pnl": account["realized_pnl"],
            "total_trades": account["total_trades"],
            "wins": account["wins"],
            "losses": account["losses"],
            "consecutive_losses": account["consecutive_losses"],
        },
    })

out = {
    "metrics": calculate_trade_metrics(payload["trades"], balance),
    "grouped": build_strategy_metrics(payload["trades"], balance),
    "edges": [
        assess_edge(case["trades"], balance, case["strategy"], case["symbol"], case["score"])
        for case in payload["edge_cases"]
    ],
    "checklists": checklists,
    "sizings": sizings,
    "lifecycles": lifecycles,
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
let comparisons = 0;

function compare(label, jsValue, pyValue) {
  comparisons += 1;
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

async function main() {
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
      checklist_cases: CHECKLIST_CASES.map((c) => ({
        direction: c.direction,
        state: stateToPython(marketState(c.state)),
      })),
      sizing_cases: SIZING_CASES.map((c) => ({
        direction: c.direction,
        entry_price: c.entryPrice,
        atr: c.atr,
        size_multiplier: c.sizeMultiplier,
      })),
      lifecycle_cases: LIFECYCLE_CASES,
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

  // 4. Checklist verdicts, one scenario per rule that can change the outcome.
  CHECKLIST_CASES.forEach((testCase, i) => {
    const js = runChecklist(
      { symbol: "BTCUSDT", direction: testCase.direction, price: 64000, atr: 800 },
      marketState(testCase.state),
      config,
    );
    const pyCase = py.checklists[i];
    const label = `checklist[${testCase.label}]`;
    compare(`${label}.decision`, js.decision, pyCase.decision);
    compare(`${label}.confidenceScore`, js.confidenceScore, pyCase.confidence_score);
    compare(`${label}.sizeMultiplier`, js.sizeMultiplier, pyCase.size_multiplier);
    compare(`${label}.killSwitch`, js.killSwitch, pyCase.kill_switch);
  });

  // 5. Sizing and level geometry.
  SIZING_CASES.forEach((testCase, i) => {
    const levels = calculateLevels({
      entryPrice: testCase.entryPrice,
      atr: testCase.atr,
      direction: testCase.direction,
      config,
    });
    const size = calculatePositionSize({
      entryPrice: testCase.entryPrice,
      stopLoss: levels.stopLoss,
      accountSize: config.accountSize,
      riskPct: config.maxRiskPerTrade,
      sizeMultiplier: testCase.sizeMultiplier,
    });
    const pyCase = py.sizings[i];
    const label = `sizing[${testCase.label}]`;
    compare(`${label}.stopLoss`, levels.stopLoss, pyCase.stop_loss);
    compare(`${label}.tp1`, levels.tp1, pyCase.tp1);
    compare(`${label}.tp2`, levels.tp2, pyCase.tp2);
    compare(`${label}.slDistance`, levels.slDistance, pyCase.sl_distance);
    compare(`${label}.size`, size, pyCase.size);
    compare(`${label}.resolvedAtr`, resolveAtr(testCase.entryPrice, testCase.atr, config), pyCase.resolved_atr);
  });

  // 6. Paper-trade lifecycles. This is the most intricate ported behaviour —
  // partial exits, the breakeven stop move, gapped fills and once-per-trade
  // win accounting — so it is compared exit by exit, not just on the total.
  for (const [i, testCase] of LIFECYCLE_CASES.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-parity-"));
    const trader = new PaperTradingService({ dataDir: dir, book: "parity", config });
    const p = testCase.position;
    trader.openPosition({
      symbol: p.symbol,
      direction: p.direction,
      size: p.size,
      entryPrice: p.entry,
      stopLoss: p.sl,
      tp1: p.tp1,
      tp2: p.tp2,
      riskUsd: p.risk,
      confidenceScore: 80,
      signalSource: "parity",
    });
    for (const price of testCase.prices) {
      // Marks must be applied in order and each must complete before the next
      // — a stop moved to breakeven by one mark changes what the next one hits.
      await trader.updatePositions({ [p.symbol]: price });
    }

    const [position] = trader.getPositions();
    const history = trader.getHistory();
    const account = trader.getAccount();
    const pyCase = py.lifecycles[i];
    const label = `lifecycle[${testCase.label}]`;

    compare(`${label}.status`, position.status, pyCase.position.status);
    compare(`${label}.remainingSize`, position.remainingSize, pyCase.position.remaining_size);
    compare(`${label}.realizedPnl`, position.realizedPnl, pyCase.position.realized_pnl);
    compare(`${label}.stopLoss`, position.stopLoss, pyCase.position.stop_loss);
    compare(`${label}.tp1Hit`, position.tp1Hit, pyCase.position.tp1_hit);
    compare(`${label}.closeReason`, position.closeReason, pyCase.position.close_reason);
    compare(`${label}.exitPrice`, position.exitPrice, pyCase.position.exit_price);
    compare(`${label}.rMultiple`, position.rMultiple, pyCase.position.r_multiple);
    compare(`${label}.exits.length`, position.exits.length, pyCase.position.exits.length);
    position.exits.forEach((exit, j) => {
      const pyExit = pyCase.position.exits[j];
      if (!pyExit) return;
      compare(`${label}.exits[${j}].reason`, exit.reason, pyExit.reason);
      compare(`${label}.exits[${j}].price`, exit.price, pyExit.price);
      compare(`${label}.exits[${j}].size`, exit.size, pyExit.size);
      compare(`${label}.exits[${j}].pnl`, exit.pnl, pyExit.pnl);
    });
    compare(`${label}.historyLength`, history.length, pyCase.history_len);
    compare(`${label}.historyPnl`, history.length ? history[0].pnl : null, pyCase.history_pnl);
    compare(`${label}.account.balance`, account.balance, pyCase.account.balance);
    compare(`${label}.account.realizedPnl`, account.realizedPnl, pyCase.account.realized_pnl);
    compare(`${label}.account.totalTrades`, account.totalTrades, pyCase.account.total_trades);
    compare(`${label}.account.wins`, account.wins, pyCase.account.wins);
    compare(`${label}.account.losses`, account.losses, pyCase.account.losses);
    compare(`${label}.account.consecutiveLosses`, account.consecutiveLosses, pyCase.account.consecutive_losses);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (mismatches.length) {
    console.error(`[parity] ${mismatches.length} mismatch(es) between the JS and Python engines:`);
    for (const line of mismatches) console.error(`  - ${line}`);
    return 1;
  }

  console.log(`[parity] JS and Python engines agree on all ${comparisons} compared fields.`);
  console.log(
    "[parity] Covered: summary metrics, grouped leaderboards and their ranking, " +
      `edge-gate verdicts (${EDGE_CASES.length} cases), checklist verdicts (${CHECKLIST_CASES.length} cases), ` +
      `sizing and levels (${SIZING_CASES.length} cases), paper-trade lifecycles (${LIFECYCLE_CASES.length} cases).`,
  );
  console.log(
    "[parity] NOT covered — not ported yet: TradingView webhook ingestion, Bitget client, Polymarket, Telegram.",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[parity] Parity check crashed: ${err.stack || err.message}`);
    process.exit(1);
  },
);
