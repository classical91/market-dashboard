"use strict";

/**
 * Regression cover for the broadcast-ledger audit fixes.
 *
 * Each block here pins a behaviour that was wrong or unprotected before:
 * an unlabelled receipt refusing every later category-less broadcast, a
 * timestamp-less receipt taking the ledger page down, a retry reproducing the
 * formatting failure it was meant to clear, an unauthorized `?key=` value
 * being echoed back into the operator's own forms, and a single unusable
 * Telegram update stalling the whole channel watch.
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { createBroadcastLedgerRouter } = require("../src/routes/broadcast-ledger");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
const { BroadcastIngestService } = require("../src/services/broadcast-ingest");

const LEDGER_KEY = "audit-ledger-key";

function newStore() {
  return new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-audit-")),
    logger: { error() {} },
  });
}

/**
 * Mount the ledger router over a fresh store with a Telegram double, run the
 * body, and always close the listener — a leaked server hangs the whole test
 * process instead of reporting the failure that caused it.
 */
async function withLedger(run, { sendImpl } = {}) {
  const store = newStore();
  const sends = [];
  const telegramService = {
    configured: true,
    async postText(text, options = {}) {
      sends.push({ text, options });
      if (sendImpl) return sendImpl(text, options);
      const targets = options.targets || [{ chatId: "-100111", threadId: null }];
      return {
        posted: targets.length,
        failed: 0,
        destinations: targets.map((target, index) => ({
          channel: "telegram",
          chatId: String(target.chatId),
          threadId: target.threadId == null ? null : String(target.threadId),
          status: "posted",
          messageId: String(500 + index),
          error: null,
        })),
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/broadcast-ledger", createBroadcastLedgerRouter({
    broadcastLedgerStore: store,
    telegramService,
    requireLedgerKey(req, res, next) {
      if (req.get("x-broadcast-key") === LEDGER_KEY) return next();
      res.status(401).json({ error: "Unauthorized" });
    },
    ledgerKey: LEDGER_KEY,
    adminKey: "",
    rateLimitPerMinute: 0,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) =>
    fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify(body),
    });
  try {
    await run({ base, store, sends, post });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ── category-window blocking must not fire on the Unclassified bucket ── */

test("an unlabelled posted receipt does not block a later category-less broadcast", async () => {
  await withLedger(async ({ store, post }) => {
    // Exactly what the Channel Watch writes for an unrelated room comment:
    // posted, no category, so it lands in the Unclassified bucket.
    store.createReceipt({
      source: "telegram-ingest",
      title: "Someone said good morning in the room",
      status: "posted",
      idempotencyKey: "telegram:-100111:1",
      destinations: [{ channel: "telegram", chatId: "-100111", status: "posted", messageId: "1" }],
    });

    const res = await post("/api/broadcast-ledger/broadcast", {
      text: "Fed holds rates steady\nhttps://example.com/audit/fed",
      idempotencyKey: "audit-unclassified-1",
    });

    assert.equal(res.status, 201, "an unrelated unlabelled receipt must not refuse a real broadcast");
  });
});

test("an unlabelled broadcast is not blocked by an earlier unlabelled broadcast", async () => {
  await withLedger(async ({ post }) => {
    const first = await post("/api/broadcast-ledger/broadcast", {
      text: "First story\nhttps://example.com/audit/one",
      idempotencyKey: "audit-unclassified-a",
    });
    assert.equal(first.status, 201);

    const second = await post("/api/broadcast-ledger/broadcast", {
      text: "A completely different story\nhttps://example.com/audit/two",
      idempotencyKey: "audit-unclassified-b",
    });
    assert.equal(second.status, 201, "two distinct unlabelled stories are not duplicates of each other");
  });
});

test("the same unlabelled story is still refused by the authoritative URL tier", async () => {
  await withLedger(async ({ post }) => {
    await post("/api/broadcast-ledger/broadcast", {
      text: "Repeat story\nhttps://example.com/audit/repeat",
      idempotencyKey: "audit-repeat-a",
    });
    const again = await post("/api/broadcast-ledger/broadcast", {
      text: "Repeat story reworded\nhttps://example.com/audit/repeat",
      idempotencyKey: "audit-repeat-b",
    });
    const body = await again.json();

    assert.equal(again.status, 409, "dropping the category scan must not weaken URL dedupe");
    assert.equal(body.match, "url");
  });
});

test("a real category still blocks a second story inside its duplicate window", async () => {
  await withLedger(async ({ post }) => {
    const first = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Crypto",
      text: "Bitcoin rallies\nhttps://example.com/audit/btc",
      idempotencyKey: "audit-crypto-a",
    });
    assert.equal(first.status, 201);

    const second = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Crypto",
      text: "Ether rallies too\nhttps://example.com/audit/eth",
      idempotencyKey: "audit-crypto-b",
    });
    const body = await second.json();

    assert.equal(second.status, 409, "the configured category window is still enforced");
    assert.equal(body.match, "category-window");
    assert.equal(body.receipt.status, "blocked");
    assert.equal(body.receipt.newsType, "Crypto", "the blocked attempt keeps the sender's exact category");
  });
});

