"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { BroadcastIngestService, deriveTitle, firstUrl } = require("../src/services/broadcast-ingest");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const CHAT_A = "-1001111";
const CHAT_B = "-1002222";

function freshStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-ingest-"));
  return new BroadcastLedgerStore({ dataDir, logger: { error() {} } });
}

/** Minimal stand-in for the state cache: same get/set contract, no disk. */
function memoryCache() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
}

/**
 * Telegram double. `queue` is a list of getUpdates responses, returned one
 * per call, so a test can drive several polls in sequence.
 */
function fakeTelegram(queue, { chatIds = [CHAT_A], configured = true } = {}) {
  const calls = [];
  return {
    configured,
    _chatIds: chatIds.map((target) =>
      target && typeof target === "object" ? target : { chatId: target, threadId: null },
    ),
    calls,
    async getUpdates(opts) {
      calls.push(opts);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next || [];
    },
  };
}

function channelPost({ updateId, chatId = CHAT_A, threadId, messageId, text }) {
  return {
    update_id: updateId,
    channel_post: {
      message_id: messageId,
      chat: { id: Number(chatId) },
      ...(threadId == null ? {} : { message_thread_id: threadId }),
      text,
    },
  };
}

function makeService(telegram, store, overrides = {}) {
  return new BroadcastIngestService({
    telegramService: telegram,
    broadcastLedgerStore: store,
    stateCache: memoryCache(),
    enabled: true,
    logger: { log() {}, error() {} },
    ...overrides,
  });
}

/* ── text parsing ── */

test("deriveTitle takes the first line with real words in it", () => {
  assert.equal(deriveTitle("Fed holds rates steady\nMore detail here"), "Fed holds rates steady");
  assert.equal(deriveTitle("\n\n  Fed holds rates steady  \n"), "Fed holds rates steady");
});

test("deriveTitle skips a short banner line when a real headline follows", () => {
  assert.equal(deriveTitle("🗓️ 19 AUG\nEthereum upgrade ships this week"), "Ethereum upgrade ships this week");
});

test("deriveTitle strips markup rather than leaking tags into the headline", () => {
  assert.equal(deriveTitle("<b>Fed holds rates steady</b>"), "Fed holds rates steady");
  assert.equal(deriveTitle("**Fed holds rates steady**"), "Fed holds rates steady");
});

test("firstUrl finds the source link and ignores trailing punctuation", () => {
  assert.equal(firstUrl("See https://example.com/news/fed for detail"), "https://example.com/news/fed");
  assert.equal(firstUrl("(https://example.com/a)"), "https://example.com/a");
  assert.equal(firstUrl("no link here"), "");
});

/* ── the core job ── */

test("a channel post becomes a posted receipt with its Telegram message id", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, messageId: 900, text: "Fed holds rates steady\nhttps://example.com/news/fed" })],
  ]);
  const summary = await makeService(telegram, store).runOnce();

  assert.equal(summary.recorded, 1);
  const [receipt] = store.list({ limit: 1 });
  assert.equal(receipt.source, "telegram-ingest");
  assert.equal(receipt.status, "posted");
  assert.equal(receipt.title, "Fed holds rates steady");
  assert.equal(receipt.canonicalUrl, "https://example.com/news/fed");
  assert.equal(receipt.destinations[0].messageId, "900");
  assert.equal(receipt.destinations[0].chatId, CHAT_A);
});

test("an ingested post is immediately visible to a ShareBot67 preflight", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, messageId: 901, text: "Fed holds rates\nhttps://example.com/news/fed" })],
  ]);
  await makeService(telegram, store).runOnce();

  // This is the whole point: nobody reported this broadcast, and the agent
  // still sees it.
  const result = store.lookup({ url: "https://www.example.com/news/fed/" });
  assert.equal(result.posted, true);
  assert.equal(result.receipt.source, "telegram-ingest");
});

test("posts from chats the dashboard does not target are ignored", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, chatId: CHAT_B, messageId: 1, text: "Someone else's channel" })],
  ]);
  const summary = await makeService(telegram, store).runOnce();

  assert.equal(summary.recorded, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(store.count(), 0);
});

test("same chatId messages from a different Telegram topic are ignored", async () => {
  const store = freshStore();
  const telegram = fakeTelegram(
    [[
      channelPost({ updateId: 1, threadId: 6297, messageId: 1, text: "Watched topic" }),
      channelPost({ updateId: 2, threadId: 7000, messageId: 2, text: "Unrelated topic" }),
      channelPost({ updateId: 3, messageId: 3, text: "General room" }),
    ]],
    { chatIds: [{ chatId: CHAT_A, threadId: "6297" }] },
  );

  const summary = await makeService(telegram, store).runOnce();
  assert.deepEqual(summary, { polled: 3, recorded: 1, attached: 0, skipped: 2 });
  assert.equal(store.count(), 1);
  assert.equal(store.list({ limit: 1 })[0].destinations[0].threadId, "6297");
});

