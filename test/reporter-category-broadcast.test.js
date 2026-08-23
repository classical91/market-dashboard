"use strict";

// The Daily Reporter used to send all three sections as one aggregate blast and
// write one receipt spanning every configured chat. That receipt could name
// destinations a given category never reached, and the category itself existed
// only in the message heading. These pin the per-category replacement: one
// send, one receipt, one destination list per category.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { createReporterRouter } = require("../src/routes/reporter");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
const { FINANCE_NEWS_DESTINATIONS, destinationsForNewsType } = require("../src/services/news-routing");

const DEFAULT_CHATS = [
  { chatId: "-100111", threadId: "1" },
  { chatId: "-100222", threadId: "2" },
];

function fakeTelegram({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    configured: true,
    _chatIds: DEFAULT_CHATS,
    async postReportSection({ newsType, text, date, targets }) {
      calls.push({ newsType, text, date, targets });
      if (failOn === newsType) {
        const err = Object.assign(new Error(`Telegram rejected ${newsType}`), { statusCode: 502 });
        err.destinations = [];
        throw err;
      }
      const sent = targets || DEFAULT_CHATS;
      return {
        posted: sent.length,
        failed: 0,
        destinations: sent.map((target, index) => ({
          channel: "telegram",
          chatId: String(target.chatId),
          threadId: target.threadId == null ? null : String(target.threadId),
          status: "posted",
          messageId: String(700 + index),
        })),
      };
    },
  };
}

function report(overrides = {}) {
  return {
    configured: true,
    dateStr: "2026-08-23",
    generatedAt: "2026-08-23T06:00:00.000Z",
    crypto: "crypto body",
    economics: "economics body",
    markets: "markets body",
    ...overrides,
  };
}

async function withReporterApp(run, { telegramService = fakeTelegram(), current = report() } = {}) {
  const store = new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-cat-")),
    logger: { error() {} },
  });
  let broadcastAt = null;
  const reporterService = {
    peekReport: () => current,
    getBroadcastAt: () => broadcastAt,
    markBroadcasted() {
      broadcastAt = new Date().toISOString();
      return broadcastAt;
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/daily-report",
    createReporterRouter({
      reporterService,
      telegramService,
      broadcastLedgerStore: store,
      requireAdmin: (req, res, next) => next(),
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, telegramService, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const broadcast = (base) => fetch(`${base}/api/daily-report/broadcast`, { method: "POST" });

test("each section is sent once, as its own category", async () => {
  await withReporterApp(async ({ base, telegramService }) => {
    const res = await broadcast(base);
    assert.equal(res.status, 200);

    assert.deepEqual(telegramService.calls.map((c) => c.newsType), ["Crypto", "Stock", "Economics"]);
    assert.deepEqual(
      telegramService.calls.map((c) => c.text),
      ["crypto body", "markets body", "economics body"],
      "the reporter's `markets` section is the Stock category",
    );
  });
});

test("each category gets its own receipt naming only its own destinations", async () => {
  await withReporterApp(async ({ base, store }) => {
    const body = await (await broadcast(base)).json();

    assert.equal(body.receipts.length, 3);
    assert.deepEqual(body.receipts.map((r) => r.newsType), ["Crypto", "Stock", "Economics"]);
    assert.ok(body.receipts.every((r) => r.status === "posted"), JSON.stringify(body.receipts));

    for (const summary of body.receipts) {
      const receipt = store.getReceipt(summary.id);
      assert.equal(receipt.newsType, summary.newsType);
      assert.deepEqual(
        receipt.destinations.map((d) => ({ chatId: d.chatId, threadId: d.threadId })),
        FINANCE_NEWS_DESTINATIONS.map((d) => ({ chatId: d.chatId, threadId: d.threadId })),
        "a receipt must name the destinations that category actually reached",
      );
    }

    // Every returned destination is tagged with the category that reached it.
    assert.ok(body.destinations.every((d) => d.newsType), JSON.stringify(body.destinations));
  });
});

test("sends go to the locked finance topics, not the configured chat list", async () => {
  await withReporterApp(async ({ base, telegramService }) => {
    await broadcast(base);
    for (const call of telegramService.calls) {
      assert.deepEqual(call.targets, destinationsForNewsType(call.newsType, null));
      assert.notDeepEqual(call.targets, DEFAULT_CHATS, "a broader chat list must not widen news routing");
    }
  });
});

test("only sections with content are sent", async () => {
  await withReporterApp(
    async ({ base, telegramService }) => {
      await broadcast(base);
      assert.deepEqual(telegramService.calls.map((c) => c.newsType), ["Crypto"]);
    },
    { current: report({ economics: "", markets: "" }) },
  );
});

test("a failing category marks its own receipt failed and does not silently continue", async () => {
  const telegramService = fakeTelegram({ failOn: "Stock" });
  await withReporterApp(
    async ({ base, store }) => {
      const res = await broadcast(base);
      assert.equal(res.status >= 400, true, "a total send failure must surface, not report ok");

      const posted = store.list({ limit: 50 }).filter((r) => r.newsType === "Crypto");
      assert.equal(posted.length, 1);
      assert.equal(posted[0].status, "posted", "the category that landed keeps its posted receipt");

      const failed = store.list({ limit: 50 }).filter((r) => r.newsType === "Stock");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].status, "failed", "the category that failed says so");
    },
    { telegramService },
  );
});

// The idempotency key is per category, so a double-clicked Broadcast cannot
// resend a category that already landed — nor fork the ledger.
test("re-broadcasting the same report does not resend a category that already posted", async () => {
  const telegramService = fakeTelegram();
  const store = new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-idem-")),
    logger: { error() {} },
  });
  const current = report();
  const reporterService = {
    peekReport: () => current,
    // Deliberately never advances, so the route's own "already broadcast" gate
    // does not mask what the ledger key is doing.
    getBroadcastAt: () => null,
    markBroadcasted: () => new Date().toISOString(),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/daily-report",
    createReporterRouter({ reporterService, telegramService, broadcastLedgerStore: store, requireAdmin: (q, s, n) => n() }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await broadcast(base);
    assert.equal(telegramService.calls.length, 3);

    const second = await (await broadcast(base)).json();
    assert.equal(telegramService.calls.length, 3, "no category may be sent twice under the same key");
    assert.equal(second.receipts.length, 3, "the existing receipts are still reported back");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
