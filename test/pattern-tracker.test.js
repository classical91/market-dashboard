"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PatternTrackerService } = require("../src/services/pattern-tracker");

function makeTracker(fetchPrice) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-tracker-"));
  return new PatternTrackerService({ dataDir, fetchPrice: fetchPrice || (async () => 100) });
}

test("log records a pending entry with a resolveAt horizon derived from interval", () => {
  const tracker = makeTracker();
  const entry = tracker.log({
    symbol: "BTCUSDT",
    interval: "4h",
    kind: "pattern",
    name: "Falling Wedge",
    bias: "bullish",
    entryPrice: 100,
    detectedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(entry.status, "pending");
  assert.equal(entry.entryPrice, 100);
  // 4h horizon is 4 days.
  assert.equal(entry.resolveAt, "2026-01-05T00:00:00.000Z");
  assert.equal(tracker.recent(10).length, 1);
});

test("resolveDue scores a hit when price moved favorably past the threshold", async () => {
  const tracker = makeTracker(async () => 103); // +3% from entryPrice 100
  tracker.log({
    symbol: "BTCUSDT",
    interval: "1h",
    kind: "pattern",
    name: "Bull Flag",
    bias: "bullish",
    entryPrice: 100,
    detectedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // past its 24h horizon already
  });
  const resolved = await tracker.resolveDue();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].outcome, "hit");
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].returnPct, 3);
});

test("resolveDue scores a miss for an unfavorable move and flat for a small one", async () => {
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  const missTracker = makeTracker(async () => 97); // -3%, bullish bias -> unfavorable
  missTracker.log({ symbol: "ETHUSDT", interval: "1h", kind: "pattern", name: "X", bias: "bullish", entryPrice: 100, detectedAt: past });
  const missResolved = await missTracker.resolveDue();
  assert.equal(missResolved[0].outcome, "miss");

  const flatTracker = makeTracker(async () => 100.5); // +0.5%, below the 2% threshold
  flatTracker.log({ symbol: "SOLUSDT", interval: "1h", kind: "pattern", name: "Y", bias: "bullish", entryPrice: 100, detectedAt: past });
  const flatResolved = await flatTracker.resolveDue();
  assert.equal(flatResolved[0].outcome, "flat");
});

test("bearish bias flips the favorable direction", async () => {
  const tracker = makeTracker(async () => 95); // -5% move
  tracker.log({
    symbol: "BTCUSDT",
    interval: "1h",
    kind: "divergence",
    name: "Regular Bearish",
    bias: "bearish",
    entryPrice: 100,
    detectedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });
  const resolved = await tracker.resolveDue();
  assert.equal(resolved[0].outcome, "hit", "price falling is favorable for a bearish call");
});

test("resolveDue leaves entries before their horizon untouched", async () => {
  const tracker = makeTracker(async () => 110);
  tracker.log({ symbol: "BTCUSDT", interval: "1D", kind: "pattern", name: "X", bias: "bullish", entryPrice: 100, detectedAt: new Date().toISOString() });
  const resolved = await tracker.resolveDue();
  assert.equal(resolved.length, 0);
  assert.equal(tracker.recent(10)[0].status, "pending");
});

test("stats aggregates hit rate overall and per pattern name", async () => {
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const tracker = makeTracker(async () => 105); // +5%, favorable for bullish
  tracker.log({ symbol: "A", interval: "1h", kind: "pattern", name: "Bull Flag", bias: "bullish", entryPrice: 100, detectedAt: past });
  await tracker.resolveDue();

  const stats = tracker.stats();
  assert.equal(stats.overall.hits, 1);
  assert.equal(stats.overall.hitRate, 100);
  assert.equal(stats.byPattern["Bull Flag"].hits, 1);
});

// ── Horizon-exact resolution, excursion and persistence ─────────────────────

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

// 1h Binance-shaped klines from `start`, closes given per bar; high/low = close ± spread.
function hourly(start, closes, { highs, lows } = {}) {
  return closes.map((close, i) => {
    const open = start + i * HOUR;
    return [open, String(close), String(highs ? highs[i] : close), String(lows ? lows[i] : close), String(close), "0", open + HOUR - 1];
  });
}