test("a channel destination without a thread watches only threadless posts", async () => {
  const store = freshStore();
  const telegram = fakeTelegram(
    [[
      channelPost({ updateId: 1, messageId: 1, text: "Channel post" }),
      channelPost({ updateId: 2, threadId: 99, messageId: 2, text: "Topic post" }),
    ]],
    { chatIds: [{ chatId: CHAT_A, threadId: null }] },
  );

  const summary = await makeService(telegram, store).runOnce();
  assert.equal(summary.recorded, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(store.list({ limit: 1 })[0].destinations[0].threadId, null);
});

test("legacy configuration defaults the ledger watchlist to exact broadcast destinations", () => {
  const store = freshStore();
  const telegram = fakeTelegram([], {
    chatIds: [
      { chatId: CHAT_A, threadId: "6297" },
      { chatId: CHAT_B, threadId: null },
    ],
  });
  const service = makeService(telegram, store);

  assert.deepEqual(service.describe().watchedTargets, [
    { chatId: CHAT_A, threadId: "6297" },
    { chatId: CHAT_B, threadId: null },
  ]);
  assert.deepEqual(telegram._chatIds, [
    { chatId: CHAT_A, threadId: "6297" },
    { chatId: CHAT_B, threadId: null },
  ], "selecting ingest targets must not mutate broadcast destinations");
});

test("an explicit ledger watchlist can select a subset without changing send destinations", () => {
  const store = freshStore();
  const telegram = fakeTelegram([], { chatIds: [CHAT_A, CHAT_B] });
  const service = makeService(telegram, store, { watchTargets: [CHAT_B] });

  assert.deepEqual(service.describe().watchedTargets, [{ chatId: CHAT_B, threadId: null }]);
  assert.deepEqual(telegram._chatIds.map((target) => target.chatId), [CHAT_A, CHAT_B]);
});

test("an explicit environment watchlist overrides an older persisted selection", () => {
  const store = freshStore();
  const telegram = fakeTelegram([], { chatIds: [CHAT_A] });
  const stateCache = memoryCache();
  stateCache.set("broadcastIngest:watchTargets", [{ chatId: CHAT_A, threadId: null }]);

  const service = makeService(telegram, store, {
    stateCache,
    watchTargets: [{ chatId: CHAT_B, threadId: "75972" }],
  });

  assert.deepEqual(service.describe().watchedTargets, [
    { chatId: CHAT_B, threadId: "75972" },
  ]);
});

test("a post with no usable text is skipped rather than stored as an empty receipt", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [
      channelPost({ updateId: 1, messageId: 1, text: "" }),
      { update_id: 2, channel_post: { message_id: 2, chat: { id: Number(CHAT_A) } } },
    ],
  ]);
  const summary = await makeService(telegram, store).runOnce();

  assert.equal(summary.recorded, 0);
  assert.equal(store.count(), 0);
});

/* ── not creating duplicates ── */

test("the dashboard's own broadcast is recognized, not recorded twice", async () => {
  const store = freshStore();
  // What POST /api/daily-report/broadcast leaves behind.
  store.createReceipt({
    source: "dashboard",
    kind: "digest",
    title: "Daily report",
    status: "posted",
    destinations: [{ channel: "telegram", chatId: CHAT_A, status: "posted", messageId: "900" }],
  });

  const telegram = fakeTelegram([[channelPost({ updateId: 1, messageId: 900, text: "CRYPTO TOP 10\n…" })]]);
  const summary = await makeService(telegram, store).runOnce();

  assert.equal(summary.recorded, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(store.count(), 1, "the digest receipt must not be duplicated by its own channel post");
});

test("a post matching a reported receipt attaches its message id instead of forking", async () => {
  const store = freshStore();
  // The shortcut reported first, without a message id.
  const { receipt } = store.createReceipt({
    source: "shortcut",
    title: "Fed holds rates steady",
    url: "https://example.com/news/fed",
    status: "posted",
  });

  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, messageId: 950, text: "Fed holds rates steady\nhttps://example.com/news/fed" })],
  ]);
  const summary = await makeService(telegram, store).runOnce();

  assert.equal(summary.attached, 1);
  assert.equal(summary.recorded, 0);
  assert.equal(store.count(), 1, "one story, one receipt");

  const updated = store.getReceipt(receipt.id);
  assert.equal(updated.source, "shortcut", "the reporting path keeps ownership of the receipt");
  assert.equal(updated.destinations[0].messageId, "950");
  assert.equal(updated.attempts.at(-1).action, "telegram-ingest");
});

test("re-reading the same update never creates a second receipt", async () => {
  const store = freshStore();
  const post = channelPost({ updateId: 1, messageId: 970, text: "Repeated story\nhttps://example.com/r" });
  const telegram = fakeTelegram([[post], [post]]);
  const service = makeService(telegram, store);

  await service.runOnce();
  await service.runOnce();

  assert.equal(store.count(), 1);
});

/* ── offset handling ── */

