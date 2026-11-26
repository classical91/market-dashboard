"use strict";

// Deterministic SYNTHETIC candles for Gann tests. A seeded random walk with
// a slow sine swing so pivots and trends exist. Test-only: these are never
// served as market data.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticCandles({ count = 500, seed = 7, start = 100, barMs = 4 * 3600 * 1000, startTime = Date.UTC(2025, 0, 6) } = {}) {
  const rand = mulberry32(seed);
  const candles = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const drift = Math.sin(i / 25) * 0.004;
    const shock = (rand() - 0.5) * 0.02;
    const open = price;
    const close = Math.max(0.01, open * (1 + drift + shock));
    const high = Math.max(open, close) * (1 + rand() * 0.006);
    const low = Math.min(open, close) * (1 - rand() * 0.006);
    const openTime = startTime + i * barMs;
    candles.push({ openTime, closeTime: openTime + barMs - 1, open, high, low, close, volume: 1000 + Math.floor(rand() * 500) });
    price = close;
  }
  return candles;
}

module.exports = { syntheticCandles, mulberry32 };
