"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dateRange, dayKey, countdown, qualityOf } = require("../public/assets/js/reporter-calendar");
const { marketStateFromDecision } = require("../src/services/trading/trading-lab");
const { runKillSwitches } = require("../src/services/trading/checklist");
const NOW = new Date("2026-11-16T01:00:00Z");

test("date filters use local calendar days across midnight and weeks", () => {
  assert.equal(dayKey(NOW, "America/Los_Angeles"), "2026-11-15");
  assert.deepEqual(dateRange("today", NOW, "America/Los_Angeles"), ["2026-11-15", "2026-11-15"]);
  assert.deepEqual(dateRange("tomorrow", NOW, "America/Los_Angeles"), ["2026-11-16", "2026-11-16"]);
  assert.deepEqual(dateRange("week", NOW, "America/Los_Angeles"), ["2026-11-09", "2026-11-15"]);
  assert.deepEqual(dateRange("nextweek", NOW, "America/Los_Angeles"), ["2026-11-16", "2026-11-22"]);
  assert.deepEqual(dateRange("14d", NOW, "UTC"), ["2026-11-16", "2026-11-29"]);
});

test("countdowns require verified timestamps and a fresh live snapshot", () => {
  const event = { at: "2026-11-16T01:30:00Z", verified: true, precision: "exact" };
  assert.equal(countdown(event, NOW, "live"), "In 30 min");
  for (const patch of [{ at: null }, { verified: false }, { precision: "assumed" }, { actual: "0" }, { status: "Tentative" }]) assert.equal(countdown({ ...event, ...patch }, NOW, "live"), "");
  assert.equal(countdown(event, NOW, "stale"), "");
  assert.equal(countdown(event, new Date("2026-11-16T01:31:00Z"), "live"), "");
});

test("idle tabs cannot renew freshness or retain stale data indefinitely", () => {
  const payload = { quality: "live", expiresAt: "2026-11-16T00:59:00Z", staleUntil: "2026-11-16T01:05:00Z" };
  assert.equal(qualityOf(payload, NOW), "stale");
  assert.equal(qualityOf(payload, new Date("2026-11-16T01:06:00Z")), "unavailable");
  assert.equal(qualityOf(null, NOW), "unavailable");
});

test("Trading Lab blocks unverifiable calendars separately from actual news windows", () => {
  const state = marketStateFromDecision({ newsRisk: { level: "unknown", available: false } });
  assert.equal(state.newsBlackout, false, "an outage is not a timed news blackout");
  assert.equal(state.calendarUnavailable, true);
  assert.match(runKillSwitches(state), /CALENDAR_UNAVAILABLE/);
});
