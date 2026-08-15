"use strict";

// The Market Regime Engine — one answer to "what environment are we in?",
// computed from candles and shared by everything that needs it.
//
// ── What this is for ────────────────────────────────────────────────────────
//
// The Trading Lab already had regime-shaped behaviour scattered through it:
// the checklist refuses counter-trend entries and blocks LOW_COMPRESSION,
// vwap_reversion_v1 stands down above ADX 22, the decision engine has its own
// "Choppy"/"Volatile" labels that trading-lab.js translates. Three vocabularies,
// three thresholds, no single place that answers the question and no way to ask
// "which strategy actually works HERE?".
//
// This module is that single place. It reads candles and returns a structured
// regime read: the label, how confident that label is, the measurements behind
// it, and what mode of trading the environment favours.
//
// ── What this is NOT (read before wiring it anywhere) ───────────────────────
//
// This engine does not decide anything. Nothing here gates a trade, sizes a
// position, or turns a strategy on or off. It is a MEASUREMENT, and it is
// deliberately kept out of the checklist's scoring path:
//
//   The checklist's `state.regime` still comes from the same EMA-cross trend
//   read it always did. Feeding these richer labels into it would change which
//   setups trade — ACCUMULATION and DISTRIBUTION are not TREND_DOWN, so the
//   counter-trend gate would stop firing on bars where it fires today — and
//   that is a change to SCORING_VERSION semantics, not an improvement to
//   reporting. Every stored experiment would become non-comparable with the
//   ones before it, in exchange for a hypothesis nobody has measured yet.
//
// So the order of operations is: measure first, tag trades with the regime they
// were opened in, build the strategy × regime evidence table, and only then —
// with numbers in hand — decide whether any of this should gate anything. See
// ./regime-router.js for the advisory layer and ./regime-metrics.js for the
// evidence.
//
// `toChecklistRegime()` exists for the day that changes: it maps this
// vocabulary down onto the five labels the checklist gate understands, so a
// future caller can feed the engine in without teaching the gate new words.
//
// ── Lookahead ───────────────────────────────────────────────────────────────
//
// Every series used here is a forward recurrence (Wilder ADX/ATR, EMA) or a
// backward-looking window, so the read at bar i depends on bars 0..i and
// nothing after. `classifyAt(bars, i)` and `classifyRegime(bars.slice(0, i+1))`
// return the same answer, and a test holds them to it. That equality is what
// makes it safe to precompute the series once and read index i inside a replay
// loop.

const { ema, adxSeries } = require("../signal-screener");
const { atrSeries } = require("./series");

/**
 * The regime vocabulary.
 *
 * The first five are the labels the checklist already reasoned over. The three
 * new ones are the concepts worth adding, and each earns its place by naming a
 * situation the old vocabulary got WRONG rather than merely un-named:
 *
 *   ACCUMULATION  A quiet range with real volume in it, sitting at the bottom
 *                 of its own structure and making higher lows. The old
 *                 vocabulary called this RANGE, which is true and useless —
 *                 it is the range that tends to resolve upward.
 *   DISTRIBUTION  The mirror: volume at the top of the structure, lower highs.
 *   TRANSITION    The market is between characters — trend strength has left
 *                 the range zone but has not established a trend. The old
 *                 vocabulary had no word for this, so these bars were forced
 *                 into RANGE or TREND and traded as though they were one.
 *                 This is the single most valuable addition, because a router
 *                 that has no way to say "I don't know" will flip strategies
 *                 back and forth precisely while the market is changing.
 *   UNKNOWN       Not enough data to have an opinion. Distinct from TRANSITION:
 *                 UNKNOWN is our ignorance, TRANSITION is the market's.
 */
const REGIMES = Object.freeze([
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "ACCUMULATION",
  "DISTRIBUTION",
  "VOLATILE_EXPANSION",
  "LOW_COMPRESSION",
  "TRANSITION",
  "UNKNOWN",
]);

// Regimes in which taking a new position is a coherent idea at all. TRANSITION
// and UNKNOWN are excluded by definition; VOLATILE_EXPANSION is excluded
// because size, not direction, is the problem there.
const TRADEABLE_REGIMES = Object.freeze([
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "ACCUMULATION",
  "DISTRIBUTION",
]);

