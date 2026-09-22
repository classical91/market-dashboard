"use strict";

// Open Interest interpretation — pure functions only.
//
// Everything here reads numbers the service has already fetched and
// normalised. Nothing fetches, nothing caches, and nothing turns a reading
// into an instruction: a "Long buildup" is a description of how positions
// changed, not a signal to go long.
//
// The one rule every function in this file keeps: a missing number stays
// missing. A venue that did not report OI for a horizon produces null, never
// 0 — a 0% change is a claim that nothing happened, and absent evidence is
// not that claim.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// The horizons the page reads. `oiFlatPct` and `priceFlatPct` are the moves
// below which a change counts as noise on that horizon: 0.3% of OI in 15
// minutes is a real shift, 0.3% over a day is not.
const HORIZONS = Object.freeze([
  Object.freeze({ key: "15m", label: "15m", ms: 15 * MINUTE, oiFlatPct: 0.3, priceFlatPct: 0.15 }),
  Object.freeze({ key: "1h", label: "1H", ms: HOUR, oiFlatPct: 0.5, priceFlatPct: 0.3 }),
  Object.freeze({ key: "4h", label: "4H", ms: 4 * HOUR, oiFlatPct: 1, priceFlatPct: 0.6 }),
  Object.freeze({ key: "24h", label: "24H", ms: 24 * HOUR, oiFlatPct: 2, priceFlatPct: 1.2 }),
]);

const HORIZON_KEYS = HORIZONS.map((h) => h.key);

function horizonByKey(key) {
  return HORIZONS.find((h) => h.key === key) || null;
}

// The four fundamental Price x OI combinations, plus the two cases where OI
// moves but price does not, a quiet state and an explicit "we don't know".
// Tones are presentation hints only; none of them is a trade direction.
const OI_STATES = Object.freeze({
  LONG_BUILDUP: Object.freeze({
    label: "Long buildup",
    tone: "bull",
    meaning: "Price up, OI up — new positions entering with price: bullish participation",
  }),
  SHORT_BUILDUP: Object.freeze({
    label: "Short buildup",
    tone: "bear",
    meaning: "Price down, OI up — new positions entering against price: bearish participation",
  }),
  SHORT_COVERING: Object.freeze({
    label: "Short covering",
    tone: "cover",
    meaning: "Price up, OI down — shorts closing, leverage leaving the market",
  }),
  LONG_UNWIND: Object.freeze({
    label: "Long unwind",
    tone: "unwind",
    meaning: "Price down, OI down — longs closing or being liquidated",
  }),
  LEVERAGE_BUILDING: Object.freeze({
    label: "Leverage building",
    tone: "watch",
    meaning: "OI rising while price is flat — positions opening without a direction yet",
  }),
  LEVERAGE_LEAVING: Object.freeze({
    label: "Leverage leaving",
    tone: "quiet",
    meaning: "OI falling while price is flat — de-risking without a directional move",
  }),
  FLAT: Object.freeze({
    label: "Quiet",
    tone: "quiet",
    meaning: "No meaningful change in open interest on this horizon",
  }),
  UNKNOWN: Object.freeze({
    label: "Unavailable",
    tone: "none",
    meaning: "Price or open interest is missing for this horizon",
  }),
});

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Percent change from `then` to `now`; null unless both are usable. */
function pctChange(now, then) {
  if (!isNumber(now) || !isNumber(then) || then <= 0 || now < 0) return null;
  return ((now - then) / then) * 100;
}

/**
 * The Price x OI state for one horizon.
 *
 * OI decides first: if open interest did not move beyond the horizon's noise
 * floor, the price move — however large — says nothing about positioning,
 * and the state is FLAT. Only then does price decide which of the four the
 * move was.
 */
function classifyPriceOi(priceChangePct, oiChangePct, horizonKey = "1h") {
  if (!isNumber(priceChangePct) || !isNumber(oiChangePct)) return "UNKNOWN";
  const horizon = horizonByKey(horizonKey) || horizonByKey("1h");
  if (Math.abs(oiChangePct) < horizon.oiFlatPct) return "FLAT";
  const oiUp = oiChangePct > 0;
  if (Math.abs(priceChangePct) < horizon.priceFlatPct) {
    return oiUp ? "LEVERAGE_BUILDING" : "LEVERAGE_LEAVING";
  }
  const priceUp = priceChangePct > 0;
  if (priceUp && oiUp) return "LONG_BUILDUP";
  if (!priceUp && oiUp) return "SHORT_BUILDUP";
  if (priceUp && !oiUp) return "SHORT_COVERING";
  return "LONG_UNWIND";
}

