"use strict";

// Independent local-top / local-bottom scoring. This engine deliberately does
// not alter the Signal Screener's LONG / SHORT confluence score: directional
// trend and local exhaustion answer different trading questions.

const DEFAULT_OPTIONS = Object.freeze({
  bbLength: 20,
  bbStdDev: 2,
  rsiLength: 14,
  emaLength: 200,
  volumeLength: 20,
  volumeMultiplier: 1.5,
  pivotLeft: 2,
  pivotRight: 2,
  evidenceLookback: 6,
});

const WEIGHTS = Object.freeze({
  priceLocation: 15,
  momentum: 10,
  divergence: 20,
  liquidity: 20,
  volume: 15,
  confirmation: 20,
});

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average = mean(values)) {
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function emaSeries(values, length) {
  const output = new Array(values.length).fill(null);
  if (values.length < length) return output;
  let previous = mean(values.slice(0, length));
  output[length - 1] = previous;
  const multiplier = 2 / (length + 1);
  for (let index = length; index < values.length; index += 1) {
    previous = values[index] * multiplier + previous * (1 - multiplier);
    output[index] = previous;
  }
  return output;
}

function rsiSeries(closes, length) {
  const output = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return output;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= length;
  averageLoss /= length;
  output[length] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = length + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

function bollingerSeries(candles, length, deviations) {
  const output = new Array(candles.length).fill(null);
  const closes = candles.map((candle) => candle.close);
  for (let index = length - 1; index < candles.length; index += 1) {
    const window = closes.slice(index - length + 1, index + 1);
    const middle = mean(window);
    const deviation = standardDeviation(window, middle);
    output[index] = {
      middle,
      upper: middle + deviation * deviations,
      lower: middle - deviation * deviations,
      deviation,
      closeZScore: deviation > 0 ? (closes[index] - middle) / deviation : 0,
    };
  }
  return output;
}

function findSwings(candles, { left = 2, right = 2 } = {}) {
  const lows = [];
  const highs = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const neighbors = candles.slice(index - left, index).concat(candles.slice(index + 1, index + right + 1));
    const low = candles[index].low;
    const high = candles[index].high;
    if (neighbors.every((candle) => low <= candle.low) && neighbors.some((candle) => low < candle.low)) {
      lows.push({ index, price: low });
    }
    if (neighbors.every((candle) => high >= candle.high) && neighbors.some((candle) => high > candle.high)) {
      highs.push({ index, price: high });
    }
  }
  return { lows, highs };
}

function detectRegularDivergence(swings, rsiValues, side) {
  const candidates = side === "bottom" ? swings.lows : swings.highs;
  const valid = candidates.filter((swing) => Number.isFinite(rsiValues[swing.index]));
  if (valid.length < 2) return null;
  const previous = valid[valid.length - 2];
  const current = valid[valid.length - 1];
  const previousRsi = rsiValues[previous.index];
  const currentRsi = rsiValues[current.index];
  const detected = side === "bottom"
    ? current.price < previous.price && currentRsi > previousRsi
    : current.price > previous.price && currentRsi < previousRsi;
  if (!detected) return null;
  return {
    previous,
    current,
    previousRsi: Number(previousRsi.toFixed(1)),
    currentRsi: Number(currentRsi.toFixed(1)),
  };
}

function findLiquiditySweep(candles, swings, side, startIndex) {
  const candidates = side === "bottom" ? swings.lows : swings.highs;
  for (let index = candles.length - 1; index >= startIndex; index -= 1) {
    const prior = [...candidates].reverse().find((swing) => swing.index < index);
    if (!prior) continue;
    const candle = candles[index];
    const swept = side === "bottom"
      ? candle.low < prior.price && candle.close > prior.price
      : candle.high > prior.price && candle.close < prior.price;
    if (swept) return { index, level: prior.price, extreme: side === "bottom" ? candle.low : candle.high };
  }
  return null;
}

function findVolumeClimax(candles, length, multiplier, startIndex) {
  let strongest = null;
  for (let index = Math.max(length, startIndex); index < candles.length; index += 1) {
    const baseline = mean(candles.slice(index - length, index).map((candle) => candle.volume));
    if (!(baseline > 0)) continue;
    const ratio = candles[index].volume / baseline;
    if (ratio >= multiplier && (!strongest || ratio > strongest.ratio)) strongest = { index, ratio };
  }
  return strongest;
}

function findBandExcursion(candles, bands, side, startIndex) {
  let strongest = null;
  for (let index = startIndex; index < candles.length; index += 1) {
    const band = bands[index];
    if (!band) continue;
    const price = side === "bottom" ? candles[index].low : candles[index].high;
    const zScore = band.deviation > 0 ? (price - band.middle) / band.deviation : 0;
    const crossed = side === "bottom" ? price <= band.lower : price >= band.upper;
    if (!crossed) continue;
    if (!strongest || (side === "bottom" ? zScore < strongest.zScore : zScore > strongest.zScore)) {
      strongest = { index, zScore, boundary: side === "bottom" ? band.lower : band.upper };
    }
  }
  return strongest;
}

function detectConfirmation(candles, bands, swings, side, excursion, startIndex) {
  const lastIndex = candles.length - 1;
  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  const currentBand = bands[lastIndex];
  let bandReclaim = false;
  if (excursion && excursion.index < lastIndex && currentBand) {
    bandReclaim = side === "bottom" ? current.close > currentBand.lower : current.close < currentBand.upper;
  }

  const candidates = side === "bottom" ? swings.highs : swings.lows;
  const pivot = [...candidates].reverse().find((swing) => swing.index >= startIndex && swing.index < lastIndex);
  const structureBreak = Boolean(
    pivot && previous && (side === "bottom"
      ? current.close > pivot.price && previous.close <= pivot.price
      : current.close < pivot.price && previous.close >= pivot.price),
  );
  return { confirmed: bandReclaim || structureBreak, bandReclaim, structureBreak, level: pivot?.price ?? null };
}

function classifyExtremeState(score, confirmation) {
  if (score < 40) return "NONE";
  if (score < 60) return "WATCH";
  if (confirmation && score >= 85) return "CONFIRMED";
  if (confirmation) return "CONFIRMING";
  return "CANDIDATE";
}

function scoreTier(score) {
  if (score < 40) return "No extreme";
  if (score < 60) return "Watch";
  if (score < 75) return "Candidate";
  if (score < 85) return "Strong candidate";
  return "High-confluence extreme";
}

function buildSideScore(side, evidence) {
  const components = {
    priceLocation: Boolean(evidence.excursion),
    momentum: Boolean(evidence.momentum),
    divergence: Boolean(evidence.divergence),
    liquidity: Boolean(evidence.sweep),
    volume: Boolean(evidence.volumeClimax),
    confirmation: Boolean(evidence.confirmation.confirmed),
  };
  const score = Object.entries(components).reduce((total, [key, awarded]) => total + (awarded ? WEIGHTS[key] : 0), 0);
  const reasons = [];
  if (components.priceLocation) reasons.push({ key: "priceLocation", label: `${side === "bottom" ? "Lower" : "Upper"} BB excursion`, weight: WEIGHTS.priceLocation });
  if (components.momentum) reasons.push({ key: "momentum", label: `RSI ${side === "bottom" ? "oversold" : "overbought"}`, weight: WEIGHTS.momentum });
  if (components.divergence) reasons.push({ key: "divergence", label: `Regular ${side === "bottom" ? "bullish" : "bearish"} divergence`, weight: WEIGHTS.divergence });
  if (components.liquidity) reasons.push({ key: "liquidity", label: `${side === "bottom" ? "Swing low" : "Swing high"} swept`, weight: WEIGHTS.liquidity });
  if (components.volume) reasons.push({ key: "volume", label: `Volume climax ${evidence.volumeClimax.ratio.toFixed(1)}×`, weight: WEIGHTS.volume });
  if (components.confirmation) {
    const confirmationLabel = evidence.confirmation.structureBreak
      ? `${side === "bottom" ? "Bullish" : "Bearish"} structure break`
      : `${side === "bottom" ? "Lower" : "Upper"} BB reclaimed`;
    reasons.push({ key: "confirmation", label: confirmationLabel, weight: WEIGHTS.confirmation });
  }
  reasons.sort((a, b) => b.weight - a.weight);
  return {
    score,
    state: classifyExtremeState(score, components.confirmation),
    tier: scoreTier(score),
    confirmed: components.confirmation,
    reasons,
    components,
    metrics: {
      zScore: evidence.excursion ? Number(evidence.excursion.zScore.toFixed(2)) : null,
      rsi: evidence.momentum == null ? null : Number(evidence.momentum.toFixed(1)),
      volumeRatio: evidence.volumeClimax ? Number(evidence.volumeClimax.ratio.toFixed(2)) : null,
      sweptLevel: evidence.sweep?.level ?? null,
    },
  };
}

function calculateLocalExtremes(candles, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  if (!Array.isArray(candles) || candles.length < Math.max(settings.bbLength, settings.rsiLength + 1)) {
    return { error: "Not enough candle history for local-extreme scoring" };
  }
  const closes = candles.map((candle) => candle.close);
  const bands = bollingerSeries(candles, settings.bbLength, settings.bbStdDev);
  const rsiValues = rsiSeries(closes, settings.rsiLength);
  const emaValues = emaSeries(closes, settings.emaLength);
  const swings = findSwings(candles, { left: settings.pivotLeft, right: settings.pivotRight });
  const startIndex = Math.max(0, candles.length - settings.evidenceLookback);
  const recentRsi = rsiValues.slice(startIndex).filter(Number.isFinite);
  const volumeClimax = findVolumeClimax(candles, settings.volumeLength, settings.volumeMultiplier, startIndex);
  const bottomExcursion = findBandExcursion(candles, bands, "bottom", startIndex);
  const topExcursion = findBandExcursion(candles, bands, "top", startIndex);
  const recentDivergence = (side) => {
    const divergence = detectRegularDivergence(swings, rsiValues, side);
    return divergence && divergence.current.index >= startIndex - settings.pivotRight ? divergence : null;
  };
  const bottomEvidence = {
    excursion: bottomExcursion,
    momentum: recentRsi.length && Math.min(...recentRsi) <= 30 ? Math.min(...recentRsi) : null,
    divergence: recentDivergence("bottom"),
    sweep: findLiquiditySweep(candles, swings, "bottom", startIndex),
    volumeClimax,
    confirmation: detectConfirmation(candles, bands, swings, "bottom", bottomExcursion, startIndex),
  };
  const topEvidence = {
    excursion: topExcursion,
    momentum: recentRsi.length && Math.max(...recentRsi) >= 70 ? Math.max(...recentRsi) : null,
    divergence: recentDivergence("top"),
    sweep: findLiquiditySweep(candles, swings, "top", startIndex),
    volumeClimax,
    confirmation: detectConfirmation(candles, bands, swings, "top", topExcursion, startIndex),
  };
  const bottom = buildSideScore("bottom", bottomEvidence);
  const top = buildSideScore("top", topEvidence);
  const last = candles.length - 1;
  const ema200 = emaValues[last];
  const trend = ema200 == null ? "UNKNOWN" : closes[last] >= ema200 ? "UPTREND" : "DOWNTREND";
  let dominant = null;
  if (Math.max(bottom.score, top.score) >= 40) {
    if (bottom.score !== top.score) dominant = bottom.score > top.score ? "bottom" : "top";
    else dominant = (bottomExcursion?.index ?? -1) >= (topExcursion?.index ?? -1) ? "bottom" : "top";
  }
  const dominantResult = dominant ? (dominant === "bottom" ? bottom : top) : null;
  let setupType = "none";
  if (dominant === "bottom") setupType = trend === "UPTREND" ? "trend-pullback bottom" : "reversal bottom";
  if (dominant === "top") setupType = trend === "DOWNTREND" ? "trend-rally top" : "reversal top";

  return {
    bottom,
    top,
    dominant,
    state: dominantResult?.state ?? "NONE",
    mainReason: dominantResult?.reasons.slice(0, 2).map((reason) => reason.label).join(" + ") || null,
    context: {
      trend,
      priceAboveEma200: ema200 == null ? null : closes[last] >= ema200,
      ema200: ema200 == null ? null : Number(ema200.toFixed(8)),
      setupType,
    },
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  WEIGHTS,
  bollingerSeries,
  calculateLocalExtremes,
  classifyExtremeState,
  detectRegularDivergence,
  findLiquiditySweep,
  findSwings,
};
