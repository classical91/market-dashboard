"use strict";

// Cross-Market Open Interest — accuracy audit.
//
// Every displayed value must trace to a known observation, be computed from
// comparable observations, carry its dates and scope, and be missing (with a
// reason) rather than fabricated. These tests pin that down per failure mode,
// plus the ES case that prompted the audit: +18.08% on the page against
// roughly −0.15% on a TradingView S&P 500 reference.
const test = require("node:test");
const assert = require("node:assert");

const { CrossMarketOiService, oiChange, quarterlyRollExpiry } = require("../src/services/cross-market-oi/service");
const { aggregateOpenInterest, isSpreadSymbol } = require("../src/services/cross-market-oi/databento-provider");
const { MemoryCache } = require("../src/services/cache");
const { INSTRUMENTS } = require("../src/config/cross-market-oi");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12); // Tue 22 Sep 2026
const quiet = { log() {}, warn() {}, error() {} };

const ES_NAME = "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE";

function week(date, oi, name = "TEST - EXCHANGE") {
  return { date, marketAndExchange: name, openInterest: oi, nonCommLong: 100, nonCommShort: 50, commLong: 0, commShort: 0 };
}

const ES = INSTRUMENTS.find((i) => i.id === "sp500-cme");
const GOLD = INSTRUMENTS.find((i) => i.id === "gold-comex");

function memoryStore() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, JSON.parse(JSON.stringify(v))), map };
}

function weeklyService(byCode, opts = {}) {
  return new CrossMarketOiService({
    provider: { label: "CFTC test", async fetchWeekly() { if (byCode instanceof Error) throw byCode; return new Map(Object.entries(byCode)); } },
    cache: new MemoryCache(),
    store: opts.store === undefined ? memoryStore() : opts.store,
    instruments: opts.instruments || [ES, GOLD],
    now: opts.now || (() => NOW),
    logger: quiet,
  });
}

function dailyService(byId, opts = {}) {
  return new CrossMarketOiService({
    provider: { label: "CFTC test", async fetchWeekly() { return new Map(); } },
    dailyProvider: { label: "Databento test", configured: true, async fetchDaily() { return { byId: new Map(Object.entries(byId)), errors: {} }; } },
    cache: new MemoryCache(),
    store: memoryStore(),
    instruments: opts.instruments || [ES, GOLD],
    now: opts.now || (() => NOW),
    logger: quiet,
  });
}

function oi(snap, id) {
  return snap.rows.find((r) => r.id === id && r.metricType === "OI");
}

// ── the calculation ────────────────────────────────────────

test("OI change is ((current − previous) / previous) × 100: positive, negative and zero", () => {
  assert.deepEqual(oiChange({ openInterest: 110 }, { openInterest: 100 }), { change: 10, changePct: 10, valueStatus: "OK" });
  assert.deepEqual(oiChange({ openInterest: 90 }, { openInterest: 100 }), { change: -10, changePct: -10, valueStatus: "OK" });
  assert.deepEqual(oiChange({ openInterest: 100 }, { openInterest: 100 }), { change: 0, changePct: 0, valueStatus: "OK" });
});

test("no previous observation, or a missing previous OI, is insufficient history — never 0", () => {
  assert.deepEqual(oiChange({ openInterest: 100 }, null), { change: null, changePct: null, valueStatus: "INSUFFICIENT_HISTORY" });
  assert.deepEqual(oiChange({ openInterest: 100 }, { openInterest: null }), { change: null, changePct: null, valueStatus: "INSUFFICIENT_HISTORY" });
});

test("a zero previous OI gives no percentage (division by zero is not +∞ or 0)", () => {
  const r = oiChange({ openInterest: 100 }, { openInterest: 0 });
  assert.equal(r.changePct, null);
  assert.equal(r.valueStatus, "ZERO_BASE");
  assert.equal(r.change, 100, "the contract change itself is still known");
});

