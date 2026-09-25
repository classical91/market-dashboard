"use strict";

// Timeframe arithmetic shared by every RSI Matrix provider.
//
// Every provider hands the service the same candle shape —
//   { openTime, closeTime, open, high, low, close, volume }  oldest first
// — with closeTime following Binance's convention (openTime + interval - 1ms),
// so SignalScreenerService's dropUnclosedCandle() applies unchanged and the
// RSI engine never needs to know which venue a candle came from.
//
// Timeframe keys match signal-screener.js's INTERVAL_MAP ("1h", "4h", "1D",
// "1W") so a Binance request is a straight pass-through.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Display order of the matrix rows: slowest first, like the reference
// indicator.
const TIMEFRAMES = ["1W", "1D", "4h", "1h"];

const MINUTE_MS = 60 * 1000;

// The intraday keys serve the Market Matrix charts only; the RSI Matrix's own
// timeframe list is TIMEFRAMES above, which they are deliberately not in.
const TIMEFRAME_MS = {
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "30m": 30 * MINUTE_MS,
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
  "1D": DAY_MS,
  "1W": 7 * DAY_MS,
};

const TIMEFRAME_LABELS = { "1W": "1W", "1D": "1D", "4h": "4H", "1h": "1H" };

// Weekly bars open on Monday 00:00 UTC (TradingView's and Binance's
// convention). The Unix epoch was a Thursday; the first Monday after it is
// 1970-01-05, four days in.
const WEEK_ANCHOR_MS = 4 * DAY_MS;

function isTimeframe(tf) {
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, tf);
}

/** Start of the bar that contains `t` on timeframe `tf`, in UTC. */
function bucketStart(t, tf) {
  const ms = TIMEFRAME_MS[tf];
  const anchor = tf === "1W" ? WEEK_ANCHOR_MS : 0;
  return Math.floor((t - anchor) / ms) * ms + anchor;
}

function finite(value) {
  // Number(null) and Number("") are 0: a missing field must stay missing.
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Builds a candle from raw fields, or null when the close is unusable. A
 * candle without a close can't contribute to RSI; dropping it here keeps a
 * provider's half-populated row from becoming a zero.
 */
function makeCandle({ openTime, closeTime, open, high, low, close, volume }) {
  const c = finite(close);
  const t = finite(openTime);
  if (c == null || t == null) return null;
  return {
    openTime: t,
    closeTime: finite(closeTime) ?? t,
    open: finite(open) ?? c,
    high: finite(high) ?? c,
    low: finite(low) ?? c,
    close: c,
    volume: finite(volume) ?? 0,
  };
}

/** Sorted oldest-first with duplicate open times collapsed (last wins). */
function normalizeCandles(candles) {
  const byOpen = new Map();
  for (const candle of candles || []) {
    if (candle) byOpen.set(candle.openTime, candle);
  }
  return Array.from(byOpen.values()).sort((a, b) => a.openTime - b.openTime);
}

/**
 * Rolls finer candles up into `tf` bars on UTC boundaries — real candles,
 * regrouped, never interpolated. Used where a venue has no native bar for a
 * timeframe (Coinbase has no 4h or 1W; Yahoo has no 4h). A bucket whose end is
 * still in the future comes out with a future closeTime, so the ordinary
 * unclosed-candle rule drops it.
 */
function aggregateCandles(candles, tf) {
  const ms = TIMEFRAME_MS[tf];
  const buckets = new Map();
  for (const candle of normalizeCandles(candles)) {
    const start = bucketStart(candle.openTime, tf);
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, {
        openTime: start,
        closeTime: start + ms - 1,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
      continue;
    }
    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume += candle.volume;
  }
  return Array.from(buckets.values()).sort((a, b) => a.openTime - b.openTime);
}

/**
 * Candles from a series of point observations ({ t, value }) — the shape a
 * dominance or market-cap history has. The close of a bar is the last
 * observation inside it.
 */
function candlesFromPoints(points, tf) {
  const ms = TIMEFRAME_MS[tf];
  const buckets = new Map();
  const sorted = (points || [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);
  for (const point of sorted) {
    const start = bucketStart(point.t, tf);
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, {
        openTime: start,
        closeTime: start + ms - 1,
        open: point.value,
        high: point.value,
        low: point.value,
        close: point.value,
        volume: 0,
      });
      continue;
    }
    bucket.high = Math.max(bucket.high, point.value);
    bucket.low = Math.min(bucket.low, point.value);
    bucket.close = point.value;
  }
  return Array.from(buckets.values()).sort((a, b) => a.openTime - b.openTime);
}

/**
 * The longest run of consecutive bars ending at the newest one. For a series
 * this app samples itself, a missing bar is a period nobody observed; carrying
 * the previous close across it would invent a flat stretch that RSI reads as
 * real calm. So RSI only ever runs over an unbroken tail.
 */
function contiguousTail(candles, tf) {
  const ms = TIMEFRAME_MS[tf];
  if (!candles.length) return candles;
  let start = candles.length - 1;
  while (start > 0 && candles[start].openTime - candles[start - 1].openTime === ms) start -= 1;
  return candles.slice(start);
}

/**
 * How long a fetched series stays good. A closed-bar RSI can only change when
 * the next bar closes, so the cache lives until just after that close — 1H
 * refreshes hourly, 1W at most every few hours (capped so a feed that was
 * lagging at fetch time is re-read the same day, not next week).
 */
const TTL_CAP_MS = { "1h": HOUR_MS, "4h": 2 * HOUR_MS, "1D": 6 * HOUR_MS, "1W": 12 * HOUR_MS };
const CLOSE_GRACE_MS = 90 * 1000;
const MIN_TTL_MS = 60 * 1000;

function ttlUntilNextClose(tf, now = Date.now()) {
  const nextClose = bucketStart(now, tf) + TIMEFRAME_MS[tf];
  const ttl = nextClose - now + CLOSE_GRACE_MS;
  return Math.max(MIN_TTL_MS, Math.min(ttl, TTL_CAP_MS[tf]));
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  TIMEFRAMES,
  TIMEFRAME_MS,
  TIMEFRAME_LABELS,
  isTimeframe,
  bucketStart,
  makeCandle,
  normalizeCandles,
  aggregateCandles,
  candlesFromPoints,
  contiguousTail,
  ttlUntilNextClose,
};