test("the poll offset advances past handled updates", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [
      channelPost({ updateId: 41, messageId: 1, text: "One\nhttps://example.com/1" }),
      channelPost({ updateId: 42, messageId: 2, text: "Two\nhttps://example.com/2" }),
    ],
    [],
  ]);
  const service = makeService(telegram, store);

  await service.runOnce();
  await service.runOnce();

  assert.equal(telegram.calls[0].offset, undefined, "the first poll starts from wherever Telegram is");
  assert.equal(telegram.calls[1].offset, 43, "the second resumes past the highest update handled");
  assert.equal(store.count(), 2);
});

test("the offset survives a new service instance over the same cache", async () => {
  const store = freshStore();
  const cache = memoryCache();
  const telegram = fakeTelegram([[channelPost({ updateId: 77, messageId: 1, text: "A\nhttps://example.com/a" })], []]);

  await makeService(telegram, store, { stateCache: cache }).runOnce();
  await makeService(telegram, store, { stateCache: cache }).runOnce();

  assert.equal(telegram.calls[1].offset, 78, "a restart resumes rather than re-reading the whole backlog");
});

/* ── failure modes ── */

test("a 409 conflict is reported once and does not throw", async () => {
  const store = freshStore();
  const conflict = Object.assign(new Error("Telegram getUpdates failed (409): Conflict"), { statusCode: 409 });
  const telegram = fakeTelegram([conflict, conflict]);
  const errors = [];
  const service = makeService(telegram, store, { logger: { log() {}, error: (m) => errors.push(m) } });

  const first = await service.runOnce();
  const second = await service.runOnce();

  assert.equal(first.conflict, true);
  assert.equal(second.conflict, true);
  assert.equal(errors.length, 1, "a persistent conflict must not spam the log every poll");
  assert.match(errors[0], /409|another process/i);
});

test("other Telegram errors propagate rather than being swallowed", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([Object.assign(new Error("boom"), { statusCode: 500 })]);
  await assert.rejects(() => makeService(telegram, store).runOnce(), /boom/);
});

test("the watch stays off unless explicitly enabled", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([[channelPost({ updateId: 1, messageId: 1, text: "Ignored" })]]);
  const service = makeService(telegram, store, { enabled: false });

  assert.equal(service.enabled, false);
  await service.runOnce();
  assert.equal(telegram.calls.length, 0, "a disabled watch must not call Telegram at all");
  assert.equal(store.count(), 0);
});

test("the watch stays off when Telegram itself is unconfigured", () => {
  const store = freshStore();
  const telegram = fakeTelegram([], { configured: false });
  assert.equal(makeService(telegram, store).enabled, false);
});

test("start() on a disabled watch leaves no timer running", () => {
  const store = freshStore();
  const telegram = fakeTelegram([], { configured: false });
  const service = makeService(telegram, store);
  service.start();
  assert.equal(service._timer, null);
  service.stop();
});

test("deriveTitle keeps terse headlines, which a length-based rule would eat", () => {
  // The bug this guards: an earlier "short line = banner" rule discarded any
  // headline under ~24 chars whenever a second line followed it.
  assert.equal(deriveTitle("Bitcoin crashes\nDetail follows"), "Bitcoin crashes");
  assert.equal(deriveTitle("Fed holds rates steady\nMore detail"), "Fed holds rates steady");
  assert.equal(deriveTitle("CRYPTO TOP 10\n🗓️ 19 AUG\nFirst story"), "CRYPTO TOP 10");
});

/* ── attribution across the watch/report race ── */

test("the watch seeing a post first does not cost you the attribution", async () => {
  const store = freshStore();
  // The watch polls on a timer, so it often sees the post seconds before the
  // sender's own receipt call lands. That ordering used to produce two
  // receipts: one unattributed, one naming the path.
  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, messageId: 500, text: "Fed holds rates steady\nhttps://example.com/news/fed" })],
  ]);
  await makeService(telegram, store).runOnce();
  assert.equal(store.list({ limit: 1 })[0].source, "telegram-ingest");

  // Then the shortcut reports itself.
  store.createReceipt({
    source: "shortcut",
    title: "Fed holds rates steady",
    url: "https://example.com/news/fed",
    idempotencyKey: "shortcut-run-1",
    status: "posted",
  });

  assert.equal(store.count(), 1, "one broadcast, one receipt");
  const [receipt] = store.list({ limit: 1 });
  assert.equal(receipt.source, "shortcut", "the path that sent it wins over 'observed in the channel'");
  assert.equal(receipt.destinations[0].messageId, "500", "and the watch's message id survives the claim");
});

test("a post nobody claims stays unattributed, which is the honest answer", async () => {
  const store = freshStore();
  const telegram = fakeTelegram([
    [channelPost({ updateId: 1, messageId: 501, text: "Typed straight into Telegram\nhttps://example.com/manual" })],
  ]);
  await makeService(telegram, store).runOnce();

  const { bySource, unattributed } = store.sourceBreakdown();
  assert.equal(bySource["telegram-ingest"], 1);
  assert.equal(unattributed, 1);
});
