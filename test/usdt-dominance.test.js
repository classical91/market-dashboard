"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { UsdtDominanceService } = require("../src/services/usdt-dominance");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usdt-dominance-"));
}

function stubMarketData(percent, { live = true, source = "coingecko" } = {}) {
  return {
    async getGlobalDominance() {
      return {
        live,
        source,
        dominance: [
          { symbol: "BTC", percent: 52 },
          { symbol: "USDT", percent },
        ],
      };
    },
  };
}

// A clock the test drives, so a 24h window can be crossed without waiting.
function clock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const HOUR = 60 * 60 * 1000;

test("reports the current level immediately, with no invented direction", async () => {
  const dir = tempDir();
  const service = new UsdtDominanceService({ marketDataService: stubMarketData(6.24), dataDir: dir });
  const read = await service.read();

  assert.equal(read.symbol, "USDT.D");
  assert.equal(read.percent, 6.24);
  assert.equal(read.live, true);
  // The first ever read has nothing to compare against — that must surface as
  // null, not as a FLAT that looks like a real observation.
  assert.equal(read.direction, null);
  assert.equal(read.changes.h4, null);
  assert.equal(read.changes.h24, null);
  assert.equal(read.history.points, 1);
});

test("derives direction once the accumulated history spans the window", async () => {
  const dir = tempDir();
  const time = clock(Date.UTC(2026, 0, 1));
  const rising = { percent: 6.0 };
  const service = new UsdtDominanceService({
    marketDataService: { async getGlobalDominance() { return { live: true, source: "coingecko", dominance: [{ symbol: "USDT", percent: rising.percent }] }; } },
    dataDir: dir,
    now: time.now,
  });

  await service.read();
  time.advance(4 * HOUR);
  rising.percent = 6.4;
  const afterFour = await service.read();

  assert.equal(afterFour.changes.h4.direction, "RISING");
  assert.equal(afterFour.changes.h4.delta, 0.4);
  assert.equal(afterFour.changes.h24, null, "24h has no coverage yet");
  assert.equal(afterFour.direction, "RISING", "falls back to the 4h read while the series is young");

  time.advance(20 * HOUR);
  rising.percent = 5.7;
  const afterDay = await service.read();
  assert.equal(afterDay.changes.h24.direction, "FALLING");
  assert.equal(afterDay.changes.h24.delta, -0.3);
  assert.equal(afterDay.direction, "FALLING", "24h is the headline once it is available");
});

test("a move inside the flat band is FLAT, not a direction", async () => {
  const dir = tempDir();
  const time = clock(Date.UTC(2026, 0, 1));
  const level = { percent: 6.2 };
  const service = new UsdtDominanceService({
    marketDataService: { async getGlobalDominance() { return { live: true, source: "coingecko", dominance: [{ symbol: "USDT", percent: level.percent }] }; } },
    dataDir: dir,
    now: time.now,
  });

  await service.read();
  time.advance(4 * HOUR);
  level.percent = 6.23;
  const read = await service.read();
  assert.equal(read.changes.h4.direction, "FLAT");
});

test("a gap in coverage reads as no comparison rather than the nearest point", async () => {
  const dir = tempDir();
  const time = clock(Date.UTC(2026, 0, 1));
  const service = new UsdtDominanceService({ marketDataService: stubMarketData(6.0), dataDir: dir, now: time.now });

  await service.read();
  // Nothing recorded for three days — the app was down. The old point must not
  // answer for "4 hours ago".
  time.advance(72 * HOUR);
  const read = await service.read();
  assert.equal(read.changes.h4, null);
  assert.equal(read.changes.h24, null);
  assert.equal(read.direction, null);
});

test("snapshots are throttled so page loads cannot flood the series", async () => {
  const dir = tempDir();
  const time = clock(Date.UTC(2026, 0, 1));
  const service = new UsdtDominanceService({ marketDataService: stubMarketData(6.0), dataDir: dir, now: time.now });

  await service.read();
  time.advance(60 * 1000);
  await service.read();
  time.advance(60 * 1000);
  const read = await service.read();
  assert.equal(read.history.points, 1, "three reads a minute apart keep one snapshot");

  time.advance(10 * 60 * 1000);
  const later = await service.read();
  assert.equal(later.history.points, 2);
});

test("fallback readings are never persisted as observations", async () => {
  const dir = tempDir();
  const service = new UsdtDominanceService({
    marketDataService: stubMarketData(6, { live: false, source: "fallback" }),
    dataDir: dir,
  });

  const read = await service.read();
  assert.equal(read.live, false);
  // Writing the hardcoded fallback would manufacture a flat line that later
  // reads back as real data.
  assert.equal(read.history.points, 0);
});

test("a provider that omits USDT degrades to an error row, not a zero", async () => {
  const dir = tempDir();
  const service = new UsdtDominanceService({
    marketDataService: { async getGlobalDominance() { return { live: true, source: "coingecko", dominance: [{ symbol: "BTC", percent: 52 }] }; } },
    dataDir: dir,
  });

  const read = await service.read();
  assert.equal(read.percent, null);
  assert.match(read.error, /not reported/i);
});

test("history survives a restart and is read back from disk", async () => {
  const dir = tempDir();
  const time = clock(Date.UTC(2026, 0, 1));
  const level = { percent: 6.0 };
  const marketDataService = { async getGlobalDominance() { return { live: true, source: "coingecko", dominance: [{ symbol: "USDT", percent: level.percent }] }; } };

  await new UsdtDominanceService({ marketDataService, dataDir: dir, now: time.now }).read();
  time.advance(5 * HOUR);
  level.percent = 6.5;

  // A fresh instance, as after a deploy — the series is on disk, not in memory.
  const read = await new UsdtDominanceService({ marketDataService, dataDir: dir, now: time.now }).read();
  assert.equal(read.history.points, 2);
  assert.equal(read.changes.h4.direction, "RISING");
});
