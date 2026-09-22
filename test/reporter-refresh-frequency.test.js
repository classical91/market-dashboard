"use strict";

// Settings → Reporter → Refresh Frequency, end to end.
//
// The setting travels as ttlHours on the generate request, and the reporter
// turns it into a cooldown in whole calendar days before it will remake the
// same desk. Both halves matter: Daily has to allow an 11pm briefing to be
// remade the next morning, and Every 2 Days has to actually refuse the next
// morning — which it did not, because the gate used to be hardcoded to the
// calendar day and ignored the TTL entirely.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { ReporterService, cooldownDays, isWithinCooldown } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-freq-"));
}

function dayKey(offsetDays) {
  const now = new Date();
  const then = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const month = String(then.getMonth() + 1).padStart(2, "0");
  const day = String(then.getDate()).padStart(2, "0");
  return `${then.getFullYear()}-${month}-${day}`;
}

/**
 * A desk that generates for real, minus the provider call.
 *
 * `calls` is shared across every service built over the same directory so a
 * test can count what a later "day" actually spent.
 */
function reporter(dataDir, calls = []) {
  const service = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  service._generate = async (prompt) => {
    calls.push(prompt);
    return { content: `body ${calls.length}`, sources: [] };
  };
  service.calls = calls;
  return service;
}

function backdateRecord(record, days) {
  if (!record || typeof record !== "object") return record;
  const aged = { ...record };
  if (aged.generatedAt) aged.generatedAt = new Date(new Date(aged.generatedAt).getTime() - days * DAY_MS).toISOString();
  if (aged.generatedDateKey) aged.generatedDateKey = dayKey(-days);
  return aged;
}

/**
 * Wind the stored state back `days`, then hand back a reporter reading it —
 * the same view the app has when someone returns the next morning. Both the
 * durable log and the persisted cache are aged, because the gate consults
 * whichever of them still holds the desk.
 */
function dayLater(dataDir, days, calls) {
  const logFile = path.join(dataDir, "reporter-generation-log.json");
  const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
  fs.writeFileSync(logFile, JSON.stringify(log.map((entry) => backdateRecord(entry, days))));

  const cacheFile = path.join(dataDir, "reporter-cache.json");
  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const aged = {};
    Object.keys(cache).forEach((key) => {
      // Per-day generation keys carry the day they were written for, so
      // ageing the store has to move those back too — otherwise today's key
      // still holds yesterday's generation and nothing would ever regenerate.
      const agedKey = key.replace(/\d{4}-\d{2}-\d{2}$/, dayKey(-days));
      aged[agedKey] = { ...cache[key], value: backdateRecord(cache[key].value, days) };
    });
    fs.writeFileSync(cacheFile, JSON.stringify(aged));
  }

  return reporter(dataDir, calls);
}

/* ── The cooldown itself ────────────────────────────────────────────────── */

test("a TTL becomes whole calendar days, with a one-day floor", () => {
  assert.equal(cooldownDays(24 * HOUR_MS), 1);
  assert.equal(cooldownDays(48 * HOUR_MS), 2);
  assert.equal(cooldownDays(168 * HOUR_MS), 7);
  // A sub-day TTL keeps the original once-per-calendar-day behaviour rather
  // than opening up repeat spending on the same desk.
  assert.equal(cooldownDays(HOUR_MS), 1);
  assert.equal(cooldownDays(0), 1);
  assert.equal(cooldownDays(null), 1);
});

test("the cooldown counts calendar days, not a rolling window", () => {
  const today = { generatedDateKey: dayKey(0) };
  const yesterday = { generatedDateKey: dayKey(-1) };
  const twoDaysAgo = { generatedDateKey: dayKey(-2) };

  assert.equal(isWithinCooldown(today, 1), true);
  assert.equal(isWithinCooldown(yesterday, 1), false, "Daily unlocks at midnight, not 24h later");

  assert.equal(isWithinCooldown(today, 2), true);
  assert.equal(isWithinCooldown(yesterday, 2), true, "Every 2 Days still holds the slot the next morning");
  assert.equal(isWithinCooldown(twoDaysAgo, 2), false, "and releases it the morning after that");
});

