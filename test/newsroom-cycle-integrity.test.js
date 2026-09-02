"use strict";

// Cycle-exact delivery.
//
// A newsroom cycle is retried by *delivering* it again, never by regenerating
// it — which means delivery has to be able to answer "what did THIS cycle
// write?" long after a later cycle wrote something newer for the same section.
// Asking the reporter for the latest report cannot answer that: it returns
// today's crypto section, not the one the failed cycle produced two days ago.
//
// These tests pin the difference. The headline case is the one that motivated
// the change: cycle A fails to deliver, cycle B later generates fresh content,
// cycle A is retried, and cycle A's own text — not cycle B's — is what goes
// out under cycle A's receipts.
//
// Nothing here touches a network. The provider call is replaced, Telegram is a
// double, and `fetch` itself is booby-trapped for the whole file so a real
// request would fail loudly rather than quietly leave the sandbox.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { NewsroomService } = require("../src/services/newsroom");
const { NewsroomCycleStore, cycleIdForKey, scheduledCycleKey } = require("../src/services/newsroom-cycles");
const { ReporterService } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const SECTIONS = ["crypto", "economics", "markets"];
const DAY_MS = 24 * 60 * 60 * 1000;

/* ── no network, at all ── */

const realFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = (...args) => {
  networkAttempts += 1;
  throw new Error(`A test tried to reach the network: ${String(args[0])}`);
};
test.after(() => {
  globalThis.fetch = realFetch;
});

/* ── harness ── */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-newsroom-integrity-"));
}

// The reporter's own day key: local calendar date, matching formatDateKey().
function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Which section a prompt is for, so generated content can be recognizably
// per-section without reaching into the reporter's internals.
function sectionFromPrompt(prompt) {
  if (/TRENDING CRYPTO TOKENS/i.test(prompt)) return "crypto";
  if (/ECONOMIC DEVELOPMENTS/i.test(prompt)) return "economics";
  return "markets";
}

function fakeTelegram({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    _chatIds: [{ chatId: "-100111", threadId: "1" }],
    failOn,
    async postReportSection({ newsType, text, date, targets }) {
      calls.push({ newsType, text, date });
      if (this.failOn === newsType || this.failOn === "*") {
        throw Object.assign(new Error(`Telegram rejected ${newsType}`), { statusCode: 502 });
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
          messageId: String(700 + index + calls.length * 10),
        })),
      };
    },
  };
}

/**
 * Build the newsroom over a directory. Called again over the same directory to
 * model a later day / a restart: the stores reload from disk, and only the
 * in-memory pieces start fresh.
 */
function makeWorld({ dataDir, telegramService, allowPartialDelivery = false, era = { value: "A" }, calls = [] }) {
  const reporterService = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  reporterService._generate = async (prompt) => {
    const section = sectionFromPrompt(prompt);
    calls.push(section);
    return { content: `CYCLE-${era.value} ${section} body`, sources: [] };
  };

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
  return { dataDir, newsroom, cycleStore, reporterService, broadcastLedgerStore, telegramService, calls, era };
}

/**
 * Age every stored generation by a day, references included, and drop the
 * cache — the state the next calendar day would leave behind. The cycle record
 * and the generation log are moved together, so the references keep pointing
 * at exactly the entries they always pointed at.
 */
function ageGenerationHistoryOneDay(dataDir) {
  const shift = (iso) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : new Date(at.getTime() - DAY_MS).toISOString();
  };

  const logFile = path.join(dataDir, "reporter-generation-log.json");
  const log = JSON.parse(fs.readFileSync(logFile, "utf8")).map((entry) => {
    const generatedAt = shift(entry.generatedAt);
    return { ...entry, generatedAt, generatedDateKey: dayKey(new Date(generatedAt)) };
  });
  fs.writeFileSync(logFile, JSON.stringify(log), "utf8");

  const cycleFile = path.join(dataDir, "newsroom-cycles.json");
  const stored = JSON.parse(fs.readFileSync(cycleFile, "utf8"));
  stored.cycles = stored.cycles.map((cycle) => ({
    ...cycle,
    sectionsGenerated: (cycle.sectionsGenerated || []).map((entry) => ({
      ...entry,
      generatedAt: shift(entry.generatedAt),
      generationRef: entry.generationRef
        ? { ...entry.generationRef, generatedAt: shift(entry.generationRef.generatedAt) }
        : entry.generationRef,
    })),
  }));
  fs.writeFileSync(cycleFile, JSON.stringify(stored), "utf8");

  fs.rmSync(path.join(dataDir, "reporter-cache.json"), { force: true });
}