test("a zero-base week is shown as missing with the reason", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 1000, ES_NAME), week("2026-09-08", 0, ES_NAME)] }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(es.normalizedValue, null);
  assert.equal(es.valueStatus, "ZERO_BASE");
  assert.match(es.statusReason, /was 0/);
  assert.equal(snap.coverage.withData, 0, "a row with no plotted value is not counted as data");
  assert.equal(snap.coverage.reported, 1);
});

// ── missing observations ───────────────────────────────────

test("a missing current observation is an unavailable row of nulls", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 1000, ES_NAME), week("2026-09-08", 900, ES_NAME)] }).snapshot();
  const gold = oi(snap, "gold-comex");
  assert.equal(gold.valueStatus, "UNAVAILABLE");
  for (const k of ["currentValue", "previousValue", "change", "changePct", "normalizedValue", "observationDate", "comparisonDate"]) assert.equal(gold[k], null, k);
});

test("a missing previous observation says so, and the current OI stays traceable", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 1000, ES_NAME)] }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(es.currentValue, 1000);
  assert.equal(es.observationDate, "2026-09-15");
  assert.equal(es.comparisonDate, null);
  assert.equal(es.normalizedValue, null);
  assert.equal(es.valueStatus, "INSUFFICIENT_HISTORY");
  assert.match(es.statusReason, /No CFTC report 1 week before 2026-09-15/);
});

// ── date boundaries ────────────────────────────────────────

test("date boundaries: a holiday-shifted report (±2 days) compares, a 3-day miss does not", async () => {
  const shifted = await weeklyService({ "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-09", 100, ES_NAME)] }).snapshot();
  assert.equal(oi(shifted, "sp500-cme").comparisonDate, "2026-09-09");
  assert.equal(oi(shifted, "sp500-cme").changePct, 10);
  const off = await weeklyService({ "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-11", 100, ES_NAME)] }).snapshot();
  assert.equal(oi(off, "sp500-cme").normalizedValue, null, "4 days off the target week is not that week");
});

test("daily: a session missing from the series refuses the comparison instead of stretching it", async () => {
  // 22 Sep vs 15 Sep for 1D: the sessions between are missing.
  const snap = await dailyService({ "sp500-cme": [{ date: "2026-09-22", openInterest: 110, contracts: 3 }, { date: "2026-09-15", openInterest: 100, contracts: 3 }] })
    .snapshot({ timeframe: "D", lookback: "1d" });
  const es = oi(snap, "sp500-cme");
  assert.equal(es.normalizedValue, null);
  assert.equal(es.valueStatus, "INSUFFICIENT_HISTORY");
  assert.match(es.statusReason, /a session is missing/);
  // Friday → Monday is one session.
  const weekend = await dailyService({ "sp500-cme": [{ date: "2026-09-21", openInterest: 110 }, { date: "2026-09-18", openInterest: 100 }] })
    .snapshot({ timeframe: "D", lookback: "1d" });
  assert.equal(oi(weekend, "sp500-cme").changePct, 10);
});

// ── staleness and fallback ─────────────────────────────────

test("a market behind the rest of the report is STALE, not presented as concurrent", async () => {
  const snap = await weeklyService({
    "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-08", 100, ES_NAME)],
    "088691": [week("2026-09-08", 500, "GOLD - COMMODITY EXCHANGE INC."), week("2026-09-01", 400, "GOLD - COMMODITY EXCHANGE INC.")],
  }).snapshot();
  const gold = oi(snap, "gold-comex");
  assert.equal(gold.isStale, true);
  assert.equal(gold.freshness.state, "STALE");
  assert.match(gold.freshness.reason, /as of 2026-09-08; other markets are as of 2026-09-15/);
  assert.equal(gold.changePct, 25, "the value stays traceable to its own dates");
  assert.equal(oi(snap, "sp500-cme").isStale, false);
});

test("an old observation is STALE on its own row", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-08", 100, ES_NAME)] }, { now: () => NOW + 14 * DAY }).snapshot();
  assert.equal(oi(snap, "sp500-cme").isStale, true);
});

