"use strict";

// How old is the market data a card is actually showing?
//
// Every engine on the My Trades card serves cached results computed from
// closed candles, so "BULLISH 67" and "TOP CONFIRMED" look identical whether
// they were derived a minute ago or hours ago from a feed that has stopped
// advancing. The numbers alone cannot tell a reader which of the two it is.
//
// This module answers that from two independent clocks, because they fail
// independently:
//
//   candle age      how long ago the newest CLOSED candle the engine ran on
//                   closed. On a 4h chart this is normally anything from zero
//                   to four hours old and perfectly current; it only means
//                   trouble once it runs past a whole bar, which says the
//                   feed itself is behind.
//   calculation age how long ago the engine last recomputed. This is cache
//                   age, and it goes bad when a refresh stops happening at
//                   all — the candles may be current while nobody is reading
//                   them.
//
// Neither is combined into the other, and neither is combined into the
// context state: freshness says whether the evidence is current, not which
// way it points.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every interval either engine accepts. Months are approximated at 30 days —
// the tolerances below are half-bar wide, so the drift never decides anything.
const INTERVAL_MS = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": HOUR,
  "2h": 2 * HOUR,
  "4h": 4 * HOUR,
  "6h": 6 * HOUR,
  "12h": 12 * HOUR,
  "1D": DAY,
  "1W": 7 * DAY,
  "1M": 30 * DAY,
};

// A recompute is never expected to be more current than the engines' own
// cache TTL, and asking for more than that would flag healthy pages. These
// bracket the per-timeframe threshold so a 15m card is not judged by a daily
// card's patience, nor a weekly card held to a 15m one's.
const MIN_CALC_TOLERANCE_MS = 10 * MINUTE;
const MAX_CALC_TOLERANCE_MS = HOUR;

function intervalMs(interval) {
  return INTERVAL_MS[interval] || null;
}

/** Epoch millis from either a number or an ISO string; null for anything else. */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The newest closed candle is between zero and one bar old in normal
 * operation, so only an age past a full bar means the feed is lagging. Half a
 * bar of slack on top absorbs exchange-side publish delay without crying
 * stale on every timeframe boundary.
 */
function candleToleranceMs(interval) {
  const bar = intervalMs(interval);
  if (!bar) return null;
  return bar + Math.max(bar / 2, MINUTE);
}

/** Recompute patience, scaled to the timeframe and clamped to the bracket above. */
function calculationToleranceMs(interval) {
  const bar = intervalMs(interval);
  if (!bar) return MIN_CALC_TOLERANCE_MS;
  return Math.min(Math.max(bar / 4, MIN_CALC_TOLERANCE_MS), MAX_CALC_TOLERANCE_MS);
}

/**
 * Compact, human ages: "just now", "23m", "2h 13m", "3d 4h". Deliberately at
 * most two units — this sits inline on a dense card, not in a report.
 */
function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 0) return "just now";
  const totalMinutes = Math.floor(ms / MINUTE);
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * One engine's two clocks.
 *
 * An engine that failed and an engine that never reported a timestamp are
 * both UNKNOWN rather than FRESH: the whole point is to avoid reading absent
 * evidence as current evidence.
 */
function assessSource({ key, label, interval, candleCloseTime, computedAt, error } = {}, now = Date.now()) {
  const closedAt = toMillis(candleCloseTime);
  const calculatedAt = toMillis(computedAt);
  const candleAgeMs = closedAt == null ? null : now - closedAt;
  const calculationAgeMs = calculatedAt == null ? null : now - calculatedAt;

  const candleLimit = candleToleranceMs(interval);
  const calculationLimit = calculationToleranceMs(interval);
  const candleStale = candleAgeMs != null && candleLimit != null && candleAgeMs > candleLimit;
  const calculationStale = calculationAgeMs != null && calculationAgeMs > calculationLimit;

  let state = "FRESH";
  let reason = null;
  if (error) {
    state = "UNKNOWN";
    reason = `${label} is unavailable`;
  } else if (candleStale || calculationStale) {
    state = "STALE";
    reason = candleStale
      ? `${label} last saw a closed ${interval} candle ${formatAge(candleAgeMs)} ago`
      : `${label} was last calculated ${formatAge(calculationAgeMs)} ago`;
  } else if (closedAt == null && calculatedAt == null) {
    state = "UNKNOWN";
    reason = `${label} reports no data age`;
  }

  return {
    key: key || null,
    label,
    state,
    reason,
    candleCloseTime: closedAt,
    candleAgeMs,
    candleStale,
    computedAt: calculatedAt,
    calculationAgeMs,
    calculationStale,
  };
}

/**
 * Rolls the per-engine assessments into one line for the card.
 *
 * The roll-up is pessimistic on purpose — it reports the OLDEST candle and
 * the OLDEST calculation across the engines, and one stale engine makes the
 * card stale. A card is a single claim about a pair right now, and the reader
 * should see its weakest link rather than its strongest.
 */
function assessFreshness({ interval, sources = [] } = {}, now = Date.now()) {
  const assessed = sources.map((source) => assessSource({ ...source, interval }, now));
  const stale = assessed.filter((source) => source.state === "STALE");
  const known = assessed.filter((source) => source.state !== "UNKNOWN");

  let state = "FRESH";
  if (stale.length) state = "STALE";
  else if (!known.length) state = "UNKNOWN";

  const candleAges = assessed.map((s) => s.candleAgeMs).filter((age) => age != null);
  const calculationAges = assessed.map((s) => s.calculationAgeMs).filter((age) => age != null);
  const candleAgeMs = candleAges.length ? Math.max(...candleAges) : null;
  const calculationAgeMs = calculationAges.length ? Math.max(...calculationAges) : null;

  const parts = [];
  parts.push(candleAgeMs == null
    ? `${interval} candle age unknown`
    : `${interval} candle closed ${formatAge(candleAgeMs)} ago`);
  parts.push(calculationAgeMs == null
    ? "context calculation time unknown"
    : `context calculated ${formatAge(calculationAgeMs)} ago`);

  return {
    state,
    interval: interval || null,
    summary: parts.join(" · "),
    candleAgeMs,
    calculationAgeMs,
    // Named engines rather than a bare flag: "something is stale" sends a
    // reader hunting across three sections for which one it was.
    staleReasons: stale.map((source) => source.reason),
    sources: assessed,
  };
}

module.exports = {
  INTERVAL_MS,
  intervalMs,
  toMillis,
  formatAge,
  candleToleranceMs,
  calculationToleranceMs,
  assessSource,
  assessFreshness,
};
