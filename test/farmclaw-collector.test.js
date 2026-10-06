"use strict";

// FarmClaw's consumer half of the handoff queue. The dashboard half already
// queued and leased items; FarmClaw had nowhere durable to put them, so it
// correctly never sent a receipt. These tests pin the consumer: a receipt is
// only sent for a task that is on FarmClaw's disk, the receipt id is that
// task's id, and a crash anywhere in between converges without duplicates.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-collector-"));
process.env.ADMIN_API_KEY = "collector-test-admin";
process.env.BROADCAST_LEDGER_API_KEY = "collector-test-ledger";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { FarmclawHandoffStore } = require("../src/services/farmclaw-handoffs");
const { FarmclawIntakeStore } = require("../src/services/farmclaw-intake");
const { createHandoffClient, collectOnce } = require("../src/services/farmclaw-collector");

const quiet = { log() {}, warn() {}, error() {} };
// These tests are about the task store and the receipt; delivery always works here.
const deliver = async (payload) => ({ outcome: "delivered", deliveryId: `run_${payload.taskId}` });

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-intake-")), name);
}

/** A client that talks to an in-process handoff store, so leases can be time-travelled. */
function storeClient(handoffs, { failReceipts = 0 } = {}) {
  let receiptFailures = failReceipts;
  const reply = (fn) => {
    try {
      const value = fn();
      if (value === null) return { ok: false, status: 404, json: { error: "Handoff not found" } };
      return { ok: true, status: 200, json: value };
    } catch (err) {
      return { ok: false, status: err.statusCode || 500, json: { error: err.message } };
    }
  };
  return {
    calls: [],
    async claim(body) {
      this.calls.push(["claim"]);
      return reply(() => ({ ok: true, records: handoffs.claim(body) }));
    },
    async receipt(id, body) {
      this.calls.push(["receipt", id, body.receiptId]);
      if (receiptFailures > 0) {
        receiptFailures -= 1;
        throw new Error("socket hang up");
      }
      return reply(() => handoffs.receipt(id, body));
    },
    async fail(id, body) {
      this.calls.push(["fail", id, body.error]);
      return reply(() => handoffs.fail(id, body));
    },
  };
}

