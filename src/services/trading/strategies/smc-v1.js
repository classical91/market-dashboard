"use strict";

// smc_v1 — a conservative, mechanical approximation of Smart Money Concepts.
//
// Read the name honestly: this is NOT "SMC done properly". Discretionary SMC
// traders read liquidity, sessions, inducement and intent; none of that is in
// here. What this file does is take the four ideas that CAN be written as
// rules a backtester can replay without lookahead, and require all four to
// agree before it will signal:
//
//   1. Trend alignment. Genuine higher-timeframe context when the caller
//      supplies `context.htfTrendUp`, otherwise an EMA21/EMA50 read of the
//      chart being traded. Longs only in an up trend, shorts only in a down
//      trend — no counter-trend fades.
//   2. Market structure. Swing highs and lows from confirmed fractals, and a
//      break of structure: a close beyond the most recent confirmed swing.
//   3. Displacement. The break has to be delivered by a candle with real range
//      relative to ATR, and it has to leave a fair value gap — a three-bar
//      imbalance where the move was fast enough to skip price.
//   4. Retest. The entry is a pullback INTO that gap, not the break itself.
//      Chasing the displacement candle is the single most common way an SMC
//      backtest flatters itself.
//
// Anything short of all four returns FLAT with the reason it fell short, so
// the UI can explain a quiet strategy instead of just showing nothing. Every
// value the decision rests on is reported in `indicators`.

const { ema } = require("../../signal-screener");
const { atr } = require("../../decision-engine");

const SMC_V1_DEFAULTS = {
  // Fractal wings: a swing high needs `swingWing` lower highs on each side.
  // Two is the smallest number that is not just "the previous bar".
  swingWing: 2,
  // How far back a broken swing may sit, and how stale a break or a gap may
  // be before the setup is considered spent rather than fresh.
  structureLookback: 40,
  bosMaxAge: 12,
  fvgMaxAge: 12,
  trendFast: 21,
  trendSlow: 50,
  atrLen: 14,
  // The displacement candle's range must be at least this multiple of ATR.
  displacementAtr: 1.2,
  // Stop sits this far beyond the far side of the gap, in ATR.
  stopBufferAtr: 0.25,
  // Fallback reward multiple when no structural target is available.
  fallbackRewardR: 2,
};

// The slowest input is the 50-period EMA, but structure needs a lot more
// history than an indicator does: 40 bars of lookback for the broken swing
// plus room for the swings themselves to form.
const REQUIRED_WARMUP_BARS = 120;

function flat(reasons, indicators = {}, error = null, price = null) {
  return {
    signal: "FLAT",
    strategy: "smc_v1",
    price,
    error,
    reasons,
    indicators,
    confidence: null,
    stopHint: null,
    targetHint: null,
  };
}

// Confirmed fractal pivots. A pivot is only reported once `wing` bars have
// closed on BOTH sides of it — an unconfirmed pivot at the right-hand edge is
// exactly the lookahead this strategy must not have.
function findSwings(bars, wing) {
  const highs = [];
  const lows = [];
  for (let i = wing; i < bars.length - wing; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high });
    if (isLow) lows.push({ index: i, price: bars[i].low });
  }
  return { highs, lows };
}

// The most recent confirmed swing that a later candle CLOSED beyond. Closing
// beyond is the whole point: a wick through a level is liquidity being taken,
// not structure being broken.
function findBreak(bars, swings, direction, options) {
  const last = bars.length - 1;
  const oldest = last - options.structureLookback;

  for (let s = swings.length - 1; s >= 0; s -= 1) {
    const swing = swings[s];
    if (swing.index < oldest) break;
    const from = swing.index + options.swingWing + 1;
    for (let j = from; j <= last; j += 1) {
      const broken = direction === "LONG" ? bars[j].close > swing.price : bars[j].close < swing.price;
      if (broken) return { level: swing.price, swingIndex: swing.index, breakIndex: j };
    }
  }
  return null;
}

