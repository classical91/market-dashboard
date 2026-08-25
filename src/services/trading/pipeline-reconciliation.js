"use strict";

// One reconciliation view over the paper pipeline, because "the journal is
// empty" was never answerable from any single store.
//
// Three stores hold three different kinds of record, and they are deliberately
// NOT the same thing:
//
//   SignalActionStore   signal-bridge-log.json — the EVALUATION ledger. One row
//                       per entry transition the bridge scored, whatever the
//                       outcome. This is the denominator.
//   PaperTradingService trading-lab/<book>/{positions,history}.json — the
//                       EXECUTION ledger. Paper fills and their closes.
//   TradeJournalService trade-journal.json — the HUMAN journal. Hand-logged,
//                       hand-graded (`taken`, `result`, `regimeCorrect`), and
//                       reachable only through an admin-keyed route. Nothing
//                       automated writes it, and nothing here does either:
//                       its win-rate and expectancy statistics are only
//                       meaningful because a person vouched for every row.
//                       It is reported alongside, never fed.
//
// The question this answers is the reconciliation one: of everything evaluated,
// where did each one end up, and did anything silently disappear?
//
//   73 evaluated, 70 blocked, 2 dry-run, 1 failed, 0 unaccounted.
//
// `reconciled` is true only when every evaluated row reached a terminal status
// carrying a reason, and every bridge-owned paper fill has an evaluation row
// behind it. Anything else lands in `discrepancies` with enough detail to go
// looking.

const { listStrategyAccounts } = require("./strategy-accounts");
const { positionOwner, EXECUTION_OWNERS } = require("./execution-owner");

// Every status _record() can write. A row outside this set means the bridge
// grew an outcome this view does not know how to account for — which is
// exactly the silent drift worth failing on.
const TERMINAL_STATUSES = Object.freeze(["dry-run", "blocked", "failed", "skipped", "opened"]);

// Statuses that mean "scored, and deliberately not filled". Kept separate from
// `failed` so an attribution refusal is never mistaken for an error.
const REFUSAL_REASON = /no registered strategy identity/i;

