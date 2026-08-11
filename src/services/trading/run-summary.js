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