// A three-bar imbalance: bar k-1 and bar k+1 do not overlap, so bar k moved
// fast enough to leave a gap in traded price. The gap is the zone price is
// expected to come back and rebalance, which is where this strategy enters.
function findFvg(bars, direction, fromIndex, options, atrValue) {
  const last = bars.length - 1;
  const start = Math.max(1, fromIndex - 1);

  // Scanning from last - 2, not last - 1: the gap's third candle must have
  // closed BEFORE the bar being decided. Otherwise the decided bar is both
  // the edge of the gap and the thing testing it, and every displacement
  // trivially reads as its own retest.
  for (let k = last - 2; k >= start; k -= 1) {
    if (k - 1 < 0 || k + 1 >= last) continue;
    if (last - k > options.fvgMaxAge) break;

    const range = bars[k].high - bars[k].low;
    const displaced = atrValue > 0 && range >= options.displacementAtr * atrValue;

    if (direction === "LONG" && bars[k + 1].low > bars[k - 1].high) {
      return { bottom: bars[k - 1].high, top: bars[k + 1].low, index: k, range, displaced };
    }
    if (direction === "SHORT" && bars[k + 1].high < bars[k - 1].low) {
      return { bottom: bars[k + 1].high, top: bars[k - 1].low, index: k, range, displaced };
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const smcV1 = {
  id: "smc_v1",
  name: "SMC v1",
  version: "1.0.0",
  // Backtest-only, deliberately. It has never run forward on a single live
  // candle, so anything above `backtest` would be a claim the evidence does
  // not support — and `backtest` is not a scanner-eligible status, so the live
  // scanner will refuse to start it even if someone sets
  // LIVE_SCANNER_STRATEGY=smc_v1.
  status: "backtest",
  supportsBacktest: true,
  supportsLiveScanner: false,
  supportsLiveResearch: true,
  description:
    "Conservative Smart Money Concepts approximation: higher-timeframe (or EMA) trend, break of structure on a confirmed swing, a displacement candle leaving a fair value gap, entered on the retest of that gap. Backtest only.",
  requiredWarmupBars: REQUIRED_WARMUP_BARS,

  describeRules() {
    return {
      purpose: "Mechanical market-structure continuation research",
      looksFor: "Trend alignment, a confirmed break of structure, displacement with a fair value gap, then a retest",
      longEntry: "Bullish trend plus bullish BOS and displaced FVG retest",
      shortEntry: "Bearish trend plus bearish BOS and displaced FVG retest",
      trendFilter: `EMA${SMC_V1_DEFAULTS.trendFast}/EMA${SMC_V1_DEFAULTS.trendSlow}, unless genuine higher-timeframe context is supplied`,
      stop: `${SMC_V1_DEFAULTS.stopBufferAtr} ATR beyond the far side of the retested gap`,
      target: `Next opposing structure, otherwise ${SMC_V1_DEFAULTS.fallbackRewardR}R`,
      positionSizing: "Trading Lab checklist, edge gate and account-local risk limits",
    };
  },

  evaluate(candles, index, context = {}) {
    const options = { ...SMC_V1_DEFAULTS, ...(context.options || {}) };
    const bars = candles.slice(0, index + 1);

    if (bars.length < REQUIRED_WARMUP_BARS) {
      return flat(
        [],
        {},
        `Need at least ${REQUIRED_WARMUP_BARS} closed candles, have ${bars.length}`,
        bars.length ? bars[bars.length - 1].close : null,
      );
    }

    const last = bars.length - 1;
    const bar = bars[last];
    const price = bar.close;
    const closes = bars.map((b) => b.close);

    const emaFast = ema(closes, options.trendFast)[last];
    const emaSlow = ema(closes, options.trendSlow)[last];
    const atrValue = atr(bars, options.atrLen);

    if (![emaFast, emaSlow, atrValue].every((v) => v != null && Number.isFinite(v)) || !(atrValue > 0)) {
      return flat([], {}, "Indicators not warmed up yet", price);
    }

    // Higher-timeframe context wins when the caller has one; the EMA read is
    // the fallback, not the preference. Which one was used is reported, so a
    // result is never ambiguous about what trend it traded with.
    //
    // The field is `htfTrendUp`, and ONLY `htfTrendUp`. It used to read
    // `context.trendUp`, which the candle backtester filled in from an EMA
    // read of the very timeframe being tested — so "higher-timeframe context"
    // was the same chart under another name, the trend source reported
    // "context" when there was none, and the confidence bonus below was paid
    // for information the strategy already had. A caller with genuine
    // higher-timeframe data supplies `htfTrendUp` and gets the old behaviour;
    // a caller without it now correctly falls through to the EMA read.
    const htfTrendUp =
      context.htfTrendUp === true ? true : context.htfTrendUp === false ? false : null;
    const trendSource = htfTrendUp === null ? "ema" : "htf";
    const trendUp = htfTrendUp === null ? emaFast > emaSlow : htfTrendUp;
    const trend = emaFast === emaSlow && htfTrendUp === null ? "FLAT" : trendUp ? "UP" : "DOWN";

    const indicators = {
      emaFast,
      emaSlow,
      atr: atrValue,
      trend,
      trendSource,
      bosLevel: null,
      bosAge: null,
      fvgTop: null,
      fvgBottom: null,
      fvgAge: null,
      displacement: null,
      retested: false,
    };

    const reasons = [
      `Trend ${trend} from ${trendSource === "htf" ? "higher-timeframe context" : `EMA${options.trendFast}/EMA${options.trendSlow} on the traded timeframe`}` +
        ` (EMA${options.trendFast} ${emaFast.toFixed(2)} vs EMA${options.trendSlow} ${emaSlow.toFixed(2)})`,
    ];

    if (trend === "FLAT") {
      reasons.push("No directional trend — structure trades need a side to be on");
      return flat(reasons, indicators, null, price);
    }

    const direction = trend === "UP" ? "LONG" : "SHORT";
    const { highs, lows } = findSwings(bars, options.swingWing);
    const swings = direction === "LONG" ? highs : lows;

    if (!swings.length) {
      reasons.push("No confirmed swing points in range — structure is unreadable");
      return flat(reasons, indicators, null, price);
    }

    const bos = findBreak(bars, swings, direction, options);
    if (!bos) {
      reasons.push(
        `No ${direction === "LONG" ? "bullish" : "bearish"} break of structure in the last ${options.structureLookback} bars`,
      );
      return flat(reasons, indicators, null, price);
    }

    const bosAge = last - bos.breakIndex;
    indicators.bosLevel = bos.level;
    indicators.bosAge = bosAge;
    reasons.push(
      `${direction === "LONG" ? "Bullish" : "Bearish"} BOS: close beyond swing ${bos.level.toFixed(2)} ${bosAge} bar(s) ago`,
    );

    if (bosAge > options.bosMaxAge) {
      reasons.push(`BOS is ${bosAge} bars old (max ${options.bosMaxAge}) — the move is no longer fresh`);
      return flat(reasons, indicators, null, price);
    }

    const fvg = findFvg(bars, direction, bos.breakIndex, options, atrValue);
    if (!fvg) {
      reasons.push("No fair value gap left behind the break — the move was not a displacement");
      return flat(reasons, indicators, null, price);
    }

    const fvgAge = last - fvg.index;
    indicators.fvgTop = fvg.top;
    indicators.fvgBottom = fvg.bottom;
    indicators.fvgAge = fvgAge;
    indicators.displacement = fvg.displaced;
    reasons.push(
      `Fair value gap ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} from a ${fvg.range.toFixed(2)} range candle ${fvgAge} bar(s) ago`,
    );

    if (!fvg.displaced) {
      reasons.push(
        `Gap candle range ${fvg.range.toFixed(2)} is under ${options.displacementAtr}× ATR ${atrValue.toFixed(2)} — imbalance without displacement`,
      );
      return flat(reasons, indicators, null, price);
    }

    // The retest. Price must have traded back INTO the gap on this bar and
    // still closed on the right side of it: a wick into the zone that closes
    // through it is the zone failing, not holding.
    const retested =
      direction === "LONG"
        ? bar.low <= fvg.top && price > fvg.bottom
        : bar.high >= fvg.bottom && price < fvg.top;
    indicators.retested = retested;

    if (!retested) {
      reasons.push(
        direction === "LONG"
          ? `No pullback into the gap yet (bar low ${bar.low.toFixed(2)} vs gap top ${fvg.top.toFixed(2)}) — waiting rather than chasing`
          : `No pullback into the gap yet (bar high ${bar.high.toFixed(2)} vs gap bottom ${fvg.bottom.toFixed(2)}) — waiting rather than chasing`,
      );
      return flat(reasons, indicators, null, price);
    }

    reasons.push("Price retested the gap and closed back on the trend side — entry");

    // Structural stop: the far side of the gap plus an ATR buffer, so a normal
    // wick through the zone does not take the trade out.
    const buffer = options.stopBufferAtr * atrValue;
    const stopHint =
      direction === "LONG"
        ? Math.min(fvg.bottom, bar.low) - buffer
        : Math.max(fvg.top, bar.high) + buffer;

    // Target the next opposing structure if there is one beyond the entry;
    // otherwise a plain reward multiple of the structural risk.
    const opposing = direction === "LONG" ? highs : lows;
    const structural = opposing
      .filter((s) => (direction === "LONG" ? s.price > price : s.price < price))
      .slice(-1)[0];
    const risk = Math.abs(price - stopHint);
    const targetHint = structural
      ? structural.price
      : direction === "LONG"
        ? price + options.fallbackRewardR * risk
        : price - options.fallbackRewardR * risk;

    // A rough, explicitly-not-authoritative score. The Trading Lab checklist
    // is what actually sizes the trade; this only ranks smc_v1's own setups
    // against each other by how clean the structure was.
    let confidence = 50;
    // Paid for GENUINE higher-timeframe agreement only. A same-timeframe EMA
    // read is not extra information about the trade, so it earns nothing.
    if (trendSource === "htf") confidence += 10;
    if (bosAge <= 5) confidence += 10;
    if (fvgAge <= 5) confidence += 10;
    if (atrValue > 0 && fvg.range >= 2 * options.displacementAtr * atrValue) confidence += 10;

    return {
      signal: direction,
      strategy: "smc_v1",
      price,
      error: null,
      reasons,
      indicators,
      confidence: clamp(confidence, 0, 100),
      stopHint,
      targetHint,
    };
  },
};

module.exports = { smcV1, SMC_V1_DEFAULTS, findSwings, findBreak, findFvg, REQUIRED_WARMUP_BARS };
