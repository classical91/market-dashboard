"use strict";

// The newsroom cycle is the record that answers "did the scheduled run
// happen, and how far did it get?". These pin the parts that are easy to get
// wrong once generation and delivery are separate steps: a doubled cron
// invocation must not fork the run, a delivery failure must never cost a
// regeneration, and an authentication failure must be distinguishable from a
// transient one so it is not retried forever.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { NewsroomService } = require("../src/services/newsroom");
const { NewsroomCycleStore, scheduledCycleKey } = require("../src/services/newsroom-cycles");
const { ReporterService } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
const { classifyFailure } = require("../src/services/failure-classification");

const SCHEDULED_AT = "2026-08-26T13:00:00.000Z";
const SECTIONS = ["crypto", "economics", "markets"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-newsroom-"));
}

/**
 * A real ReporterService with only the provider call replaced, so the log,
 * the same-day dedupe and the cycle linking are all exercised for real.
 */
function fakeReporter({ dataDir, generate, sources = [] } = {}) {
  const calls = [];
  const service = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  service._generate = async (prompt) => {
    calls.push(prompt);
    if (generate) return generate(prompt, calls.length);
    return { content: `body ${calls.length}`, sources };
  };
  service.calls = calls;
  return service;
}

function fakeTelegram({ failOn = null, error } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    _chatIds: [{ chatId: "-100111", threadId: "1" }],
    failOn,
    async postReportSection({ newsType, text, date, targets }) {
      calls.push({ newsType, text, date, targets });
      if (this.failOn === newsType) {
        throw error || Object.assign(new Error(`Telegram rejected ${newsType}`), { statusCode: 502 });
      }
      const sent = targets || this._chatIds;
      return {
        posted: sent.length,
        failed: 0,
        destinations: sent.map((target, index) => ({
          channel: "telegram",
          chatId: String(target.chatId),
          threadId: target.threadId == null ? null : String(target.threadId),
          status: "posted",
          messageId: String(900 + index + calls.length * 10),
        })),
      };
    },
  };
}

function makeNewsroom({ reporterOptions = {}, telegramService = fakeTelegram(), allowPartialDelivery = false } = {}) {
  const dataDir = tempDir();
  const reporterService = fakeReporter({ dataDir, ...reporterOptions });
  const cycleStore = new NewsroomCycleStore({ dataDir, logger: { error() {} } });
  const broadcastLedgerStore = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  const newsroom = new NewsroomService({
    cycleStore,
    reporterService,
    telegramService,
    broadcastLedgerStore,
    sections: SECTIONS,
    expectedRunTimesUtc: ["13:00"],
    allowPartialDelivery,
    logger: { error() {} },
  });
  return { dataDir, newsroom, cycleStore, reporterService, telegramService, broadcastLedgerStore };
}

/* ── a complete cycle ── */

test("a cycle that generates every section and delivers completes", async () => {
  const { newsroom, telegramService, broadcastLedgerStore } = makeNewsroom();

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT, trigger: "cron" });

  assert.equal(cycle.status, "completed");
  assert.equal(cycle.trigger, "cron");
  assert.equal(cycle.cycleKey, scheduledCycleKey(SCHEDULED_AT));
  assert.deepEqual(
    cycle.sectionsGenerated.map((entry) => entry.section).sort(),
    [...SECTIONS].sort(),
  );
  assert.ok(cycle.completedAt, "a completed cycle records when it finished");
  assert.deepEqual(telegramService.calls.map((call) => call.newsType), ["Crypto", "Stock", "Economics"]);
  assert.equal(broadcastLedgerStore.list({ cycleId: cycle.id, limit: 20 }).length, 3);
});

test("a cycle links its receipts, and the receipts keep their Telegram message ids", async () => {
  const { newsroom, broadcastLedgerStore } = makeNewsroom();
  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  const receipts = broadcastLedgerStore.list({ cycleId: cycle.id, limit: 20 });
  assert.deepEqual(
    [...cycle.receiptIds].sort(),
    receipts.map((receipt) => receipt.id).sort(),
    "every receipt the cycle wrote is reachable from the cycle",
  );
  receipts.forEach((receipt) => {
    assert.equal(receipt.cycleId, cycle.id);
    assert.ok(receipt.destinations.length, `${receipt.newsType} recorded no destination`);
    receipt.destinations.forEach((destination) => {
      assert.ok(destination.messageId, "a delivered destination keeps its Telegram message id");
    });
  });

  // cycle -> generated sections -> receipts -> destinations -> message ids
  assert.ok(cycle.destinations.every((destination) => destination.messageId && destination.newsType));
});