function bucket(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function intervalOfSignalSource(signalSource) {
  const match = String(signalSource || "").match(/^signal-bot:(.+)$/);
  return match ? match[1] : null;
}

/**
 * Reconcile the evaluation ledger against the execution ledgers.
 *
 * `limit` bounds how much of the action log is read back; it is the same log
 * the Trading Lab already serves, capped at 2000 rows by the store itself.
 */
function reconcilePaperPipeline({
  signalActionStore = null,
  tradingLabService = null,
  tradeJournalService = null,
  limit = 500,
} = {}) {
  const discrepancies = [];
  const actions = signalActionStore && typeof signalActionStore.recent === "function"
    ? signalActionStore.recent(limit)
    : [];

  // ── Evaluation ────────────────────────────────────────────────────────────

  const byStatus = bucket(actions, (row) => row.status);
  const unknownStatus = actions.filter((row) => !TERMINAL_STATUSES.includes(row.status));
  const missingReason = actions.filter((row) => !row.reason);
  // Attribution is what makes a row answer "why" without re-running the scan.
  const missingAttribution = actions.filter((row) => !row.symbol || !row.direction || !row.strategy);

  if (unknownStatus.length) {
    discrepancies.push({
      kind: "unknown-status",
      count: unknownStatus.length,
      detail: `Evaluation rows carry a status outside ${TERMINAL_STATUSES.join("/")}: ` +
        `${[...new Set(unknownStatus.map((row) => String(row.status)))].join(", ")}`,
    });
  }
  if (missingReason.length) {
    discrepancies.push({
      kind: "missing-reason",
      count: missingReason.length,
      detail: "Evaluation rows with no reason — the outcome cannot be explained from the log alone",
    });
  }
  if (missingAttribution.length) {
    discrepancies.push({
      kind: "missing-attribution",
      count: missingAttribution.length,
      detail: "Evaluation rows missing symbol, direction or strategy",
    });
  }

  const evaluation = {
    total: actions.length,
    byStatus,
    // The reconciliation identity: everything evaluated is accounted for by a
    // terminal status. `unaccounted` must be 0.
    accounted: actions.length - unknownStatus.length,
    unaccounted: unknownStatus.length,
    withReason: actions.length - missingReason.length,
    recoveredLegacyAttribution: actions.filter((row) => row.attributionRecovered === true).length,
    // Scored as tradeable but not filled — the population that would become
    // fills if execution were enabled and attributed.
    eligible: actions.filter((row) => row.status === "dry-run" && /would open/i.test(String(row.reason || ""))).length,
    refusedByAttribution: actions.filter((row) => REFUSAL_REASON.test(String(row.reason || ""))).length,
    oldest: actions.length ? actions[actions.length - 1].timestamp : null,
    newest: actions.length ? actions[0].timestamp : null,
  };

  // ── Execution ─────────────────────────────────────────────────────────────

  const accounts = [];
  let bridgeOpen = 0;
  let bridgeClosed = 0;
  const unlogged = [];

  if (tradingLabService && typeof tradingLabService.strategyLedger === "function") {
    // An evaluation row stands behind a fill when the bridge scored that symbol
    // on that interval at or before the position opened. Symbol+interval rather
    // than an id because positions predate this view; a fill with no plausible
    // row behind it is the hole worth reporting.
    const evaluatedKeys = new Map();
    for (const row of actions) {
      const key = `${row.symbol}:${row.interval}`;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) continue;
      evaluatedKeys.set(key, Math.max(evaluatedKeys.get(key) || 0, at));
    }

    const seenBridgeFill = (position) => {
      const interval = intervalOfSignalSource(position.signalSource);
      if (!interval) return true;
      const earliest = evaluatedKeys.get(`${position.symbol}:${interval}`);
      if (!earliest) return false;
      const opened = Date.parse(position.openedAt);
      return !Number.isFinite(opened) || earliest <= opened + 60_000;
    };

    for (const { id, label } of listStrategyAccounts()) {
      let ledger;
      try {
        ledger = tradingLabService.strategyLedger(id);
      } catch {
        continue;
      }
      const open = ledger.getOpenPositions();
      const history = ledger.getHistory();
      const bridgeOpenHere = open.filter((p) => positionOwner(p) === EXECUTION_OWNERS.SIGNAL_BRIDGE);
      const bridgeClosedHere = history.filter((p) => positionOwner(p) === EXECUTION_OWNERS.SIGNAL_BRIDGE);
      bridgeOpen += bridgeOpenHere.length;
      bridgeClosed += bridgeClosedHere.length;

      for (const position of [...bridgeOpenHere, ...bridgeClosedHere]) {
        if (!seenBridgeFill(position)) {
          unlogged.push(`${id}:${position.symbol}@${position.openedAt || "unknown"}`);
        }
      }

      accounts.push({
        strategyId: id,
        label,
        open: open.length,
        closed: history.length,
        bridgeOwnedOpen: bridgeOpenHere.length,
        bridgeOwnedClosed: bridgeClosedHere.length,
      });
    }
  }

  if (unlogged.length) {
    discrepancies.push({
      kind: "unlogged-fill",
      count: unlogged.length,
      detail: `Bridge-owned paper positions with no evaluation row behind them: ${unlogged.slice(0, 5).join(", ")}` +
        (unlogged.length > 5 ? ` (+${unlogged.length - 5} more)` : ""),
    });
  }

  const execution = {
    bridgeOwnedOpen: bridgeOpen,
    bridgeOwnedClosed: bridgeClosed,
    accounts,
    // Said plainly so a zero here reads as the designed outcome it is, rather
    // than as a missing pipeline: the Signal Bot has no registered strategy
    // identity, so persistent execution is refused by design.
    note: bridgeOpen + bridgeClosed === 0 && evaluation.refusedByAttribution > 0
      ? "No bridge-owned paper fills: Signal Bot has no registered strategy identity, so persistent execution is refused by design."
      : null,
  };

  // ── Human journal (reported, never written) ───────────────────────────────

  let manualJournal = null;
  if (tradeJournalService && typeof tradeJournalService.stats === "function") {
    const stats = tradeJournalService.stats();
    manualJournal = {
      maintainedBy: "human",
      entries: stats.total,
      taken: stats.taken,
      graded: stats.graded,
      note: "Hand-logged and hand-graded through the admin-keyed journal route. The pipeline never writes here — its statistics are only meaningful because a person vouched for each row.",
    };
  }

  return {
    updatedAt: new Date().toISOString(),
    reconciled: discrepancies.length === 0,
    summary:
      `${evaluation.total} evaluated, ` +
      Object.entries(byStatus).map(([status, n]) => `${n} ${status}`).join(", ") +
      `${evaluation.total ? ", " : ""}${evaluation.unaccounted} unaccounted`,
    evaluation,
    execution,
    manualJournal,
    discrepancies,
  };
}

module.exports = { reconcilePaperPipeline, TERMINAL_STATUSES };
