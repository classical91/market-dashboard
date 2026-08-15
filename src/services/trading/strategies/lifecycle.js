"use strict";

// Where a strategy sits in the research pipeline, and what the codebase is
// therefore allowed to do with it.
//
// The status is a *claim about evidence*, not a switch. Moving a strategy from
// `backtest` to `validated` does not make anything happen; it records that the
// historical evidence was reviewed and passed. The two eligibility flags are
// what code actually reads, and both are computed here — never declared by a
// strategy about itself.
//
//   experimental         Being developed. May change shape without notice.
//   backtest             Historical testing. smc_v1 is here.
//   validated            Historical evidence has passed the promotion criteria.
//                        Still has never met a live candle.
//   forward-paper        Running against live market data with PAPER
//                        execution. mindset_v1 is here — this is what the live
//                        scanner runs, and no real order exists anywhere in
//                        this codebase.
//   real-money-eligible  Has completed validation and could POTENTIALLY be
//                        approved for real-money execution later. Nothing is
//                        here. Even here, it would still be gated by a human
//                        decision plus the two exchange-side switches
//                        (TRADING_MODE=live and ALLOW_LIVE_TRADING=true) that
//                        this repo never flips.
//   retired              No longer active. Kept to reproduce old experiments.
//
// ── Two eligibilities, deliberately not one ─────────────────────────────────
//
// "Live" is an ambiguous word here and the ambiguity is expensive, so it is
// avoided entirely:
//
//   scannerEligible      May the LIVE SCANNER run this forward, on live
//                        candles, against a PAPER ledger? True for mindset_v1.
//   realMoneyEligible    Has this completed validation such that real-money
//                        execution could later be approved? False for
//                        everything, and there is no code path that would act
//                        on it if it were true.
//
// A strategy can be scanner eligible while nowhere near real money — that is
// the normal case, and it is exactly what forward-paper means.
//
// The promotion policy that decides when a status *may* change (trade count,
// expectancy, profit factor, drawdown) is deliberately not here yet.

const LIFECYCLE_STATUSES = Object.freeze([
  "experimental",
  "backtest",
  "validated",
  "forward-paper",
  "real-money-eligible",
  "retired",
]);

// Statuses under which forward paper operation is a sensible thing to be
// doing. `validated` is deliberately NOT here: passing historical criteria is
// what earns a strategy the right to be *promoted* to forward-paper, and that
// promotion is a decision someone makes, not a side effect of a status.
const SCANNER_STATUSES = Object.freeze(["forward-paper", "real-money-eligible"]);

// Both conditions required, neither self-certified:
//
//   1. the strategy declares it can run in the live scanner at all, and
//   2. its lifecycle status permits forward-paper operation.
//
// Registry presence confers nothing.
function computeScannerEligible(strategy) {
  return strategy.supportsLiveScanner === true && SCANNER_STATUSES.includes(strategy.status);
}

// Live demo research is evidence collection, not promotion. A candle strategy
// may opt into the isolated paper runner while its lifecycle remains
// `backtest`; this capability is never consulted by the production scanner.
function computeLiveResearchEligible(strategy) {
  return strategy.supportsLiveResearch === true && strategy.supportsBacktest === true;
}

// Real-money eligibility is a lifecycle claim only. It is deliberately NOT
// conditioned on supportsLiveScanner: whether the scanner can run something is
// a different question from whether its evidence would justify real money.
// Today this returns false for every registered strategy, which is correct.
function computeRealMoneyEligible(strategy) {
  return strategy.status === "real-money-eligible";
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
  // Validated at load like everything else here: a shortDescription that is
  // not a usable string would reach a card as "[object Object]" or an empty
  // line, and a dashboard is a bad place to discover a metadata typo.
  if (strategy.shortDescription !== undefined) {
    if (typeof strategy.shortDescription !== "string" || !strategy.shortDescription.trim()) {
      throw new Error(`${where} must declare shortDescription as a non-empty string when present`);
    }
    // A card has room for one or two lines. This is a metadata bound rather
    // than a rendering one so the limit is enforced where the text is written
    // — the UI never silently clips a value it was handed.
    if (strategy.shortDescription.length > 140) {
      throw new Error(
        `${where} has a ${strategy.shortDescription.length}-character shortDescription; keep it under 140 so it fits a card in one or two lines`,
      );
    }
  }
  if (strategy.supportsLiveResearch !== undefined && typeof strategy.supportsLiveResearch !== "boolean") {
    throw new Error(`${where} must declare supportsLiveResearch as a boolean when present`);
  }
  if (strategy.supportsEventReplay !== undefined && typeof strategy.supportsEventReplay !== "boolean") {
    throw new Error(`${where} must declare supportsEventReplay as a boolean when present`);
  }
  return strategy;
}

// The public metadata shape. Both eligibility fields are always computed, so
// callers cannot be misled by a stale or optimistic field on the strategy.
function describeStrategy(strategy) {
  return {
    id: strategy.id,
    name: strategy.name,
    version: strategy.version,
    description: strategy.description,
    // The card-sized summary. Falls back to the full description rather than
    // being null, so a caller never has to decide what to show when a strategy
    // has not declared one — and so a new strategy that forgets it renders
    // something correct-but-long instead of an empty card.
    shortDescription: strategy.shortDescription || strategy.description,
    status: strategy.status,
    supportsBacktest: strategy.supportsBacktest,
    supportsEventReplay: strategy.supportsEventReplay === true,
    supportsLiveScanner: strategy.supportsLiveScanner,
    supportsLiveResearch: strategy.supportsLiveResearch === true,
    liveResearchEligible: computeLiveResearchEligible(strategy),
    scannerEligible: computeScannerEligible(strategy),
    realMoneyEligible: computeRealMoneyEligible(strategy),
    requiredWarmupBars: strategy.requiredWarmupBars,
    datasetAvailability: strategy.datasetAvailability || null,
    rules: typeof strategy.describeRules === "function" ? strategy.describeRules() : null,
  };
}

module.exports = {
  LIFECYCLE_STATUSES,
  SCANNER_STATUSES,
  computeScannerEligible,
  computeLiveResearchEligible,
  computeRealMoneyEligible,
  assertValidLifecycle,
  describeStrategy,
};