test("generated sections are traceable to the cycle through the generation log", async () => {
  const { newsroom, reporterService } = makeNewsroom({
    reporterOptions: {
      sources: [{ url: "https://example.com/story", title: "Example" }],
    },
  });
  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  const logged = reporterService.listGenerations({ cycleId: cycle.id, limit: 10 });
  assert.equal(logged.length, 3);
  logged.forEach((entry) => {
    assert.equal(entry.cycleId, cycle.id);
    assert.ok(entry.content, "the log keeps the generated content, not just a pointer");
    assert.deepEqual(entry.sources, [{ url: "https://example.com/story", title: "Example" }]);
  });

  const cycleSection = cycle.sectionsGenerated.find((entry) => entry.section === "crypto");
  assert.equal(cycleSection.sourceMetadata.available, true);
});

test("a generation that returns no citations records none rather than inventing them", async () => {
  const { newsroom } = makeNewsroom({ reporterOptions: { sources: [] } });
  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  cycle.sectionsGenerated.forEach((entry) => {
    assert.deepEqual(entry.sources, []);
    assert.equal(entry.sourceMetadata.available, false);
    assert.match(entry.sourceMetadata.reason, /no citations/i);
  });
});

/* ── idempotency ── */

test("a doubled cron invocation cannot fork the cycle", async () => {
  const { newsroom, cycleStore, reporterService, telegramService } = makeNewsroom();

  const [first, second] = await Promise.all([
    newsroom.runCycle({ scheduledAt: SCHEDULED_AT, trigger: "cron" }),
    newsroom.runCycle({ scheduledAt: SCHEDULED_AT, trigger: "cron" }),
  ]);

  assert.equal(first.cycle.id, second.cycle.id, "both invocations name the same cycle");
  assert.equal(cycleStore.list({ limit: 20 }).length, 1, "one slot, one cycle");
  assert.equal(reporterService.calls.length, 3, "no section is generated twice");
  assert.equal(telegramService.calls.length, 3, "no category is sent twice");
  assert.ok([first, second].some((result) => result.skipped === "already-running"));
});

test("re-running a completed slot reports it and does nothing", async () => {
  const { newsroom, reporterService, telegramService } = makeNewsroom();
  await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  const again = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });
  assert.equal(again.skipped, "already-completed");
  assert.equal(reporterService.calls.length, 3);
  assert.equal(telegramService.calls.length, 3);
});

test("two sections generated concurrently both survive in the history", async () => {
  const dataDir = tempDir();
  const reporter = fakeReporter({ dataDir });

  await Promise.all([
    reporter.generateReport(null, "crypto", "", { cycleId: "cyc_test" }),
    reporter.generateReport(null, "economics", "", { cycleId: "cyc_test" }),
  ]);

  const logged = reporter.listGenerations({ cycleId: "cyc_test", limit: 10 });
  assert.deepEqual(logged.map((entry) => entry.section).sort(), ["crypto", "economics"]);
});

/* ── generation failure ── */

test("a generation failure is its own status and sends nothing", async () => {
  const telegramService = fakeTelegram();
  const { newsroom } = makeNewsroom({
    telegramService,
    reporterOptions: {
      generate: async (_prompt, callNumber) => {
        if (callNumber === 2) throw Object.assign(new Error("upstream exploded"), { status: 503 });
        return { content: `body ${callNumber}`, sources: [] };
      },
    },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "generation_failed");
  assert.equal(telegramService.calls.length, 0, "an incomplete report is never delivered");
  assert.equal(cycle.failures.length, 1);
  assert.equal(cycle.failures[0].phase, "generation");
  assert.equal(cycle.failures[0].class, "retryable");
});

test("a failed slot resumes and generates only the section that is missing", async () => {
  let failNext = true;
  const { newsroom, reporterService } = makeNewsroom({
    reporterOptions: {
      generate: async (_prompt, callNumber) => {
        if (failNext && callNumber === 2) throw Object.assign(new Error("upstream exploded"), { status: 503 });
        return { content: `body ${callNumber}`, sources: [] };
      },
    },
  });

  const first = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });
  assert.equal(first.cycle.status, "generation_failed");
  const generatedFirst = first.cycle.sectionsGenerated.length;

  failNext = false;
  const second = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(second.cycle.id, first.cycle.id);
  assert.equal(second.cycle.status, "completed");
  assert.equal(
    reporterService.calls.length,
    3 + (SECTIONS.length - generatedFirst),
    "only the missing section is generated on the resume",
  );
});

/* ── partial delivery ── */

