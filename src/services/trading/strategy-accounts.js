"use strict";

// Strategy paper accounts — one isolated persistent ledger per registered
// strategy, so "does this strategy make money?" is a question with an answer.
//
// ── Why this is separate from books ─────────────────────────────────────────
//
// The lab has three persistent books — Main, Shadow SMC, Alts — and they are a
// port of TraderClaw's three Python bot services, not a portfolio design. One
// of them is even named after a strategy, which is where the confusion starts:
// a book looks like it answers "how is SMC doing?" and actually answers "what
// happened in the ledger the shadow_trader bot used to write to".
//
// The two questions are genuinely different and both worth asking:
//
//   Strategy account  How does ONE strategy perform, in isolation, with its own
//                     starting balance, its own risk state and its own history?
//   Portfolio book    How does a COLLECTION of activity perform together? The
//                     signal-bot bridge has no registry strategy at all, so its
//                     trades can only ever be book-level activity.
//
// So books are kept, unchanged and un-renamed, and accounts are added beside
// them.
//
// ── Derived, never listed by hand ───────────────────────────────────────────
//
// The account set comes from the strategy registry. Registering a sixth
// strategy gives it an account with no second list to update, which is the
// property that stops the two drifting — a hand-maintained mirror of the
// registry is exactly the kind of duplication that ends with an account nobody
// notices is missing.
//
// ── An account is not a permission ──────────────────────────────────────────
//
// Every registered strategy gets an account, including the four that may not
// trade forward. Those accounts exist, sit at their starting balance, and
// display why they are inactive. Nothing here consults or confers eligibility:
// the live scanner still resolves what it may run through
// strategies/index.js#getScannerStrategy, which checks lifecycle status and is
// never handed anything from this module. An account is a place to put results,
// not a licence to produce them.

const { listStrategies, describe } = require("./strategies");

// Ledgers are namespaced so a strategy id can never collide with a book id — a
// future book called "smc" and the smc_v1 account must not share a directory.
//
// A PREFIX rather than a nested path, because PaperTradingService sanitises its
// book name to [a-z0-9_-] and a "strategies/mindset_v1" would silently flatten
// to "strategiesmindset_v1" — still isolated, but by accident, and with the
// separator that was carrying the guarantee quietly deleted.
const ACCOUNT_NAMESPACE = "strategy";

function ledgerKey(strategyId) {
  return `${ACCOUNT_NAMESPACE}-${strategyId}`;
}

/**
 * Why an account is or is not accumulating a forward track record, in the terms
 * the dashboard shows.
 *
 * `active` is taken from `scannerEligible`, which lifecycle.js computes from
 * status *and* capability — it is never read off the strategy itself, so an
 * account cannot claim to be live because a strategy said so.
 */
function accountMode(meta) {
  if (meta.scannerEligible) {
    return { active: true, mode: "forward-paper", label: "Forward Paper" };
  }
  // Ordered by what actually blocks a forward record. A strategy that cannot
  // even be replayed on candles is further from trading than one that can, and
  // the label should say which.
  if (meta.supportsEventReplay && !meta.supportsBacktest) {
    return { active: false, mode: "event-replay", label: "Event Replay Only" };
  }
  if (meta.supportsBacktest) {
    return { active: false, mode: "backtest", label: "Backtest Only" };
  }
  return { active: false, mode: meta.status, label: "Not Forward Enabled" };
}

/**
 * Every strategy that should have an account, straight from the registry.
 *
 * Retired strategies keep their accounts: the point of retiring rather than
 * deleting is that old results stay reproducible, and a ledger that vanishes
 * when a status changes defeats that.
 */
function listStrategyAccounts() {
  return listStrategies().map((meta) => ({
    id: meta.id,
    name: meta.name,
    status: meta.status,
    version: meta.version,
    scannerEligible: meta.scannerEligible,
    realMoneyEligible: meta.realMoneyEligible,
    supportsBacktest: meta.supportsBacktest,
    supportsEventReplay: meta.supportsEventReplay,
    ledgerKey: ledgerKey(meta.id),
    ...accountMode(meta),
  }));
}

// The account descriptor for one strategy, or null when the id is not
// registered. Does not throw: callers asking "is there an account for this?"
// are usually not in a position to turn a typo into a 400.
function describeStrategyAccount(strategyId) {
  const meta = describe(strategyId);
  if (!meta) return null;
  return {
    id: meta.id,
    name: meta.name,
    status: meta.status,
    version: meta.version,
    scannerEligible: meta.scannerEligible,
    realMoneyEligible: meta.realMoneyEligible,
    supportsBacktest: meta.supportsBacktest,
    supportsEventReplay: meta.supportsEventReplay,
    ledgerKey: ledgerKey(meta.id),
    ...accountMode(meta),
  };
}

/**
 * May a forward execution attributed to this strategy be written to the
 * strategy's own account?
 *
 * True only for a scanner-eligible strategy, which is a lifecycle answer
 * computed elsewhere. This does not GRANT anything — a strategy that is not
 * scanner eligible cannot reach an execution path in the first place — it
 * decides where an execution that already happened gets recorded, and keeps a
 * non-eligible strategy's account empty rather than mysteriously populated.
 */
function acceptsForwardTrades(strategyId) {
  const account = describeStrategyAccount(strategyId);
  return Boolean(account && account.active);
}

module.exports = {
  ACCOUNT_NAMESPACE,
  ledgerKey,
  accountMode,
  listStrategyAccounts,
  describeStrategyAccount,
  acceptsForwardTrades,
};