function makeHistoricalTracker({ candles, now, dataDir }) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "md-tracker-"));
  const calls = [];
  const tracker = new PatternTrackerService({
    dataDir: dir,
    now: () => now.value,
    fetchCandles: async (q) => {
      calls.push(q);
      return candles.filter((c) => c[0] >= q.startTime && c[0] <= q.endTime);
    },
    fetchPrice: async () => { throw new Error("live price must not be used when candles are available"); },
  });
  return { tracker, calls, dir };
}

test("horizon is anchored to the candle close, and detection latency is recorded", () => {
  const now = { value: T0 };
  const { tracker } = makeHistoricalTracker({ candles: [], now });
  const entry = tracker.log({
    symbol: "BTCUSDT", interval: "1h", kind: "pattern", name: "Bull Flag", bias: "bullish", entryPrice: 100,
    detectedAt: new Date(T0 + 7 * 60 * 1000).toISOString(), candleCloseTime: T0 - 1,
  });
  assert.equal(entry.entryAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entry.resolveAt, "2026-01-02T00:00:00.000Z");
  assert.equal(entry.detectionLatencyMs, 7 * 60 * 1000);
});

test("a late resolver scores the price at the horizon, not the price when it runs", async () => {
  // 24 bars inside the window end at 103 (+3%); the next day crashes to 90.
  const closes = [...Array(23).fill(101), 103, ...Array(24).fill(90)];
  const candles = hourly(T0, closes, { highs: closes.map((c, i) => (i === 10 ? 106 : c)), lows: closes.map((c, i) => (i === 5 ? 98 : c)) });
  const now = { value: T0 + 48 * HOUR + 5 * 60 * 1000 }; // resolver was down a full day
  const { tracker, calls } = makeHistoricalTracker({ candles, now });
  tracker.log({ symbol: "BTCUSDT", interval: "1h", kind: "pattern", name: "Bull Flag", bias: "bullish", entryPrice: 100, detectedAt: new Date(T0).toISOString(), candleCloseTime: T0 - 1 });

  const [resolved] = await tracker.resolveDue();
  assert.equal(resolved.outcome, "hit");
  assert.equal(resolved.returnPct, 3);
  assert.equal(resolved.resolvedPrice, 103);
  assert.equal(resolved.priceAt, "2026-01-02T00:00:00.000Z");
  assert.equal(resolved.priceSource, "historical");
  assert.equal(resolved.mfePct, 6);
  assert.equal(resolved.maePct, -2);
  assert.equal(calls[0].interval, "1h");
  assert.equal(calls[0].startTime, T0);
});

test("excursion is measured in the direction of a bearish call", async () => {
  const closes = Array(24).fill(97);
  const candles = hourly(T0, closes, { highs: closes.map((c, i) => (i === 2 ? 104 : c)), lows: closes.map((c, i) => (i === 20 ? 92 : c)) });
  const now = { value: T0 + 25 * HOUR };
  const { tracker } = makeHistoricalTracker({ candles, now });
  tracker.log({ symbol: "ETHUSDT", interval: "1h", kind: "divergence", name: "Regular Bearish", bias: "bearish", entryPrice: 100, detectedAt: new Date(T0).toISOString(), candleCloseTime: T0 - 1 });
  const [resolved] = await tracker.resolveDue();
  assert.equal(resolved.outcome, "hit");
  assert.equal(resolved.mfePct, 8);
  assert.equal(resolved.maePct, -4);
});

test("an entry stays pending until the horizon candle exists and has closed", async () => {
  const now = { value: T0 + 24 * HOUR + 1000 };
  const { tracker } = makeHistoricalTracker({ candles: hourly(T0, Array(23).fill(101)), now });
  tracker.log({ symbol: "BTCUSDT", interval: "1h", kind: "pattern", name: "X", bias: "bullish", entryPrice: 100, detectedAt: new Date(T0).toISOString(), candleCloseTime: T0 - 1 });
  assert.deepEqual(await tracker.resolveDue(), []);
  assert.equal(tracker.recent(1)[0].status, "pending");
});

