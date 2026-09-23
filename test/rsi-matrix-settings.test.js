"use strict";

// The RSI Matrix's own instrument registry. It is separate from the Binance
// token universe on purpose; these pin that separation, persistence across a
// restart, and that a bad row is refused before it can reach the matrix.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RsiMatrixSettingsService } = require("../src/services/rsi-matrix-settings");
const { ScreenerSettingsService } = require("../src/services/screener-settings");
const { DEFAULT_INSTRUMENTS } = require("../src/services/rsi-matrix/registry");

const quiet = { log() {}, warn() {}, error() {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsi-matrix-settings-"));
}

function create(dir, verifyInstrument = null) {
  const service = new RsiMatrixSettingsService({ dataDir: dir, logger: quiet, verifyInstrument });
  service.ensureSeeded();
  return service;
}

function editable(snapshot) {
  return snapshot.instruments.map(({ id, label, group, provider, providerSymbol, enabled }) => ({
    id,
    label,
    group,
    provider,
    providerSymbol,
    enabled,
  }));
}

test("both reference groups are seeded, with one column per logical market", () => {
  const snap = create(tmpDir()).snapshot();
  assert.deepEqual(snap.groups.map((g) => g.id), ["cross-market", "crypto-stables"]);
  const labels = (group) => snap.instruments.filter((r) => r.group === group).map((r) => r.label);
  assert.deepEqual(labels("cross-market"), ["SPX", "BTCUSD", "ETHUSD", "XRPUSDT", "US10Y", "GOLD", "SILVER", "USOIL", "EUR1!", "DXY"]);
  for (const label of ["USDT.D", "BTCUSD", "BTC.D", "TOTAL3", "USDC.D", "MXUSDT", "USTCUSDT", "CROUSDT", "KCSUSDT", "BNBUSDT.P", "DAIUSD", "TUSD", "USDDUSDC", "USDPUSDT", "PYUSDEUR", "FRAXUSDT"]) {
    assert.ok(labels("crypto-stables").includes(label), `${label} is seeded`);
  }
  // MXUSDT and MEXC:MXUSDT were the same market: one column.
  assert.equal(snap.instruments.filter((r) => r.provider === "mexc" && r.providerSymbol === "MXUSDT").length, 1);
  assert.equal(snap.rsiLength, 14);
  assert.deepEqual(snap.timeframes.map((t) => [t.key, t.enabled]), [["1W", true], ["1D", true], ["4h", true], ["1h", true]]);
  assert.ok(snap.instruments.every((r) => r.isDefault && r.enabled));
});

test("reorder, relabel, enable/disable and timeframes survive a restart", async () => {
  const dir = tmpDir();
  const first = create(dir);
  const rows = editable(first.snapshot());
  const gold = rows.find((r) => r.id === "gold");
  gold.label = "XAU";
  const spx = rows.find((r) => r.id === "spx");
  spx.enabled = false;
  // Move GOLD to the front.
  const reordered = [gold, ...rows.filter((r) => r !== gold)];
  await first.save({ instruments: reordered, timeframes: { "1h": false } });

  const restarted = create(dir).snapshot();
  assert.equal(restarted.instruments[0].id, "gold");
  assert.equal(restarted.instruments[0].label, "XAU");
  assert.equal(restarted.instruments.find((r) => r.id === "spx").enabled, false);
  assert.deepEqual(restarted.timeframes.find((t) => t.key === "1h"), { key: "1h", label: "1H", enabled: false });
  assert.equal(restarted.status.state, "loaded");
});

test("every timeframe cannot be switched off", async () => {
  const service = create(tmpDir());
  await assert.rejects(
    service.save({ instruments: editable(service.snapshot()), timeframes: { "1W": false, "1D": false, "4h": false, "1h": false } }),
    (err) => err.statusCode === 400,
  );
});

test("added instruments are verified, persisted and deletable; defaults are not deletable", async () => {
  const dir = tmpDir();
  const verified = [];
  const service = create(dir, async (row) => verified.push(row));
  const snap = await service.addInstrument({ label: "RENDER", group: "crypto-stables", provider: "binance", providerSymbol: "renderusdt" });
  assert.deepEqual(verified, [{ provider: "binance", providerSymbol: "RENDERUSDT" }]);
  const added = snap.instruments.find((r) => r.label === "RENDER");
  assert.equal(added.isDefault, false);
  assert.equal(added.providerSymbol, "RENDERUSDT");

  assert.ok(create(dir).snapshot().instruments.some((r) => r.id === added.id), "survives restart");

  assert.throws(() => service.removeInstrument("gold"), (err) => err.statusCode === 400);
  const after = service.removeInstrument(added.id);
  assert.ok(!after.instruments.some((r) => r.id === added.id));
});

test("duplicate instruments are refused", async () => {
  const service = create(tmpDir(), async () => {});
  await assert.rejects(
    service.addInstrument({ label: "MX again", group: "crypto-stables", provider: "mexc", providerSymbol: "MXUSDT" }),
    (err) => err.statusCode === 409,
  );
  // The same market in the other group is a legitimate second column.
  await service.addInstrument({ label: "MX", group: "cross-market", provider: "mexc", providerSymbol: "MXUSDT" });

  // And a save can't create a duplicate by editing a row into another's slot.
  const rows = editable(service.snapshot());
  rows.find((r) => r.id === "eth-usd").providerSymbol = "BTCUSDT";
  await assert.rejects(service.save({ instruments: rows }), (err) => err.statusCode === 409);
});

test("invalid provider symbols are rejected cleanly, before any verification", async () => {
  let calls = 0;
  const service = create(tmpDir(), async () => { calls += 1; });
  const bad = [
    { provider: "binance", providerSymbol: "USDT.D" },
    { provider: "binance", providerSymbol: "CRYPTOCAP:USDT" },
    { provider: "mexc", providerSymbol: "MEXC:MXUSDT" },
    { provider: "kucoin", providerSymbol: "USDDUSDC" },
    { provider: "poloniex", providerSymbol: "FRAXUSDT" },
    { provider: "coingecko-mcap", providerSymbol: "Tether USD!" },
    { provider: "dominance", providerSymbol: "BTCUSDT" },
    { provider: "nowhere", providerSymbol: "BTCUSDT" },
  ];
  for (const row of bad) {
    await assert.rejects(
      service.addInstrument({ label: "Bad", group: "crypto-stables", ...row }),
      (err) => err.statusCode === 400,
      `${row.provider} ${row.providerSymbol}`,
    );
  }
  await assert.rejects(
    service.addInstrument({ label: "", group: "crypto-stables", provider: "binance", providerSymbol: "BTCUSDT" }),
    (err) => err.statusCode === 400,
  );
  await assert.rejects(
    service.addInstrument({ label: "X", group: "stocks", provider: "binance", providerSymbol: "BTCUSDT" }),
    (err) => err.statusCode === 400,
  );
  assert.equal(calls, 0);
});

test("a failed verification saves nothing; only changed sources are verified", async () => {
  const dir = tmpDir();
  const checked = [];
  const service = create(dir, async (row) => {
    checked.push(row.providerSymbol);
    if (row.providerSymbol === "NOPEUSDT") {
      const err = new Error("MEXC Spot does not recognise NOPEUSDT");
      err.statusCode = 400;
      throw err;
    }
  });
  await assert.rejects(
    service.addInstrument({ label: "NOPE", group: "crypto-stables", provider: "mexc", providerSymbol: "NOPEUSDT" }),
    /does not recognise/,
  );
  assert.ok(!service.snapshot().instruments.some((r) => r.label === "NOPE"));

  const rows = editable(service.snapshot());
  rows.find((r) => r.id === "cro").providerSymbol = "NOPEUSDT";
  rows.find((r) => r.id === "gold").label = "Gold";
  await assert.rejects(service.save({ instruments: rows }), /does not recognise/);
  assert.equal(create(dir).snapshot().instruments.find((r) => r.id === "cro").providerSymbol, "CROUSDT");
  assert.deepEqual(checked, ["NOPEUSDT", "NOPEUSDT"], "unchanged rows are not re-verified");
});

test("a stale page can't drop or invent rows through a save", async () => {
  const service = create(tmpDir());
  const rows = editable(service.snapshot());
  await assert.rejects(service.save({ instruments: rows.slice(1) }), (err) => err.statusCode === 409);
  await assert.rejects(
    service.save({ instruments: [...rows, { ...rows[0], id: "ghost" }] }),
    (err) => err.statusCode === 409,
  );
});

test("reset restores the shipped list; user rows stay but are switched off", async () => {
  const service = create(tmpDir(), async () => {});
  await service.addInstrument({ label: "RENDER", group: "crypto-stables", provider: "binance", providerSymbol: "RENDERUSDT" });
  const rows = editable(service.snapshot()).reverse();
  rows.forEach((r) => { r.enabled = false; });
  await service.save({ instruments: rows, timeframes: { "1W": false } });
  const snap = service.reset();
  assert.deepEqual(snap.instruments.slice(0, DEFAULT_INSTRUMENTS.length).map((r) => r.id), DEFAULT_INSTRUMENTS.map((r) => r.id));
  assert.ok(snap.instruments.slice(0, DEFAULT_INSTRUMENTS.length).every((r) => r.enabled));
  const render = snap.instruments.find((r) => r.label === "RENDER");
  assert.equal(render.enabled, false);
  assert.ok(snap.timeframes.every((t) => t.enabled));
});

test("a corrupt file serves the defaults and is backed up on the next write", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "rsi-matrix-settings.json"), "{not json");
  const service = new RsiMatrixSettingsService({ dataDir: dir, logger: quiet });
  const snap = service.snapshot();
  assert.equal(snap.status.state, "corrupt");
  assert.equal(snap.instruments.length, DEFAULT_INSTRUMENTS.length);
  await service.save({ instruments: editable(snap) });
  assert.ok(fs.existsSync(path.join(dir, "rsi-matrix-settings.json.corrupt")));
  assert.equal(service.snapshot().status.state, "loaded");
});

