"use strict";

// Cross-Market Open Interest: CFTC parsing, the two normalised metrics, the
// rule that a missing market is null and never 0, last-good fallback, and the
// catalog the page's selection and filters rely on.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { CftcCotProvider } = require("../src/services/cross-market-oi/cftc-provider");
const {
  CrossMarketOiService,
  inQuarterlyRollWindow,
} = require("../src/services/cross-market-oi/service");
const { createCrossMarketOiRouter } = require("../src/routes/cross-market-oi");
const { MemoryCache } = require("../src/services/cache");
const {
  INSTRUMENTS,
  ASSET_CLASSES,
  DEFAULT_SELECTION,
  MIN_SELECTION,
  MAX_SELECTION,
} = require("../src/config/cross-market-oi");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12); // Tue 22 Sep 2026
const quiet = { log() {}, warn() {}, error() {} };

function week(date, oi, long, short) {
  return { date, marketAndExchange: "TEST - EXCHANGE", openInterest: oi, nonCommLong: long, nonCommShort: short, commLong: 0, commShort: 0 };
}

const INSTR = [
  { id: "btc-cme", symbol: "BTC", marketName: "Bitcoin", exchange: "CME", assetClass: "crypto", contract: "133741", roll: "monthly" },
  { id: "dxy-ice", symbol: "DXY", marketName: "U.S. Dollar Index", exchange: "ICE", assetClass: "fx", contract: "098662", roll: "quarterly" },
  { id: "gold-comex", symbol: "GC", marketName: "Gold", exchange: "COMEX", assetClass: "metals", contract: "088691", roll: "bimonthly" },
];

function history() {
  return new Map([
    ["133741", [
      week("2026-09-15", 30000, 12000, 15000),
      week("2026-09-08", 30450, 12500, 14000),
      week("2026-09-01", 31000, 12000, 14000),
      week("2026-08-25", 29000, 11000, 14000),
      week("2026-08-18", 25000, 10000, 13000),
    ]],
    ["098662", [
      week("2026-09-15", 22700, 15000, 5000),
      // Holiday week: reported as of Wednesday instead of Tuesday.
      week("2026-09-09", 30000, 16000, 5000),
    ]],
    // Gold is missing from the response entirely.
  ]);
}

function fakeProvider(impl) {
  const calls = [];
  return {
    label: "CFTC test",
    calls,
    async fetchWeekly(codes, opts) {
      calls.push({ codes, opts });
      return impl(codes, opts);
    },
  };
}

function memoryStore() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, JSON.parse(JSON.stringify(v))), map };
}

function makeService(opts = {}) {
  return new CrossMarketOiService({
    provider: opts.provider || fakeProvider(() => history()),
    cache: new MemoryCache(),
    store: opts.store === undefined ? memoryStore() : opts.store,
    instruments: INSTR,
    now: opts.now || (() => NOW),
    logger: quiet,
  });
}

function pick(snapshot, id, metricType) {
  return snapshot.rows.find((r) => r.id === id && r.metricType === metricType);
}

// ── provider ───────────────────────────────────────────────

test("the CFTC provider queries every code in one request and normalises rows", async () => {
  let seen = null;
  const provider = new CftcCotProvider({
    appToken: "secret-token",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => [
          { cftc_contract_market_code: "133741", report_date_as_yyyy_mm_dd: "2026-09-08T00:00:00.000", open_interest_all: "30450", noncomm_positions_long_all: "12500", noncomm_positions_short_all: "14000", market_and_exchange_names: "BITCOIN - CHICAGO MERCANTILE EXCHANGE" },
          { cftc_contract_market_code: "133741", report_date_as_yyyy_mm_dd: "2026-09-15T00:00:00.000", open_interest_all: "30000", noncomm_positions_long_all: "12000", noncomm_positions_short_all: "" },
          { cftc_contract_market_code: "13874A", report_date_as_yyyy_mm_dd: "2026-09-15T00:00:00.000", open_interest_all: "2100000" },
          { cftc_contract_market_code: "", report_date_as_yyyy_mm_dd: "2026-09-15" },
        ],
      };
    },
  });
  const byCode = await provider.fetchWeekly(["133741", "13874A"], { sinceDate: "2026-07-20" });
  const where = new URL(seen.url).searchParams.get("$where");
  assert.match(where, /cftc_contract_market_code in\('133741','13874A'\)/);
  assert.match(where, /report_date_as_yyyy_mm_dd >= '2026-07-20T00:00:00'/);
  assert.equal(seen.init.headers["X-App-Token"], "secret-token");
  const btc = byCode.get("133741");
  assert.deepEqual(btc.map((r) => r.date), ["2026-09-15", "2026-09-08"], "newest first");
  assert.equal(btc[0].nonCommShort, null, "an empty field is missing, not zero");
  assert.equal(byCode.get("13874A")[0].openInterest, 2100000);
  assert.equal(byCode.size, 2);
});

