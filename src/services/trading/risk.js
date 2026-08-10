"use strict";

// Position sizing and stop/target levels, ported from TraderClaw's
// executor.py. This is the pure arithmetic half of the executor — deciding how
// big a trade is and where its stop and targets sit. Order placement lives
// behind the exchange adapter and is deliberately not part of this module, so
// the Trading Lab can size a trade without any live-order code in the path.

const { getTradingConfig } = require("./config");
const { round } = require("./round");

// ATR for sizing, falling back to a single configured fraction of price when
// the signal carries none. One fallback for the whole system — two different
// synthetic volatility assumptions would make paper results incomparable.
function resolveAtr(entryPrice, atr, config = getTradingConfig()) {
  const n = Number(atr);
  if (Number.isFinite(n) && n > 0) return n;
  return entryPrice * config.atrFallbackPct;
}

// ATR-based position sizing. Returns size in base-asset units.
function calculatePositionSize({ entryPrice, stopLoss, accountSize, riskPct, sizeMultiplier, minSize = 0.001 }) {
  if (!(entryPrice > 0) || !(sizeMultiplier > 0)) return 0;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!(stopDistance > 0)) return 0;
  const riskAmount = accountSize * riskPct * sizeMultiplier;
  return round(Math.max(riskAmount / stopDistance, minSize), 4);
}

// Stop loss and take profits from ATR. Default blueprint ratios: SL 1.5x ATR,
// TP1 at 1.5R, TP2 at 2.5R (all configurable).
function calculateLevels({ entryPrice, atr, direction, config = getTradingConfig(), precision = 1 }) {
  const slDistance = config.slAtrMultiple * resolveAtr(entryPrice, atr, config);
  const sign = direction === "LONG" ? 1 : -1;

  return {
    stopLoss: round(entryPrice - sign * slDistance, precision),
    tp1: round(entryPrice + sign * config.tp1RMultiple * slDistance, precision),
    tp2: round(entryPrice + sign * config.tp2RMultiple * slDistance, precision),
    slDistance: round(slDistance, precision),
  };
}

// Full sizing pass for one candidate trade: levels, size, and the dollar risk
// that the R-multiple will later be measured against.
function planTrade({ symbol, direction, entryPrice, atr, sizeMultiplier, config = getTradingConfig(), precision = 1 }) {
  if (!(entryPrice > 0)) {
    return { ok: false, reason: "Entry price must be positive" };
  }
  if (direction !== "LONG" && direction !== "SHORT") {
    return { ok: false, reason: `Direction must be LONG or SHORT, got ${direction}` };
  }
  if (!(sizeMultiplier > 0)) {
    return { ok: false, reason: "Size multiplier is zero — no trade" };
  }

  const levels = calculateLevels({ entryPrice, atr, direction, config, precision });
  const size = calculatePositionSize({
    entryPrice,
    stopLoss: levels.stopLoss,
    accountSize: config.accountSize,
    riskPct: config.maxRiskPerTrade,
    sizeMultiplier,
  });

  if (!(size > 0)) {
    return { ok: false, reason: "Calculated position size is zero" };
  }

  return {
    ok: true,
    symbol,
    direction,
    entryPrice,
    size,
    ...levels,
    // Risk is derived from the configured fraction rather than size ×
    // stop-distance so that the min-size floor above can never silently
    // inflate the R denominator on a tiny account.
    riskUsd: round(config.accountSize * config.maxRiskPerTrade * sizeMultiplier, 2),
    sizeMultiplier,
  };
}

module.exports = { resolveAtr, calculatePositionSize, calculateLevels, planTrade };