test("an entry logged while resolution is in flight is not lost", async () => {
  const now = { value: T0 + 25 * HOUR };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-tracker-"));
  let tracker;
  tracker = new PatternTrackerService({
    dataDir: dir,
    now: () => now.value,
    fetchCandles: async () => {
      tracker.log({ symbol: "SOLUSDT", interval: "4h", kind: "pattern", name: "Late", bias: "bullish", entryPrice: 1, detectedAt: new Date(now.value).toISOString() });
      return hourly(T0, Array(24).fill(103));
    },
  });
  tracker.log({ symbol: "BTCUSDT", interval: "1h", kind: "pattern", name: "Early", bias: "bullish", entryPrice: 100, detectedAt: new Date(T0).toISOString(), candleCloseTime: T0 - 1 });
  await tracker.resolveDue();
  const entries = tracker.recent(10);
  assert.deepEqual(entries.map((e) => `${e.name}:${e.status}`), ["Late:pending", "Early:resolved"]);
});

test("a corrupt track log is quarantined and the backup restored instead of starting empty", () => {
  const now = { value: T0 };
  const { tracker, dir } = makeHistoricalTracker({ candles: [], now });
  tracker.log({ symbol: "A", interval: "1h", kind: "pattern", name: "One", bias: "bullish", entryPrice: 1, detectedAt: new Date(T0).toISOString() });
  tracker.log({ symbol: "B", interval: "1h", kind: "pattern", name: "Two", bias: "bullish", entryPrice: 1, detectedAt: new Date(T0).toISOString() });
  fs.writeFileSync(path.join(dir, "pattern-track-log.json"), '[{"id": "torn', "utf8");

  const entries = tracker.recent(10);
  assert.deepEqual(entries.map((e) => e.name), ["One"], "backup holds the version before the last write");
  assert.ok(fs.readdirSync(dir).some((f) => /^pattern-track-log\.corrupt-\d+\.json$/.test(f)), "corrupt file kept for inspection");
  assert.equal(tracker.stats().integrity.recoveredFromBackup, true);
});

test("writes leave no temp file behind and never truncate pending entries", () => {
  const { MAX_ACTIVE_ENTRIES } = require("../src/services/pattern-tracker");
  const now = { value: T0 + 1000 * HOUR };
  const { tracker, dir } = makeHistoricalTracker({ candles: [], now });
  const file = path.join(dir, "pattern-track-log.json");
  const seed = [];
  for (let i = 0; i < MAX_ACTIVE_ENTRIES; i += 1) {
    seed.push({ id: `r${i}`, name: "Old", interval: "1h", symbol: "A", bias: "bullish", status: "resolved", outcome: "hit", returnPct: 3 });
  }
  seed.push({ id: "p-oldest", name: "Old pending", status: "pending", resolveAt: new Date(T0 + 2000 * HOUR).toISOString() });
  fs.writeFileSync(file, JSON.stringify(seed), "utf8");

  tracker.log({ symbol: "B", interval: "1h", kind: "pattern", name: "New", bias: "bullish", entryPrice: 1, detectedAt: new Date(now.value).toISOString() });

  const active = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(active.length, MAX_ACTIVE_ENTRIES);
  assert.ok(active.some((e) => e.id === "p-oldest"), "oldest pending entry survives the cap");
  assert.equal(active.filter((e) => e.status === "resolved").length, MAX_ACTIVE_ENTRIES - 2);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")));
  // Overflowed resolved history moves to the archive and still counts.
  assert.equal(tracker.stats().overall.total, MAX_ACTIVE_ENTRIES);
});

test("stats break accuracy down by interval and symbol", async () => {
  const now = { value: T0 + 25 * HOUR };
  const { tracker } = makeHistoricalTracker({ candles: hourly(T0, Array(24).fill(105)), now });
  tracker.log({ symbol: "BTCUSDT", interval: "1h", kind: "pattern", name: "Bull Flag", bias: "bullish", entryPrice: 100, detectedAt: new Date(T0).toISOString(), candleCloseTime: T0 - 1 });
  await tracker.resolveDue();
  const stats = tracker.stats();
  assert.equal(stats.byInterval["1h"].hitRate, 100);
  assert.equal(stats.bySymbol.BTCUSDT.hits, 1);
  assert.equal(stats.byPattern["Bull Flag"].avgMfePct, 5);
  assert.deepEqual(stats.priceSources, { historical: 1, live: 0 });
});