function describeState(state) {
  return { state, ...(OI_STATES[state] || OI_STATES.UNKNOWN) };
}

/**
 * The OI value closest to `targetTime` without being newer than it, within
 * `toleranceMs`. Points must be sorted oldest first. Returns null when the
 * history does not reach back that far — a 24h change is never computed from
 * a 20h history.
 */
function valueAtOrBefore(points, targetTime, toleranceMs) {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point.t <= targetTime + toleranceMs / 2) {
      return targetTime - point.t <= toleranceMs ? point : null;
    }
  }
  return null;
}

/** Per-horizon OI change from a history of `{ t, oi }` points (oldest first). */
function oiChanges(points, resolutionMs) {
  const changes = {};
  for (const h of HORIZONS) changes[h.key] = null;
  const usable = (points || []).filter((p) => p && isNumber(p.t) && isNumber(p.oi) && p.oi > 0);
  if (usable.length < 2) return changes;
  const last = usable[usable.length - 1];
  for (const h of HORIZONS) {
    // A single-step horizon must use the previous step, never the same one.
    if (h.ms < resolutionMs) continue;
    const then = valueAtOrBefore(usable, last.t - h.ms, resolutionMs);
    if (then && then !== last) changes[h.key] = pctChange(last.oi, then.oi);
  }
  return changes;
}

/**
 * Per-horizon price change from candles (`{ openTime, closeTime, close }`,
 * oldest first). The reference price is the close of the last candle that
 * had closed by `now - horizon`.
 */
function priceChanges(candles, now = Date.now()) {
  const changes = {};
  for (const h of HORIZONS) changes[h.key] = null;
  const usable = (candles || []).filter((c) => c && isNumber(c.close) && c.close > 0 && isNumber(c.closeTime));
  if (usable.length < 2) return changes;
  const current = usable[usable.length - 1].close;
  for (const h of HORIZONS) {
    const target = now - h.ms;
    let ref = null;
    for (let i = usable.length - 1; i >= 0; i -= 1) {
      if (usable[i].closeTime <= target) {
        ref = usable[i];
        break;
      }
    }
    // A reference that closed long before the target is a gap in the feed,
    // not a baseline.
    if (ref && target - ref.closeTime <= Math.max(h.ms, HOUR)) {
      changes[h.key] = pctChange(current, ref.close);
    }
  }
  return changes;
}

/**
 * Is the latest 1h OI change unusual for this asset?
 *
 * Measured against the asset's own recent 1h changes rather than a fixed
 * cut-off, because a 3% hourly move is routine for a meme coin and
 * remarkable for BTC. Returns null when the history is too short to say.
 */
function detectSpike(points, resolutionMs, {
  windowMs = HOUR,
  minSamples = 24,
  zThreshold = 2.5,
  minAbsPct = 1,
} = {}) {
  const usable = (points || []).filter((p) => p && isNumber(p.oi) && p.oi > 0);
  const lag = Math.max(1, Math.round(windowMs / resolutionMs));
  if (usable.length < lag + minSamples + 1) return null;
  const changes = [];
  for (let i = lag; i < usable.length; i += 1) {
    changes.push(pctChange(usable[i].oi, usable[i - lag].oi));
  }
  const current = changes[changes.length - 1];
  // The baseline excludes the window the current change overlaps, so a
  // spike cannot dilute its own yardstick.
  const baseline = changes.slice(0, Math.max(0, changes.length - lag));
  if (baseline.length < minSamples || !isNumber(current)) return null;
  const mean = baseline.reduce((sum, v) => sum + v, 0) / baseline.length;
  const variance = baseline.reduce((sum, v) => sum + (v - mean) ** 2, 0) / baseline.length;
  const std = Math.sqrt(variance);
  const zScore = std > 0 ? (current - mean) / std : null;
  const isSpike = zScore != null && Math.abs(zScore) >= zThreshold && Math.abs(current) >= minAbsPct;
  return {
    isSpike,
    direction: isSpike ? (current > 0 ? "UP" : "DOWN") : null,
    changePct: round(current, 2),
    zScore: zScore == null ? null : round(zScore, 2),
    samples: baseline.length,
  };
}

