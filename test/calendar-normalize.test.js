"use strict";

// The calendar feeds news risk, and news risk gates whether a setup is worth
// trading. So "what instant is this event?" has to have one right answer.
//
// The old normalizer kept clock labels as supplied and assessNewsRisk compared
// them against UTC, so 08:30 ET was scored as 08:30 UTC — a blackout window
// four or five hours from the release. These pin the resolution rules and,
// just as importantly, the cases where the honest answer is "unknown".

const test = require("node:test");
const assert = require("node:assert");

const { normalizeCalendar, resolveEventTime, dayKey } = require("../src/services/calendar-normalize");
const { assessNewsRisk } = require("../src/services/decision-engine");

// 2026-08-23 is during US daylight saving: New York is UTC-4, London UTC+1.
const NOW = new Date("2026-08-23T12:00:00.000Z");

function feed(rows) {
  return { events: rows };
}

// ── Resolution ──────────────────────────────────────────────────────────────

test("an ISO timestamp with an offset is taken exactly as given", () => {
  const { at, precision } = resolveEventTime("2026-08-23T08:30:00-04:00", { timezone: "UTC", now: NOW });
  assert.equal(at.toISOString(), "2026-08-23T12:30:00.000Z");
  assert.equal(precision, "exact");
});

test("a Z timestamp is exact", () => {
  const { at, precision } = resolveEventTime("2026-08-23T12:30:00Z", { timezone: "America/New_York", now: NOW });
  assert.equal(at.toISOString(), "2026-08-23T12:30:00.000Z");
  assert.equal(precision, "exact", "an explicit offset must not be overridden by the configured zone");
});

test("epoch seconds and milliseconds both resolve exactly", () => {
  const seconds = resolveEventTime(1787486400, { timezone: "UTC", now: NOW });
  const millis = resolveEventTime(1787486400000, { timezone: "UTC", now: NOW });
  assert.equal(seconds.at.toISOString(), millis.at.toISOString());
  assert.equal(seconds.precision, "exact");
});

// The bug, stated directly: a US release at 08:30 ET is 12:30 UTC, not 08:30.
test("a bare clock label is read in the configured feed timezone, not as UTC", () => {
  const { at, precision } = resolveEventTime("08:30", { timezone: "America/New_York", now: NOW });
  assert.equal(at.toISOString(), "2026-08-23T12:30:00.000Z");
  assert.equal(precision, "assumed");
});

test("a zone suffix on the value wins over the configured default", () => {
  const { at } = resolveEventTime("08:30 ET", { timezone: "UTC", now: NOW });
  assert.equal(at.toISOString(), "2026-08-23T12:30:00.000Z", "ET must beat a UTC default");
});

test("UTC-labelled and unlabelled UTC agree", () => {
  const labelled = resolveEventTime("14:00 UTC", { timezone: "America/New_York", now: NOW });
  const plain = resolveEventTime("14:00", { timezone: "UTC", now: NOW });
  assert.equal(labelled.at.toISOString(), plain.at.toISOString());
});

test("a date and wall-clock time with no offset uses the resolved zone", () => {
  const { at, precision } = resolveEventTime("2026-08-23 09:45", { timezone: "Europe/London", now: NOW });
  assert.equal(at.toISOString(), "2026-08-23T08:45:00.000Z", "London is UTC+1 in August");
  assert.equal(precision, "assumed");
});

// Offsets are not constants. A January release at 08:30 ET is 13:30 UTC, not
// 12:30 — reading DST off the instant is the whole point of resolving properly.
test("the zone offset is taken at the event's own date, so DST is handled", () => {
  const winter = new Date("2026-01-15T12:00:00.000Z");
  const { at } = resolveEventTime("08:30", { timezone: "America/New_York", now: winter });
  assert.equal(at.toISOString(), "2026-01-15T13:30:00.000Z");
});

test("garbage resolves to unknown rather than to some invented instant", () => {
  for (const value of ["", "  ", "not a time", null, undefined, "99:99", {}]) {
    const { at, precision } = resolveEventTime(value, { timezone: "UTC", now: NOW });
    assert.equal(at, null, `${JSON.stringify(value)} must not produce an instant`);
    assert.equal(precision, "unknown");
  }
});

// ── Normalization ───────────────────────────────────────────────────────────

test("events are normalized with an instant, a display time and their zone", () => {
  const { items, reason } = normalizeCalendar(
    feed([{ time: "08:30", title: "US CPI", impact: "High" }]),
    { timezone: "America/New_York", now: NOW },
  );
  assert.equal(reason, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, "2026-08-23T12:30:00.000Z");
  assert.equal(items[0].time, "08:30", "display stays in the feed's own zone");
  assert.equal(items[0].timezone, "America/New_York");
  assert.equal(items[0].precision, "assumed");
  assert.equal(items[0].impact, "High");
});