test("end to end against the app: queued link becomes a FarmClaw task, then received", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const url = "https://x.com/cryptorover/status/2106855957615804601";
    const queued = await fetch(`${base}/api/farmclaw/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "collector-test-admin" },
      body: JSON.stringify({ url, handle: "cryptorover" }),
    }).then((res) => res.json());
    assert.strictEqual(queued.status, "pending");

    const store = new FarmclawIntakeStore({ file: tmpFile("intake.json") });
    const client = createHandoffClient({ baseUrl: base, key: "collector-test-ledger" });
    const summary = await collectOnce({ client, store, deliver, logger: quiet });
    assert.strictEqual(summary.claimed, 1);
    assert.strictEqual(summary.received, 1);
    assert.deepStrictEqual(summary.errors, []);

    const [task] = store.list();
    assert.strictEqual(task.handoffId, queued.id);
    assert.strictEqual(task.url, url);
    assert.strictEqual(task.handle, "cryptorover");
    assert.strictEqual(task.status, "open");
    assert.ok(task.receiptSentAt);

    const after = await fetch(`${base}/api/farmclaw/handoffs/${queued.id}`, {
      headers: { "x-admin-key": "collector-test-admin" },
    }).then((res) => res.json());
    assert.strictEqual(after.status, "received");
    assert.strictEqual(after.receipt.receiptId, task.id);

    const empty = await collectOnce({ client, store, deliver, logger: quiet });
    assert.strictEqual(empty.claimed, 0);
    assert.strictEqual(store.list().length, 1);

    const badKey = createHandoffClient({ baseUrl: base, key: "wrong" });
    await assert.rejects(collectOnce({ client: badKey, store, deliver, logger: quiet }), /claim failed: HTTP 401/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a lost receipt is re-sent with the same task id after the lease expires", async () => {
  let now = Date.parse("2026-10-06T12:00:00Z");
  const handoffs = new FarmclawHandoffStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-lost-")),
    leaseMs: 60 * 1000,
    now: () => now,
  });
  const { record } = handoffs.request({ url: "https://x.com/a/status/1" });
  const store = new FarmclawIntakeStore({ file: tmpFile("intake.json") });
  const client = storeClient(handoffs, { failReceipts: 1 });

  const first = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(first.pendingRetry, 1);
  assert.strictEqual(handoffs.get(record.id).status, "claimed", "no receipt landed, so not received");
  const [task] = store.list();
  assert.strictEqual(task.receiptSentAt, null);

  const leased = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(leased.claimed, 0, "an active lease is not handed out again");

  now += 61 * 1000;
  const second = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(second.claimed, 1);
  assert.strictEqual(second.received, 1);
  assert.strictEqual(store.list().length, 1, "the re-handed item reuses the existing task");
  assert.strictEqual(handoffs.get(record.id).status, "received");
  assert.strictEqual(handoffs.get(record.id).receipt.receiptId, task.id);
  const receiptIds = client.calls.filter((call) => call[0] === "receipt").map((call) => call[2]);
  assert.deepStrictEqual(receiptIds, [task.id, task.id]);
});

test("an intake store that can't be written reports a failure and never a receipt", async () => {
  const handoffs = new FarmclawHandoffStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-fail-")) });
  const { record } = handoffs.request({ url: "https://x.com/a/status/2" });
  const file = tmpFile("intake.json");
  fs.writeFileSync(file, "{ not json");
  const store = new FarmclawIntakeStore({ file });
  const client = storeClient(handoffs);

  const summary = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(summary.failed, 1);
  assert.ok(!client.calls.some((call) => call[0] === "receipt"));
  const failed = handoffs.get(record.id);
  assert.strictEqual(failed.status, "failed");
  assert.match(failed.error, /^FarmClaw intake store write failed: /);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "{ not json", "a corrupt store is not overwritten");
});

test("a conflicting receipt is recorded on the task, not papered over", async () => {
  let now = Date.parse("2026-10-06T12:00:00Z");
  const handoffs = new FarmclawHandoffStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-conflict-")),
    leaseMs: 60 * 1000,
    now: () => now,
  });
  const { record } = handoffs.request({ url: "https://x.com/a/status/3" });
  handoffs.claim({ agent: "farmclaw" });
  now += 61 * 1000;
  // Another consumer already acknowledged under its own id.
  handoffs.receipt(record.id, { receiptId: "someone_else" });
  handoffs.request({ url: "https://x.com/a/status/4" });

  const store = new FarmclawIntakeStore({ file: tmpFile("intake.json") });
  // Hand the already-received item back to simulate a stale claim response.
  const client = storeClient(handoffs);
  const realClaim = client.claim.bind(client);
  client.claim = async (body) => {
    const res = await realClaim(body);
    res.json.records.push(handoffs.get(record.id));
    return res;
  };

  const summary = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(summary.received, 1);
  assert.strictEqual(summary.errors.length, 1);
  const conflicted = store.get(record.id);
  assert.match(conflicted.receiptError, /HTTP 409/);
  assert.strictEqual(conflicted.receiptSentAt, null);
  assert.strictEqual(handoffs.get(record.id).receipt.receiptId, "someone_else");
});

test("FarmClaw works its tasks through open → in_progress → done", () => {
  const store = new FarmclawIntakeStore({ file: tmpFile("intake.json") });
  const { task, created } = store.intake({ id: "fch_1", url: "https://x.com/a/status/5" });
  assert.strictEqual(created, true);
  assert.strictEqual(store.intake({ id: "fch_1" }).created, false);
  assert.throws(() => store.intake({}), /handoff id is required/);
  assert.throws(() => store.update(task.id, { status: "posted" }), /status must be one of/);

  store.update(task.id, { status: "in_progress" });
  const done = store.update("fch_1", { status: "done", note: "drafted thread" });
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.note, "drafted thread");
  assert.deepStrictEqual(done.history[0], { at: done.updatedAt, event: "updated", from: "in_progress", to: "done" });
  assert.strictEqual(store.list({ status: "open" }).length, 0);
  assert.strictEqual(store.list({ status: "done" }).length, 1);
  assert.strictEqual(store.update("nope", { status: "done" }), null);
});

test("collectOnce refuses to run without a delivery, so it can't acknowledge an undelivered link", async () => {
  const store = new FarmclawIntakeStore({ file: tmpFile("intake.json") });
  await assert.rejects(collectOnce({ client: {}, store, logger: quiet }), /needs a deliver function/);
});
