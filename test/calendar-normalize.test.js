"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCalendar, resolveEventTime, dayKey, clockInZone } = require("../src/services/calendar-normalize");
const { assessNewsRisk, scoreSetup } = require("../src/services/decision-engine");
const { MacroCalendarService, providerRows } = require("../src/services/macro-calendar");
const { MarketDataService } = require("../src/services/market-data");
const NOW = new Date("2026-08-23T12:00:00Z");
const event = (overrides = {}) => ({ title: "US CPI", date: "2026-08-23T12:30:00Z", impact: "High", country: "USD", ...overrides });
const normalize = (rows, options = {}) => normalizeCalendar(rows, { now: NOW, ...options });

test("exact instants agree in UTC, Eastern and Pacific", () => {
  const at = resolveEventTime("2026-08-23T08:30:00-04:00");
  assert.equal(at.at.toISOString(), "2026-08-23T12:30:00.000Z");
  assert.equal(at.precision, "exact");
  assert.equal(clockInZone(at.at, "UTC"), "12:30");
  assert.equal(clockInZone(at.at, "America/New_York"), "08:30");
  assert.equal(clockInZone(at.at, "America/Los_Angeles"), "05:30");
});

test("bare clocks and undated rows never receive today's date", () => {
  assert.equal(resolveEventTime(1787486400).at.toISOString(), resolveEventTime(1787486400000).at.toISOString());
  for (const raw of ["08:30", "08:30 ET", "TBA", null, {}, "2026-02-30T12:30:00Z", "2026-08-23T25:00:00Z"]) assert.equal(resolveEventTime(raw).at, null, String(raw));
  assert.equal(normalize([{ title: "CPI", time: "08:30" }]).reason, "invalid-events");
});

test("dated local clocks are assumed and DST follows the event's date", () => {
  for (const [raw, expected] of [["2026-01-15 08:30", "2026-01-15T13:30:00.000Z"], ["2026-07-15 08:30", "2026-07-15T12:30:00.000Z"]]) {
    const result = resolveEventTime(raw, { timezone: "America/New_York" });
    assert.equal(result.at.toISOString(), expected);
    assert.equal(result.precision, "assumed");
  }
  assert.equal(resolveEventTime("2026-03-08 02:30", { timezone: "America/New_York" }).at, null);
  assert.equal(resolveEventTime("2026-11-01T01:30:00-04:00").at.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(resolveEventTime("2026-11-01T01:30:00-05:00").at.toISOString(), "2026-11-01T06:30:00.000Z");
});

test("fall-back DST events sort by their actual instant, not repeated local clock labels", () => {
  const result = normalize([
    event({ title: "Later standard time", date: "2026-11-01T01:20:00-05:00" }),
    event({ title: "Earlier daylight time", date: "2026-11-01T01:50:00-04:00" }),
  ], { now: new Date("2026-11-01T04:00:00Z"), timezone: "America/New_York" });
  assert.deepEqual(result.items.map(x => x.title), ["Earlier daylight time", "Later standard time"]);
});

test("midnight filtering uses the requested zone; date-only events stay untimed", () => {
  const now = new Date("2026-08-23T01:00:00Z");
  const rows = [event({ date: "2026-08-23T01:30:00Z" }), event({ title: "Tentative", date: "2026-08-22", time: "TBA" })];
  const result = normalize(rows, { now, timezone: "America/Los_Angeles" });
  assert.equal(dayKey(now, "America/Los_Angeles"), "2026-08-22");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].time, "18:30");
  assert.equal(result.items[1].precision, "unknown");
  assert.equal(result.items[1].status, "Tentative");
});

test("rolling windows retain future events, deduplicate and remove ten-row truncation", () => {
  const rows = Array.from({ length: 15 }, (_, i) => event({ title: "Release " + i, date: `2026-08-${23 + Math.floor(i / 4)}T12:30:00Z` }));
  const result = normalize([rows[10], ...rows, event({ title: "Expired", date: "2026-08-20T12:30:00Z" })], { days: 7 });
  assert.equal(result.items.length, 15);
  assert.equal(result.items[0].country, "US");
  assert.ok(result.items.every(row => row.date >= "2026-08-23"));
  assert.equal(result.items.at(-1).date, "2026-08-26");
});

test("zero actual values survive; a passed scheduled time alone does not mean released", () => {
  const result = normalize([event({ actual: 0, forecast: "2.0%", previous: "2.1%" }), event({ title: "Pending actual", date: "2026-08-23T11:30:00Z" })]);
  assert.equal(result.items[0].status, "Delayed");
  assert.equal(result.items[1].status, "Released");
  assert.equal(result.items[1].actual, "0");
  assert.equal(result.items[1].verified, true);
  assert.equal(normalizeCalendar(null).reason, "invalid-shape");
  assert.equal(normalizeCalendar([]).reason, "empty-feed");
});

test("Trading Economics UTC dates, numeric importance and DateSpan are respected", () => {
  const rows = providerRows([{ CalendarID: "123", Date: "2026-08-23T12:30:00", Event: "CPI", Country: "United States", Importance: 3, DateSpan: "0", Actual: "2%" }], "tradingeconomics");
  const normalized = normalize(rows).items[0];
  assert.equal(normalized.at, "2026-08-23T12:30:00.000Z");
  assert.equal(normalized.precision, "exact");
  assert.equal(normalized.impact, "High");
  rows[0].precision = "assumed";
  assert.equal(normalize(rows).items[0].verified, false);
});