const REGIME_DEFAULTS = Object.freeze({
  adxLen: 14,
  atrLen: 14,
  emaFastLen: 21,
  emaSlowLen: 55,
  // Windows for the "relative to its own recent past" measurements. Twenty bars
  // matches what the checklist's volatility and volume rules are written
  // against, so a reading here means the same thing there.
  atrAverageLookback: 20,
  volumeLookback: 20,
  structureLookback: 20,

  // ── Trend strength thresholds ────────────────────────────────────────────
  // The gap between adxRangeMax and adxTrendMin is not slack, it is the
  // TRANSITION zone, and it exists on purpose. A single threshold would force
  // every bar into "range" or "trend" and would flip on noise for any market
  // sitting near it — which is exactly the market that is changing character.
  adxRangeMax: 20,
  adxTrendMin: 25,
  // Where each label reaches full confidence.
  adxRangeStrong: 12,
  adxTrendStrong: 40,

  // ── Volatility thresholds, as a ratio of ATR to its own recent average ───
  expansionAtrRatio: 1.8,
  compressionAtrRatio: 0.7,

  // Volume that makes a quiet range look like someone is working in it.
  effortVolumeRatio: 1.2,
  // How close to the bottom (or top) of the structure price must sit before a
  // range is read as accumulation (or distribution), as a fraction of range.
  edgeFraction: 0.33,

  // Below this confidence the read is not actionable, whatever the label says.
  // Routing treats a low-confidence read exactly like TRANSITION — see
  // ./regime-router.js. This is the "don't force every candle into a strategy"
  // rule, expressed as a number.
  minConfidence: 55,
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// How far `value` has travelled from `lo` to `hi`, clamped. Used everywhere a
// margin becomes a confidence: a reading that just barely cleared its threshold
// scores near 0, one that cleared it decisively scores near 1.
function ramp(value, lo, hi) {
  if (!Number.isFinite(value) || lo === hi) return 0;
  return clamp01((value - lo) / (hi - lo));
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The warmup this engine needs before its answer means anything.
 *
 * ADX needs roughly three times its period to settle (Wilder smoothing is
 * seeded, then smoothed again for the ADX itself), and the slow EMA needs its
 * own span. Asking below this returns UNKNOWN rather than a confident number
 * computed from a half-warm indicator.
 */
function warmupFor(options = {}) {
  const o = { ...REGIME_DEFAULTS, ...options };
  return Math.max(
    o.adxLen * 3,
    o.emaSlowLen + 1,
    o.atrLen + o.atrAverageLookback,
    o.structureLookback + 1,
    o.volumeLookback + 1,
  );
}

/**
 * Every series the engine needs, computed once over the whole candle set.
 *
 * Each one is prefix-safe (see ./series), so reading index i here is identical
 * to recomputing that indicator from bars 0..i. Pass the result to classifyAt()
 * inside a replay loop to avoid recomputing ADX on every bar.
 */
function buildRegimeSeries(bars, options = {}) {
  const o = { ...REGIME_DEFAULTS, ...options };
  const closes = bars.map((b) => b.close);
  return {
    closes,
    adx: adxSeries(bars, o.adxLen),
    atr: atrSeries(bars, o.atrLen),
    emaFast: ema(closes, o.emaFastLen),
    emaSlow: ema(closes, o.emaSlowLen),
  };
}

// The price structure of the last `lookback` bars ending at `index`: how wide
// the range is in ATR terms, where price sits inside it, and whether its lows
// are rising or its highs falling.
//
// The halves comparison is what separates "a range" from "a range that is
// going somewhere". It is a deliberately crude read of a genuinely subtle idea
// — this is not Wyckoff analysis, it is a measurable proxy for one part of it,
// and it is named ACCUMULATION rather than something grander for that reason.
function structureAt(bars, index, lookback) {
  const start = Math.max(0, index - lookback + 1);
  const window = bars.slice(start, index + 1);
  if (window.length < 4) return null;

  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const width = high - low;

  const half = Math.floor(window.length / 2);
  const firstLow = Math.min(...lows.slice(0, half));
  const lastLow = Math.min(...lows.slice(half));
  const firstHigh = Math.max(...highs.slice(0, half));
  const lastHigh = Math.max(...highs.slice(half));

  return {
    high,
    low,
    width,
    // 0 = at the bottom of the range, 1 = at the top. A zero-width window has
    // no inside, so it reads as the middle rather than dividing by zero.
    position: width > 0 ? clamp01((bars[index].close - low) / width) : 0.5,
    higherLows: lastLow > firstLow,
    lowerHighs: lastHigh < firstHigh,
  };
}

function volatilityLabel(atrRatio, o) {
  if (atrRatio >= o.expansionAtrRatio) return "EXPANDING";
  if (atrRatio <= o.compressionAtrRatio) return "COMPRESSED";
  if (atrRatio >= 1.3) return "ELEVATED";
  return "NORMAL";
}

function volumeLabel(volumeRatio) {
  if (volumeRatio >= 1.5) return "ABOVE_AVERAGE";
  if (volumeRatio < 0.85) return "BELOW_AVERAGE";
  return "AVERAGE";
}

// What the environment favours, and how much risk it deserves. Advisory: this
// is the engine's opinion, not a permission.
const REGIME_POSTURE = Object.freeze({
  TREND_UP: { mode: "TREND_FOLLOWING", bias: "LONG", risk: "NORMAL", action: "TREND CONTINUATION" },
  TREND_DOWN: { mode: "TREND_FOLLOWING", bias: "SHORT", risk: "NORMAL", action: "TREND CONTINUATION" },
  RANGE: { mode: "MEAN_REVERSION", bias: "NEUTRAL", risk: "NORMAL", action: "WAIT / MEAN REVERSION" },
  ACCUMULATION: { mode: "MEAN_REVERSION", bias: "LONG", risk: "NORMAL", action: "ACCUMULATE / FADE LOWS" },
  DISTRIBUTION: { mode: "MEAN_REVERSION", bias: "SHORT", risk: "NORMAL", action: "DISTRIBUTE / FADE HIGHS" },
  // Not "trade the breakout" — nothing here knows which way it breaks. The
  // checklist already refuses entries in this regime outright.
  LOW_COMPRESSION: { mode: "BREAKOUT_PENDING", bias: "NEUTRAL", risk: "NONE", action: "NO TRADE — COILED" },
  VOLATILE_EXPANSION: { mode: "NONE", bias: "NEUTRAL", risk: "REDUCED", action: "REDUCE SIZE" },
  TRANSITION: { mode: "NONE", bias: "NEUTRAL", risk: "NONE", action: "NO TRADE — TRANSITION" },
  UNKNOWN: { mode: "NONE", bias: "NEUTRAL", risk: "NONE", action: "NO TRADE — INSUFFICIENT DATA" },
});

/**
 * Map this vocabulary onto the five labels the CHECKLIST gate understands.
 *
 * Nothing calls this in the scoring path today, and that is deliberate (see the
 * header). It exists so that when someone does wire the engine into the
 * checklist, the gate is handed a word it already knows rather than being
 * taught three new ones in the same change.
 *
 * The three new labels all map to RANGE, which is the honest reduction: they
 * are all non-directional environments, and RANGE is the checklist's word for
 * "no directional gate applies". Mapping TRANSITION to LOW_COMPRESSION to block
 * trading would be a policy decision smuggled in as a translation.
 */
function toChecklistRegime(regime) {
  switch (regime) {
    case "TREND_UP":
    case "TREND_DOWN":
    case "LOW_COMPRESSION":
    case "VOLATILE_EXPANSION":
      return regime;
    case "ACCUMULATION":
    case "DISTRIBUTION":
    case "RANGE":
    case "TRANSITION":
      return "RANGE";
    default:
      return "UNKNOWN";
  }
}

function unknownRead(reason, at = null, options = {}) {
  const posture = REGIME_POSTURE.UNKNOWN;
  return {
    regime: "UNKNOWN",
    confidence: 0,
    actionable: false,
    direction: "NEUTRAL",
    trend: "NEUTRAL",
    bias: posture.bias,
    preferredMode: posture.mode,
    riskPosture: posture.risk,
    action: posture.action,
    volatility: "UNKNOWN",
    volumeState: "UNKNOWN",
    structure: null,
    indicators: { adx: null, atr: null, atrRatio: null, volumeRatio: null, emaFast: null, emaSlow: null, emaSeparationAtr: null },
    reasons: [reason],
    checklistRegime: "UNKNOWN",
    at,
    options: { ...REGIME_DEFAULTS, ...options },
  };
}

/**
 * Classify the regime as of the close of `bars[index]`.
 *
 * The classification is a fixed cascade, and the ORDER is the design:
 *
 *   1. Volatility expansion outranks everything. A market moving twice its
 *      normal range is one fact about size that matters more than any fact
 *      about direction — a trend read taken during an expansion is a trend read
 *      about to be stopped out.
 *   2. Compression next, for the mirror reason.
 *   3. Then trend, if ADX has actually established one AND the moving averages
 *      agree on which way. Requiring both means a high ADX with no directional
 *      agreement falls through to TRANSITION instead of picking a side.
 *   4. Then the range family — plain RANGE, or accumulation/distribution when
 *      there is effort in it and price is working one edge of the structure.
 *   5. Anything left is TRANSITION: measurably neither, and said out loud.
 *
 * Confidence blends the MARGIN of the deciding test (how decisively the
 * threshold was cleared) with the agreement of the secondary evidence. A
 * reading that scraped past its threshold with nothing corroborating it scores
 * low on purpose — that is the number the router uses to refuse to act.
 */
function classifyAt(bars, index, { series = null, options = {} } = {}) {
  const o = { ...REGIME_DEFAULTS, ...options };
  const at = bars && bars[index] ? bars[index].closeTime ?? null : null;

  if (!Array.isArray(bars) || index < 0 || index >= bars.length) {
    return unknownRead("No candle at the requested index", null, o);
  }

  const needed = warmupFor(o);
  if (index + 1 < needed) {
    return unknownRead(
      `Need at least ${needed} closed candles for a regime read, have ${index + 1}`,
      at,
      o,
    );
  }

  const s = series || buildRegimeSeries(bars, o);
  const bar = bars[index];
  const adx = s.adx[index];
  const atrValue = s.atr[index];
  const emaFast = s.emaFast[index];
  const emaSlow = s.emaSlow[index];

  if (![adx, atrValue, emaFast, emaSlow].every((v) => v != null && Number.isFinite(v)) || !(atrValue > 0)) {
    return unknownRead("Indicators are not warmed up yet", at, o);
  }

  // ── Measurements ─────────────────────────────────────────────────────────
  // All windows look backward from `index`, so none of this can see the future.

  const atrHistory = [];
  for (let i = Math.max(o.atrLen + 1, index - o.atrAverageLookback + 1); i <= index; i += 1) {
    if (s.atr[i] != null) atrHistory.push(s.atr[i]);
  }
  const atrAverage = mean(atrHistory);
  const atrRatio = atrAverage > 0 ? atrValue / atrAverage : 1;

  let volumeSum = 0;
  let volumeCount = 0;
  for (let i = Math.max(0, index - o.volumeLookback + 1); i <= index; i += 1) {
    volumeSum += Number(bars[i].volume) || 0;
    volumeCount += 1;
  }
  const volumeAverage = volumeCount ? volumeSum / volumeCount : 0;
  const volumeRatio = volumeAverage > 0 ? (Number(bar.volume) || 0) / volumeAverage : 1;

  const structure = structureAt(bars, index, o.structureLookback);
  // EMA separation measured in ATR, not percent: a 1% gap means something
  // different on a quiet market than a violent one, and the whole point of a
  // regime read is to be comparable across both.
  const emaSeparationAtr = (emaFast - emaSlow) / atrValue;
  const direction = emaFast > emaSlow ? "UP" : emaFast < emaSlow ? "DOWN" : "NEUTRAL";
  const closeAgrees = direction === "UP" ? bar.close > emaSlow : direction === "DOWN" ? bar.close < emaSlow : false;

  const indicators = {
    adx: round(adx, 1),
    atr: round(atrValue, 6),
    atrRatio: round(atrRatio, 2),
    volumeRatio: round(volumeRatio, 2),
    emaFast: round(emaFast, 6),
    emaSlow: round(emaSlow, 6),
    emaSeparationAtr: round(emaSeparationAtr, 2),
  };

  const reasons = [];
  let regime;
  let primary; // margin of the deciding test, 0..1
  let support; // agreement of the corroborating evidence, 0..1

  // ── 1. Volatility expansion ──────────────────────────────────────────────
  if (atrRatio >= o.expansionAtrRatio) {
    regime = "VOLATILE_EXPANSION";
    primary = ramp(atrRatio, o.expansionAtrRatio, o.expansionAtrRatio * 1.6);
    support = clamp01(ramp(volumeRatio, 1, 2));
    reasons.push(`ATR ${atrRatio.toFixed(2)}× its own average — volatility expansion`);
    if (volumeRatio >= 1.5) reasons.push(`Volume ${volumeRatio.toFixed(2)}× average confirms the expansion`);

  // ── 2. Compression ───────────────────────────────────────────────────────
  } else if (atrRatio <= o.compressionAtrRatio && adx < o.adxRangeMax) {
    regime = "LOW_COMPRESSION";
    primary = ramp(o.compressionAtrRatio - atrRatio, 0, o.compressionAtrRatio * 0.5);
    support = clamp01(
      (ramp(o.adxRangeMax - adx, 0, o.adxRangeMax - o.adxRangeStrong) + ramp(1 - volumeRatio, 0, 0.4)) / 2,
    );
    reasons.push(`ATR ${atrRatio.toFixed(2)}× average with ADX ${adx.toFixed(1)} — coiled, no trend`);

  // ── 3. Trend ─────────────────────────────────────────────────────────────
  } else if (adx >= o.adxTrendMin && direction !== "NEUTRAL") {
    regime = direction === "UP" ? "TREND_UP" : "TREND_DOWN";
    primary = ramp(adx, o.adxTrendMin, o.adxTrendStrong);
    // Three corroborations, each worth a third: the moving averages separated
    // rather than merely crossed, the close on the correct side of the slow
    // average, and volatility not already blown out.
    support = clamp01(
      (ramp(Math.abs(emaSeparationAtr), 0, 1.5) + (closeAgrees ? 1 : 0) + (atrRatio <= 1.3 ? 1 : 0.5)) / 3,
    );
    reasons.push(`ADX ${adx.toFixed(1)} — trend established`);
    reasons.push(
      `EMA${o.emaFastLen} ${direction === "UP" ? "above" : "below"} EMA${o.emaSlowLen} by ${Math.abs(emaSeparationAtr).toFixed(2)}× ATR`,
    );
    if (!closeAgrees) {
      reasons.push(`Close is on the wrong side of EMA${o.emaSlowLen} — trend is established but stretched`);
    }

  // ── 4. The range family ──────────────────────────────────────────────────
  } else if (adx < o.adxRangeMax) {
    const rangeMargin = ramp(o.adxRangeMax - adx, 0, o.adxRangeMax - o.adxRangeStrong);
    const effort = volumeRatio >= o.effortVolumeRatio;
    const atLow = structure && structure.position <= o.edgeFraction;
    const atHigh = structure && structure.position >= 1 - o.edgeFraction;

    if (effort && atLow && structure.higherLows) {
      regime = "ACCUMULATION";
      primary = rangeMargin;
      support = clamp01((ramp(volumeRatio, o.effortVolumeRatio, 2) + ramp(o.edgeFraction - structure.position, 0, o.edgeFraction)) / 2);
      reasons.push(`ADX ${adx.toFixed(1)} — no trend`);
      reasons.push(
        `Price in the bottom ${Math.round(structure.position * 100)}% of a ${o.structureLookback}-bar range on ${volumeRatio.toFixed(2)}× volume, with higher lows`,
      );
    } else if (effort && atHigh && structure.lowerHighs) {
      regime = "DISTRIBUTION";
      primary = rangeMargin;
      support = clamp01((ramp(volumeRatio, o.effortVolumeRatio, 2) + ramp(structure.position - (1 - o.edgeFraction), 0, o.edgeFraction)) / 2);
      reasons.push(`ADX ${adx.toFixed(1)} — no trend`);
      reasons.push(
        `Price in the top ${Math.round((1 - structure.position) * 100)}% of a ${o.structureLookback}-bar range on ${volumeRatio.toFixed(2)}× volume, with lower highs`,
      );
    } else {
      regime = "RANGE";
      primary = rangeMargin;
      // A range is most convincingly a range when price is in the MIDDLE of it
      // and volatility is unremarkable — both of which are the absence of the
      // things that would make it something else.
      const middleness = structure ? 1 - Math.abs(structure.position - 0.5) * 2 : 0.5;
      support = clamp01((middleness + (atrRatio <= 1.2 ? 1 : 0.5)) / 2);
      reasons.push(`ADX ${adx.toFixed(1)} — no trend, price is ranging`);
    }

  // ── 5. Neither ───────────────────────────────────────────────────────────
  } else {
    regime = "TRANSITION";
    // Confidence PEAKS in the middle of the gap. Dead centre between "no trend"
    // and "established trend" is the least ambiguous transition there is — we
    // are confident it is neither. Near either edge the read is genuinely
    // marginal and scores accordingly.
    const through = ramp(adx, o.adxRangeMax, o.adxTrendMin);
    primary = 1 - Math.abs(through * 2 - 1);
    support = direction === "NEUTRAL" ? 1 : clamp01(1 - ramp(Math.abs(emaSeparationAtr), 0, 1.5));
    reasons.push(
      `ADX ${adx.toFixed(1)} sits between the range ceiling (${o.adxRangeMax}) and the trend floor (${o.adxTrendMin}) — the market is changing character`,
    );
    if (adx >= o.adxTrendMin && direction === "NEUTRAL") {
      reasons.push("Trend strength without directional agreement — no side to take");
    }
  }

  // The deciding margin carries most of the weight; corroboration adjusts it.
  const confidence = Math.round(100 * clamp01(0.65 * primary + 0.35 * support));
  const posture = REGIME_POSTURE[regime];
  const actionable = TRADEABLE_REGIMES.includes(regime) && confidence >= o.minConfidence;

  if (!actionable && TRADEABLE_REGIMES.includes(regime)) {
    reasons.push(
      `Confidence ${confidence}% is under the ${o.minConfidence}% floor — the label stands but is not strong enough to act on`,
    );
  }

  return {
    regime,
    confidence,
    // Whether anything downstream should route on this read. False for
    // TRANSITION and UNKNOWN by definition, false for VOLATILE_EXPANSION and
    // LOW_COMPRESSION because those are size problems rather than direction
    // problems, and false for any read under the confidence floor.
    actionable,
    // The raw EMA ordering. Kept because it is a measurement and callers may
    // want it, but see `trend` before displaying it as one.
    direction,
    /**
     * The TREND, which is not the same thing as the EMA ordering.
     *
     * In a range the fast EMA still sits on one side of the slow one — it has
     * to sit somewhere — and reporting that as "Direction: DOWN" beside a RANGE
     * label states a trend the engine has just finished measuring the absence
     * of. ADX below the range ceiling IS the finding that the ordering is
     * noise, so outside a trend regime this reads NEUTRAL.
     */
    trend: regime === "TREND_UP" ? "UP" : regime === "TREND_DOWN" ? "DOWN" : "NEUTRAL",
    bias: posture.bias,
    preferredMode: posture.mode,
    riskPosture: posture.risk,
    action: posture.action,
    volatility: volatilityLabel(atrRatio, o),
    volumeState: volumeLabel(volumeRatio),
    structure: structure
      ? {
          high: round(structure.high, 6),
          low: round(structure.low, 6),
          widthAtr: round(structure.width / atrValue, 2),
          position: round(structure.position, 2),
          higherLows: structure.higherLows,
          lowerHighs: structure.lowerHighs,
          label: structure.higherLows && !structure.lowerHighs
            ? "HIGHER_LOWS"
            : structure.lowerHighs && !structure.higherLows
              ? "LOWER_HIGHS"
              : "SIDEWAYS",
        }
      : null,
    indicators,
    reasons,
    // The label the checklist gate would understand, for the day someone wires
    // this in. Nothing reads it in the scoring path today.
    checklistRegime: toChecklistRegime(regime),
    at,
    options: o,
  };
}

// The regime as of the last closed candle — the question the dashboard asks.
function classifyRegime(bars, options = {}) {
  if (!Array.isArray(bars) || !bars.length) {
    return unknownRead("No candles supplied", null, options);
  }
  return classifyAt(bars, bars.length - 1, { options });
}

module.exports = {
  REGIMES,
  TRADEABLE_REGIMES,
  REGIME_DEFAULTS,
  REGIME_POSTURE,
  classifyRegime,
  classifyAt,
  buildRegimeSeries,
  toChecklistRegime,
  warmupFor,
};