// The other half of the old bug: a full ISO datetime was truncated to HH:MM,
// so the date was thrown away and yesterday looked exactly like today.
test("an event on another day is dropped, not treated as today's", () => {
  const { items, reason, dropped } = normalizeCalendar(
    feed([
      { time: "2026-08-22T12:30:00Z", title: "Yesterday CPI", impact: "High" },
      { time: "2026-08-24T12:30:00Z", title: "Tomorrow CPI", impact: "High" },
    ]),
    { timezone: "UTC", now: NOW },
  );
  assert.deepEqual(items, []);
  assert.equal(reason, "no-events-today");
  assert.equal(dropped, 2);
});

test("today's events survive alongside dropped ones", () => {
  const { items, dropped } = normalizeCalendar(
    feed([
      { time: "2026-08-22T12:30:00Z", title: "Yesterday", impact: "High" },
      { time: "2026-08-23T14:00:00Z", title: "Today", impact: "High" },
    ]),
    { timezone: "UTC", now: NOW },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Today");
  assert.equal(dropped, 1);
});

test("a split date and time field are joined rather than losing the date", () => {
  const { items } = normalizeCalendar(
    feed([{ date: "2026-08-23", time: "08:30", title: "US CPI", impact: "High" }]),
    { timezone: "America/New_York", now: NOW },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].at, "2026-08-23T12:30:00.000Z");
});

test("an event with no usable time is kept but carries no instant", () => {
  const { items } = normalizeCalendar(
    feed([{ time: "TBA", title: "Fed Speaker", impact: "High" }]),
    { timezone: "UTC", now: NOW },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].at, null);
  assert.equal(items[0].precision, "unknown");
  assert.equal(items[0].time, "--");
});

test("events are ordered by time, untimed ones last", () => {
  const { items } = normalizeCalendar(
    feed([
      { time: "2026-08-23T18:00:00Z", title: "Late", impact: "High" },
      { time: "TBA", title: "Untimed", impact: "High" },
      { time: "2026-08-23T09:00:00Z", title: "Early", impact: "High" },
    ]),
    { timezone: "UTC", now: NOW },
  );
  assert.deepEqual(items.map((item) => item.title), ["Early", "Late", "Untimed"]);
});

test("malformed and empty feeds are distinguished from each other", () => {
  assert.equal(normalizeCalendar({ events: "nope" }, { now: NOW }).reason, "invalid-shape");
  assert.equal(normalizeCalendar(null, { now: NOW }).reason, "empty-feed");
  assert.equal(normalizeCalendar({ events: [] }, { now: NOW }).reason, "empty-feed");
  assert.equal(normalizeCalendar([], { now: NOW }).reason, "empty-feed");
});

test("an invalid configured timezone falls back to UTC rather than throwing", () => {
  const { items } = normalizeCalendar(
    feed([{ time: "08:30", title: "US CPI", impact: "High" }]),
    { timezone: "Not/AZone", now: NOW },
  );
  assert.equal(items[0].timezone, "UTC");
  assert.equal(items[0].at, "2026-08-23T08:30:00.000Z");
});

test("dayKey reports the calendar day in the given zone, not UTC", () => {
  // 01:30 UTC on the 23rd is still the 22nd in New York.
  const instant = new Date("2026-08-23T01:30:00.000Z");
  assert.equal(dayKey(instant, "UTC"), "2026-08-23");
  assert.equal(dayKey(instant, "America/New_York"), "2026-08-22");
});

// ── News risk, off real instants ────────────────────────────────────────────

function highImpact(at, title = "US CPI") {
  return { at, time: "08:30", timezone: "America/New_York", precision: "assumed", title, impact: "High" };
}

test("an event inside the pre-release window reads high", () => {
  const risk = assessNewsRisk([highImpact("2026-08-23T12:30:00.000Z")], NOW);
  assert.equal(risk.level, "high");
  assert.match(risk.reason, /in 30 min/);
});

test("an event that just landed still reads high", () => {
  const risk = assessNewsRisk([highImpact("2026-08-23T11:50:00.000Z")], NOW);
  assert.equal(risk.level, "high");
  assert.match(risk.reason, /10 min ago/);
});

test("an event well past its window no longer suppresses trading", () => {
  const risk = assessNewsRisk([highImpact("2026-08-23T09:00:00.000Z")], NOW);
  assert.equal(risk.level, "low");
  assert.match(risk.reason, /all released/);
});

test("an event later today reads medium, not high", () => {
  const risk = assessNewsRisk([highImpact("2026-08-23T18:00:00.000Z")], NOW);
  assert.equal(risk.level, "medium");
});

// The regression, end to end: with the old clock-label comparison an 08:30 ET
// event was read as 08:30 UTC — 3.5 hours before `now` — and so scored as long
// past. It is actually 30 minutes away and must read high.
test("an 08:30 ET event 30 minutes out is not mistaken for one already passed", () => {
  const { items } = normalizeCalendar(
    feed([{ time: "08:30 ET", title: "US CPI", impact: "High" }]),
    { timezone: "UTC", now: NOW },
  );
  const risk = assessNewsRisk(items, NOW);
  assert.equal(risk.level, "high", `expected high, got ${risk.level}: ${risk.reason}`);
  assert.match(risk.reason, /in 30 min/);
});