/* ── a receipt with no timestamp must not take the page down ── */

test("the ledger page renders even when a stored receipt has no timestamp", async () => {
  await withLedger(async ({ base, store }) => {
    const { receipt } = store.createReceipt({
      source: "manual",
      newsType: "Stock",
      title: "Legacy row with no timestamp",
      status: "posted",
    });
    // Simulate a hand-edited or pre-version-1 ledger file: same shape, no
    // createdAt. Every "is this today?" comparison used to throw on it.
    const file = path.join(store._file);
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    document.receipts = document.receipts.map((row) =>
      row.id === receipt.id ? { ...row, createdAt: undefined } : row,
    );
    fs.writeFileSync(file, JSON.stringify(document, null, 2), "utf8");

    const res = await fetch(`${base}/api/broadcast-ledger/manual?key=${LEDGER_KEY}`);
    assert.equal(res.status, 200, "a timestamp-less receipt must not 500 the operator page");
    const html = await res.text();
    assert.match(html, /Broadcast receipts/);
  });
});

test("the daily summary skips a timestamp-less receipt instead of throwing", async () => {
  await withLedger(async ({ base, store }) => {
    store.createReceipt({ source: "manual", newsType: "Stock", title: "Dated", status: "posted" });
    const file = path.join(store._file);
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    document.receipts.push({ id: "rcpt_legacy", source: "manual", newsType: "Stock", title: "Undated", status: "posted", attempts: [] });
    fs.writeFileSync(file, JSON.stringify(document, null, 2), "utf8");

    const res = await fetch(`${base}/api/broadcast-ledger/manual?key=${LEDGER_KEY}&range=all`);
    assert.equal(res.status, 200);
  });
});

/* ── retry ── */

