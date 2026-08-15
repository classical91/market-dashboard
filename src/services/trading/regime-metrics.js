"use strict";

// Strategy × regime performance — the table that turns "VWAP works in ranges"
// from a belief into a measurement.
//
// The claim a regime router rests on is not "this is a range". It is "strategies
// like this one have historically paid in ranges and lost in trends". That is a
// claim about evidence, and nothing in this codebase could state it before this
// module: metrics.js groups by strategy, by symbol and by score bucket, so a
// strategy's expectancy was a single number pooling every environment it ever
// traded in. A strategy that makes +0.4R in ranges and loses -0.3R in trends
// shows up there as a mediocre +0.05R, and the useful fact — that it has a
// regime it belongs in — is averaged away.
//
// ── The honesty rules ───────────────────────────────────────────────────────
//
// A cell in this table is a per-regime sample, which means it is SMALL. A
// strategy with 200 trades might have 19 of them in TREND_UP, and 19 trades is
// not an edge, it is an anecdote. Two rules keep that visible:
//
//   1. Every cell carries its own trade count, and cells below `minTrades` are
//      marked `sufficient: false` rather than dropped. Dropping them would hide
//      that the strategy traded there at all; presenting them unmarked would
//      invite a routing decision built on nineteen trades.
//   2. Trades with no regime tag are counted and reported separately, never
//      silently pooled into a regime. History recorded before regime tagging
//      existed is untagged, and a table that quietly folded it into RANGE would
//      be inventing evidence.
//
// Nothing here decides anything either. See ./regime-router.js.

const { calculateTradeMetrics } = require("./metrics");
const { REGIMES } = require("./regime");

// Where a trade records the regime it was OPENED in. `meta.regime` is where the
// backtester and paper trader write it; the top-level field is accepted so a
// caller with a flatter record shape is not forced to nest it.
function regimeKey(trade) {
  const tagged =
    (trade && trade.meta && trade.meta.regime) || (trade && trade.regimeAtEntry) || null;
  const label = tagged ? String(tagged) : null;
  return label && REGIMES.includes(label) ? label : "UNTAGGED";
}

function strategyKey(trade) {
  return String((trade && (trade.signalSource || trade.strategy || trade.source)) || "unknown");
}

// The confidence the regime read had when the trade was opened, if it was
// recorded. Averaged per cell so a reader can tell a cell built from decisive
// reads apart from one built from marginal ones.
function regimeConfidence(trade) {
  const value = Number(trade && trade.meta && trade.meta.regimeConfidence);
  return Number.isFinite(value) ? value : null;
}

function meanOrNull(values) {
  return values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
}

/**
 * One strategy's performance broken out by the regime each trade was opened in.
 *
 * `cells` is keyed by regime label and contains the full metrics shape the rest
 * of the lab uses, so a cell is directly comparable with a strategy summary.
 */
function buildRegimeRow(trades, startingBalance, minTrades) {
  const byRegime = new Map();
  for (const trade of trades) {
    const key = regimeKey(trade);
    if (!byRegime.has(key)) byRegime.set(key, []);
    byRegime.get(key).push(trade);
  }

  const cells = {};
  for (const [regime, regimeTrades] of byRegime) {
    const metrics = calculateTradeMetrics(regimeTrades, startingBalance);
    cells[regime] = {
      ...metrics,
      // Is this cell evidence, or is it an anecdote? Stated per cell because
      // the answer differs per cell within a single row.
      sufficient: metrics.closedTrades >= minTrades,
      meanRegimeConfidence: meanOrNull(
        regimeTrades.map(regimeConfidence).filter((v) => v !== null),
      ),
    };
  }

  return cells;
}

/**
 * The full strategy × regime table.
 *
 * Returns rows in the same order the caller's history produced strategies, each
 * with a pooled summary and per-regime cells, plus the tagging coverage of the
 * history it was built from.
 *
 * `coverage` is the first thing to read. A table built from history that is 90%
 * untagged is not a regime analysis, and it should be obvious at a glance
 * rather than discovered by summing the cells.
 */
function buildRegimeMatrix(history, startingBalance, { minTrades = 20 } = {}) {
  const trades = Array.isArray(history) ? history : [];

  const byStrategy = new Map();
  for (const trade of trades) {
    const key = strategyKey(trade);
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(trade);
  }

  const rows = [];
  for (const [strategy, strategyTrades] of byStrategy) {
    rows.push({
      strategy,
      summary: calculateTradeMetrics(strategyTrades, startingBalance),
      cells: buildRegimeRow(strategyTrades, startingBalance, minTrades),
    });
  }

  // Ranked by pooled expectancy so the table opens on the strategies that have
  // done best overall — the per-regime story is then read across each row.
  rows.sort((a, b) => b.summary.expectancyR - a.summary.expectancyR);

  const tagged = trades.filter((t) => regimeKey(t) !== "UNTAGGED").length;

  // Only the regimes that actually appear, in the canonical order — a table
  // with nine columns of which six are empty is harder to read than one with
  // three, and the vocabulary is available from ./regime for anyone who wants
  // the full set.
  const present = new Set(trades.map(regimeKey));
  const regimes = REGIMES.filter((r) => present.has(r));
  if (present.has("UNTAGGED")) regimes.push("UNTAGGED");

  return {
    regimes,
    rows,
    minTrades,
    coverage: {
      trades: trades.length,
      tagged,
      untagged: trades.length - tagged,
      taggedPct: trades.length ? Math.round((tagged / trades.length) * 100) : 0,
    },
  };
}

/**
 * What the matrix says about ONE strategy in ONE regime, in the form a router
 * needs: a verdict, and the evidence behind it.
 *
 * The verdict vocabulary is deliberately three-valued. "No evidence" is not
 * "bad" — a strategy that has never traded in a regime has not failed there,
 * and conflating the two would suppress a strategy for the crime of being new.
 *
 *   FAVOURABLE    enough trades, positive expectancy
 *   UNFAVOURABLE  enough trades, non-positive expectancy
 *   INSUFFICIENT  not enough trades to say either way
 */
function verdictFor(matrix, strategy, regime) {
  const row = matrix.rows.find((r) => r.strategy === strategy);
  const cell = row && row.cells ? row.cells[regime] : null;

  if (!cell) {
    return { verdict: "INSUFFICIENT", cell: null, reason: `no trades recorded in ${regime}` };
  }
  if (!cell.sufficient) {
    return {
      verdict: "INSUFFICIENT",
      cell,
      reason: `${cell.closedTrades} closed trade(s) in ${regime}, needs ${matrix.minTrades}`,
    };
  }
  return {
    verdict: cell.expectancyR > 0 ? "FAVOURABLE" : "UNFAVOURABLE",
    cell,
    reason: `${cell.expectancyR >= 0 ? "+" : ""}${cell.expectancyR}R over ${cell.closedTrades} trades in ${regime}`,
  };
}

module.exports = { buildRegimeMatrix, buildRegimeRow, verdictFor, regimeKey };
