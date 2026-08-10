"use strict";

// Historical edge gate for paper-trading signals, ported from TraderClaw's
// edge_gate.py.
//
// Small samples are allowed through as learning trades. Once enough closed
// trades exist, bad expectancy, a weak profit factor or excessive drawdown can
// block an entry outright or halve its size.

const { buildStrategyMetrics, scoreBucket } = require("./metrics");
const { getTradingConfig } = require("./config");

function signed(value, digits) {
  const n = Number(value) || 0;
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(digits)}`;
}

function findGroup(groups, dimension, key) {
  return (groups[dimension] || []).find((row) => row.key === key) || null;
}

function assessEdge({ history, startingBalance, strategy, symbol, score = null, config = getTradingConfig() }) {
  const metrics = buildStrategyMetrics(history, startingBalance);
  const { groups } = metrics;
  const bucket = scoreBucket(score);

  // Most specific evidence first: how this exact strategy has performed beats
  // how this symbol has, which beats how setups of this quality have, which
  // beats the account as a whole.
  const candidates = [
    ["strategy", strategy, findGroup(groups, "strategy", strategy)],
    ["symbol", symbol, findGroup(groups, "symbol", symbol)],
    ["scoreBucket", bucket, findGroup(groups, "scoreBucket", bucket)],
    ["summary", "all", metrics.summary],
  ];
  const usable = candidates.filter(([, , row]) => row && row.closedTrades > 0);

  if (!usable.length) {
    return {
      decision: "ALLOW",
      sizeMultiplier: 1,
      reasons: ["EDGE_LEARNING: no closed trades yet"],
      metrics: metrics.summary,
    };
  }

  const [dimension, key, primary] = usable[0];
  const trades = primary.closedTrades || 0;
  const pf = primary.profitFactor;
  const expectancy = primary.expectancyR || 0;
  const drawdown = primary.maxDrawdownPct || 0;

  const reasons = [
    `EDGE_${dimension.toUpperCase()}: ${key} | ${trades} trades | Exp ${signed(expectancy, 3)}R | ` +
      `PF ${pf === null || pf === undefined ? "n/a" : pf} | DD ${drawdown}%`,
  ];

  const block = (reason) => {
    reasons.push(reason);
    return { decision: "BLOCK", sizeMultiplier: 0, reasons, metrics: primary };
  };

  if (trades < config.edgeMinSampleTrades) {
    reasons.push(
      `EDGE_LEARNING: sample ${trades}/${config.edgeMinSampleTrades}, allow reduced evidence weight`,
    );
    return { decision: "ALLOW", sizeMultiplier: 1, reasons, metrics: primary };
  }
  if (expectancy < config.edgeMinExpectancyR) {
    return block(`EDGE_BLOCK: expectancy below ${signed(config.edgeMinExpectancyR, 2)}R`);
  }
  if (pf !== null && pf !== undefined && pf < config.edgeMinProfitFactor) {
    return block(`EDGE_BLOCK: profit factor below ${config.edgeMinProfitFactor.toFixed(2)}`);
  }
  if (drawdown > config.edgeMaxDrawdownPct) {
    return block(`EDGE_BLOCK: drawdown above ${config.edgeMaxDrawdownPct.toFixed(1)}%`);
  }
  if (expectancy < config.edgeSoftExpectancyR || drawdown > config.edgeSoftDrawdownPct) {
    reasons.push("EDGE_REDUCE: edge is positive but not strong enough for full size");
    return { decision: "REDUCE", sizeMultiplier: 0.5, reasons, metrics: primary };
  }

  reasons.push("EDGE_ALLOW: historical edge accepted");
  return { decision: "ALLOW", sizeMultiplier: 1, reasons, metrics: primary };
}

module.exports = { assessEdge };