test("an undated or future-dated entry never holds a desk's slot", () => {
  assert.equal(isWithinCooldown(null, 2), false);
  assert.equal(isWithinCooldown({}, 2), false);
  assert.equal(isWithinCooldown({ generatedAt: "not a date" }, 2), false);
  assert.equal(isWithinCooldown({ generatedDateKey: dayKey(1) }, 2), false);
});

/* ── Through generateReport ─────────────────────────────────────────────── */

test("both settings refuse a second generation on the same day", async () => {
  // This is the part that already worked, and has to keep working: a page
  // reload must not cost an OpenAI call.
  for (const hours of [24, 48]) {
    const service = reporter(tempDir());
    await service.generateReport(hours * HOUR_MS, "crypto", "");
    const again = await service.generateReport(hours * HOUR_MS, "crypto", "");
    assert.equal(again.generationSkipped, true, `${hours}h refuses a same-day repeat`);
    assert.equal(service.calls.length, 1);
  }
});

test("Daily regenerates the next day; Every 2 Days does not", async () => {
  const daily = tempDir();
  const every2 = tempDir();
  const dailyCalls = [];
  const every2Calls = [];

  await reporter(daily, dailyCalls).generateReport(24 * HOUR_MS, "crypto", "");
  await reporter(every2, every2Calls).generateReport(48 * HOUR_MS, "crypto", "");
  assert.equal(dailyCalls.length, 1);
  assert.equal(every2Calls.length, 1);

  // The next morning the two settings part ways.
  const dailyNextDay = await dayLater(daily, 1, dailyCalls).generateReport(24 * HOUR_MS, "crypto", "");
  assert.ok(!dailyNextDay.generationSkipped, "Daily means a new briefing every day");
  assert.equal(dailyCalls.length, 2);

  const every2NextDay = await dayLater(every2, 1, every2Calls).generateReport(48 * HOUR_MS, "crypto", "");
  assert.equal(every2NextDay.generationSkipped, true, "Every 2 Days must not regenerate on day two");
  assert.equal(every2NextDay.generationSkippedReason, "within-refresh-window");
  assert.equal(every2NextDay.refreshCooldownDays, 2);
  assert.equal(every2Calls.length, 1, "and must not spend another OpenAI call");
  assert.equal(every2NextDay.crypto, "body 1", "the saved report is served instead");
});

test("Every 2 Days regenerates once the window has passed", async () => {
  const dataDir = tempDir();
  const calls = [];

  await reporter(dataDir, calls).generateReport(48 * HOUR_MS, "crypto", "");
  const report = await dayLater(dataDir, 2, calls).generateReport(48 * HOUR_MS, "crypto", "");

  assert.ok(!report.generationSkipped);
  assert.equal(calls.length, 2);
});

test("a skipped generation reports when the desk unlocks", async () => {
  const dataDir = tempDir();
  const calls = [];

  await reporter(dataDir, calls).generateReport(48 * HOUR_MS, "crypto", "");
  const report = await dayLater(dataDir, 1, calls).generateReport(48 * HOUR_MS, "crypto", "");

  // Generated yesterday under a two-day window, so it unlocks tomorrow — the
  // date is counted from the report, not from whenever the user asked again.
  assert.equal(report.nextGenerationDate, dayKey(1));
});

test("Daily still reports the same-day reason it always has", async () => {
  const service = reporter(tempDir());
  await service.generateReport(24 * HOUR_MS, "crypto", "");

  const report = await service.generateReport(24 * HOUR_MS, "crypto", "");
  assert.equal(report.generationSkippedReason, "already-generated-today");
  assert.equal(report.refreshCooldownDays, 1);
  assert.equal(report.nextGenerationDate, dayKey(1));
});

test("the cooldown is per desk, so one desk's window does not block the others", async () => {
  const service = reporter(tempDir());
  await service.generateReport(48 * HOUR_MS, "crypto", "");

  const economics = await service.generateReport(48 * HOUR_MS, "economics", "");
  assert.ok(!economics.generationSkipped);
  assert.equal(service.calls.length, 2);
});