const readLog = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, "reporter-generation-log.json"), "utf8"));
const writeLog = (dataDir, log) =>
  fs.writeFileSync(path.join(dataDir, "reporter-generation-log.json"), JSON.stringify(log), "utf8");

/* ── the bug this exists to prevent ── */

test("retrying an older cycle delivers that cycle's report, never a newer cycle's", async () => {
  const dataDir = tempDir();
  const era = { value: "A" };
  const calls = [];

  // Day one: cycle A generates, and every Telegram send fails.
  const dead = fakeTelegram({ failOn: "*" });
  const dayOne = makeWorld({ dataDir, telegramService: dead, era, calls });
  const cycleA = (await dayOne.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" })).cycle;
  assert.equal(cycleA.status, "delivery_failed");
  assert.equal(cycleA.sectionsGenerated.length, 3, "the report exists; only delivery failed");
  assert.equal(calls.length, 3);

  // A day passes.
  ageGenerationHistoryOneDay(dataDir);

  // Day two: cycle B generates genuinely newer content and delivers it.
  era.value = "B";
  const live = fakeTelegram();
  const dayTwo = makeWorld({ dataDir, telegramService: live, era, calls });
  const cycleB = (await dayTwo.newsroom.runCycle({ scheduledAt: "2026-08-27T13:00:00.000Z", trigger: "cron" })).cycle;
  assert.equal(cycleB.status, "completed");
  assert.equal(calls.length, 6, "cycle B generated its own sections");
  assert.ok(live.calls.every((call) => call.text.includes("CYCLE-B")));

  // The retry. This is the moment the old code reached for the latest cache.
  const beforeRetry = live.calls.length;
  const retry = await dayTwo.newsroom.deliverCycle(cycleA.id);

  const retrySends = live.calls.slice(beforeRetry);
  assert.deepEqual(
    retrySends.map((call) => call.newsType),
    ["Crypto", "Stock", "Economics"],
    "every category of the older cycle is delivered",
  );
  retrySends.forEach((call) => {
    assert.ok(call.text.includes("CYCLE-A"), `${call.newsType} must carry cycle A's own text`);
    assert.equal(call.text.includes("CYCLE-B"), false, `${call.newsType} must not carry cycle B's text`);
  });
  assert.equal(calls.length, 6, "a delivery retry never regenerates");
  assert.equal(retry.cycle.status, "completed");

  // And the receipts the retry wrote belong to cycle A, not to cycle B.
  const receipts = dayTwo.broadcastLedgerStore.list({ cycleId: cycleA.id, limit: 20 });
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every((receipt) => receipt.cycleId === cycleA.id));
  assert.equal(
    dayTwo.broadcastLedgerStore.list({ cycleId: cycleB.id, limit: 20 }).length,
    3,
    "cycle B keeps its own three receipts and gains none from the retry",
  );
});

test("a cycle records the exact generation each of its sections stands for", async () => {
  const dataDir = tempDir();
  const world = makeWorld({ dataDir, telegramService: fakeTelegram() });
  const { cycle } = await world.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z" });

  const log = world.reporterService.listGenerations({ cycleId: cycle.id, limit: 10 });
  assert.equal(log.length, 3);

  cycle.sectionsGenerated.forEach((entry) => {
    const logged = log.find((item) => item.section === entry.section);
    assert.ok(entry.generationRef, `${entry.section} records no generation reference`);
    assert.equal(entry.generationRef.section, entry.section);
    assert.equal(entry.generationRef.cycleId, cycle.id);
    assert.equal(entry.generationRef.generatedAt, logged.generatedAt);
    assert.equal(entry.reused, false);
    assert.equal(entry.reusedFromCycleId, null);
  });
});

