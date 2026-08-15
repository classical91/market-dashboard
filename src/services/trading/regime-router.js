"use strict";

// The regime router — "given the environment we measured, which strategies does
// the EVIDENCE say belong here?"
//
// ── Advisory, and structurally so ───────────────────────────────────────────
//
// This module returns an opinion. It does not turn strategies on or off, and it
// cannot: the live scanner resolves what it may run through
// strategies/index.js#getScannerStrategy, which checks lifecycle status
// independently and refuses anything that is not scanner eligible. A router
// recommendation is not an input to that check and never becomes one here.
//
// That separation is the point, not an oversight. A backtest-only strategy must
// not become a forward-paper strategy because a routing table liked its numbers
// — promotion is a decision someone makes after reviewing evidence, and the
// evidence this router reads is exactly the evidence that review would use. So
// every recommendation carries `scannerEligible` alongside it, and a strategy
// the scanner may not run is labelled as such however good its regime numbers
// are. `enforced: false` is on every response for the same reason.
//
// ── The refusal case is the feature ─────────────────────────────────────────
//
// A router with no way to say "none of them" will pick a strategy on every bar,
// which means it flips between strategies precisely while the market is
// changing character — the moment its recommendations are least reliable and
// most expensive. So a non-actionable regime read (TRANSITION, UNKNOWN, a read
// under the confidence floor, or an environment where size rather than
// direction is the problem) returns no selection at all, with the reason.
//
// That outcome is more valuable than the accumulation/distribution labels: it
// is the one that stops the system trading its own indecision.

const { listStrategies, describe } = require("./strategies");
const { verdictFor } = require("./regime-metrics");

// Ranking within the eligible set: measured expectancy first, then profit
// factor, then sample size. Same order metrics.js ranks by, for the same
// reason — an edge that is larger, more consistent and better evidenced beats
// one that is only larger.
function compareCandidates(a, b) {
  const pf = (c) => (c.cell && c.cell.profitFactor === null ? Infinity : (c.cell && c.cell.profitFactor) || 0);
  return (
    (b.expectancyR ?? 0) - (a.expectancyR ?? 0) ||
    pf(b) - pf(a) ||
    ((b.cell && b.cell.closedTrades) || 0) - ((a.cell && a.cell.closedTrades) || 0)
  );
}

function candidateFrom(strategyId, matrix, regime) {
  const meta = describe(strategyId);
  const { verdict, cell, reason } = verdictFor(matrix, strategyId, regime);

  return {
    strategy: strategyId,
    name: (meta && meta.name) || strategyId,
    status: (meta && meta.status) || null,
    // Read from the lifecycle module, never from the routing decision. A
    // strategy the scanner may not run is reported as such even when it is the
    // best-performing candidate in this regime.
    scannerEligible: Boolean(meta && meta.scannerEligible),
    verdict,
    reason,
    expectancyR: cell ? cell.expectancyR : null,
    trades: cell ? cell.closedTrades : 0,
    cell,
  };
}

/**
 * Route a regime read against measured evidence.
 *
 * @param read     a regime read from ./regime#classifyRegime
 * @param matrix   a strategy × regime table from ./regime-metrics#buildRegimeMatrix
 * @param strategies  which strategy ids to consider; defaults to every
 *                    registered strategy that can be backtested, because the
 *                    question "where does this belong?" is a research question
 *                    and research runs on backtests.
 *
 * The returned shape always includes every considered strategy in exactly one
 * bucket, so a reader can never be left wondering what happened to one:
 *
 *   preferred    the single best-evidenced strategy for this regime, or null
 *   eligible     measured favourable here (includes `preferred`)
 *   suppressed   measured UNFAVOURABLE here — the wrong-regime case
 *   unproven     not enough trades in this regime to say either way. Kept
 *                apart from `suppressed` on purpose: never having traded in a
 *                regime is not the same as having lost money there, and
 *                merging the two would bury every new strategy.
 */
function routeRegime({ read, matrix, strategies = null } = {}) {
  const ids =
    strategies && strategies.length
      ? strategies.map(String)
      : listStrategies({ supportsBacktest: true }).map((s) => s.id);

  const base = {
    regime: read ? read.regime : "UNKNOWN",
    confidence: read ? read.confidence : 0,
    actionable: Boolean(read && read.actionable),
    // Stated on every response: this is advice, and nothing acts on it.
    advisory: true,
    enforced: false,
    preferred: null,
    eligible: [],
    suppressed: [],
    unproven: [],
    evidence: {
      minTrades: matrix ? matrix.minTrades : null,
      coverage: matrix ? matrix.coverage : null,
    },
    reasons: [],
  };

  if (!read || !read.actionable) {
    const label = read ? read.regime : "UNKNOWN";
    return {
      ...base,
      // Every candidate is held, none suppressed for cause — nothing about
      // these strategies failed here, the environment is simply unreadable.
      held: ids.map((id) => {
        const meta = describe(id);
        return { strategy: id, name: (meta && meta.name) || id, status: (meta && meta.status) || null };
      }),
      reasons: [
        label === "TRANSITION"
          ? "TRANSITION — the market is between characters, no strategy selected"
          : label === "UNKNOWN"
            ? "UNKNOWN — not enough data for a regime read, no strategy selected"
            : read && read.confidence < (read.options ? read.options.minConfidence : 55)
              ? `${label} at ${read.confidence}% confidence is under the floor — no strategy selected`
              : `${label} — an environment for sizing decisions rather than selection, no strategy selected`,
        ...(read ? read.reasons : []),
      ],
    };
  }

  if (!matrix || !matrix.rows || !matrix.rows.length) {
    return {
      ...base,
      unproven: ids.map((id) => candidateFrom(id, { rows: [], minTrades: null }, read.regime)),
      reasons: [
        `${read.regime} at ${read.confidence}% confidence, but there is no recorded trade history to route on yet`,
      ],
    };
  }

  const candidates = ids.map((id) => candidateFrom(id, matrix, read.regime));
  const eligible = candidates.filter((c) => c.verdict === "FAVOURABLE").sort(compareCandidates);
  const suppressed = candidates.filter((c) => c.verdict === "UNFAVOURABLE").sort(compareCandidates);
  const unproven = candidates.filter((c) => c.verdict === "INSUFFICIENT");

  const preferred = eligible.length ? eligible[0] : null;

  const reasons = [
    `${read.regime} at ${read.confidence}% confidence — ${read.action}`,
    ...(preferred
      ? [`Preferred: ${preferred.name} (${preferred.reason})`]
      : ["No strategy has measured favourably in this regime yet"]),
    ...suppressed.map((c) => `Suppressed: ${c.name} — wrong regime (${c.reason})`),
    ...(unproven.length
      ? [`Unproven here: ${unproven.map((c) => c.name).join(", ")} — insufficient trades in ${read.regime}`]
      : []),
  ];

  // A recommendation the scanner could not act on even if it were enforced is
  // worth saying out loud, so nobody reads "Preferred: X" as "X is running".
  if (preferred && !preferred.scannerEligible) {
    reasons.push(
      `${preferred.name} is not scanner eligible (status ${preferred.status}) — this is a research recommendation, not a live selection`,
    );
  }

  return { ...base, preferred, eligible, suppressed, unproven, held: [], reasons };
}

module.exports = { routeRegime };