test("retry sends plain text when the caller asks for it, as /broadcast does", async () => {
  await withLedger(async ({ base, store, sends }) => {
    const { receipt } = store.createReceipt({
      source: "shortcut",
      newsType: "Stock",
      title: "Earnings beat <Q3>",
      status: "failed",
      destinations: [{ channel: "telegram", chatId: "-1001841650798", threadId: "6297", status: "failed" }],
    });

    const res = await fetch(`${base}/api/broadcast-ledger/receipts/${receipt.id}/retry?key=${LEDGER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Earnings beat <Q3>", parseMode: "none" }),
    });

    assert.equal(res.status, 200);
    assert.equal(sends.at(-1).options.parseMode, null, "a plain-text original must be retried as plain text");
  });
});

test("retry defaults to HTML and reuses the category's routing policy", async () => {
  await withLedger(async ({ base, store, sends }) => {
    const { receipt } = store.createReceipt({
      source: "shortcut",
      newsType: "Crypto",
      title: "Bitcoin retry",
      status: "failed",
      destinations: [{ channel: "telegram", chatId: "-1001841650798", threadId: "6297", status: "failed" }],
    });

    const res = await fetch(`${base}/api/broadcast-ledger/receipts/${receipt.id}/retry?key=${LEDGER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Bitcoin retry" }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(sends.at(-1).options.parseMode, "HTML");
    assert.deepEqual(
      sends.at(-1).options.targets,
      [{ chatId: "-1001841650798", threadId: "6297" }, { chatId: "-1001941064823", threadId: "984" }],
      "retry must use the same finance routing as first delivery",
    );
    assert.equal(body.receipt.newsType, "Crypto", "retry never re-guesses the category");
    assert.equal(store.count(), 1, "retry updates the receipt rather than forking a second one");
  });
});

test("retry appends to attempt history rather than erasing the original failure", async () => {
  await withLedger(async ({ base, store }) => {
    const { receipt } = store.createReceipt({
      source: "shortcut",
      newsType: "Stock",
      title: "History is kept",
      status: "failed",
      error: "Telegram rejected the message",
    });

    await fetch(`${base}/api/broadcast-ledger/receipts/${receipt.id}/retry?key=${LEDGER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "History is kept" }),
    });

    const stored = store.getReceipt(receipt.id);
    assert.ok(stored.attempts.length >= 2, "the original attempt survives the retry");
    assert.equal(stored.attempts.at(-1).action, "retry");
    assert.ok(
      stored.attempts.some((attempt) => attempt.ok === false),
      "the failure that prompted the retry is still readable",
    );
  });
});

test("only a failed receipt can be retried", async () => {
  await withLedger(async ({ base, store }) => {
    const { receipt } = store.createReceipt({
      source: "shortcut",
      newsType: "Stock",
      title: "Already out",
      status: "posted",
    });

    const res = await fetch(`${base}/api/broadcast-ledger/receipts/${receipt.id}/retry?key=${LEDGER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Already out" }),
    });

    assert.equal(res.status, 409, "a posted receipt is never re-sent by the retry control");
  });
});

/* ── the manual page must not reflect an unauthorized key parameter ── */

test("a junk ?key= is not echoed into the page when a header authorized the request", async () => {
  await withLedger(async ({ base }) => {
    const res = await fetch(`${base}/api/broadcast-ledger/manual?key=attacker-supplied-value`, {
      headers: { "x-broadcast-key": LEDGER_KEY },
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.ok(!html.includes("attacker-supplied-value"), "only a key that authorized the request is carried forward");
  });
});

test("a valid ?key= is still carried into the page's forms", async () => {
  await withLedger(async ({ base }) => {
    const res = await fetch(`${base}/api/broadcast-ledger/manual?key=${LEDGER_KEY}`);
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, new RegExp(`name="key" value="${LEDGER_KEY}"`), "the phone-browser path still works");
  });
});

/* ── channel watch resilience ── */

function ingestHarness({ updates, store }) {
  const polls = [];
  const saved = {};
  return new BroadcastIngestService({
    telegramService: {
      configured: true,
      _chatIds: [{ chatId: "-100111" }],
      async getUpdates(options) {
        polls.push(options);
        return typeof updates === "function" ? updates(polls.length) : updates;
      },
    },
    broadcastLedgerStore: store,
    stateCache: {
      get: (key) => (key in saved ? saved[key] : null),
      set: (key, value) => { saved[key] = value; },
    },
    enabled: true,
    logger: { log() {}, error() {} },
    _saved: saved,
  });
}

test("one unusable update does not stop the rest of the batch or stall the offset", async () => {
  const store = newStore();
  const service = ingestHarness({
    store,
    updates: [
      // A post whose chat object is present but whose id blows up on read.
      { update_id: 10, channel_post: { message_id: 1, get chat() { throw new Error("corrupt update"); } } },
      { update_id: 11, channel_post: { message_id: 2, chat: { id: -100111 }, text: "Real headline\nhttps://example.com/audit/real" } },
    ],
  });

  const summary = await service.runOnce();

  assert.equal(summary.recorded, 1, "the good post in the same batch is still recorded");
  assert.equal(summary.errors, 1, "the unusable one is counted, not hidden");
  assert.equal(store.count(), 1);

  // The offset advanced past both, so the poison update is not re-read forever.
  const second = await service.runOnce();
  assert.equal(second.polled, 2);
  assert.equal(store.count(), 1, "re-reading records nothing new");
});

test("a malformed getUpdates payload is an empty poll, not a crash", async () => {
  const store = newStore();
  const service = ingestHarness({ store, updates: { not: "an array" } });

  const summary = await service.runOnce();

  assert.deepEqual(summary, { polled: 0, recorded: 0, attached: 0, skipped: 0 });
  assert.equal(store.count(), 0);
});

test("a null entry inside the update array is skipped rather than thrown on", async () => {
  const store = newStore();
  const service = ingestHarness({ store, updates: [null, { update_id: 3 }] });

  const summary = await service.runOnce();

  assert.equal(summary.skipped, 2);
  assert.equal(store.count(), 0);
});

/* ── ledger search and filtering, at the store contract ── */

test("the ledger finds a receipt by its exact receipt id", () => {
  const store = newStore();
  const { receipt } = store.createReceipt({ source: "manual", newsType: "Stock", title: "Findable by id", status: "posted" });
  store.createReceipt({ source: "manual", newsType: "Crypto", title: "Something else", status: "posted" });

  const found = store.list({ query: receipt.id });

  assert.equal(found.length, 1);
  assert.equal(found[0].id, receipt.id);
});

test("the ledger finds a receipt by words from its headline", () => {
  const store = newStore();
  store.createReceipt({ source: "manual", newsType: "Economics", title: "Inflation cools in June", status: "posted" });
  store.createReceipt({ source: "manual", newsType: "Crypto", title: "Bitcoin rallies", status: "posted" });

  assert.equal(store.list({ query: "inflation cools" }).length, 1);
  assert.equal(store.list({ query: "INFLATION" }).length, 1, "search is case-insensitive");
  assert.equal(store.list({ query: "nothing matching" }).length, 0);
});

test("status filtering separates blocked, failed and broadcasted receipts", () => {
  const store = newStore();
  store.createReceipt({ source: "manual", newsType: "Stock", title: "Landed", status: "posted" });
  store.createReceipt({ source: "manual", newsType: "Stock", title: "Half landed", status: "partial" });
  store.createReceipt({ source: "manual", newsType: "Stock", title: "Never landed", status: "failed" });
  store.createReceipt({ source: "manual", newsType: "Stock", title: "Refused", status: "blocked" });

  assert.equal(store.list({ status: "broadcasted" }).length, 2, "posted and partial both count as broadcast");
  assert.equal(store.list({ status: "failed" }).length, 1);
  assert.equal(store.list({ status: "blocked" }).length, 1);
  assert.notEqual(
    store.list({ status: "failed" })[0].id,
    store.list({ status: "blocked" })[0].id,
    "a blocked attempt stays distinguishable from a failed delivery",
  );
});

test("category filtering returns only the sender's exact category", () => {
  const store = newStore();
  store.createReceipt({ source: "manual", newsType: "Geopolitics", title: "Border talks", status: "posted" });
  store.createReceipt({ source: "manual", newsType: "Crypto", title: "Bitcoin rallies", status: "posted" });
  store.createReceipt({ source: "manual", title: "No label at all", status: "posted" });

  assert.equal(store.list({ newsType: "Geopolitics" }).length, 1);
  assert.equal(store.list({ newsType: "Crypto" }).length, 1);
  assert.equal(store.list({ newsType: "Unclassified" }).length, 1, "a missing label is filterable, not invisible");
});

/* ── category handling at the send boundary ── */

test("a supported sender category is recorded exactly as sent", async () => {
  await withLedger(async ({ post, store }) => {
    const res = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Geopolitics",
      text: "Border talks resume\nhttps://example.com/audit/border",
      idempotencyKey: "audit-geo-1",
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.receipt.newsType, "Geopolitics", "no keyword guessing over a supplied category");
    assert.equal(store.getReceipt(body.receipt.id).newsType, "Geopolitics");
  });
});

test("a missing category becomes Unclassified rather than a guess", async () => {
  await withLedger(async ({ post }) => {
    const res = await post("/api/broadcast-ledger/broadcast", {
      text: "Bitcoin crashes as crypto markets sell off\nhttps://example.com/audit/nolabel",
      idempotencyKey: "audit-nolabel-1",
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.receipt.newsType, "Unclassified", "crypto keywords must not become a Crypto label");
  });
});

test("an unsupported category is refused, not silently rewritten", async () => {
  await withLedger(async ({ post }) => {
    const res = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Sports",
      text: "Not a market story\nhttps://example.com/audit/sports",
      idempotencyKey: "audit-sports-1",
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /newsType must be one of/);
  });
});

test("the daily category limit is enforced from the resolved category", async () => {
  await withLedger(async ({ post }) => {
    const first = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Geopolitics",
      text: "First geopolitics item\nhttps://example.com/audit/geo-1",
      idempotencyKey: "audit-geo-limit-1",
    });
    assert.equal(first.status, 201);

    const second = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Geopolitics",
      text: "Second geopolitics item\nhttps://example.com/audit/geo-2",
      idempotencyKey: "audit-geo-limit-2",
    });
    const body = await second.json();

    assert.equal(second.status, 409, "the Geopolitics daily cap holds at the send boundary");
    assert.equal(body.receipt.status, "blocked");
  });
});