test("provider failure with nothing saved: unavailable, no numbers, no fallback flag", async () => {
  const snap = await weeklyService(new Error("CFTC HTTP 503"), { store: null }).snapshot();
  assert.equal(snap.source.status, "UNAVAILABLE");
  for (const row of snap.rows) {
    assert.equal(row.normalizedValue, null);
    assert.equal(row.isFallback, false);
    assert.equal(row.retrievedAt, null);
  }
});

test("cached/fallback data is marked on every row with when it was retrieved", async () => {
  const store = memoryStore();
  const live = await weeklyService({ "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-08", 100, ES_NAME)] }, { store }).snapshot();
  assert.equal(oi(live, "sp500-cme").isFallback, false);
  assert.equal(oi(live, "sp500-cme").retrievedAt, new Date(NOW).toISOString());
  const later = () => NOW + 2 * 60 * 60 * 1000;
  const snap = await weeklyService(new Error("CFTC HTTP 503"), { store, now: later }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(snap.source.status, "CACHED");
  assert.equal(es.isFallback, true);
  assert.equal(es.retrievedAt, new Date(NOW).toISOString(), "retrievedAt is the original fetch, not now");
  assert.equal(es.changePct, 10);
});

// ── market identity ────────────────────────────────────────

test("symbol mapping: the reference six map to the intended CFTC markets", () => {
  // Names as the CFTC Legacy report prints them for these codes.
  const expected = {
    "btc-cme": ["133741", "BITCOIN - CHICAGO MERCANTILE EXCHANGE"],
    "dxy-ice": ["098662", "USD INDEX - ICE FUTURES U.S."],
    "gold-comex": ["088691", "GOLD - COMMODITY EXCHANGE INC."],
    "natgas-nymex": ["023651", "NAT GAS NYME - NEW YORK MERCANTILE EXCHANGE"],
    "sp500-cme": ["13874A", ES_NAME],
    "rty-cme": ["239742", "RUSSELL E-MINI - CHICAGO MERCANTILE EXCHANGE"],
  };
  for (const [id, [code, name]] of Object.entries(expected)) {
    const inst = INSTRUMENTS.find((i) => i.id === id);
    assert.equal(inst.contract, code, `${id} code`);
    assert.ok(new RegExp(inst.cftcName, "i").test(name), `${id} accepts "${name}"`);
  }
  // Similar-looking markets are refused.
  assert.ok(!new RegExp(ES.cftcName, "i").test("MICRO E-MINI S&P 500 INDEX - CHICAGO MERCANTILE EXCHANGE"));
  assert.ok(!new RegExp(ES.cftcName, "i").test("S&P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE"));
  const btc = INSTRUMENTS.find((i) => i.id === "btc-cme");
  assert.ok(!new RegExp(btc.cftcName, "i").test("MICRO BITCOIN - CHICAGO MERCANTILE EXCHANGE"));
  const rty = INSTRUMENTS.find((i) => i.id === "rty-cme");
  assert.ok(!new RegExp(rty.cftcName, "i").test("MICRO E-MINI RUSSELL 2000 INDEX - CHICAGO MERCANTILE EXCHANGE"));
});

test("a code that reports a different market is refused, not plotted under this label", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 110, "MICRO E-MINI S&P 500 INDEX - CHICAGO MERCANTILE EXCHANGE"), week("2026-09-08", 100, ES_NAME)] }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(es.valueStatus, "IDENTITY_MISMATCH");
  assert.equal(es.identityVerified, false);
  assert.equal(es.normalizedValue, null);
  assert.match(es.error, /not E-mini S&P 500/);
});

test("an older report under another name is never the base of a comparison", async () => {
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 110, ES_NAME), week("2026-09-08", 100, "SOMETHING ELSE - CME")] }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(es.identityVerified, true);
  assert.equal(es.normalizedValue, null);
  assert.equal(es.valueStatus, "INSUFFICIENT_HISTORY");
});

// ── expiry and roll ────────────────────────────────────────

test("contract roll: a comparison that spans the roll is flagged even when today is clear of it", () => {
  // Third Friday of September 2026 is the 18th; window 28 Aug – 25 Sep.
  assert.equal(quarterlyRollExpiry("2026-09-15"), "2026-09-18");
  assert.equal(quarterlyRollExpiry("2026-10-13"), null);
  assert.equal(quarterlyRollExpiry("2026-09-15", "2026-10-13"), "2026-09-18", "4W change from inside the window");
  assert.equal(quarterlyRollExpiry("2026-10-06", "2026-10-13"), null);
});

