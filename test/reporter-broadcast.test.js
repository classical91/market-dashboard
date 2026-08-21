"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "test-secret-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-broadcast-"));
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Keep Telegram unconfigured so these tests never make a network call — the
// route's "not configured" gate is what's under test here.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");
const { ReporterService } = require("../src/services/reporter");
const { MemoryCache } = require("../src/services/cache");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("broadcast rejects a missing admin key with 401", async () => {
  const res = await fetch(`${base}/api/daily-report/broadcast`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("broadcast reports Telegram as unconfigured once the admin guard passes", async () => {
  const res = await fetch(`${base}/api/daily-report/broadcast`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /telegram is not configured/i);
});

test("ReporterService.markBroadcasted round-trips through getBroadcastAt", () => {
  const reporter = new ReporterService({ cache: new MemoryCache(), apiKey: "" });
  assert.equal(reporter.getBroadcastAt(), null);
  const broadcastAt = reporter.markBroadcasted();
  assert.ok(broadcastAt);
  assert.equal(reporter.getBroadcastAt(), broadcastAt);
});

test("reporter sends and receipts each category separately with actual destinations", async () => {
  const express = require("express");
  const { createReporterRouter } = require("../src/routes/reporter");
  const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-routes-"));
  const store = new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
  const calls = [];
  const exactTargets = [
    { chatId: "-1001841650798", threadId: "6297" },
    { chatId: "-1001941064823", threadId: "984" },
  ];
  const telegramService = {
    configured: true,
    targetsForNewsType: () => exactTargets,
    async postReportSection(input) {
      calls.push(input);
      return {
        posted: 2,
        failed: 0,
        destinations: exactTargets.map((target, index) => ({
          channel: "telegram",
          ...target,
          status: "posted",
          messageId: `${calls.length}${index}`,
        })),
      };
    },
  };
  const reporterService = {
    peekReport: () => ({
      configured: true,
      generatedAt: "2026-08-20T12:00:00.000Z",
      dateStr: "2026-08-20",
      crypto: "crypto body",
      markets: "stock body",
      economics: "economics body",
    }),
    getBroadcastAt: () => null,
    markBroadcasted: () => "2026-08-20T12:01:00.000Z",
  };
  const app = express();
  app.use(express.json());
  app.use("/api/daily-report", createReporterRouter({
    reporterService,
    telegramService,
    broadcastLedgerStore: store,
    requireAdmin: (_req, _res, next) => next(),
  }));
  const localServer = http.createServer(app);
  await new Promise((resolve) => localServer.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${localServer.address().port}/api/daily-report/broadcast`, {
      method: "POST",
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((call) => call.newsType), ["Crypto", "Stock", "Economics"]);
    assert.equal(body.receiptIds.length, 3);
    const receipts = store.list({ limit: 10 });
    assert.deepEqual(receipts.map((receipt) => receipt.newsType).sort(), ["Crypto", "Economics", "Stock"]);
    receipts.forEach((receipt) => {
      assert.deepEqual(
        receipt.destinations.map(({ chatId, threadId }) => ({ chatId, threadId })),
        exactTargets,
      );
    });
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
  }
});
