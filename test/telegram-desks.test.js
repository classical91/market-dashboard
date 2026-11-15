"use strict";

// Which website desks may post to Telegram is a Settings choice: Geopolitics
// to the Telegram groups, Economics/Stocks/Crypto to FarmBot instead.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { BroadcastLedgerStore, TELEGRAM_DESKS } = require("../src/services/broadcast-ledger");
const { broadcastReportSections } = require("../src/services/report-broadcast");
const { createReporterRouter } = require("../src/routes/reporter");
const { createDeskTelegramRouter } = require("../src/routes/desk-telegram");
const { PhoneBriefingStore } = require("../src/services/phone-briefings");
const { GEOPOLITICS_DESTINATIONS } = require("../src/services/news-routing");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-telegram-desks-"));
}

function ledger() {
  return new BroadcastLedgerStore({ dataDir: tmp(), logger: { error() {} } });
}

function fakeTelegram() {
  const calls = [];
  return {
    calls,
    configured: true,
    _chatIds: [{ chatId: "-100111" }],
    async postReportSection({ newsType, text, targets }) {
      calls.push({ newsType, text, targets });
      const sent = targets || [{ chatId: "-100111" }];
      return { destinations: sent.map((t, i) => ({ channel: "telegram", chatId: String(t.chatId), threadId: t.threadId || null, status: "posted", messageId: String(900 + i) })) };
    },
  };
}

const REPORT = { dateStr: "2026-11-15", generatedAt: "2026-11-15T06:00:00.000Z", geopolitics: "geo", economics: "econ", markets: "stocks", crypto: "crypto" };

test("all four desks go to Telegram until Settings narrows it; unknown names are dropped", () => {
  const store = ledger();
  assert.deepEqual(store.getSettings().telegramDesks, ["Geopolitics", "Economics", "Stock", "Crypto"]);
  assert.deepEqual(TELEGRAM_DESKS, ["Geopolitics", "Economics", "Stock", "Crypto"]);
  assert.deepEqual(store.updateSettings({ telegramDesks: ["Geopolitics", "Weather"] }).telegramDesks, ["Geopolitics"]);
  assert.deepEqual(store.getSettings().telegramDesks, ["Geopolitics"], "saved on the server");
  assert.deepEqual(store.updateSettings({ telegramDesks: [] }).telegramDesks, [], "every desk can be switched off");
  assert.deepEqual(store.updateSettings({ requireExactCategory: true }).telegramDesks, [], "other saves keep the choice");
});

test("Broadcast and the newsroom send only the desks switched on for Telegram", async () => {
  const store = ledger();
  store.updateSettings({ telegramDesks: ["Geopolitics"] });
  const telegram = fakeTelegram();
  const result = await broadcastReportSections({ report: REPORT, telegramService: telegram, broadcastLedgerStore: store });
  assert.deepEqual(telegram.calls.map((c) => c.newsType), ["Geopolitics"]);
  assert.deepEqual(telegram.calls[0].targets, GEOPOLITICS_DESTINATIONS.map((t) => ({ ...t })), "Geopolitics keeps its own groups");
  assert.deepEqual(result.skipped.sort(), ["Crypto", "Economics", "Stock"]);
  assert.equal(result.receipts.length, 1);
});

test("the Reporter Room's Broadcast says so when no saved desk may go to Telegram", async () => {
  const store = ledger();
  store.updateSettings({ telegramDesks: ["Geopolitics"] });
  const telegram = fakeTelegram();
  const app = express();
  app.use("/api/daily-report", createReporterRouter({
    reporterService: { peekReport: () => ({ configured: true, ...REPORT, geopolitics: "" }), getBroadcastAt: () => null, markBroadcasted: () => "now" },
    telegramService: telegram, broadcastLedgerStore: store, requireAdmin: (req, res, next) => next(),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/daily-report/broadcast`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /switched off in Settings/);
    assert.equal(telegram.calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a desk page sends its own run, looked up on the server, once", async () => {
  const dir = tmp();
  const store = ledger();
  store.updateSettings({ telegramDesks: ["Geopolitics"] });
  const telegram = fakeTelegram();
  const briefingStore = new PhoneBriefingStore({ dataDir: dir, logger: { error() {} } });
  const phone = briefingStore.receive("geopolitics", { text: "1. Phone geo story\n2. Another" }).entry;
  briefingStore.receive("economics", { text: "1. Econ\n2. More" });
  const reporterService = {
    getGenerationForReference: ({ section, generatedAt }) => (section === "geopolitics" && generatedAt === "2026-11-15T01:00:00.000Z"
      ? { ok: true, generation: { content: "1. Reporter geo\n2. B", generatedAt } }
      : { ok: false }),
  };
  const app = express();
  app.use("/api/desk-telegram", createDeskTelegramRouter({ briefingStore, reporterService, telegramService: telegram, broadcastLedgerStore: store, requireAdmin: (req, res, next) => next() }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body) => fetch(`${base}/api/desk-telegram/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const info = await (await fetch(`${base}/api/desk-telegram`)).json();
    assert.equal(info.desks.geopolitics.telegram, true);
    assert.equal(info.desks.geopolitics.destinations, GEOPOLITICS_DESTINATIONS.length);
    assert.equal(info.desks.economics.telegram, false);
    assert.doesNotMatch(JSON.stringify(info), /-100/, "no chat ids leave Settings");

    const first = await (await send({ desk: "geopolitics", runId: phone.id, text: "ignored browser text" })).json();
    assert.equal(first.ok, true);
    assert.equal(first.alreadySent, false);
    assert.equal(first.posted, GEOPOLITICS_DESTINATIONS.length);
    assert.equal(telegram.calls[0].text, "1. Phone geo story\n2. Another", "the stored run is sent, not browser text");

    const again = await (await send({ desk: "geopolitics", runId: phone.id })).json();
    assert.equal(again.alreadySent, true);
    assert.equal(telegram.calls.length, 1, "the same run is never posted twice");

    await send({ desk: "geopolitics", runId: "reporter-2026-11-15T01:00:00.000Z" });
    assert.equal(telegram.calls[1].text, "1. Reporter geo\n2. B");

    const off = await send({ desk: "economics", runId: "x" });
    assert.equal(off.status, 403);
    assert.match((await off.json()).error, /switched off for Telegram/);
    assert.equal((await send({ desk: "geopolitics", runId: "missing" })).status, 404);
    assert.equal(telegram.calls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
