"use strict";

// Where a strategy sits in the research pipeline, and what the codebase is
// therefore allowed to do with it.
//
// The status is a *claim about evidence*, not a switch. Moving a strategy from
// `backtest` to `validated` does not make anything happen; it records that the
// backtests were reviewed. The capability flags are what code actually reads,
// and they are set by hand per strategy — never derived from "it is in the
// registry, so it must be ready".
//
//   experimental   Being written. May change shape without notice.
//   backtest       Replayable, and that is all. smc_v1 is here.
//   validated      Backtests reviewed and believed; still not forward-tested.
//   forward-paper  Running forward on live candles against a PAPER ledger.
//                  mindset_v1 is here — the live scanner runs it, and no real
//                  order exists anywhere in this codebase.
//   live-eligible  Approved for real-money execution. Nothing is here, and
//                  nothing gets here without a human decision plus the two
//                  exchange-side gates (TRADING_MODE=live and
//                  ALLOW_LIVE_TRADING=true) that this repo never flips.
//   retired        Kept for reproducing old experiments; not for new runs.
//
// The promotion policy that decides when a status *may* change (trade count,
// expectancy, profit factor, drawdown) is deliberately not here yet.

const LIFECYCLE_STATUSES = Object.freeze([
  "experimental",
  "backtest",
  "validated",
  "forward-paper",
  "live-eligible",
  "retired",
]);

// Two independent conditions, both required, neither self-certified:
//
//   1. the strategy declares it can run in the live scanner at all, and
//   2. the research lifecycle has actually reached live-eligible.
//
// A strategy object that sets `liveEligible: true` on itself is ignored —
// eligibility is computed here or it does not exist. Today this returns false
// for every registered strategy, which is the correct answer.
function computeLiveEligible(strategy) {
  return strategy.supportsLiveScanner === true && strategy.status === "live-eligible";
}

function assertValidLifecycle(strategy) {
  const where = `Strategy "${strategy && strategy.id}"`;
  if (!strategy || typeof strategy.id !== "string" || !strategy.id) {
    throw new Error("A registered strategy needs a non-empty string id");
  }
  if (typeof strategy.version !== "string" || !strategy.version) {
    // Versions are recorded on every experiment; an unversioned strategy
    // makes its own history unreproducible.
    throw new Error(`${where} must declare a version string`);
  }
  if (!LIFECYCLE_STATUSES.includes(strategy.status)) {
    throw new Error(
      `${where} has status ${JSON.stringify(strategy.status)}; expected one of ${LIFECYCLE_STATUSES.join(", ")}`,
    );
  }
  if (typeof strategy.supportsBacktest !== "boolean" || typeof strategy.supportsLiveScanner !== "boolean") {
    throw new Error(`${where} must declare supportsBacktest and supportsLiveScanner as booleans`);
  }
  return strategy;
}

// The public metadata shape. `liveEligible` is always computed, so callers
// cannot be misled by a stale or optimistic field on the strategy itself.
function describeStrategy(strategy) {
  return {
    id: strategy.id,
    name: strategy.name,
    version: strategy.version,
    description: strategy.description,
    status: strategy.status,
    supportsBacktest: strategy.supportsBacktest,
    supportsLiveScanner: strategy.supportsLiveScanner,
    liveEligible: computeLiveEligible(strategy),
    requiredWarmupBars: strategy.requiredWarmupBars,
  };
}

module.exports = { LIFECYCLE_STATUSES, computeLiveEligible, assertValidLifecycle, describeStrategy };