test("a limited category requires a stable idempotency key", async () => {
  await withLedger(async ({ post }) => {
    const res = await post("/api/broadcast-ledger/broadcast", {
      newsType: "Geopolitics",
      text: "No key supplied\nhttps://example.com/audit/geo-nokey",
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /idempotencyKey is required for limited category Geopolitics/);
  });
});

/* ── partial and failed delivery stay honest ── */

test("a send that reaches one destination of two is recorded as partial", async () => {
  await withLedger(
    async ({ post }) => {
      const res = await post("/api/broadcast-ledger/broadcast", {
        newsType: "Stock",
        text: "Partial delivery\nhttps://example.com/audit/partial",
        idempotencyKey: "audit-partial-1",
      });
      const body = await res.json();

      assert.equal(res.status, 201);
      assert.equal(body.receipt.status, "partial", "a partial send never reads as a clean success");
      assert.equal(body.receipt.destinations.find((d) => d.status === "posted").messageId, "600");
      assert.ok(body.receipt.destinations.find((d) => d.status === "failed").error);
    },
    {
      sendImpl: async (text, options) => ({
        posted: 1,
        failed: 1,
        destinations: [
          { channel: "telegram", chatId: String(options.targets[0].chatId), threadId: String(options.targets[0].threadId), status: "posted", messageId: "600", error: null },
          { channel: "telegram", chatId: String(options.targets[1].chatId), threadId: String(options.targets[1].threadId), status: "failed", messageId: null, error: "chat not found" },
        ],
      }),
    },
  );
});

test("a total send failure leaves a failed receipt, never a phantom success", async () => {
  await withLedger(
    async ({ post, store }) => {
      const res = await post("/api/broadcast-ledger/broadcast", {
        newsType: "Stock",
        text: "Total failure\nhttps://example.com/audit/failed",
        idempotencyKey: "audit-failed-1",
      });
      const body = await res.json();

      assert.equal(res.status, 502);
      assert.equal(body.receipt.status, "failed");
      assert.equal(store.lookup({ url: "https://example.com/audit/failed" }).posted, false,
        "a failed receipt is not evidence the story went out");
    },
    {
      sendImpl: async () => {
        const error = new Error("Telegram send failed for all destinations");
        error.statusCode = 502;
        error.destinations = [
          { channel: "telegram", chatId: "-1001841650798", threadId: "6297", status: "failed", messageId: null, error: "chat not found" },
        ];
        throw error;
      },
    },
  );
});

/* ── auth ── */

test("the machine broadcast endpoint refuses an unauthenticated caller", async () => {
  await withLedger(async ({ base }) => {
    const res = await fetch(`${base}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "should not send" }),
    });

    assert.equal(res.status, 401);
  });
});

test("the ledger page refuses a browser with no credentials at all", async () => {
  await withLedger(async ({ base }) => {
    const res = await fetch(`${base}/api/broadcast-ledger/manual`);
    assert.equal(res.status, 401);
  });
});

test("malformed input is rejected before anything is sent or stored", async () => {
  await withLedger(async ({ post, store, sends }) => {
    assert.equal((await post("/api/broadcast-ledger/broadcast", { text: "" })).status, 400);
    assert.equal((await post("/api/broadcast-ledger/broadcast", { text: "x", url: "not-a-url" })).status, 400);
    assert.equal((await post("/api/broadcast-ledger/broadcast", { text: "x", source: "nobody" })).status, 400);
    assert.equal(sends.length, 0, "nothing reached Telegram");
    assert.equal(store.count(), 0, "nothing reached the ledger");
  });
});