// A countdown to an event whose time nobody published is fabricated. It should
// caution, never claim precision.
test("an untimed high-impact event raises caution without inventing a countdown", () => {
  const risk = assessNewsRisk(
    [{ at: null, time: "--", precision: "unknown", title: "Fed Speaker", impact: "High" }],
    NOW,
  );
  assert.equal(risk.level, "medium");
  assert.match(risk.reason, /no published time/);
  assert.doesNotMatch(risk.reason, /\bin -?\d+ min\b/);
});

test("no high-impact events reads low", () => {
  const risk = assessNewsRisk([{ at: null, title: "Consumer Sentiment", impact: "Medium" }], NOW);
  assert.equal(risk.level, "low");
  assert.equal(risk.nextHighImpact, null);
});

test("the nearest event wins when several are in the window", () => {
  const risk = assessNewsRisk(
    [highImpact("2026-08-23T12:40:00.000Z", "Far"), highImpact("2026-08-23T12:05:00.000Z", "Near")],
    NOW,
  );
  assert.equal(risk.level, "high");
  assert.match(risk.reason, /^Near/);
});

// Fallback events are seed data, not a schedule.
test("fallback calendar events never produce a countdown", async () => {
  const { MarketDataService } = require("../src/services/market-data");
  const service = new MarketDataService({ calendarUrl: "" });
  const calendar = await service.getCalendar({ now: NOW });
  assert.equal(calendar.live, false);
  assert.ok(calendar.items.every((item) => item.at === null), "fallback items must carry no instant");
  const risk = assessNewsRisk(calendar.items, NOW);
  assert.notEqual(risk.level, "high", "seed data must not trigger a news blackout");
});

// ── Why the calendar fell back ──────────────────────────────────────────────
//
// "Calendar is on fallback" used to be a dead end: a missing URL, a provider
// 500, an unreadable shape and a quiet Sunday all looked identical, so there
// was no way to tell a misconfiguration from an outage — while news risk went
// on being scored off seed data either way.

const http = require("node:http");
const { MarketDataService } = require("../src/services/market-data");

async function withCalendarFeed(handler, run, serviceOptions = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}/calendar`;
  try {
    await run(new MarketDataService({ calendarUrl: url, retryCount: 0, ...serviceOptions }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonHandler(status, body) {
  return (req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

test("an unset URL reports not-configured", async () => {
  const calendar = await new MarketDataService({ calendarUrl: "" }).getCalendar({ now: NOW });
  assert.equal(calendar.live, false);
  assert.equal(calendar.reason, "not-configured");
  assert.match(calendar.detail, /MACRO_CALENDAR_URL/);
});

test("a provider error reports request-failed with the cause", async () => {
  await withCalendarFeed(jsonHandler(503, { error: "down" }), async (service) => {
    const calendar = await service.getCalendar({ now: NOW });
    assert.equal(calendar.live, false);
    assert.equal(calendar.reason, "request-failed");
    assert.ok(calendar.detail, "the underlying error has to be reported");
  });
});

test("an unreadable shape reports invalid-shape, not an empty feed", async () => {
  await withCalendarFeed(jsonHandler(200, { events: "not-an-array" }), async (service) => {
    const calendar = await service.getCalendar({ now: NOW });
    assert.equal(calendar.reason, "invalid-shape");
    assert.match(calendar.detail, /array/i);
  });
});

test("a feed with nothing scheduled today says so, rather than looking broken", async () => {
  await withCalendarFeed(
    jsonHandler(200, { events: [{ time: "2026-08-20T12:30:00Z", title: "Old CPI", impact: "High" }] }),
    async (service) => {
      const calendar = await service.getCalendar({ now: NOW });
      assert.equal(calendar.reason, "no-events-today");
      assert.match(calendar.detail, /none scheduled today/);
    },
  );
});

test("a healthy feed is live and reports how much of its timing is real", async () => {
  await withCalendarFeed(
    jsonHandler(200, {
      events: [
        { time: "2026-08-23T12:30:00Z", title: "US CPI", impact: "High" },
        { time: "10:00", title: "Consumer Sentiment", impact: "Medium" },
        { time: "TBA", title: "Fed Speaker", impact: "High" },
      ],
    }),
    async (service) => {
      const calendar = await service.getCalendar({ now: NOW });
      assert.equal(calendar.live, true);
      assert.equal(calendar.reason, null);
      assert.equal(calendar.timezone, "America/New_York");
      assert.deepEqual(calendar.timing, { total: 3, exact: 1, assumed: 1, untimed: 1 });
      assert.ok(calendar.fetchedAt, "a live read has to be datable");
    },
    { calendarTimezone: "America/New_York" },
  );
});
