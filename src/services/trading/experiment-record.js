"use strict";

// Turning a finished backtest into a research record.
//
// Pure and I/O-free: this file decides WHAT an experiment is, `experiment-store
// .js` decides where it lives. The split is what lets the store move to SQLite
// later without the backtester noticing.
//
// Every number here comes from `summarizeRun()` — the same reduction the
// comparison table uses, which in turn reads the paper trader's own metrics.
// Nothing is recalculated: an experiment that disagreed with the comparison
// table it came from would be worse than no experiment at all.

const { execFileSync } = require("child_process");

const { summarizeRun } = require("./run-summary");
const { describe } = require("./strategies");

let cachedCommit;

// The commit the code was at when the run happened. Without it a stored
// expectancy is a number with no way back to the rules that produced it.
//
// Deployed containers usually have no .git, so the platform's build metadata
// is tried first and a missing SHA is recorded as null rather than guessed.
function resolveGitCommit({ env = process.env, exec = execFileSync, useCache = true } = {}) {
  if (useCache && cachedCommit !== undefined) return cachedCommit;

  let commit = null;
  const fromEnv =
    env.GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.SOURCE_VERSION || env.GITHUB_SHA || "";
  if (String(fromEnv).trim()) {
    commit = String(fromEnv).trim();
  } else {
    try {
      commit = String(exec("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim() || null;
    } catch {
      // No git, no .git directory, or a detached build — not an error.
      commit = null;
    }
  }

  if (useCache) cachedCommit = commit;
  return commit;
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Collision-resistant without pulling in a uuid dependency: a sortable time
// prefix plus randomness, so ids read chronologically in a file listing.
//
// The timestamp is zero-padded to a fixed width. Unpadded base36 sorts
// lexicographically only while every value has the same number of digits,
// which is true of real millisecond timestamps and false the moment anything
// (a test, a fake clock) supplies a smaller number.
function newExperimentId(now = Date.now(), random = Math.random) {
  const time = now.toString(36).padStart(9, "0");
  return `exp_${time}${Math.floor(random() * 0xfffff).toString(36).padStart(4, "0")}`;
}

/**
 * Build the record for a completed backtest run.
 *
 * @param {object} result   A BacktestService.run() result.
 * @param {object} [meta]   { id, gitCommit, notes, source } overrides, mainly
 *                          for tests and for callers that already know the SHA.
 */
function buildExperimentRecord(result, meta = {}) {
  const summary = summarizeRun(result);
  const strategy = describe(result.strategy);

  return {
    id: meta.id || newExperimentId(),
    createdAt: meta.createdAt || new Date().toISOString(),
    source: meta.source || "backtest",
    notes: meta.notes || null,

    // What ran
    strategy: summary.strategy,
    strategyName: summary.strategyName,
    // Falls back to the result's own version for strategies outside the
    // registry (an inline function used in a one-off run).
    strategyVersion: (strategy && strategy.version) || result.strategyVersion || null,
    strategyStatus: (strategy && strategy.status) || null,
    gitCommit: meta.gitCommit !== undefined ? meta.gitCommit : resolveGitCommit(),

    // What it ran on
    symbol: summary.symbol,
    timeframe: summary.interval,
    from: isoOrNull(result.from),
    to: isoOrNull(result.to),
    bars: summary.bars,
    warmupBars: summary.warmupBars,

    // What happened
    signals: summary.signals,
    closedTrades: summary.closedTrades,
    openAtEnd: summary.openAtEnd,
    winRate: summary.winRate,
    netPnlUsd: summary.netPnlUsd,
    netReturnPct: summary.netReturnPct,
    expectancyR: summary.expectancyR,
    profitFactor: summary.profitFactor,
    maxDrawdownPct: summary.maxDrawdownPct,
    worstLossStreak: summary.worstLossStreak,

    // Under what assumptions. Both are required to reproduce the numbers
    // above: the same strategy over the same bars with different fees is a
    // different experiment.
    options: result.options || {},
    costs: summary.costs || null,
  };
}

module.exports = { buildExperimentRecord, resolveGitCommit, newExperimentId };
