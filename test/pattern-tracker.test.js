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
