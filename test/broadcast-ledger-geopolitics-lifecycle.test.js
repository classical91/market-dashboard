"use strict";

// One Geopolitics run, one receipt.
//
// ShareBot67's post_report.ps1 used to guard under `sharebot67-attempt-<hash>`
// and then record the delivery under `sharebot67-<hash>`. The ledger dedupes on
// the exact idempotency key, so every successful post left two cards: the
// guard's pending one ("Destination not reported") and a separate posted one.
// These tests drive the HTTP sequence the script must follow — guard once,
// keep the returned receipt id, finalize that receipt — against an isolated
// ledger and a fake Telegram, and pin the lifecycle down.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");

const { createBroadcastLedgerRouter } = require("../src/routes/broadcast-ledger");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const LEDGER_KEY = "test-ledger-key";
const DESTINATION = {
  channel: "telegram",
  chatId: "-1001941064823",
  threadId: "984",
  label: "Geopolitics",
};

async function withLedger(run) {
  const store = new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-geo-")),
    logger: { error() {} },
  });
  const notifications = [];
  const app = express();
  app.use(express.json());
  app.use("/api/broadcast-ledger", createBroadcastLedgerRouter({
    broadcastLedgerStore: store,
    telegramService: { configured: false },
    notificationService: { async notify(kind, receipt) { notifications.push({ kind, id: receipt?.id }); } },
    requireLedgerKey(req, res, next) {
      if (req.get("x-broadcast-key") === LEDGER_KEY) return next();
      return res.status(401).json({ error: "unauthorized" });
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/broadcast-ledger`;
  const call = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await run({ store, call, notifications });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * The sequence post_report.ps1 follows, in JS. `telegram()` resolves to
 * `{ outcome: "sent", messageId }`, `{ outcome: "failed", error }` (Telegram
 * said no — confirmed) or `{ outcome: "ambiguous", error }` (no answer; it may
 * have gone out).
 */
async function runGeopoliticsAttempt(call, { reportHash, headline, text, telegram, finalizeWith = "patch" }) {
  // One key per report, used for the guard and every later write.
  const idempotencyKey = `sharebot67-${reportHash}`;
  const guard = await call("POST", "/broadcast/guard", {
    source: "sharebot67",
    newsType: "Geopolitics",
    headline,
    text,
    idempotencyKey,
    destinations: [DESTINATION],
  });
  if (guard.status === 409) return { stage: "blocked", guard, telegramCalled: false };
  assert.equal(guard.status, 200, `guard failed: ${JSON.stringify(guard.body)}`);
  const receiptId = guard.body.receipt.id;

  const delivery = await telegram();
  if (delivery.outcome === "ambiguous") {
    // Leave the receipt pending for reconcile; never resend blindly.
    return { stage: "ambiguous", receiptId, telegramCalled: true };
  }

  const final = delivery.outcome === "sent"
    ? {
      source: "sharebot67",
      status: "posted",
      action: "telegram-sent",
      destinations: [{ ...DESTINATION, status: "posted", messageId: String(delivery.messageId) }],
    }
    : {
      source: "sharebot67",
      status: "failed",
      action: "telegram-failed",
      error: delivery.error,
      destinations: [{ ...DESTINATION, status: "failed", error: delivery.error }],
    };
  const finalized = finalizeWith === "patch"
    ? await call("PATCH", `/receipts/${receiptId}`, final)
    : await call("POST", "/receipts", { ...final, newsType: "Geopolitics", title: headline, idempotencyKey });
  return { stage: delivery.outcome, receiptId, finalized, telegramCalled: true };
}

test("guard plus a successful post leaves exactly one receipt, advanced from pending to posted", async () => {
  await withLedger(async ({ store, call }) => {
    const before = await call("POST", "/broadcast/guard", {
      source: "sharebot67",
      newsType: "Geopolitics",
      headline: "Ceasefire talks resume in Doha",
      text: "Ceasefire talks resume in Doha after a week-long pause",
      idempotencyKey: "sharebot67-abc123",
      destinations: [DESTINATION],
    });
    assert.equal(before.status, 200);
    assert.equal(before.body.receipt.status, "pending");
    // The pending card already names where it is headed.
    assert.equal(before.body.receipt.destinations.length, 1);
    assert.equal(before.body.receipt.destinations[0].status, "pending");
    assert.equal(before.body.receipt.destinations[0].messageId, null);

    const patched = await call("PATCH", `/receipts/${before.body.receipt.id}`, {
      source: "sharebot67",
      status: "posted",
      destinations: [{ ...DESTINATION, status: "posted", messageId: "92657" }],
    });
    assert.equal(patched.status, 200);

    assert.equal(store.count(), 1, "the guard's receipt is the only receipt");
    const receipt = store.getReceipt(before.body.receipt.id);
    assert.equal(receipt.status, "posted");
    assert.equal(receipt.idempotencyKey, "sharebot67-abc123");
    assert.deepStrictEqual(
      receipt.destinations.map(({ channel, chatId, threadId, label, status, messageId }) => ({ channel, chatId, threadId, label, status, messageId })),
      [{ channel: "telegram", chatId: "-1001941064823", threadId: "984", label: "Geopolitics", status: "posted", messageId: "92657" }],
    );
    assert.deepStrictEqual(receipt.attempts.map((attempt) => attempt.action), ["guard", "update"]);
    assert.equal(store.list({ status: "pending" }).length, 0, "no orphaned pending card");
  });
});

test("the full script sequence records destination evidence and the Telegram message id", async () => {
  await withLedger(async ({ store, call }) => {
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r1",
      headline: "Border clashes reported overnight",
      text: "Border clashes reported overnight near the disputed crossing",
      telegram: async () => ({ outcome: "sent", messageId: 92657 }),
    });
    assert.equal(run.stage, "sent");
    assert.equal(store.count(), 1);
    const [receipt] = store.list();
    assert.equal(receipt.id, run.receiptId);
    assert.equal(receipt.status, "posted");
    assert.equal(receipt.newsType, "Geopolitics");
    assert.equal(receipt.destinations[0].chatId, DESTINATION.chatId);
    assert.equal(receipt.destinations[0].threadId, DESTINATION.threadId);
    assert.equal(receipt.destinations[0].label, DESTINATION.label);
    assert.equal(receipt.destinations[0].messageId, "92657");
  });
});

test("the old split keys are what forked the receipt", async () => {
  // Documents the bug: a guard key and a different finalization key are two
  // receipts by design, because the ledger never merges on a guess.
  await withLedger(async ({ store, call }) => {
    await call("POST", "/broadcast/guard", {
      source: "sharebot67", newsType: "Geopolitics", headline: "Split key story", idempotencyKey: "sharebot67-attempt-h1",
    });
    await call("POST", "/receipts", {
      source: "sharebot67", newsType: "Geopolitics", title: "Split key story", idempotencyKey: "sharebot67-h1", status: "posted",
    });
    assert.equal(store.count(), 2);
  });
});

test("finalizing by POST with the same key updates the guard's receipt instead of creating another", async () => {
  await withLedger(async ({ store, call }) => {
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r2",
      headline: "Sanctions package agreed",
      text: "Sanctions package agreed by foreign ministers",
      telegram: async () => ({ outcome: "sent", messageId: 501 }),
      finalizeWith: "post",
    });
    assert.equal(run.finalized.status, 200);
    assert.equal(run.finalized.body.created, false);
    assert.equal(run.finalized.body.receipt.id, run.receiptId);
    assert.equal(store.count(), 1);
    assert.equal(store.getReceipt(run.receiptId).status, "posted");
    assert.equal(store.getReceipt(run.receiptId).destinations[0].messageId, "501");
  });
});

test("POST finalization also accepts the guard's attemptId spelling of the key", async () => {
  await withLedger(async ({ store, call }) => {
    const guard = await call("POST", "/broadcast/guard", {
      source: "sharebot67", newsType: "Geopolitics", headline: "Attempt id story", attemptId: "sharebot67-r3",
    });
    const finalized = await call("POST", "/receipts", {
      source: "sharebot67", newsType: "Geopolitics", title: "Attempt id story", attemptId: "sharebot67-r3",
      status: "posted", destinations: [{ ...DESTINATION, status: "posted", messageId: "77" }],
    });
    assert.equal(finalized.body.receipt.id, guard.body.receipt.id);
    assert.equal(store.count(), 1);
  });
});

test("repeated finalization is idempotent", async () => {
  await withLedger(async ({ store, call }) => {
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r4",
      headline: "Summit postponed",
      text: "Summit postponed amid security concerns",
      telegram: async () => ({ outcome: "sent", messageId: 9001 }),
    });
    const final = {
      source: "sharebot67",
      status: "posted",
      destinations: [{ ...DESTINATION, status: "posted", messageId: "9001" }],
    };
    await call("PATCH", `/receipts/${run.receiptId}`, final);
    await call("POST", "/receipts", { ...final, title: "Summit postponed", idempotencyKey: "sharebot67-r4" });

    assert.equal(store.count(), 1);
    const receipt = store.getReceipt(run.receiptId);
    assert.equal(receipt.status, "posted");
    assert.equal(receipt.destinations.length, 1, "destinations merge in place, never duplicate");
    assert.equal(receipt.destinations[0].messageId, "9001");

    // A retried guard on the same key now refuses: the attempt already went out.
    const again = await call("POST", "/broadcast/guard", {
      source: "sharebot67", newsType: "Geopolitics", headline: "Summit postponed", idempotencyKey: "sharebot67-r4",
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.receipt.id, run.receiptId);
    assert.equal(store.count(), 1);
  });
});

test("a confirmed delivery failure marks the same receipt failed and releases the daily slot", async () => {
  await withLedger(async ({ store, call, notifications }) => {
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r5",
      headline: "Election result contested",
      text: "Election result contested by opposition parties",
      telegram: async () => ({ outcome: "failed", error: "Telegram 400: Bad Request: message thread not found" }),
    });
    assert.equal(run.stage, "failed");
    assert.equal(store.count(), 1);
    const receipt = store.getReceipt(run.receiptId);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.destinations[0].status, "failed");
    assert.match(receipt.error.message, /thread not found/);
    assert.ok(notifications.some((n) => n.kind === "failed" && n.id === run.receiptId));

    // Failed receipts release capacity, so the next report may go out.
    const next = await call("POST", "/broadcast/guard", {
      source: "sharebot67", newsType: "Geopolitics", headline: "Next geopolitics story", idempotencyKey: "sharebot67-r6",
    });
    assert.equal(next.status, 200);
  });
});

test("a failure finalized by POST on the same key still notifies", async () => {
  await withLedger(async ({ store, call, notifications }) => {
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r7",
      headline: "Port strike spreads",
      text: "Port strike spreads to three more terminals",
      telegram: async () => ({ outcome: "failed", error: "Telegram 403: bot was kicked" }),
      finalizeWith: "post",
    });
    assert.equal(store.count(), 1);
    assert.equal(store.getReceipt(run.receiptId).status, "failed");
    assert.ok(notifications.some((n) => n.kind === "failed" && n.id === run.receiptId));
  });
});

test("an ambiguous delivery leaves the one receipt pending and is never resent", async () => {
  await withLedger(async ({ store, call }) => {
    let sends = 0;
    const run = await runGeopoliticsAttempt(call, {
      reportHash: "r8",
      headline: "Troop movements observed",
      text: "Troop movements observed near the frontier",
      telegram: async () => { sends += 1; return { outcome: "ambiguous", error: "timeout" }; },
    });
    assert.equal(run.stage, "ambiguous");
    assert.equal(sends, 1);
    assert.equal(store.count(), 1);
    assert.equal(store.getReceipt(run.receiptId).status, "pending");
  });
});

test("a 409 from the guard stops the run before Telegram", async () => {
  await withLedger(async ({ store, call }) => {
    let sends = 0;
    const telegram = async () => { sends += 1; return { outcome: "sent", messageId: sends }; };
    const first = await runGeopoliticsAttempt(call, {
      reportHash: "r9", headline: "First geopolitics story today", text: "First geopolitics story today", telegram,
    });
    assert.equal(first.stage, "sent");

    const second = await runGeopoliticsAttempt(call, {
      reportHash: "r10", headline: "Second geopolitics story today", text: "Second geopolitics story today", telegram,
    });
    assert.equal(second.stage, "blocked");
    assert.equal(second.guard.status, 409);
    assert.match(second.guard.body.reason, /daily limit/i);
    assert.equal(second.telegramCalled, false);
    assert.equal(sends, 1, "Telegram was contacted once, for the allowed story only");
    // The posted story plus the visible blocked attempt — nothing pending.
    assert.deepStrictEqual(store.list().map((r) => r.status).sort(), ["blocked", "posted"]);
  });
});

test("the guard never records delivery evidence the sender supplied early", async () => {
  await withLedger(async ({ call }) => {
    const guard = await call("POST", "/broadcast/guard", {
      source: "sharebot67",
      newsType: "Geopolitics",
      headline: "Early evidence story",
      idempotencyKey: "sharebot67-r11",
      destinations: [{ ...DESTINATION, status: "posted", message_id: "123" }],
    });
    assert.equal(guard.body.receipt.status, "pending");
    assert.equal(guard.body.receipt.destinations[0].status, "pending");
    assert.equal(guard.body.receipt.destinations[0].messageId, null);
  });
});
