"use strict";

// The screener token universes: Settings is the single place that decides
// which tokens each screener scans, and these pin the properties that make
// that claim true — the defaults are preserved out of the box, the three
// universes move independently, an emptied one stays empty, and the scanners
// still share one candle cache across the universes that overlap.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { ScreenerSettingsService, SCREENER_KEYS } = require("../src/services/screener-settings");
const { createScreenerSettingsRouter } = require("../src/routes/screener-settings");
const { createDirectionalBiasRouter } = require("../src/routes/directional-bias");
const { createLocalExtremesRouter } = require("../src/routes/local-extremes");
const { createPatternScannerRouter } = require("../src/routes/pattern-scanner");
const { SignalScreenerService } = require("../src/services/signal-screener");
const { TOP_TOKENS } = require("../src/config/market-symbols");

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screener-settings-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Never let a unit test reach Binance: the verifier is the one part of the
// store that would otherwise make a network call.
function makeService(overrides = {}) {
  return new ScreenerSettingsService({
    dataDir: tempDir(),
    logger: { log() {}, warn() {}, error() {} },
    verifySymbol: async () => {},
    ...overrides,
  });
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("first boot seeds every screener from the default catalog", () => {
  const service = makeService();
  service.ensureSeeded();

  for (const key of SCREENER_KEYS) {
    assert.deepEqual(service.getUniverse(key), TOP_TOKENS);
  }
  assert.equal(service.catalog().length, TOP_TOKENS.length);
});

test("a default added in a later release starts being scanned, an unchecked one stays unchecked", () => {
  const dataDir = tempDir();
  const logger = { log() {}, warn() {}, error() {} };
  const first = new ScreenerSettingsService({ dataDir, logger, defaults: ["BTCUSDT", "ETHUSDT"] });
  first.ensureSeeded();
  // The operator drops ETH from one screener.
  first.save({ directionalBias: ["BTCUSDT"] });

  // A later release extends the default catalog.
  const second = new ScreenerSettingsService({ dataDir, logger, defaults: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
  second.ensureSeeded();

  assert.deepEqual(second.getUniverse("directionalBias"), ["BTCUSDT", "SOLUSDT"]);
  assert.deepEqual(second.getUniverse("localExtremes"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  // Re-seeding is idempotent: the new default is offered exactly once.
  assert.equal(second.ensureSeeded(), false);
});

test("the three universes move independently", () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
  service.ensureSeeded();

  service.save({ directionalBias: ["BTCUSDT"], patternScanner: ["SOLUSDT"] });

  assert.deepEqual(service.getUniverse("directionalBias"), ["BTCUSDT"]);
  assert.deepEqual(service.getUniverse("localExtremes"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(service.getUniverse("patternScanner"), ["SOLUSDT"]);
});

test("an emptied universe stays empty rather than silently falling back to the defaults", () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT"] });
  service.ensureSeeded();
  service.save({ localExtremes: [] });

  assert.deepEqual(service.getUniverse("localExtremes"), []);
  // And it survives a reload — an empty list is saved state, not a read glitch.
  const reread = new ScreenerSettingsService({
    dataDir: path.dirname(service._file),
    logger: { log() {}, warn() {}, error() {} },
    defaults: ["BTCUSDT", "ETHUSDT"],
  });
  assert.deepEqual(reread.getUniverse("localExtremes"), []);
});

test("an unreadable settings file serves the defaults instead of stopping every screener", () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT"] });
  service.ensureSeeded();
  fs.writeFileSync(service._file, "{ not json", "utf8");

  assert.deepEqual(service.getUniverse("directionalBias"), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(service.snapshot().status.state, "corrupt");
});

test("membership is a subset of the catalog, never a back door for adding to it", () => {
  const service = makeService({ defaults: ["BTCUSDT"] });
  service.ensureSeeded();

  assert.throws(
    () => service.save({ directionalBias: ["BTCUSDT", "RENDERUSDT"] }),
    /not in the token catalog/,
  );
  assert.deepEqual(service.getUniverse("directionalBias"), ["BTCUSDT"]);
});

test("addToken verifies against Binance, then joins the catalog and every screener", async () => {
  const verified = [];
  const service = makeService({
    defaults: ["BTCUSDT"],
    verifySymbol: async (symbol) => { verified.push(symbol); },
  });
  service.ensureSeeded();

  await service.addToken("renderusdt");

  assert.deepEqual(verified, ["RENDERUSDT"]);
  for (const key of SCREENER_KEYS) {
    assert.deepEqual(service.getUniverse(key), ["BTCUSDT", "RENDERUSDT"]);
  }
  await assert.rejects(() => service.addToken("RENDERUSDT"), /already in the token catalog/);
});

test("a pair Binance does not list is never persisted", async () => {
  const service = makeService({
    defaults: ["BTCUSDT"],
    verifySymbol: async () => { throw new Error("Binance does not list NOPEUSDT as a spot pair"); },
  });
  service.ensureSeeded();

  await assert.rejects(() => service.addToken("NOPEUSDT"), /does not list/);
  assert.deepEqual(service.catalog(), ["BTCUSDT"]);
});

test("dominance indices are refused with an explanation rather than a format error", async () => {
  const service = makeService({ defaults: ["BTCUSDT"] });
  service.ensureSeeded();
  await assert.rejects(() => service.addToken("USDT.D"), /market context/);
  await assert.rejects(() => service.addToken("BTCUSDT.P"), /Binance spot pair/);
});

test("a default is unchecked, not deleted; an added token can be removed", async () => {
  const service = makeService({ defaults: ["BTCUSDT"] });
  service.ensureSeeded();
  await service.addToken("RENDERUSDT");

  assert.throws(() => service.removeToken("BTCUSDT"), /uncheck it instead/);
  service.removeToken("RENDERUSDT");

  assert.deepEqual(service.catalog(), ["BTCUSDT"]);
  assert.deepEqual(service.getUniverse("patternScanner"), ["BTCUSDT"]);
});

test("reset restores every default and leaves added tokens in the catalog but switched off", async () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT"] });
  service.ensureSeeded();
  await service.addToken("RENDERUSDT");
  service.save({ directionalBias: [], localExtremes: ["ETHUSDT"] });

  const snapshot = service.reset();

  assert.deepEqual(snapshot.universes.directionalBias, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(snapshot.universes.patternScanner, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(service.catalog(), ["BTCUSDT", "ETHUSDT", "RENDERUSDT"]);
});

test("the snapshot marks which catalog rows are defaults and counts each universe", async () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT"] });
  service.ensureSeeded();
  await service.addToken("RENDERUSDT", { screeners: ["patternScanner"] });

  const snapshot = service.snapshot();
  assert.deepEqual(
    snapshot.catalog.map((token) => [token.symbol, token.label, token.isDefault]),
    [["BTCUSDT", "BTC", true], ["ETHUSDT", "ETH", true], ["RENDERUSDT", "RENDER", false]],
  );
  assert.deepEqual(snapshot.counts, { directionalBias: 2, localExtremes: 2, patternScanner: 3, openInterest: 2 });
});

test("the API reads openly and gates every write", async () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT"] });
  service.ensureSeeded();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/screener-settings",
    createScreenerSettingsRouter({
      screenerSettingsService: service,
      requireAdmin: (req, res, next) =>
        (req.get("x-admin-key") === "secret" ? next() : res.status(401).json({ error: "Unauthorized" })),
    }),
  );
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));

  await withServer(app, async (base) => {
    const read = await fetch(`${base}/api/screener-settings`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).universes.directionalBias, ["BTCUSDT", "ETHUSDT"]);

    const anonymous = await fetch(`${base}/api/screener-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ universes: { directionalBias: [] } }),
    });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(service.getUniverse("directionalBias"), ["BTCUSDT", "ETHUSDT"]);

    const saved = await fetch(`${base}/api/screener-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-key": "secret" },
      body: JSON.stringify({ universes: { directionalBias: ["ETHUSDT"] } }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).universes.directionalBias, ["ETHUSDT"]);

    const rejected = await fetch(`${base}/api/screener-settings/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "secret" },
      body: JSON.stringify({ symbol: "USDT.D" }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /market context/);
  });
});

test("each screener route scans the universe it is configured with", async () => {
  const service = makeService({ defaults: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
  service.ensureSeeded();
  service.save({ directionalBias: ["BTCUSDT"], localExtremes: ["ETHUSDT", "SOLUSDT"], patternScanner: [] });

  const asked = { bias: null, extremes: null, pattern: null };
  const app = express();
  app.use(
    "/api/directional-bias",
    createDirectionalBiasRouter({
      screenerSettingsService: service,
      signalScreenerService: {
        async scanDirectionalBias(interval, minChecks, { symbols }) {
          asked.bias = symbols;
          return symbols.map((symbol) => ({ symbol }));
        },
      },
    }),
  );
  app.use(
    "/api/local-extremes",
    createLocalExtremesRouter({
      screenerSettingsService: service,
      signalScreenerService: {
        async scanLocalExtremes(interval, minChecks, { symbols }) {
          asked.extremes = symbols;
          return symbols.map((symbol) => ({ symbol }));
        },
      },
    }),
  );
  app.use(
    "/api/pattern-scanner",
    createPatternScannerRouter({
      screenerSettingsService: service,
      patternScannerService: {
        scanIntervals: ["1h", "4h", "1D"],
        async scanAll({ symbols }) {
          asked.pattern = symbols;
          return symbols.map((symbol) => ({ symbol }));
        },
      },
    }),
  );

  await withServer(app, async (base) => {
    await fetch(`${base}/api/directional-bias`);
    await fetch(`${base}/api/local-extremes`);
    const pattern = await fetch(`${base}/api/pattern-scanner`);

    assert.deepEqual(asked.bias, ["BTCUSDT"]);
    assert.deepEqual(asked.extremes, ["ETHUSDT", "SOLUSDT"]);
    // An emptied universe reaches the scanner as an empty page, not as the
    // full default list the page has stopped claiming to show.
    assert.deepEqual(asked.pattern, []);
    assert.deepEqual((await pattern.json()).results, []);
  });
});

test("a symbol two screeners share is still fetched and scored once", async () => {
  let fetches = 0;
  const cache = new Map();
  const memory = {
    async getOrLoad(key, ttl, load) {
      if (cache.has(key)) return cache.get(key);
      const value = await load();
      cache.set(key, value);
      return value;
    },
    async set(key, value) {
      cache.set(key, value);
      return value;
    },
  };
  const service = new SignalScreenerService({ cache: memory, tokens: ["BTCUSDT"] });
  service._fetchKlines = async () => {
    fetches += 1;
    // 400 flat-ish bars: enough history for EMA200 and the rest to resolve.
    return Array.from({ length: 400 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 100 + i * 0.1,
      high: 101 + i * 0.1,
      low: 99 + i * 0.1,
      close: 100 + i * 0.1,
      volume: 10,
      closeTime: i * 3_600_000 + 3_599_999,
    }));
  };

  const bias = await service.scanDirectionalBias("1h", 4, { symbols: ["BTCUSDT", "ETHUSDT"] });
  const extremes = await service.scanLocalExtremes("1h", 4, { symbols: ["BTCUSDT"] });

  assert.equal(bias.length, 2);
  assert.equal(extremes.length, 1);
  // BTC once, ETH once — the second page's BTC row came out of the shared
  // per-symbol cache rather than a second Binance pass.
  assert.equal(fetches, 2);
});

test("omitting symbols leaves every existing caller on the default universe", async () => {
  const scanned = [];
  const memory = {
    async getOrLoad(key, ttl, load) { return load(); },
    async set(key, value) { return value; },
  };
  const service = new SignalScreenerService({ cache: memory, tokens: ["BTCUSDT", "ETHUSDT"] });
  service.scanToken = async (symbol) => { scanned.push(symbol); return { symbol }; };

  await service.scanAll("4h", 4);
  assert.deepEqual(scanned, ["BTCUSDT", "ETHUSDT"]);
});

test("an older settings file gains the Open Interest universe once, from the defaults", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, "screener-settings.json");
  // The shape every deployment wrote before Open Interest existed, with a
  // deliberately customised universe that must survive the migration.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    seededDefaults: ["BTCUSDT", "ETHUSDT"],
    added: [],
    universes: { directionalBias: ["BTCUSDT"], localExtremes: ["ETHUSDT"], patternScanner: [] },
  }));
  const service = makeService({ dataDir, defaults: ["BTCUSDT", "ETHUSDT"] });

  assert.equal(service.ensureSeeded(), true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.universes.openInterest, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(written.universes.directionalBias, ["BTCUSDT"]);
  assert.deepEqual(written.universes.patternScanner, []);
  assert.equal(service.snapshot().status.state, "loaded");
  // Idempotent: a second boot has nothing left to migrate.
  assert.equal(service.ensureSeeded(), false);
});
