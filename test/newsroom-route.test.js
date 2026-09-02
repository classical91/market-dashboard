"use strict";

// The newsroom API is what the ShareBot status panel and an operator read when
// a scheduled run goes quiet, so these check the two things that make it worth
// reading: it reports the real state of the last cycles, and it never leaks a
// credential or a prompt body while doing it.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { createNewsroomRouter } = require("../src/routes/newsroom");
const { NewsroomService } = require("../src/services/newsroom");
const { NewsroomCycleStore } = require("../src/services/newsroom-cycles");
const { ReporterService } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const SECTIONS = ["crypto", "economics", "markets"];
const SECRET_PROMPT = "internal desk prompt with a shared secret";

function fakeTelegram({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    _chatIds: [{ chatId: "-100111", threadId: "1" }],
    failOn,
    async postReportSection({ newsType, targets }) {
      calls.push({ newsType });
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
          messageId: String(500 + index + calls.length),
        })),
      };
    },
  };
}

async function withNewsroomApp(run, { telegramService = fakeTelegram() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-newsroom-route-"));
  const reporterService = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  reporterService._generate = async () => ({ content: "section body", sources: [] });

  const cycleStore = new NewsroomCycleStore({ dataDir, logger: { error() {} } });
  const broadcastLedgerStore = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  const newsroomService = new NewsroomService({
    cycleStore,
    reporterService,
    telegramService,
    broadcastLedgerStore,
    sections: SECTIONS,
    expectedRunTimesUtc: ["13:00", "21:00"],
    logger: { error() {} },
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/api/newsroom",
    createNewsroomRouter({
      newsroomService,
      cycleStore,
      reporterService,
      broadcastLedgerStore,
      requireAdmin: (req, res, next) => next(),
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, newsroomService, cycleStore, reporterService, telegramService, broadcastLedgerStore });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const runCycle = (base, body) =>
  fetch(`${base}/api/newsroom/cycles/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });

const health = async (base) => (await fetch(`${base}/api/newsroom/health`)).json();

test("health reports a completed cycle accurately", async () => {
  await withNewsroomApp(async ({ base }) => {
    await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });
    const body = await health(base);

    assert.equal(body.status, "completed");
    assert.equal(body.lastSuccessfulCycle.status, "completed");
    assert.equal(body.lastAttemptedCycle.id, body.lastSuccessfulCycle.id);
    assert.equal(body.lastAttemptedCycle.generatedSectionCount, 3);
    assert.equal(body.lastAttemptedCycle.deliverySucceeded > 0, true);
    assert.equal(body.lastAttemptedCycle.deliveryFailed, 0);
    assert.equal(body.currentCycle, null);
    assert.equal(body.lastError, null);
    assert.equal(body.reporter.model, "test-model");
    assert.ok(body.nextExpectedRunAt, "a configured schedule reports the next expected run");
  });
});

test("health reports a partial delivery as partial, keeping the last successful cycle", async () => {
  const telegramService = fakeTelegram();
  await withNewsroomApp(
    async ({ base }) => {
      await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });
      const completed = await health(base);

      telegramService.failOn = "Stock";
      await runCycle(base, { scheduledAt: "2026-08-27T13:00:00.000Z", trigger: "cron" });
      const body = await health(base);

      assert.equal(body.status, "delivery_partial");
      assert.equal(body.lastAttemptedCycle.status, "delivery_partial");
      assert.equal(
        body.lastSuccessfulCycle.id,
        completed.lastSuccessfulCycle.id,
        "a later partial run does not erase the last known-good cycle",
      );
      assert.equal(body.lastError.phase, "delivery");
      assert.equal(body.lastError.class, "retryable");
      assert.ok(
        body.lastAttemptedCycle.deliverySucceeded > 0,
        "a partial cycle records the destinations that did land",
      );
    },
    { telegramService },
  );
});

test("health reports a failed delivery and its classification", async () => {
  await withNewsroomApp(
    async ({ base }) => {
      await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });
      const body = await health(base);

      assert.equal(body.status, "delivery_failed");
      assert.equal(body.lastSuccessfulCycle, null);
      assert.equal(body.lastAttemptedCycle.generatedSectionCount, 3, "the report exists even though delivery failed");
      assert.equal(body.lastError.code, "server_error");
      assert.equal(body.lastError.retryable, true);
    },
    { telegramService: fakeTelegram({ failOn: "*" }) },
  );
});

test("health exposes no credential, prompt body or message text", async () => {
  await withNewsroomApp(async ({ base, reporterService }) => {
    await reporterService.generateReport(null, "crypto", SECRET_PROMPT, { cycleId: null });
    await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });

    const raw = await (await fetch(`${base}/api/newsroom/health`)).text();
    assert.equal(raw.includes(SECRET_PROMPT), false, "a custom prompt body must not reach an operational read");
    assert.equal(raw.includes("test-key"), false, "no API key in a health read");
    assert.equal(raw.includes("section body"), false, "no report text in a health read");
  });
});

test("the cycle detail links generations and receipts, without prompt bodies", async () => {
  await withNewsroomApp(async ({ base }) => {
    const started = await (await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z" })).json();
    const detail = await (await fetch(`${base}/api/newsroom/cycles/${started.cycle.id}`)).json();

    assert.equal(detail.cycle.id, started.cycle.id);
    assert.equal(detail.generations.length, 3);
    assert.equal(detail.receipts.length, 3);
    assert.deepEqual(detail.generations.map((entry) => entry.section).sort(), [...SECTIONS].sort());
    assert.ok(detail.generations.every((entry) => typeof entry.content === "string"));
    assert.ok(detail.generations.every((entry) => !("prompt" in entry)));
    assert.deepEqual(
      detail.receipts.map((receipt) => receipt.newsType).sort(),
      ["Crypto", "Economics", "Stock"],
    );
    assert.ok(detail.receipts.every((receipt) => receipt.destinations.every((destination) => destination.messageId)));
    assert.ok(detail.receipts.every((receipt) => receipt.attempts.length >= 1), "attempt history survives");
  });
});

test("an unknown cycle is a 404, not an empty cycle", async () => {
  await withNewsroomApp(async ({ base }) => {
    const res = await fetch(`${base}/api/newsroom/cycles/cyc_missing`);
    assert.equal(res.status, 404);
  });
});

test("a duplicate run over HTTP returns the same cycle", async () => {
  await withNewsroomApp(async ({ base, cycleStore, telegramService }) => {
    const [first, second] = await Promise.all([
      runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" }),
      runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" }),
    ]);
    const firstBody = await first.json();
    const secondBody = await second.json();

    assert.equal(firstBody.cycle.id, secondBody.cycle.id);
    assert.equal(cycleStore.list({ limit: 10 }).length, 1);
    assert.equal(telegramService.calls.length, 3);
  });
});

test("the deliver endpoint retries delivery without regenerating", async () => {
  const telegramService = fakeTelegram({ failOn: "Stock" });
  await withNewsroomApp(
    async ({ base }) => {
      const started = await (await runCycle(base, { scheduledAt: "2026-08-26T13:00:00.000Z" })).json();
      assert.equal(started.cycle.status, "delivery_partial");

      telegramService.failOn = null;
      const retried = await (
        await fetch(`${base}/api/newsroom/cycles/${started.cycle.id}/deliver`, { method: "POST" })
      ).json();

      assert.equal(retried.cycle.status, "completed");
      assert.deepEqual(
        telegramService.calls.map((call) => call.newsType),
        ["Crypto", "Stock", "Economics", "Stock"],
      );
    },
    { telegramService },
  );
});

test("preflight reports configuration without running anything", async () => {
  await withNewsroomApp(async ({ base, cycleStore, telegramService }) => {
    const body = await (await fetch(`${base}/api/newsroom/preflight`)).json();

    assert.equal(body.ok, true);
    assert.ok(body.checks.find((check) => check.name === "reporter-credentials").ok);
    assert.ok(body.checks.find((check) => check.name === "news-routing").ok);
    assert.equal(cycleStore.count(), 0, "a preflight read starts no cycle");
    assert.equal(telegramService.calls.length, 0);
  });
});
