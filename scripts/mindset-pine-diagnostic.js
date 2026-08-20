#!/usr/bin/env node
"use strict";

// Reproduce the recovered Pine wrapper over public Binance spot candles.
// Usage:
//   node scripts/mindset-pine-diagnostic.js BTCUSDT 15m 2021-01-01T00:00:00Z 2026-08-20T15:59:59.999Z

const { analyzeMindsetPineParity } = require("../src/services/trading/mindset-pine-diagnostic");

const INTERVAL_MS = Object.freeze({
  "1m": 60000,
  "3m": 180000,
  "5m": 300000,
  "15m": 900000,
  "30m": 1800000,
  "1h": 3600000,
  "4h": 14400000,
  "1d": 86400000,
});

function parseCandle(row) {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  };
}

async function fetchWindow(symbol, interval, startTime, endTime) {
  const query = new URLSearchParams({
    symbol,
    interval,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: "1000",
  });
  const response = await fetch(`https://data-api.binance.vision/api/v3/klines?${query}`);
  if (!response.ok) throw new Error(`Binance candles failed (${response.status})`);
  return (await response.json()).map(parseCandle);
}

async function fetchCandles(symbol, interval, startTime, endTime) {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Unsupported interval ${interval}`);
  const starts = [];
  for (let cursor = startTime; cursor <= endTime; cursor += intervalMs * 1000) starts.push(cursor);
  const candles = [];
  for (let offset = 0; offset < starts.length; offset += 10) {
    const batch = starts.slice(offset, offset + 10);
    const rows = await Promise.all(batch.map((start) => fetchWindow(
      symbol,
      interval,
      start,
      Math.min(endTime, start + intervalMs * 1000 - 1),
    )));
    candles.push(...rows.flat());
  }
  return candles
    .filter((candle) => candle.closeTime <= endTime)
    .sort((a, b) => a.openTime - b.openTime)
    .filter((candle, index, rows) => index === 0 || candle.openTime !== rows[index - 1].openTime);
}

async function main() {
  const symbol = String(process.argv[2] || "BTCUSDT").toUpperCase();
  const interval = process.argv[3] || "15m";
  const startTime = Date.parse(process.argv[4] || "2021-01-01T00:00:00Z");
  const endTime = Date.parse(process.argv[5] || "2026-08-20T15:59:59.999Z");
  if (![startTime, endTime].every(Number.isFinite) || endTime < startTime) throw new Error("Invalid date range");
  const candles = await fetchCandles(symbol, interval, startTime, endTime);
  const result = analyzeMindsetPineParity(candles);
  process.stdout.write(`${JSON.stringify({
    source: "Binance public spot klines",
    symbol,
    interval,
    from: candles[0]?.openTime ?? null,
    to: candles.at(-1)?.closeTime ?? null,
    bars: result.bars,
    settings: result.settings,
    counts: result.counts,
    diagnostics: result.diagnostics,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { fetchCandles, parseCandle };