function round(value, digits) {
  if (!isNumber(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Market-wide read across every row that has data.
 *
 * The aggregate change is weighted by each asset's current OI value and
 * computed from coin-denominated changes, so a price move alone does not
 * read as leverage entering. Coverage is always reported: "+2% across 18 of
 * 25 assets" is the honest number, and the page must never present a
 * partial sum as the whole market.
 */
function summarizeMarket(rows) {
  const withOi = rows.filter((row) => isNumber(row.oiUsd) && row.oiUsd > 0);
  const totalOiUsd = withOi.length ? withOi.reduce((sum, row) => sum + row.oiUsd, 0) : null;
  const horizons = {};
  for (const h of HORIZONS) {
    const sample = withOi.filter((row) => isNumber(row.oiChange && row.oiChange[h.key]));
    if (!sample.length) {
      horizons[h.key] = { changePct: null, breadthPct: null, rising: 0, falling: 0, covered: 0, state: "UNKNOWN" };
      continue;
    }
    let now = 0;
    let then = 0;
    let rising = 0;
    let falling = 0;
    for (const row of sample) {
      const change = row.oiChange[h.key];
      now += row.oiUsd;
      then += row.oiUsd / (1 + change / 100);
      if (change > 0) rising += 1;
      else if (change < 0) falling += 1;
    }
    const changePct = pctChange(now, then);
    const breadthPct = (rising / sample.length) * 100;
    let state = "MIXED";
    if (changePct >= h.oiFlatPct && breadthPct >= 60) state = "EXPANSION";
    else if (changePct <= -h.oiFlatPct && breadthPct <= 40) state = "CONTRACTION";
    horizons[h.key] = {
      changePct: round(changePct, 3),
      breadthPct: round(breadthPct, 1),
      rising,
      falling,
      covered: sample.length,
      state,
    };
  }
  return {
    totalOiUsd,
    assetsWithOi: withOi.length,
    assetsTracked: rows.length,
    horizons,
  };
}

// Local-extreme states that mean the move has begun to turn, not just that
// price is stretched.
const TURNING_STATES = new Set(["CONFIRMED", "CONFIRMING"]);

/**
 * Directional Bias + Local Extreme + OI, read together.
 *
 * `bias` and `extreme` are the projections the existing screeners already
 * serve (see services/screener-projections.js) — nothing is recomputed here.
 * Each note says what the combination means for positioning; none of them
 * is an entry.
 */
function confluenceNotes({ oiState, bias = null, extreme = null, spike = null }) {
  const notes = [];
  const add = (tone, text) => notes.push({ tone, text });
  const turning = extreme && TURNING_STATES.has(extreme.state) ? extreme.dominant : null;
  const stateWord = extreme && extreme.state ? extreme.state.toLowerCase() : "";

  if (turning === "top" && (oiState === "LONG_BUILDUP" || oiState === "LEVERAGE_BUILDING")) {
    add("warn", `Rising leverage near a ${stateWord} local top`);
  }
  if (turning === "bottom" && (oiState === "SHORT_BUILDUP" || oiState === "LEVERAGE_BUILDING")) {
    add("warn", `Shorts building near a ${stateWord} local bottom — squeeze risk`);
  }
  if (turning === "top" && oiState === "LONG_UNWIND") {
    add("info", `Longs unwinding off a ${stateWord} local top`);
  }
  if (turning === "bottom" && oiState === "SHORT_COVERING") {
    add("info", `Short covering off a ${stateWord} local bottom`);
  }

  if (bias === "BULLISH" && oiState === "LONG_BUILDUP") add("aligned", "New positioning agrees with the bullish bias");
  if (bias === "BEARISH" && oiState === "SHORT_BUILDUP") add("aligned", "New positioning agrees with the bearish bias");
  if (bias === "BEARISH" && oiState === "LONG_BUILDUP") add("caution", "Longs building against a bearish bias");
  if (bias === "BULLISH" && oiState === "SHORT_BUILDUP") add("caution", "Shorts building against a bullish bias");
  if (bias === "BULLISH" && oiState === "LONG_UNWIND") add("caution", "Longs unwinding under a bullish bias");
  if (bias === "BEARISH" && oiState === "SHORT_COVERING") {
    add("caution", "Rally is short covering, not new buying, against a bearish bias");
  }

  if (spike && spike.isSpike) {
    add("warn", `OI spike: 1h change ${spike.changePct > 0 ? "+" : ""}${spike.changePct}% (z ${spike.zScore})`);
  }
  return notes;
}

module.exports = {
  HORIZONS,
  HORIZON_KEYS,
  OI_STATES,
  horizonByKey,
  pctChange,
  classifyPriceOi,
  describeState,
  valueAtOrBefore,
  oiChanges,
  priceChanges,
  detectSpike,
  summarizeMarket,
  confluenceNotes,
  round,
};