test("healthy empty feeds remain live; unavailable calendars have no sample events", async () => {
  const missing = await new MarketDataService({ calendarUrl: "" }).getCalendar({ now: NOW });
  assert.equal(missing.live, false);
  assert.deepEqual(missing.items, []);
  const service = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => [] });
  const result = await service.get({ now: NOW });
  assert.equal(result.live, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.reason, null);
});

test("concurrent consumers and date filters share one cached fetch", async () => {
  let requests = 0;
  const service = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => { requests++; return [event()]; } });
  const results = await Promise.all([service.get({ now: NOW }), service.get({ now: NOW, days: 14 }), service.get({ now: NOW, timezone: "America/New_York" })]);
  assert.equal(requests, 1);
  assert.equal(results[2].items[0].time, "08:30");
});

test("failed refreshes preserve real stale data only until its original age limit", async () => {
  let fail = false;
  const service = new MacroCalendarService({ config: { calendarUrl: "https://feed.test?key=secret", calendarCacheMs: 60_000, calendarStaleMs: 180_000 }, fetchJson: async () => { if (fail) throw new Error("secret provider details"); return [event()]; } });
  const first = await service.get({ now: NOW });
  fail = true;
  const stale = await service.get({ now: new Date(+NOW + 70_000) });
  assert.equal(stale.stale, true);
  assert.equal(stale.live, false);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.ok(!JSON.stringify(stale).includes("secret"));
  const expired = await service.get({ now: new Date(+NOW + 181_000) });
  assert.deepEqual(expired.items, []);
  assert.equal(expired.stale, false);
});

test("rate limits honor Retry-After; malformed and timed-out feeds are distinct", async () => {
  let requests = 0;
  const limited = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => { requests++; throw { statusCode: 429, retryAfterMs: 600_000 }; } });
  assert.equal((await limited.get({ now: NOW })).reason, "rate-limited");
  await limited.get({ now: new Date(+NOW + 300_000) });
  assert.equal(requests, 1);
  for (const [body, reason] of [[null, "invalid-shape"], [{ events: "bad" }, "invalid-shape"], [[{ title: "Undated" }], "invalid-events"]]) {
    const service = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => body });
    assert.equal((await service.get({ now: NOW })).reason, reason);
  }
  const timeout = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => { throw { statusCode: 408 }; } });
  assert.equal((await timeout.get({ now: NOW })).reason, "timeout");
});

test("yesterday expires at midnight even before the snapshot's TTL", async () => {
  const service = new MacroCalendarService({ config: { calendarUrl: "https://feed.test" }, fetchJson: async () => [event({ date: "2026-08-23T23:59:00Z" })] });
  await service.get({ now: new Date("2026-08-23T23:58:00Z") });
  assert.equal((await service.get({ now: new Date("2026-08-24T00:01:00Z") })).items.length, 0);
});

test("only exact verified fresh instants trigger news blackout windows", () => {
  const row = normalize([event()]).items[0];
  assert.equal(assessNewsRisk([row], NOW).level, "high");
  for (const patch of [{ precision: "assumed" }, { precision: "unknown" }, { verified: false }, { stale: true }, { at: null }]) {
    const risk = assessNewsRisk([{ ...row, ...patch }], NOW);
    assert.notEqual(risk.level, "high");
    assert.doesNotMatch(risk.reason, /in \d+ min/);
  }
  for (const quality of [{ live: false }, { live: true, stale: true }, { live: true, expiresAt: NOW.toISOString() }]) {
    const risk = assessNewsRisk([row], NOW, quality);
    assert.equal(risk.level, "unknown");
    assert.equal(risk.available, false);
    assert.equal(risk.nextHighImpact, null);
    assert.match(scoreSetup({ signal: "LONG", screenerScore: 99, adx: 40, regime: { score: 90, label: "Risk-On" }, newsRisk: risk }).action, /verify calendar/);
  }
  assert.equal(assessNewsRisk([], NOW, { live: true }).level, "low");
});

test("an exact event just across midnight is inside the blackout window", () => {
  const now = new Date("2026-08-23T23:50:00Z");
  const row = normalize([event({ date: "2026-08-24T00:10:00Z" })], { now, days: 2 }).items[0];
  assert.equal(assessNewsRisk([row], now).level, "high");
});

test("provider-declared tentative/delayed releases cannot create verified countdowns", () => {
  for (const status of ["Tentative", "Delayed"]) {
    const row = normalize([event({ status, actual: "null" })]).items[0];
    assert.equal(row.verified, false);
    assert.equal(row.actual, null);
    assert.notEqual(assessNewsRisk([row], NOW).level, "high");
  }
});

test("the real HTTP timeout returns unavailable without leaking the provider URL", async t => {
  const http = require("node:http");
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const service = new MarketDataService({ calendarUrl: `http://127.0.0.1:${server.address().port}/?key=secret`, requestTimeoutMs: 30 });
  const result = await service.getCalendar({ now: NOW });
  assert.equal(result.reason, "timeout");
  assert.deepEqual(result.items, []);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