test("contract expiration: summing expiries keeps a roll from reading as a collapse and an explosion", () => {
  // Old contract 1.5M → 400K, next contract 300K → 1.4M: positions moved.
  const line = (id, symbol, date, q) => JSON.stringify({ hd: { ts_event: `${date}T22:00:00Z`, instrument_id: id }, ts_ref: `${date}T00:00:00Z`, symbol, stat_type: 9, quantity: q, update_action: 1 });
  const rows = aggregateOpenInterest([
    line(1, "ESU6", "2026-09-08", 1500000), line(2, "ESZ6", "2026-09-08", 300000),
    line(1, "ESU6", "2026-09-15", 400000), line(2, "ESZ6", "2026-09-15", 1400000),
    // A calendar spread reporting OI would double-count the same positions.
    line(3, "ESU6-ESZ6", "2026-09-15", 250000),
  ].join("\n"));
  assert.deepEqual(rows, [
    { date: "2026-09-15", openInterest: 1800000, contracts: 2 },
    { date: "2026-09-08", openInterest: 1800000, contracts: 2 },
  ]);
  assert.equal(oiChange(rows[0], rows[1]).changePct, 0);
  assert.equal(isSpreadSymbol("ESU6-ESZ6"), true);
  assert.equal(isSpreadSymbol("UD:1V: VT 0915 12345"), true);
  assert.equal(isSpreadSymbol("ESZ6"), false);
  assert.equal(isSpreadSymbol(undefined), false);
});

test("a Databento delete withdraws that expiry's figure instead of leaving it summed", () => {
  const line = (id, q, action) => JSON.stringify({ hd: { ts_event: "2026-09-22T22:00:00Z", instrument_id: id }, ts_ref: "2026-09-22T00:00:00Z", stat_type: 9, quantity: q, update_action: action });
  assert.deepEqual(aggregateOpenInterest([line(1, 100, 1), line(2, 50, 1), line(2, 50, 2)].join("\n")), [{ date: "2026-09-22", openInterest: 100, contracts: 1 }]);
});

// ── regression: ES +18.08% vs a TradingView reference of ≈ −0.15% ──

test("ES +18.08% is the CFTC all-expiry weekly change, labelled and flagged as a roll-week reading", async () => {
  // The CFTC figure for 13874A is every ES expiry combined, Tuesday to
  // Tuesday. In the September roll week both the expiring and the next
  // contract are open, so the combined total swells; a front-contract (ES1!)
  // daily figure moves very differently. The number is not changed to match
  // a reference that measures something else — it is labelled.
  const snap = await weeklyService({ "13874A": [week("2026-09-15", 2361600, ES_NAME), week("2026-09-08", 2000000, ES_NAME)] }).snapshot();
  const es = oi(snap, "sp500-cme");
  assert.equal(es.changePct, 18.08);
  assert.equal(es.normalizedValue, 18.08);
  assert.equal(es.valueStatus, "OK");
  assert.equal(es.contractScope, "ALL_EXPIRIES");
  assert.equal(es.expiration, null, "an all-expiry total has no single expiration");
  assert.equal(es.source, "CFTC COT · Legacy, Futures Only");
  assert.equal(es.contract, "13874A");
  assert.equal(es.reportName, ES_NAME);
  assert.equal(es.identityVerified, true);
  assert.equal(es.observationDate, "2026-09-15");
  assert.equal(es.comparisonDate, "2026-09-08");
  assert.equal(es.rollWindow, true);
  assert.equal(es.rollExpiry, "2026-09-18");
  assert.equal(es.isPreliminary, null, "the CFTC gives no preliminary flag; unknown, not asserted");
  const metric = snap.metrics.find((m) => m.type === "OI");
  assert.match(metric.label, /all expiries/i);
  assert.match(metric.plotted, /every listed expiry combined/);
});