test("with partial delivery on, the sections that exist go out and the cycle stays partial", async () => {
  const telegramService = fakeTelegram();
  const { newsroom } = makeNewsroom({
    telegramService,
    allowPartialDelivery: true,
    reporterOptions: {
      generate: async (_prompt, callNumber) => {
        if (callNumber === 2) throw Object.assign(new Error("upstream exploded"), { status: 503 });
        return { content: `body ${callNumber}`, sources: [] };
      },
    },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.sectionsGenerated.length, 2);
  assert.equal(telegramService.calls.length, 2, "only the generated sections are sent");
  assert.equal(
    cycle.status,
    "delivery_partial",
    "an incomplete report is never completed, even when every send succeeded",
  );
  assert.equal(cycle.failures[0].phase, "generation", "the missing section stays visible as a failure");
});

test("partial delivery never sends a section this cycle did not generate", async () => {
  // Yesterday's markets section is still cached. Today's markets generation
  // fails. Delivering the cached copy would publish stale copy under today's
  // date and hang a receipt on a cycle that never generated it.
  const telegramService = fakeTelegram();
  const { newsroom, reporterService } = makeNewsroom({
    telegramService,
    allowPartialDelivery: true,
    reporterOptions: {
      generate: async (_prompt, callNumber) => {
        // markets is the third section of the run
        if (callNumber === 3) throw Object.assign(new Error("upstream exploded"), { status: 503 });
        return { content: `body ${callNumber}`, sources: [] };
      },
    },
  });
  reporterService._cache.set("reporter:latest:markets", {
    dateStr: "YESTERDAY",
    content: "stale markets body from an earlier day",
    generatedAt: "2026-08-25T13:00:00.000Z",
  }, 24 * 60 * 60 * 1000);

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.deepEqual(telegramService.calls.map((call) => call.newsType), ["Crypto", "Economics"]);
  assert.equal(
    telegramService.calls.some((call) => call.text.includes("stale")),
    false,
    "a section from an earlier day must never ride along in today's cycle",
  );
  assert.equal(cycle.status, "delivery_partial");
});

test("with partial delivery off, an incomplete cycle still sends nothing", async () => {
  const telegramService = fakeTelegram();
  const { newsroom } = makeNewsroom({
    telegramService,
    reporterOptions: {
      generate: async (_prompt, callNumber) => {
        if (callNumber === 2) throw Object.assign(new Error("upstream exploded"), { status: 503 });
        return { content: `body ${callNumber}`, sources: [] };
      },
    },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "generation_failed");
  assert.equal(telegramService.calls.length, 0);
});

/* ── delivery failure and retry ── */

test("one failing category leaves the others delivered and the cycle partial", async () => {
  const telegramService = fakeTelegram({ failOn: "Stock" });
  const { newsroom, broadcastLedgerStore } = makeNewsroom({ telegramService });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "delivery_partial");
  assert.deepEqual(telegramService.calls.map((call) => call.newsType), ["Crypto", "Stock", "Economics"]);

  const receipts = broadcastLedgerStore.list({ cycleId: cycle.id, limit: 20 });
  const byType = Object.fromEntries(receipts.map((receipt) => [receipt.newsType, receipt.status]));
  assert.equal(byType.Crypto, "posted");
  assert.equal(byType.Economics, "posted");
  assert.equal(byType.Stock, "failed");
});

test("retrying delivery does not regenerate the report and does not resend what landed", async () => {
  const telegramService = fakeTelegram({ failOn: "Stock" });
  const { newsroom, reporterService } = makeNewsroom({ telegramService });

  const first = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });
  assert.equal(first.cycle.status, "delivery_partial");
  assert.equal(reporterService.calls.length, 3);

  telegramService.failOn = null;
  const retry = await newsroom.deliverCycle(first.cycle.id);

  assert.equal(reporterService.calls.length, 3, "delivery retry must never regenerate");
  assert.equal(retry.cycle.status, "completed");
  assert.deepEqual(
    telegramService.calls.map((call) => call.newsType),
    ["Crypto", "Stock", "Economics", "Stock"],
    "only the category that failed is sent again",
  );
});

test("a delivery that lands nowhere is delivery_failed, not generation_failed", async () => {
  const telegramService = fakeTelegram();
  telegramService.postReportSection = async ({ newsType }) => {
    throw Object.assign(new Error(`Telegram rejected ${newsType}`), { statusCode: 502 });
  };
  const { newsroom } = makeNewsroom({ telegramService });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "delivery_failed");
  assert.equal(cycle.sectionsGenerated.length, 3, "the report still exists — only delivery failed");
});

/* ── failure classification ── */

