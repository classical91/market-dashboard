"use strict";

// The collector's delivery step: the claimed link has to reach the live
// FarmClaw session, not only a local file. Pins that a receipt follows only a
// confirmed delivery, that a known failure is retried and then reported, that
// an unknown outcome is never re-sent blindly, and that the delivery command
// never needs to know the dashboard's claim/receipt payloads.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-delivery-"));
process.env.ADMIN_API_KEY = "delivery-test-admin";
process.env.BROADCAST_LEDGER_API_KEY = "delivery-test-ledger";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { FarmclawHandoffStore } = require("../src/services/farmclaw-handoffs");
const { FarmclawIntakeStore } = require("../src/services/farmclaw-intake");
const { createHandoffClient, collectOnce, describeNetworkError } = require("../src/services/farmclaw-collector");
const { createCommandDeliverer } = require("../src/services/farmclaw-delivery");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "farmclaw-collector.js");
const quiet = { log() {}, warn() {}, error() {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-deliver-"));
}

/** A delivery command (a small node script) whose behaviour each test picks. */
function writeDeliverScript(dir, body) {
  const file = path.join(dir, "deliver.js");
  fs.writeFileSync(
    file,
    `const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(path.join(dir, "deliveries.jsonl"))}, JSON.stringify({ payload, env: { url: process.env.FARMCLAW_URL, task: process.env.FARMCLAW_TASK_ID, message: process.env.FARMCLAW_MESSAGE } }) + "\\n");
${body}
`,
  );
  return `"${process.execPath}" "${file}"`;
}

function deliveries(dir) {
  const file = path.join(dir, "deliveries.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function storeClient(handoffs) {
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
    receipts: [],
    fails: [],
    loseNextReceipt: false,
    async claim(body) {
      return reply(() => ({ ok: true, records: handoffs.claim(body) }));
    },
    async receipt(id, body) {
      this.receipts.push({ id, body });
      if (this.loseNextReceipt) {
        this.loseNextReceipt = false;
        throw new Error("socket hang up");
      }
      return reply(() => handoffs.receipt(id, body));
    },
    async fail(id, body) {
      this.fails.push({ id, error: body.error });
      return reply(() => handoffs.fail(id, body));
    },
  };
}

function leasedQueue() {
  let now = Date.parse("2026-10-06T12:00:00Z");
  const handoffs = new FarmclawHandoffStore({ dataDir: tmpDir(), leaseMs: 60 * 1000, now: () => now });
  return { handoffs, advance: () => { now += 61 * 1000; } };
}

test("end to end: the link reaches the session command, then the receipt names the task and delivery", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = tmpDir();
  try {
    const url = "https://www.coindesk.com/markets/2026/10/06/example-story";
    const queued = await fetch(`${base}/api/farmclaw/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "delivery-test-admin" },
      body: JSON.stringify({ url, handle: "CoinDesk", text: "Bitcoin ETF flows turn positive" }),
    }).then((res) => res.json());

    const store = new FarmclawIntakeStore({ file: path.join(dir, "intake.json") });
    const deliver = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.log(JSON.stringify({ deliveryId: "tg_msg_501" }));') });
    const client = createHandoffClient({ baseUrl: base, key: "delivery-test-ledger" });

    const summary = await collectOnce({ client, store, deliver, logger: quiet });
    assert.deepStrictEqual(
      { claimed: summary.claimed, delivered: summary.delivered, received: summary.received, errors: summary.errors },
      { claimed: 1, delivered: 1, received: 1, errors: [] },
    );

    const [sent] = deliveries(dir);
    const [task] = store.list();
    assert.strictEqual(sent.payload.url, url);
    assert.strictEqual(sent.payload.handoffId, queued.id);
    assert.strictEqual(sent.payload.taskId, task.id);
    assert.strictEqual(sent.env.url, url);
    assert.strictEqual(sent.env.task, task.id);
    assert.match(sent.payload.message, /coindesk\.com/);
    assert.match(sent.payload.message, /@CoinDesk: Bitcoin ETF flows turn positive/);
    assert.ok(!("receiptId" in sent.payload), "the delivery command never sees dashboard receipt fields");

    assert.strictEqual(task.delivery.deliveryId, "tg_msg_501");
    const after = await fetch(`${base}/api/farmclaw/handoffs/${queued.id}`, {
      headers: { "x-admin-key": "delivery-test-admin" },
    }).then((res) => res.json());
    assert.strictEqual(after.status, "received");
    assert.strictEqual(after.receipt.receiptId, task.id);
    assert.strictEqual(after.receipt.note, "Delivered to the FarmClaw session: tg_msg_501");

    const again = await collectOnce({ client, store, deliver, logger: quiet });
    assert.strictEqual(again.claimed, 0);
    assert.strictEqual(deliveries(dir).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a delivery the command reports as failed is retried after the lease, then reported with its exact error", async () => {
  const { handoffs, advance } = leasedQueue();
  const { record } = handoffs.request({ url: "https://x.com/a/status/10" });
  const dir = tmpDir();
  const store = new FarmclawIntakeStore({ file: path.join(dir, "intake.json") });
  const deliver = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.error("openclaw: gateway not connected"); process.exit(3);') });
  const client = storeClient(handoffs);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const pass = await collectOnce({ client, store, deliver, logger: quiet });
    assert.strictEqual(pass.pendingRetry, 1, `attempt ${attempt} waits for the lease`);
    assert.strictEqual(handoffs.get(record.id).status, "claimed");
    advance();
  }
  const last = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(last.failed, 1);
  assert.strictEqual(client.receipts.length, 0, "no receipt without a delivery");
  const failed = handoffs.get(record.id);
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.error, "Delivery to the FarmClaw session failed 3 times: delivery command exited 3: openclaw: gateway not connected");
  assert.strictEqual(deliveries(dir).length, 3);

  // A re-tap is a fresh round: the next pass delivers again.
  handoffs.request({ url: "https://x.com/a/status/10" });
  const fixed = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.log(JSON.stringify({ deliveryId: 77 }));') });
  const retried = await collectOnce({ client, store, deliver: fixed, logger: quiet });
  assert.strictEqual(retried.received, 1);
  assert.strictEqual(handoffs.get(record.id).status, "received");
  assert.strictEqual(store.list()[0].delivery.deliveryId, "77");
});

test("an unknown outcome is reported and never re-sent until someone resolves it", async () => {
  const { handoffs } = leasedQueue();
  const { record } = handoffs.request({ url: "https://x.com/a/status/11" });
  const dir = tmpDir();
  const store = new FarmclawIntakeStore({ file: path.join(dir, "intake.json") });
  // Exit 0 but no deliveryId: it may have posted, so it must not be re-posted.
  const deliver = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.log("sent?");') });
  const client = storeClient(handoffs);

  const first = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(first.unknown, 1);
  assert.strictEqual(client.receipts.length, 0);
  assert.match(handoffs.get(record.id).error, /unknown outcome: delivery command exited 0 without \{"deliveryId"/);

  handoffs.request({ url: "https://x.com/a/status/11" });
  const second = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(second.unknown, 1);
  assert.strictEqual(deliveries(dir).length, 1, "a re-tap does not re-send an unknown delivery");
  assert.match(handoffs.get(record.id).error, /Not re-sent, to avoid a duplicate/);

  const [task] = store.list();
  store.resolveDelivery(task.id, { outcome: "retry" });
  handoffs.request({ url: "https://x.com/a/status/11" });
  const ok = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.log(JSON.stringify({ deliveryId: "run_9" }));') });
  const third = await collectOnce({ client, store, deliver: ok, logger: quiet });
  assert.strictEqual(third.received, 1);
  assert.strictEqual(deliveries(dir).length, 2);
});

test("a timed-out delivery command counts as unknown, not failed", async () => {
  const dir = tmpDir();
  const deliver = createCommandDeliverer({ command: writeDeliverScript(dir, "setTimeout(() => {}, 10000);"), timeoutMs: 300 });
  const result = await deliver({ handoffId: "fch_1", taskId: "fct_1", url: "https://x.com/a/status/12", message: "m" });
  assert.strictEqual(result.outcome, "unknown");
  assert.match(result.error, /timed out/);
});

test("delivered but the receipt was lost: the next claim re-sends only the receipt", async () => {
  const { handoffs, advance } = leasedQueue();
  const { record } = handoffs.request({ url: "https://x.com/a/status/13" });
  const dir = tmpDir();
  const store = new FarmclawIntakeStore({ file: path.join(dir, "intake.json") });
  const deliver = createCommandDeliverer({ command: writeDeliverScript(dir, 'console.log(JSON.stringify({ deliveryId: "m1" }));') });
  const client = storeClient(handoffs);
  client.loseNextReceipt = true;

  const first = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(first.delivered, 1);
  assert.strictEqual(first.pendingRetry, 1);
  advance();
  const second = await collectOnce({ client, store, deliver, logger: quiet });
  assert.strictEqual(second.delivered, 0);
  assert.strictEqual(second.received, 1);
  assert.strictEqual(deliveries(dir).length, 1);
  assert.strictEqual(handoffs.get(record.id).status, "received");
  assert.deepStrictEqual(client.receipts.map((r) => r.body.receiptId), [store.list()[0].id, store.list()[0].id]);
});

test("network errors keep their cause instead of a bare 'fetch failed'", async () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND farm-bot.up.railway.app"), { code: "ENOTFOUND" });
  assert.strictEqual(describeNetworkError(err), "fetch failed (ENOTFOUND getaddrinfo ENOTFOUND farm-bot.up.railway.app)");

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const client = createHandoffClient({ baseUrl: `http://127.0.0.1:${port}`, key: "k" });
  const store = new FarmclawIntakeStore({ file: path.join(tmpDir(), "intake.json") });
  await assert.rejects(collectOnce({ client, store, logger: quiet }), /claim failed: fetch failed \(ECONNREFUSED/);
});

test("the CLI will not run without a delivery command unless told to stay local", () => {
  const env = { ...process.env, FARMCLAW_DELIVER_CMD: "", FARMCLAW_OPENCLAW_HOOKS_URL: "", FARMCLAW_OPENCLAW_HOOK_TOKEN: "", FARMCLAW_INTAKE_FILE: path.join(tmpDir(), "intake.json") };
  const refused = spawnSync(process.execPath, [CLI, "run"], { env, encoding: "utf8" });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /no delivery to FarmClaw configured/);

  const local = spawnSync(process.execPath, [CLI, "--local-only", "run", "--url", "http://127.0.0.1:1"], { env, encoding: "utf8" });
  assert.strictEqual(local.status, 1);
  assert.match(local.stderr, /claim failed/, "--local-only gets past the guard");

  const dir = tmpDir();
  const tested = spawnSync(process.execPath, [CLI, "deliver-test", "--link", "https://x.com/a/status/14"], {
    env: { ...env, FARMCLAW_DELIVER_CMD: writeDeliverScript(dir, 'console.log(JSON.stringify({ deliveryId: "t1" }));') },
    encoding: "utf8",
  });
  assert.strictEqual(tested.status, 0, tested.stderr);
  assert.strictEqual(JSON.parse(tested.stdout).result.deliveryId, "t1");
  const [sent] = deliveries(dir);
  assert.strictEqual(sent.payload.test, true);
  assert.strictEqual(sent.payload.url, "https://x.com/a/status/14");
});
