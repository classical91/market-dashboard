"use strict";

// The strategy registry.
//
// A strategy is a plain object with a fixed shape, so the backtester, the
// comparison endpoint and (later) the live scanner can all take one without
// knowing anything about what it does inside:
//
//   {
//     id: string                    // stable key used in APIs and ledgers
//     name: string                  // human label
//     version: string               // recorded on every experiment
//     description: string
//     status: string                // research lifecycle — see ./lifecycle.js
//     supportsBacktest: boolean     // may be replayed by the backtester
//     supportsLiveScanner: boolean  // may be run forward by the live scanner
//     requiredWarmupBars: number    // bars needed before its first real signal
//     evaluate(candles, index, context) -> signal
//   }
//
// `scannerEligible` and `realMoneyEligible` are NOT fields a strategy sets.
// Both are computed from status + capability (./lifecycle.js), so being in the
// registry never implies permission to run anywhere.
//
// `evaluate` is handed the full candle array plus the index of the bar being
// decided, and must read nothing past that index — that contract is what keeps
// backtests honest. `context` carries what the caller knows and the strategy
// cannot compute for itself: `options` overrides, and `trendUp` for a
// higher-timeframe trend read when one is available.
//
// The signal it returns:
//
//   {
//     signal: "LONG" | "SHORT" | "FLAT"
//     strategy: string              // echoes the strategy id
//     price: number | null          // the close the decision was made at
//     error: string | null          // why no opinion was possible (warmup)
//     reasons: string[]             // human-readable, always populated
//     indicators: object            // every value the decision rested on
//     confidence: number | null     // 0-100 self-score, null when it has none
//     stopHint / targetHint: number | null   // structural levels, advisory
//   }
//
// Registration is deliberately explicit rather than a directory scan: a
// strategy reaching the live scanner should be a visible one-line diff.

const { mindsetV1 } = require("./mindset-v1");
const { smcV1 } = require("./smc-v1");
const { shadowBananagunV1 } = require("./shadow-bananagun-v1");
const { donchianBreakoutV1 } = require("./donchian-breakout-v1");
const { vwapReversionV1 } = require("./vwap-reversion-v1");
const {
  LIFECYCLE_STATUSES,
  SCANNER_STATUSES,
  computeScannerEligible,
  computeRealMoneyEligible,
  assertValidLifecycle,
  describeStrategy,
} = require("./lifecycle");

// Validated at load: a strategy with a bad status or no version fails the
// process at startup rather than producing unreproducible experiments later.
const STRATEGIES = [
  mindsetV1,
  smcV1,
  shadowBananagunV1,
  donchianBreakoutV1,
  vwapReversionV1,
].map(assertValidLifecycle);

const BY_ID = new Map(STRATEGIES.map((strategy) => [strategy.id, strategy]));

const DEFAULT_STRATEGY_ID = "mindset_v1";

// Every registered strategy's metadata. Optional filters exist because the
// two real questions callers ask are "what can I backtest?" and "what may the
// live scanner run?", and answering those by hand at each call site is how
// capability checks drift apart.
function listStrategies({ supportsBacktest, supportsLiveScanner, status, scannerEligible, realMoneyEligible } = {}) {
  return STRATEGIES.map(describeStrategy).filter(
    (s) =>
      (supportsBacktest === undefined || s.supportsBacktest === supportsBacktest) &&
      (supportsLiveScanner === undefined || s.supportsLiveScanner === supportsLiveScanner) &&
      (status === undefined || s.status === status) &&
      (scannerEligible === undefined || s.scannerEligible === scannerEligible) &&
      (realMoneyEligible === undefined || s.realMoneyEligible === realMoneyEligible),
  );
}

/**
 * Resolve a strategy for the LIVE SCANNER, or throw a configuration error
 * naming what is actually allowed.
 *
 * This is the runtime enforcement of scanner eligibility. It lives in the
 * registry rather than in the scanner so there is exactly one answer to "may
 * this run forward?", and it refuses rather than falling back: a scanner
 * quietly running a different strategy than the one configured is worse than a
 * scanner that will not start.
 */
function getScannerStrategy(id) {
  const key = String(id || "");
  const strategy = BY_ID.get(key);
  if (!strategy) {
    throw new Error(
      `Unknown strategy "${key}" (registered: ${[...BY_ID.keys()].join(", ")})`,
    );
  }

  const meta = describeStrategy(strategy);
  if (!meta.supportsLiveScanner) {
    throw new Error(
      `Strategy "${key}" does not support the live scanner (status ${meta.status}); ` +
        `scanner-capable strategies: ${listStrategies({ scannerEligible: true }).map((s) => s.id).join(", ") || "none"}`,
    );
  }
  if (!meta.scannerEligible) {
    throw new Error(
      `Strategy "${key}" is not scanner eligible: status ${meta.status} does not permit forward-paper operation ` +
        `(needs one of ${SCANNER_STATUSES.join(", ")})`,
    );
  }
  return strategy;
}

// The metadata for one strategy, or null. Unlike getStrategy() this does not
// throw — callers asking "what is this?" are usually not in a position to
// turn a typo into a 400.
function describe(id) {
  const strategy = BY_ID.get(String(id || ""));
  return strategy ? describeStrategy(strategy) : null;
}

function hasStrategy(id) {
  return BY_ID.has(String(id || ""));
}

// Throws a 400 rather than falling back to a default: silently backtesting a
// different strategy than the one asked for would make the result a lie.
function getStrategy(id) {
  const key = String(id === undefined || id === null || id === "" ? DEFAULT_STRATEGY_ID : id);
  const strategy = BY_ID.get(key);
  if (!strategy) {
    throw Object.assign(
      new Error(`Unknown strategy "${key}" (expected one of ${[...BY_ID.keys()].join(", ")})`),
      { statusCode: 400, expose: true },
    );
  }
  return strategy;
}

module.exports = {
  STRATEGIES,
  DEFAULT_STRATEGY_ID,
  LIFECYCLE_STATUSES,
  SCANNER_STATUSES,
  listStrategies,
  describe,
  describeStrategy,
  computeScannerEligible,
  computeRealMoneyEligible,
  hasStrategy,
  getStrategy,
  getScannerStrategy,
};