test("an authentication failure is recorded as non-retryable", async () => {
  const { newsroom } = makeNewsroom({
    reporterOptions: {
      generate: async () => {
        throw Object.assign(new Error("401 Incorrect API key provided"), { status: 401 });
      },
    },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "generation_failed");
  assert.ok(cycle.failures.every((failure) => failure.class === "non_retryable"));
  assert.ok(cycle.failures.every((failure) => failure.retryable === false));
  assert.equal(cycle.lastError.code, "auth");
});

// The August 11 ShareBot cron failure. It arrives as a 401 but means something
// different from a wrong key — the identity behind the agent route is not
// recognized — so it carries its own code and points at the verification doc.
test("HTTP 401 \"User not found\" is classified as a provider identity failure", async () => {
  const { newsroom } = makeNewsroom({
    reporterOptions: {
      generate: async () => {
        throw Object.assign(new Error("HTTP 401: User not found"), { status: 401 });
      },
    },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.lastError.code, "provider_user_not_found");
  assert.equal(cycle.lastError.retryable, false);
  assert.match(cycle.lastError.reason, /agent\/model route/i);
});

test("classification separates retryable transport faults from configuration faults", () => {
  const retryable = [
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("bad gateway"), { status: 502 }),
    Object.assign(new Error("upstream down"), { status: 500 }),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    Object.assign(new Error("request timed out"), { name: "AbortError" }),
  ];
  const nonRetryable = [
    Object.assign(new Error("invalid model parameter"), { status: 400 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    Object.assign(new Error("no such model route"), { status: 404 }),
    Object.assign(new Error("missing API key"), { code: "missing_credentials" }),
  ];

  retryable.forEach((err) => {
    const classified = classifyFailure(err);
    assert.equal(classified.retryable, true, `${err.message} should be retryable`);
    assert.equal(classified.class, "retryable");
  });
  nonRetryable.forEach((err) => {
    const classified = classifyFailure(err);
    assert.equal(classified.retryable, false, `${err.message} should not be retryable`);
    assert.equal(classified.class, "non_retryable");
  });

  // An error nobody can read is not evidence that a retry is safe.
  assert.equal(classifyFailure(new Error("something odd")).class, "unknown");
  assert.equal(classifyFailure(new Error("something odd")).retryable, false);
});

/* ── preflight ── */

test("a failed preflight produces a cycle record and sends nothing", async () => {
  const dataDir = tempDir();
  const telegramService = fakeTelegram();
  telegramService.configured = false;
  telegramService._chatIds = [];
  const newsroom = new NewsroomService({
    cycleStore: new NewsroomCycleStore({ dataDir, logger: { error() {} } }),
    reporterService: fakeReporter({ dataDir }),
    telegramService,
    broadcastLedgerStore: new BroadcastLedgerStore({ dataDir, logger: { error() {} } }),
    sections: SECTIONS,
    logger: { error() {} },
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: SCHEDULED_AT });

  assert.equal(cycle.status, "preflight_failed");
  assert.equal(cycle.sectionsGenerated.length, 0, "preflight runs before anything is spent");
  assert.equal(telegramService.calls.length, 0);
  assert.equal(cycle.preflight.ok, false);
  assert.ok(cycle.preflight.checks.find((check) => check.name === "telegram-credentials" && !check.ok));
});

test("an unconfigured agent route is a warn, never a pass", async () => {
  const { newsroom } = makeNewsroom();
  const preflight = await newsroom.preflight();
  const external = preflight.checks.find((check) => check.name === "external-agent-route");

  assert.equal(external.skipped, true);
  assert.equal(external.status, "warn", "an unknown route must not read as a passing check");
  assert.match(external.detail, /not verified/i);
  assert.equal(preflight.ok, true, "an unverifiable external route must not fail a local preflight");
  assert.ok(
    preflight.checks.filter((check) => check.name !== "external-agent-route").every((check) => check.status === "pass"),
  );
});

/* ── backwards compatibility ── */

test("history written before cycles existed still loads", async () => {
  const dataDir = tempDir();
  const legacyLog = [
    {
      section: "crypto",
      label: "Emerging Markets",
      generatedAt: "2026-08-01T06:00:00.000Z",
      generatedDateKey: "2026-08-01",
      dateStr: "AUGUST 1, 2026",
      model: "old-model",
      content: "legacy crypto body",
      prompt: null,
    },
  ];
  fs.writeFileSync(path.join(dataDir, "reporter-generation-log.json"), JSON.stringify(legacyLog), "utf8");

  const reporter = fakeReporter({ dataDir });
  const report = reporter.peekReport();
  assert.equal(report.crypto, "legacy crypto body");

  const entries = reporter.listGenerations({ limit: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cycleId, undefined, "a historical entry is left as it was written");
  assert.equal(reporter.listGenerations({ cycleId: "cyc_anything" }).length, 0);

  // The same for a receipt with no cycle: it still lists, it simply does not
  // belong to a cycle.
  const ledger = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  const { receipt } = ledger.createReceipt({ source: "shortcut", title: "Legacy story", status: "posted" });
  assert.equal(receipt.cycleId, null);
  assert.equal(ledger.list({ limit: 10 }).length, 1);
  assert.equal(ledger.list({ limit: 10, cycleId: "cyc_anything" }).length, 0);
});
