"use strict";

// The comparable slice of a backtest run.
//
// Lives on its own because two very different consumers need exactly the same
// reduction: the strategy comparison table, and the experiment record that
// gets persisted. If they each did their own arithmetic they would drift, and
// a stored experiment that disagrees with the table it came from is worse than
// no experiment at all.

// The comparable slice of a full run. Deliberately small: these are the
// numbers the promotion rules are written in, and nothing else belongs in a
// side-by-side table.
function summarizeRun(result) {
  const m = result.stats.riskMetrics;
  return {
    strategy: result.strategy,
    strategyName: result.strategyName,
    // Which exit rules produced these numbers. Two experiments recorded under
    // different execution modes are not comparable, and without this the
    // stored record cannot tell you which one it was.
    executionMode: result.executionMode || "shared",
    // What the run ASKED for is above; what it actually ran on is here. A
    // comparison requested as native can contain rows that never used a native
    // level, because the strategy publishes none — reading such a row under a
    // "native strategy exits" header, with nothing in the row to contradict it,
    // is the specific misreading these three fields exist to prevent.
    executionApplied: result.executionApplied || (result.executionMode === "native" ? "none" : "shared"),
    nativeTrades: result.nativeTrades || 0,
    sharedTrades: result.sharedTrades || 0,
    nativeFallbacks: result.nativeFallbacks || 0,
    status: result.status || "ok",
    replayType: result.replayType || "candle",
    dataStatus: result.dataStatus || (result.dataset && result.dataset.status) || "available",
    dataset: result.dataset || null,
    symbol: result.symbol,
    interval: result.interval,
    bars: result.bars,
    warmupBars: result.warmupBars,
    signals: result.signals.length,
    closedTrades: m.closedTrades,
    openAtEnd: result.openAtEnd.length,
    netPnlUsd: m.netReturnUsd,
    netReturnPct: m.netReturnPct,
    expectancyR: m.expectancyR,
    profitFactor: m.profitFactor,
    maxDrawdownPct: m.maxDrawdownPct,
    winRate: result.stats.winRate,
    worstLossStreak: m.worstConsecutiveLosses,
    costs: result.costs,
    // Which named friction assumption produced these numbers, or null for a
    // deployment's own custom rates. Two rows priced differently are not
    // comparable, and three loose decimals do not say so at a glance.
    costScenario: result.costScenario || null,
  };
}

function costSummary(config) {
  return {
    takerFeeRate: config.takerFeeRate,
    slippageRate: config.slippageRate,
    fundingRate8h: config.fundingRate8h,
  };
}

module.exports = { summarizeRun, costSummary };
