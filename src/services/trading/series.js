"use strict";

// Prefix-safe indicator series shared by the backtester and the regime engine.
//
// "Prefix-safe" is the whole contract and it is worth stating precisely:
//
//   out[i] === (the same indicator recomputed from bars.slice(0, i + 1))
//
// Every series here is a forward recurrence seeded from a fixed-length prefix,
// so no future bar can enter an earlier value. That equality is what lets a
// caller compute the series ONCE over the whole candle set and read index i
// inside a replay loop without reintroducing lookahead — the alternative,
// recomputing from a fresh prefix on every bar, is the same numbers and
// quadratic work.
//
// This module exists so the regime engine can use the same ATR the backtester
// uses without requiring backtest.js, which requires the regime engine.

// Wilder ATR as a series. `out[i]` is exactly what `atr(bars.slice(0, i + 1),
// length)` returns, to the last bit — the seeding sum is accumulated in the
// same order so even the floating-point result matches.
function atrSeries(bars, length = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < length + 1) return out;

  // trs[j] is the true range of bar j + 1, matching atr()'s own indexing.
  const trs = new Array(bars.length - 1);
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    trs[i - 1] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
  }

  let value = 0;
  for (let i = 0; i < length; i += 1) value += trs[i];
  value /= length;
  out[length] = value;

  for (let i = length; i < trs.length; i += 1) {
    value = (value * (length - 1) + trs[i]) / length;
    out[i + 1] = value;
  }
  return out;
}

module.exports = { atrSeries };
