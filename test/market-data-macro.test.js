"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { MarketDataService } = require("../src/services/market-data");

function withMockedFetch(responder, run) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const body = responder(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = originalFetch;
    });
}

test("getMacro falls back when no provider is configured", async () => {
  const service = new MarketDataService({
    finnhubApiKey: "-",
    macroProvider: "none",
  });
  const result = await service.getMacro();
  assert.equal(result.live, false);
  assert.equal(result.source, "fallback");
  const symbols = result.items.map((item) => item.symbol);
  assert.ok(symbols.includes("DXY"));
  assert.ok(symbols.includes("VIX"));
});

test("getMacro uses MACRO_DATA_URL and normalizes rows", async () => {
  const service = new MarketDataService({ macroUrl: "https://feed.test/macro" });
  const result = await withMockedFetch(
    () => ({
      items: [
        { symbol: "dxy", name: "Dollar Index", price: 103.2, changePercent: -0.4 },
        { ticker: "VIX", value: 15.5, change_percent: 1.2 },
        { symbol: "BAD" },
      ],
    }),
    () => service.getMacro(),
  );
  assert.equal(result.live, true);
  assert.equal(result.source, "macro_data_url");
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.symbol),
    ["DXY", "VIX"],
  );
  assert.equal(result.items[1].price, 15.5);
  assert.equal(result.items[1].changePercent, 1.2);
});

test("getMacro quotes Finnhub instruments and flags ETF proxies", async () => {
  const service = new MarketDataService({ finnhubApiKey: "test-key" });
  const result = await withMockedFetch(
    (url) => {
      if (url.includes("symbol=UUP")) return { c: 28.4, dp: -0.31 };
      if (url.includes("symbol=GLD")) return { c: 215.2, dp: 0.5 };
      return { c: 0, dp: 0 };
    },
    () => service.getMacro(),
  );
  assert.equal(result.live, true);
  assert.equal(result.source, "finnhub");
  const dxy = result.items.find((item) => item.symbol === "DXY");
  assert.equal(dxy.price, 28.4);
  assert.equal(dxy.changePercent, -0.31);
  assert.equal(dxy.proxy, true);
  // Rows whose quote came back empty keep the static seed values.
  const vix = result.items.find((item) => item.symbol === "VIX");
  assert.equal(vix.price, 14.72);
});

test("MACRO_SYMBOLS overrides instruments and marks non-proxy provider symbols", async () => {
  const service = new MarketDataService({
    finnhubApiKey: "test-key",
    macroSymbols: "XAU=OANDA:XAU_USD,DXY=UUP",
  });
  const result = await withMockedFetch(
    (url) => (url.includes("XAU_USD") ? { c: 2411.5, dp: 0.8 } : { c: 28.1, dp: 0.1 }),
    () => service.getMacro(),
  );
  const gold = result.items.find((item) => item.symbol === "XAU");
  assert.equal(gold.price, 2411.5);
  assert.ok(!gold.proxy);
  const dxy = result.items.find((item) => item.symbol === "DXY");
  assert.equal(dxy.proxy, true);
});

test("getCalendar falls back without MACRO_CALENDAR_URL", async () => {
  const service = new MarketDataService({});
  const result = await service.getCalendar();
  assert.equal(result.live, false);
  assert.equal(result.source, "fallback");
  assert.ok(result.items.length > 0);
});

// Events now carry `at` — a resolved UTC instant — rather than a bare clock
// label, and anything dated to another day is dropped rather than posing as
// today's. `now` is injected so the fixture's date is the day under test.
test("getCalendar normalizes a JSON calendar feed", async () => {
  const now = new Date("2026-07-06T12:00:00Z");
  const service = new MarketDataService({ calendarUrl: "https://feed.test/calendar" });
  const result = await withMockedFetch(
    () => ({
      events: [
        { time: "08:30", event: "US CPI", importance: "high", country: "US" },
        { datetime: "2026-07-06T14:00:00Z", title: "Fed Speaker", impact: "HIGH" },
        { title: "Minor print", impact: "weird-value" },
        { notitle: true },
      ],
    }),
    () => service.getCalendar({ now }),
  );
  assert.equal(result.live, true);
  assert.equal(result.source, "macro_calendar_url");
  assert.equal(result.items.length, 3);

  const cpi = result.items.find((item) => item.title === "US CPI");
  assert.equal(cpi.time, "08:30");
  assert.equal(cpi.impact, "High");
  assert.equal(cpi.country, "US");
  // No zone configured, so a bare label is read as UTC — and said to be assumed.
  assert.equal(cpi.at, "2026-07-06T08:30:00.000Z");
  assert.equal(cpi.precision, "assumed");

  const fed = result.items.find((item) => item.title === "Fed Speaker");
  assert.equal(fed.time, "14:00");
  assert.equal(fed.impact, "High");
  assert.equal(fed.at, "2026-07-06T14:00:00.000Z");
  assert.equal(fed.precision, "exact", "an explicit Z offset needs no assumption");

  const minor = result.items.find((item) => item.title === "Minor print");
  assert.equal(minor.impact, "Low");
  assert.equal(minor.at, null, "no time given means no instant invented");
});

test("getCalendar reports fallback with the error when the feed fails", async () => {
  const service = new MarketDataService({ calendarUrl: "https://feed.test/calendar" });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("boom");
  };
  try {
    const result = await service.getCalendar();
    assert.equal(result.live, false);
    assert.equal(result.source, "fallback");
    assert.match(result.error, /boom/);
  } finally {
    global.fetch = originalFetch;
  }
});
