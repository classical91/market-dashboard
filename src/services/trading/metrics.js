"use strict";

// Risk and expectancy metrics for paper-trading history, ported from
// TraderClaw's risk_metrics.py.
//
// These calculations intentionally use closed trades only. Open P&L belongs in
// portfolio equity, not in the strategy edge calculation.

const { round } = require("./round");
const { regimeOfTrade } = require("./regime");

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(trade, keys) {
  for (const key of keys) {
    if (trade[key] !== undefined && trade[key] !== null) return trade[key];
  }
  return 0;
}

function isClosed(trade) {
  return trade.status === "closed" || "realizedPnl" in trade || "pnl" in trade;
}

function calculateTradeMetrics(history, startingBalance) {
  const closed = (history || []).filter(isClosed);
  const pnls = closed.map((t) => num(pick(t, ["realizedPnl", "pnl"])));
  const rValues = closed.map((t) => num(pick(t, ["rMultiple", "pnlR"])));

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((sum, p) => sum + p, 0);
  const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));
  const total = pnls.length;
  const netPnl = pnls.reduce((sum, p) => sum + p, 0);

  const expectancyUsd = total ? netPnl / total : 0;
  const expectancyR = rValues.length ? rValues.reduce((sum, r) => sum + r, 0) / rValues.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((sum, p) => sum + p, 0) / losses.length : 0;

  // An infinite profit factor (wins, no losses) is reported as null rather
  // than a huge number, so downstream gates can tell "no losses yet" apart
  // from "genuinely excellent".
  let profitFactor;
  if (grossLoss) profitFactor = round(grossProfit / grossLoss);
  else if (grossProfit) profitFactor = null;
  else profitFactor = 0;

  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }

  let streak = 0;
  let worstConsecutiveLosses = 0;
  for (const pnl of pnls) {
    if (pnl < 0) {
      streak += 1;
      worstConsecutiveLosses = Math.max(worstConsecutiveLosses, streak);
    } else if (pnl > 0) {
      streak = 0;
    }
  }

  return {
    closedTrades: total,
    netReturnUsd: round(netPnl),
    netReturnPct: startingBalance ? round((netPnl / startingBalance) * 100) : 0,
    expectancyUsd: round(expectancyUsd),
    expectancyR: round(expectancyR, 3),
    profitFactor,
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    maxDrawdownPct: round(maxDrawdown),
    worstConsecutiveLosses,
  };
}

function scoreBucket(score) {
  // Number(null) and Number("") are 0, which would file unscored trades into
  // the 0-9 bucket and drag that bucket's stats down with trades that were
  // never scored at all.
  if (score === null || score === undefined || score === "") return "unscored";
  const n = Number(score);
  if (!Number.isFinite(n)) return "unscored";
  const low = Math.floor(Math.trunc(n) / 10) * 10;
  return `${low}-${Math.min(low + 9, 100)}`;
}

/**
 * The edge gate's INDEX, not a report.
 *
 * This is keyed by `signalSource` because edge-gate.js looks a group up by the
 * exact `strategy` string its caller passed — "live:mindset_v1:15m",
 * "backtest:mindset_v1:4h", "decision:4h". Repointing this at the strategy
 * identity would stop those lookups matching, and the gate would silently fall
 * through to symbol-level or account-level evidence: a change to how positions
 * are SIZED, dressed up as a reporting improvement.
 *
 * For "which strategy earned this?", use the `strategyId` dimension below.
 */
function strategyKey(trade) {
  return String(trade.signalSource || trade.strategy || trade.source || "unknown");
}

/**
 * The strategy that actually produced the trade, from its recorded attribution.
 *
 * Deliberately never inferred from `signalSource`: that string is a source-and-
 * timeframe label whose format was never a contract, and for forward trades it
 * was "live-scanner:15m" — a timeframe, carrying no strategy at all. A record
 * without explicit attribution is UNATTRIBUTED and says so, rather than being
 * retro-assigned to whichever strategy looks likely.
 */
function strategyIdKey(trade) {
  const attributed = (trade.meta && trade.meta.strategy) || trade.strategyId || null;
  return attributed ? String(attributed) : "UNATTRIBUTED";
}

function symbolKey(trade) {
  return String(trade.symbol || "unknown");
}

/**
 * The timeframe the trade was decided on, from recorded attribution only.
 *
 * Never parsed out of `signalSource`: that string's format was never a
 * contract, and a trade with no recorded timeframe is UNATTRIBUTED rather than
 * being assigned to whichever interval the account happens to run today. Once a
 * demo account watches twenty markets on more than one interval, "which
 * timeframe is this edge actually in?" stops being answerable any other way.
 */
function timeframeKey(trade) {
  const recorded = (trade.meta && trade.meta.timeframe) || trade.timeframe || null;
  return recorded ? String(recorded) : "UNATTRIBUTED";
}

const DIMENSIONS = {
  strategy: strategyKey,
  strategyId: strategyIdKey,
  symbol: symbolKey,
  timeframe: timeframeKey,
  scoreBucket: (trade) => scoreBucket(trade.confidenceScore ?? trade.score),
  // The environment a trade was opened in. Read through the shared
  // regimeOfTrade() rather than a local copy: this grouping and the strategy ×
  // regime matrix must agree on what a tag means, and when each had its own
  // reader they disagreed about unrecognised labels.
  regime: regimeOfTrade,
};

// Ranking order matches TraderClaw: expectancy first, then profit factor,
// then the *smaller* drawdown, then sample size. A null profit factor (no
// losses recorded) sorts as if it were very strong, same as the Python side.
function compareRows(a, b) {
  const pf = (row) => (row.profitFactor === null ? 999 : row.profitFactor);
  return (
    b.expectancyR - a.expectancyR ||
    pf(b) - pf(a) ||
    a.maxDrawdownPct - b.maxDrawdownPct ||
    b.closedTrades - a.closedTrades
  );
}

function buildStrategyMetrics(history, startingBalance, minTrades = 1) {
  const groups = {};

  for (const [dimension, keyFn] of Object.entries(DIMENSIONS)) {
    const grouped = new Map();
    for (const trade of history || []) {
      const key = keyFn(trade);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(trade);
    }

    const rows = [];
    for (const [key, trades] of grouped) {
      const metrics = calculateTradeMetrics(trades, startingBalance);
      if (metrics.closedTrades < minTrades) continue;
      rows.push({ key, ...metrics });
    }

    rows.sort(compareRows);
    groups[dimension] = rows;
  }

  return {
    summary: calculateTradeMetrics(history, startingBalance),
    groups,
    minTrades,
  };
}

module.exports = { calculateTradeMetrics, buildStrategyMetrics, scoreBucket, strategyIdKey, timeframeKey, round };