test("one unreadable row is skipped without breaking the rest", () => {
  const dir = tmpDir();
  const good = { id: "gold", label: "GOLD", group: "cross-market", provider: "yahoo", providerSymbol: "GC=F", enabled: true };
  fs.writeFileSync(
    path.join(dir, "rsi-matrix-settings.json"),
    JSON.stringify({
      version: 1,
      seededDefaults: DEFAULT_INSTRUMENTS.map((r) => r.id),
      instruments: [good, { id: "bad", label: "BAD", group: "cross-market", provider: "binance", providerSymbol: "USDT.D" }],
    }),
  );
  const snap = new RsiMatrixSettingsService({ dataDir: dir, logger: quiet }).snapshot();
  assert.deepEqual(snap.instruments.map((r) => r.id), ["gold"]);
  assert.equal(snap.status.state, "partial");
});

test("the Binance-only token universe still refuses dominance and TradingView symbols", async () => {
  const universe = new ScreenerSettingsService({ dataDir: tmpDir(), logger: quiet, verifySymbol: null });
  universe.ensureSeeded();
  for (const symbol of ["USDT.D", "TOTAL3", "CRYPTOCAP:USDT", "MEXC:MXUSDT"]) {
    await assert.rejects(universe.addToken(symbol), (err) => err.statusCode === 400, symbol);
  }
});