test("provider failures are reported with a reason", async () => {
  const blocked = new CftcCotProvider({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(blocked.fetchWeekly(["1"], { sinceDate: "2026-01-01" }), /CFTC HTTP 503/);
  const slow = new CftcCotProvider({ timeoutMs: 10, fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } });
  await assert.rejects(slow.fetchWeekly(["1"], { sinceDate: "2026-01-01" }), /timed out after 10ms/);
});

// ── metrics ────────────────────────────────────────────────

test("OI is plotted as % change over the lookback, never as raw contracts", async () => {
  const snap = await makeService().snapshot({ lookback: "1w" });
  const btc = pick(snap, "btc-cme", "OI");
  assert.equal(btc.currentValue, 30000);
  assert.equal(btc.previousValue, 30450);
  assert.equal(btc.change, -450);
  assert.equal(btc.changePct, -1.48);
  assert.equal(btc.normalizedValue, btc.changePct);
  assert.equal(btc.timeframe, "W");
  assert.equal(btc.lookback, "1W");
  assert.equal(btc.observationDate, "2026-09-15");
  assert.equal(btc.freshness.state, "FRESH");

  const four = pick(await makeService().snapshot({ lookback: "4w" }), "btc-cme", "OI");
  assert.equal(four.previousDate, "2026-08-18");
  assert.equal(four.changePct, 20);
});

test("a holiday-shifted report still counts as the previous week", async () => {
  const dxy = pick(await makeService().snapshot(), "dxy-ice", "OI");
  assert.equal(dxy.previousDate, "2026-09-09");
  assert.equal(dxy.changePct, -24.33);
});

test("a lookback the history doesn't reach is null, not the nearest older report", async () => {
  const dxy = pick(await makeService().snapshot({ lookback: "4w" }), "dxy-ice", "OI");
  assert.equal(dxy.previousValue, null);
  assert.equal(dxy.changePct, null);
  assert.equal(dxy.normalizedValue, null);
  assert.equal(dxy.error, null, "the market itself is reported; only the comparison is missing");
});

test("COT positioning is net speculators as a % of OI, a separate metricType", async () => {
  const snap = await makeService().snapshot();
  const btc = pick(snap, "btc-cme", "COT_NET_SPEC");
  assert.equal(btc.currentValue, -10);
  assert.equal(btc.previousValue, -4.93);
  assert.equal(btc.change, -5.07, "percentage points");
  assert.equal(btc.changePct, null);
  assert.equal(btc.normalizedValue, -10);
  assert.equal(btc.netContracts, -3000);
  assert.notEqual(pick(snap, "btc-cme", "OI").normalizedValue, btc.normalizedValue);
});

test("a market missing from the report is an error row of nulls, never zeros", async () => {
  const snap = await makeService().snapshot();
  for (const metric of ["OI", "COT_NET_SPEC"]) {
    const gold = pick(snap, "gold-comex", metric);
    assert.match(gold.error, /No CFTC report rows for contract 088691/);
    for (const key of ["currentValue", "previousValue", "change", "changePct", "normalizedValue"]) {
      assert.equal(gold[key], null, `${metric}.${key}`);
    }
  }
  assert.deepEqual(snap.coverage, { markets: 3, withData: 2, reported: 2 });
});

test("quarterly contracts near a Mar/Jun/Sep/Dec expiry are flagged as rolling", async () => {
  // Third Friday of September 2026 is the 18th.
  assert.equal(inQuarterlyRollWindow("2026-09-15"), true);
  assert.equal(inQuarterlyRollWindow("2026-08-25"), false);
  assert.equal(inQuarterlyRollWindow("2026-12-01"), true);
  assert.equal(inQuarterlyRollWindow("2026-10-27"), false);
  const snap = await makeService().snapshot();
  assert.equal(pick(snap, "dxy-ice", "OI").rollWindow, true);
  assert.equal(pick(snap, "btc-cme", "OI").rollWindow, false, "monthly contracts are not flagged");
});

// ── freshness and fallback ─────────────────────────────────

test("an overdue weekly report is STALE", async () => {
  const later = () => NOW + 14 * DAY;
  const snap = await makeService({ now: later }).snapshot();
  assert.equal(snap.freshness.state, "STALE");
  assert.equal(pick(snap, "btc-cme", "OI").freshness.state, "STALE");
});

test("a CFTC outage serves the last good report, labelled CACHED, and it survives a restart", async () => {
  const store = memoryStore();
  await makeService({ store }).snapshot();
  const down = fakeProvider(() => { throw new Error("CFTC HTTP 503"); });
  // A fresh service over the same store is a restart.
  const snap = await makeService({ store, provider: down }).snapshot();
  assert.equal(snap.source.status, "CACHED");
  assert.match(snap.source.error, /503/);
  assert.equal(pick(snap, "btc-cme", "OI").changePct, -1.48);
});

test("a cached copy that is also old reads STALE, not CACHED", async () => {
  const store = memoryStore();
  await makeService({ store }).snapshot();
  const down = fakeProvider(() => { throw new Error("down"); });
  const snap = await makeService({ store, provider: down, now: () => NOW + 20 * DAY }).snapshot();
  assert.equal(snap.source.status, "STALE");
});

test("with no report and nothing saved, every row is unavailable and the page still answers", async () => {
  const down = fakeProvider(() => { throw new Error("getaddrinfo ENOTFOUND"); });
  const snap = await makeService({ store: null, provider: down }).snapshot();
  assert.equal(snap.source.status, "UNAVAILABLE");
  assert.ok(snap.rows.every((r) => r.error === "CFTC report unavailable" && r.normalizedValue === null));
  assert.equal(snap.coverage.withData, 0);
});

test("the report is fetched once and shared by both lookbacks", async () => {
  const provider = fakeProvider(() => history());
  const service = makeService({ provider });
  await service.snapshot({ lookback: "1w" });
  await service.snapshot({ lookback: "4w" });
  assert.equal(provider.calls.length, 1);
  await service.snapshot({ force: true });
  assert.equal(provider.calls.length, 2);
});

test("the payload says Daily is unavailable and why", async () => {
  const snap = await makeService().snapshot();
  const daily = snap.timeframes.find((t) => t.key === "D");
  assert.equal(daily.available, false);
  assert.match(daily.reason, /DATABENTO_API_KEY/);
  assert.deepEqual(snap.metrics.map((m) => m.type), ["OI", "COT_NET_SPEC"]);
});

// ── route ──────────────────────────────────────────────────

test("the API serves no-store JSON and never echoes the app token", async () => {
  const app = express();
  app.use("/api/cross-market-oi", createCrossMarketOiRouter({ crossMarketOiService: makeService() }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cross-market-oi?lookback=4w`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.doesNotMatch(text, /token/i);
    assert.equal(JSON.parse(text).lookback, "4W");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── catalog ────────────────────────────────────────────────

test("the catalog is consistent with the selection limits and asset-class filters", () => {
  const ids = INSTRUMENTS.map((i) => i.id);
  const codes = INSTRUMENTS.map((i) => i.contract);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.equal(new Set(codes).size, codes.length, "CFTC codes are unique");
  const classKeys = ASSET_CLASSES.map((c) => c.key);
  for (const inst of INSTRUMENTS) assert.ok(classKeys.includes(inst.assetClass), `${inst.id} has a known class`);
  for (const key of classKeys) assert.ok(INSTRUMENTS.some((i) => i.assetClass === key), `${key} has at least one market`);
  assert.equal(DEFAULT_SELECTION.length, 6, "the reference comparison is six markets");
  assert.ok(DEFAULT_SELECTION.every((id) => ids.includes(id)));
  assert.ok(DEFAULT_SELECTION.length >= MIN_SELECTION && DEFAULT_SELECTION.length <= MAX_SELECTION);
  for (const key of classKeys) {
    assert.ok(INSTRUMENTS.filter((i) => i.assetClass === key).length <= MAX_SELECTION);
  }
});

// ── daily (Databento) ──────────────────────────────────────

const { DatabentoDailyOiProvider, aggregateOpenInterest } = require("../src/services/cross-market-oi/databento-provider");

function stat(instrumentId, tsRef, quantity, extra = {}) {
  return JSON.stringify({ hd: { ts_event: `${tsRef}T22:00:00.000000000Z`, instrument_id: instrumentId }, ts_ref: `${tsRef}T00:00:00.000000000Z`, stat_type: 9, quantity, update_action: 1, ...extra });
}

test("daily open interest is summed across every expiry, keeping each expiry's last correction", () => {
  const text = [
    stat(1, "2026-09-21", 100),
    stat(2, "2026-09-21", 50),
    stat(1, "2026-09-22", 90),
    stat(1, "2026-09-22", 95), // correction for the same expiry and day
    stat(2, "2026-09-22", 60),
    stat(3, "2026-09-22", 2147483647), // undefined sentinel, never a real OI
    stat(4, "2026-09-22", 999, { update_action: 2 }), // delete
    stat(5, "2026-09-22", 999, { stat_type: 3 }), // settlement price, not OI
    "not json",
  ].join("\n");
  assert.deepEqual(aggregateOpenInterest(text), [
    { date: "2026-09-22", openInterest: 155, contracts: 2 },
    { date: "2026-09-21", openInterest: 150, contracts: 2 },
  ]);
});

test("the Databento provider asks per product with basic auth and never echoes the key", async () => {
  const seen = [];
  const provider = new DatabentoDailyOiProvider({
    apiKey: "db-secret",
    fetchImpl: async (url, init) => {
      seen.push({ url: new URL(url), init });
      if (url.includes("DX.FUT")) return { ok: false, status: 422, text: async () => JSON.stringify({ detail: "symbol not found" }) };
      return { ok: true, status: 200, text: async () => [stat(1, "2026-09-22", 10), stat(1, "2026-09-21", 8)].join("\n") };
    },
  });
  const { byId, errors } = await provider.fetchDaily([
    { id: "gold-comex", daily: { dataset: "GLBX.MDP3", parent: "GC.FUT" } },
    { id: "dxy-ice", daily: { dataset: "IFUS.IMPACT", parent: "DX.FUT" } },
  ], { startDate: "2026-09-09" });
  const gold = seen.find((s) => s.url.searchParams.get("symbols") === "GC.FUT");
  assert.equal(gold.url.searchParams.get("schema"), "statistics");
  assert.equal(gold.url.searchParams.get("stype_in"), "parent");
  assert.equal(gold.url.searchParams.get("dataset"), "GLBX.MDP3");
  assert.equal(gold.init.headers.Authorization, `Basic ${Buffer.from("db-secret:").toString("base64")}`);
  assert.equal(byId.get("gold-comex")[0].openInterest, 10);
  assert.match(errors["dxy-ice"], /HTTP 422 — symbol not found/);
  assert.doesNotMatch(JSON.stringify(errors), /db-secret/);

  await assert.rejects(new DatabentoDailyOiProvider({}).fetchDaily([], { startDate: "2026-09-01" }), /DATABENTO_API_KEY is not set/);
});

const DAILY_INSTR = INSTR.map((i) => ({ ...i, daily: { dataset: "GLBX.MDP3", parent: `${i.symbol}.FUT` } }));

function dailyProvider(impl, configured = true) {
  const calls = [];
  return { label: "Databento test", configured, calls, async fetchDaily(instruments, opts) { calls.push(opts); return impl(instruments, opts); } };
}

function sessions(values, end = "2026-09-22") {
  // Trading days only, newest first: skips weekends.
  const out = [];
  let t = Date.parse(`${end}T00:00:00Z`);
  for (const v of values) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t -= DAY;
    out.push({ date: new Date(t).toISOString().slice(0, 10), openInterest: v });
    t -= DAY;
  }
  return out;
}

function makeDailyService(daily, opts = {}) {
  return new CrossMarketOiService({
    provider: fakeProvider(() => history()),
    dailyProvider: daily,
    cache: new MemoryCache(),
    store: opts.store === undefined ? memoryStore() : opts.store,
    instruments: DAILY_INSTR,
    now: opts.now || (() => NOW),
    logger: quiet,
  });
}

test("Daily compares trading sessions: 1D is the previous session, 5D five sessions back", async () => {
  const daily = dailyProvider(() => ({
    byId: new Map([["btc-cme", sessions([110, 100, 99, 98, 97, 88])]]),
    errors: { "gold-comex": "No open-interest records for GC.FUT" },
  }));
  const service = makeDailyService(daily);
  const one = await service.snapshot({ timeframe: "D", lookback: "1d" });
  const btc = pick(one, "btc-cme", "OI");
  assert.equal(one.timeframe, "D");
  assert.equal(btc.timeframe, "D");
  assert.equal(btc.lookback, "1D");
  assert.equal(btc.observationDate, "2026-09-22");
  assert.equal(btc.previousDate, "2026-09-21");
  assert.equal(btc.changePct, 10);
  assert.equal(btc.freshness.state, "FRESH");
  assert.equal(one.source.status, "LIVE");

  const five = pick(await service.snapshot({ timeframe: "D", lookback: "5d" }), "btc-cme", "OI");
  assert.equal(five.previousDate, "2026-09-15", "five sessions back, across the weekend");
  assert.equal(five.changePct, 25);
  assert.equal(daily.calls.length, 1, "both daily lookbacks share one fetch");

  // Per-product failure is that market's error, not the page's.
  assert.match(pick(one, "gold-comex", "OI").error, /No open-interest records for GC.FUT/);
  assert.equal(pick(one, "gold-comex", "OI").normalizedValue, null);
  assert.equal(one.coverage.withData, 1);
});

test("COT positioning is never faked on Daily; it is a weekly quantity", async () => {
  const daily = dailyProvider(() => ({ byId: new Map([["btc-cme", sessions([110, 100])]]), errors: {} }));
  const snap = await makeDailyService(daily).snapshot({ timeframe: "D" });
  const cot = pick(snap, "btc-cme", "COT_NET_SPEC");
  assert.equal(cot.normalizedValue, null);
  assert.match(cot.error, /weekly only/);
  assert.deepEqual(snap.timeframes.find((t) => t.key === "D").metrics, ["OI"]);
});

test("without a key Daily is unavailable, says why, and Weekly is untouched", async () => {
  const daily = dailyProvider(() => { throw new Error("should not be called"); }, false);
  const service = makeDailyService(daily);
  const snap = await service.snapshot({ timeframe: "D" });
  assert.equal(snap.source.status, "UNAVAILABLE");
  assert.match(snap.source.error, /DATABENTO_API_KEY/);
  assert.ok(snap.rows.every((r) => r.normalizedValue === null && r.error));
  assert.equal(daily.calls.length, 0, "nothing is requested without a key");
  const weekly = await service.snapshot({ timeframe: "W" });
  assert.equal(weekly.source.status, "LIVE");
  assert.equal(weekly.timeframes.find((t) => t.key === "D").available, false);
});

test("a Databento outage serves the last good daily copy as CACHED", async () => {
  const store = memoryStore();
  await makeDailyService(dailyProvider(() => ({ byId: new Map([["btc-cme", sessions([110, 100])]]), errors: {} })), { store }).snapshot({ timeframe: "D" });
  const down = dailyProvider(() => { throw new Error("Databento HTTP 503"); });
  const snap = await makeDailyService(down, { store }).snapshot({ timeframe: "D" });
  assert.equal(snap.source.status, "CACHED");
  assert.equal(pick(snap, "btc-cme", "OI").changePct, 10);
  // The weekly report's saved copy is a separate record.
  assert.ok(store.map.has("cross-market-oi:last-good") || store.map.size >= 1);
});

test("a daily series that stopped advancing is STALE", async () => {
  const daily = dailyProvider(() => ({ byId: new Map([["btc-cme", sessions([110, 100], "2026-09-15")]]), errors: {} }));
  const snap = await makeDailyService(daily).snapshot({ timeframe: "D" });
  assert.equal(pick(snap, "btc-cme", "OI").freshness.state, "STALE");
});

test("the route passes timeframe=D through and defaults anything else to Weekly", async () => {
  const daily = dailyProvider(() => ({ byId: new Map([["btc-cme", sessions([110, 100])]]), errors: {} }));
  const app = express();
  app.use("/api/cross-market-oi", createCrossMarketOiRouter({ crossMarketOiService: makeDailyService(daily) }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/cross-market-oi`;
    assert.equal((await (await fetch(`${base}?timeframe=D&lookback=5d`)).json()).lookback, "5D");
    assert.equal((await (await fetch(`${base}?timeframe=4h`)).json()).timeframe, "W");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