/* ── reuse stays traceable ── */

test("a same-day cycle that reuses an earlier cycle's report points back at it", async () => {
  const dataDir = tempDir();
  const calls = [];
  const telegram = fakeTelegram();
  const world = makeWorld({ dataDir, telegramService: telegram, calls });

  const cycleA = (await world.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" })).cycle;
  assert.equal(cycleA.status, "completed");
  assert.equal(calls.length, 3);

  // Same day, later slot: nothing is regenerated, and the second cycle has to
  // say whose text it is carrying.
  telegram.failOn = "*";
  const cycleB = (await world.newsroom.runCycle({ scheduledAt: "2026-08-26T21:00:00.000Z", trigger: "cron" })).cycle;
  assert.notEqual(cycleB.id, cycleA.id);
  assert.equal(calls.length, 3, "a same-day reuse costs no generation");
  assert.equal(cycleB.status, "delivery_failed");

  cycleB.sectionsGenerated.forEach((entry) => {
    assert.equal(entry.reused, true, `${entry.section} should be marked reused`);
    assert.equal(entry.reusedFromCycleId, cycleA.id, `${entry.section} should name the cycle it reused`);
    assert.equal(entry.generationRef.cycleId, cycleA.id);
    const source = cycleA.sectionsGenerated.find((item) => item.section === entry.section);
    assert.equal(entry.generationRef.generatedAt, source.generationRef.generatedAt);
  });

  // Retrying the reusing cycle delivers the exact text it reused.
  telegram.failOn = null;
  const before = telegram.calls.length;
  const retry = await world.newsroom.deliverCycle(cycleB.id);
  assert.equal(retry.cycle.status, "completed");
  assert.equal(calls.length, 3, "the retry regenerates nothing");

  const retrySends = telegram.calls.slice(before);
  assert.deepEqual(retrySends.map((call) => call.newsType), ["Crypto", "Stock", "Economics"]);
  const firstSends = telegram.calls.slice(0, 3);
  retrySends.forEach((call) => {
    const original = firstSends.find((item) => item.newsType === call.newsType);
    assert.equal(call.text, original.text, `${call.newsType} must be byte-identical to the reused generation`);
  });
});

test("cycle detail resolves a reused section to the generation it came from", async () => {
  const dataDir = tempDir();
  const world = makeWorld({ dataDir, telegramService: fakeTelegram() });

  const cycleA = (await world.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z" })).cycle;
  const cycleB = (await world.newsroom.runCycle({ scheduledAt: "2026-08-26T21:00:00.000Z" })).cycle;

  // The reuse writes no generation log entry under cycle B, which is exactly
  // why a by-cycle lookup used to come back empty here.
  assert.equal(world.reporterService.listGenerations({ cycleId: cycleB.id, limit: 10 }).length, 0);

  const generations = world.newsroom.resolveCycleGenerations(world.cycleStore.getCycle(cycleB.id));
  assert.deepEqual(generations.map((entry) => entry.section).sort(), [...SECTIONS].sort());
  generations.forEach((entry) => {
    assert.equal(entry.resolved, true, `${entry.section} should resolve`);
    assert.equal(entry.reused, true);
    assert.equal(entry.reusedFromCycleId, cycleA.id);
    assert.equal(entry.cycleId, cycleA.id, "the content is attributed to the cycle that wrote it");
    assert.ok(entry.content.includes("CYCLE-A"));
    assert.equal("prompt" in entry, false, "a prompt body never reaches cycle detail");
  });
});

/* ── fail closed ── */

test("a section whose stored generation is gone blocks delivery instead of substituting one", async () => {
  const dataDir = tempDir();
  const calls = [];
  const dead = fakeTelegram({ failOn: "*" });
  const first = makeWorld({ dataDir, telegramService: dead, calls });
  const cycle = (await first.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z" })).cycle;
  assert.equal(cycle.status, "delivery_failed");

  // The crypto generation is lost — pruned, or never restored with the volume.
  writeLog(dataDir, readLog(dataDir).filter((entry) => entry.section !== "crypto"));

  const live = fakeTelegram();
  const retryWorld = makeWorld({ dataDir, telegramService: live, calls });
  const retry = await retryWorld.newsroom.deliverCycle(cycle.id);

  assert.equal(retry.cycle.status, "delivery_failed");
  assert.equal(live.calls.length, 0, "nothing at all is sent while a section cannot be proven");
  assert.equal(calls.length, 3, "a missing generation is never re-generated to paper over the gap");
  assert.equal(retry.cycle.lastError.code, "generation_reference_missing");
  assert.equal(retry.cycle.lastError.retryable, false);
  assert.equal(retry.cycle.lastError.phase, "delivery");
  assert.equal(retry.cycle.lastError.section, "crypto");

  // And the failure stays readable from the operational surfaces.
  const health = retryWorld.newsroom.health();
  assert.equal(health.lastError.code, "generation_reference_missing");
  const detail = retryWorld.newsroom
    .resolveCycleGenerations(retryWorld.cycleStore.getCycle(cycle.id))
    .find((entry) => entry.section === "crypto");
  assert.equal(detail.resolved, false);
  assert.equal(detail.error.code, "generation_reference_missing");
});

test("an ambiguous legacy reference fails closed rather than picking one", async () => {
  const dataDir = tempDir();
  const calls = [];
  const telegram = fakeTelegram();
  const world = makeWorld({ dataDir, telegramService: telegram, calls });

  const generatedAt = "2026-08-20T13:00:00.000Z";
  const cycleKey = scheduledCycleKey("2026-08-20T13:00:00.000Z");
  const legacyId = cycleIdForKey(cycleKey);

  // Two stored generations claiming the same section at the same instant, and
  // neither under this cycle's id. A history the app would not write, which is
  // the point: it cannot be resolved, so it must not be guessed.
  writeLog(dataDir, [
    {
      section: "crypto",
      label: "Emerging Markets",
      generatedAt,
      generatedDateKey: "2026-08-20",
      dateStr: "AUGUST 20, 2026",
      model: "old-model",
      content: "first candidate",
      prompt: null,
      cycleId: "cyc_somethingelse1",
      sources: [],
    },
    {
      section: "crypto",
      label: "Emerging Markets",
      generatedAt,
      // A different day key on the same instant is what keeps both entries in
      // the log rather than collapsing them.
      generatedDateKey: "2026-08-21",
      dateStr: "AUGUST 21, 2026",
      model: "old-model",
      content: "second candidate",
      prompt: null,
      cycleId: "cyc_somethingelse2",
      sources: [],
    },
  ]);

  // A cycle record as it was written before generation references existed.
  fs.writeFileSync(
    path.join(dataDir, "newsroom-cycles.json"),
    JSON.stringify({
      version: 1,
      cycles: [
        {
          id: legacyId,
          cycleKey,
          version: 1,
          status: "delivery_failed",
          trigger: "cron",
          scheduledAt: generatedAt,
          startedAt: generatedAt,
          completedAt: generatedAt,
          updatedAt: generatedAt,
          reporter: { model: "old-model", provider: null },
          sectionsExpected: ["crypto"],
          sectionsGenerated: [{ section: "crypto", generatedAt, model: "old-model", reused: true }],
          receiptIds: [],
          destinations: [],
          failures: [],
          preflight: null,
          lastError: null,
        },
      ],
    }),
    "utf8",
  );

  const retry = await world.newsroom.deliverCycle(legacyId);
  assert.equal(retry.cycle.status, "delivery_failed");
  assert.equal(telegram.calls.length, 0, "an ambiguous history sends nothing");
  assert.equal(calls.length, 0, "and regenerates nothing");
  assert.equal(retry.cycle.lastError.code, "generation_reference_ambiguous");
  assert.equal(retry.cycle.lastError.retryable, false);
});

/* ── old records still work ── */

test("a legacy cycle whose generation can still be identified delivers normally", async () => {
  const dataDir = tempDir();
  const calls = [];
  const telegram = fakeTelegram();
  const world = makeWorld({ dataDir, telegramService: telegram, calls });

  const generatedAt = "2026-08-20T13:00:00.000Z";
  const cycleKey = scheduledCycleKey(generatedAt);
  const legacyId = cycleIdForKey(cycleKey);

  writeLog(dataDir, [
    {
      section: "crypto",
      label: "Emerging Markets",
      generatedAt,
      generatedDateKey: "2026-08-20",
      dateStr: "AUGUST 20, 2026",
      model: "old-model",
      // Logged under the cycle itself, the ordinary pre-reference shape.
      cycleId: legacyId,
      content: "legacy crypto body",
      prompt: null,
      sources: [],
    },
    {
      section: "economics",
      label: "Economics Top 10",
      generatedAt: "2026-08-20T13:01:00.000Z",
      generatedDateKey: "2026-08-20",
      dateStr: "AUGUST 20, 2026",
      model: "old-model",
      // Reused from elsewhere, so the cycle id does not match — section plus
      // exact timestamp still identifies it, and only it.
      cycleId: "cyc_anearliercycle",
      content: "legacy economics body",
      prompt: null,
      sources: [],
    },
  ]);

  fs.writeFileSync(
    path.join(dataDir, "newsroom-cycles.json"),
    JSON.stringify({
      version: 1,
      cycles: [
        {
          id: legacyId,
          cycleKey,
          version: 1,
          status: "delivery_failed",
          trigger: "cron",
          scheduledAt: generatedAt,
          startedAt: generatedAt,
          completedAt: generatedAt,
          updatedAt: generatedAt,
          reporter: { model: "old-model", provider: null },
          sectionsExpected: ["crypto", "economics"],
          sectionsGenerated: [
            { section: "crypto", generatedAt, model: "old-model", reused: false },
            { section: "economics", generatedAt: "2026-08-20T13:01:00.000Z", model: "old-model", reused: true },
          ],
          receiptIds: [],
          destinations: [],
          failures: [],
          preflight: null,
          lastError: null,
        },
      ],
    }),
    "utf8",
  );

  const retry = await world.newsroom.deliverCycle(legacyId);

  assert.equal(calls.length, 0, "an old cycle is redelivered, never regenerated");
  assert.deepEqual(telegram.calls.map((call) => call.newsType), ["Crypto", "Economics"]);
  assert.equal(telegram.calls.find((call) => call.newsType === "Crypto").text, "legacy crypto body");
  assert.equal(telegram.calls.find((call) => call.newsType === "Economics").text, "legacy economics body");
  assert.equal(retry.cycle.status, "completed");

  // Reading it is safe too: a record with no references still renders.
  const generations = world.newsroom.resolveCycleGenerations(world.cycleStore.getCycle(legacyId));
  assert.equal(generations.length, 2);
  assert.ok(generations.every((entry) => entry.resolved));
  assert.equal(generations.find((entry) => entry.section === "economics").cycleId, "cyc_anearliercycle");
});

/* ── the guarantees that were already there ── */

test("category idempotency survives cycle-exact delivery", async () => {
  const dataDir = tempDir();
  const calls = [];
  const telegram = fakeTelegram({ failOn: "Stock" });
  const world = makeWorld({ dataDir, telegramService: telegram, calls });

  const first = await world.newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z" });
  assert.equal(first.cycle.status, "delivery_partial");

  telegram.failOn = null;
  const retry = await world.newsroom.deliverCycle(first.cycle.id);

  assert.deepEqual(
    telegram.calls.map((call) => call.newsType),
    ["Crypto", "Stock", "Economics", "Stock"],
    "a category that already posted is recognized, not sent again",
  );
  assert.equal(retry.cycle.status, "completed");
  assert.equal(calls.length, 3);

  const receipts = world.broadcastLedgerStore.list({ cycleId: first.cycle.id, limit: 20 });
  assert.equal(receipts.length, 3, "the retry reuses the cycle's receipts rather than forking new ones");
  assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ["posted", "posted", "posted"]);
});

test("nothing in this file reached the network", () => {
  assert.equal(networkAttempts, 0);
});
