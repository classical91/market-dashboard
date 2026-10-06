"use strict";

// The FarmClaw card button. It used to relay the link through the dashboard's
// Telegram bot and report success once Telegram accepted it, which FarmClaw
// never received. Now the button only queues a handoff, FarmClaw pulls it with
// the machine key, and success is FarmClaw's own receipt. These tests pin that:
// queueing is never success, and nothing goes to Telegram.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-farmclaw-"));
process.env.ADMIN_API_KEY = "farmclaw-test-admin";
process.env.BROADCAST_LEDGER_API_KEY = "farmclaw-test-ledger";
process.env.TELEGRAM_BOT_TOKEN = "123:farmclaw-test-token";
process.env.TELEGRAM_CHAT_IDS = "-1001841650798:6297";
process.env.FARMCLAW_TELEGRAM_CHAT = "-1002222222222:77";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { FarmclawHandoffStore } = require("../src/services/farmclaw-handoffs");
const { describeFarmclawWait } = require("../public/assets/js/x-broadcast");

const originalFetch = global.fetch;
let server;
let base;
let outboundCalls = [];

function mockOutbound() {
  outboundCalls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(base)) return originalFetch(url, init);
    outboundCalls.push(target);
    return { ok: true, status: 200, json: async () => ({ result: { message_id: 7 } }) };
  };
}

function call(pathname, { method = "POST", body, headers = {} } = {}) {
  return originalFetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const admin = { "x-admin-key": "farmclaw-test-admin" };
const farmclaw = { "x-broadcast-key": "farmclaw-test-ledger" };
let urlSeq = 0;
function nextPostUrl() {
  urlSeq += 1;
  return `https://x.com/cryptorover/status/21068559576158046${String(urlSeq).padStart(2, "0")}`;
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => mockOutbound());

test("queueing for FarmClaw is admin-gated on both routes", async () => {
  for (const route of ["/api/x/farmclaw", "/api/farmclaw/handoffs"]) {
    const res = await call(route, { body: { url: nextPostUrl() } });
    assert.notStrictEqual(res.status, 200);
    assert.notStrictEqual(res.status, 201);
  }
  // The machine key is for FarmClaw's side; it cannot create handoffs.
  const res = await call("/api/farmclaw/handoffs", { headers: farmclaw, body: { url: nextPostUrl() } });
  assert.strictEqual(res.status, 401);
});

test("the button only queues: pending, not success, and nothing goes to Telegram", async () => {
  const url = nextPostUrl();
  const res = await call("/api/x/farmclaw", { headers: admin, body: { url, handle: "cryptorover" } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.status, "pending");
  assert.strictEqual(res.body.created, true);
  assert.strictEqual(res.body.record.receipt, null);
  assert.strictEqual(res.body.agent.lastPollAt, null);
  assert.deepStrictEqual(outboundCalls, []);
});

test("a repeat tap returns the same handoff, even with tracking params", async () => {
  const url = nextPostUrl();
  const first = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  const again = await call("/api/x/farmclaw", { headers: admin, body: { url: `${url}?s=20&t=abc` } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.id, first.body.id);
  assert.strictEqual(again.body.created, false);
  assert.strictEqual(again.body.record.requestCount, 2);
});

test("refuses a missing or non-http url without queueing", async () => {
  for (const url of [undefined, "", "javascript:alert(1)"]) {
    const res = await call("/api/x/farmclaw", { headers: admin, body: { url } });
    assert.strictEqual(res.status, 400);
  }
});

test("FarmClaw claims, acknowledges with a receipt, and only then is it received", async () => {
  const url = nextPostUrl();
  const queued = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  const { id } = queued.body;

  const unauthorized = await call("/api/farmclaw/handoffs/claim", { body: {} });
  assert.strictEqual(unauthorized.status, 401);

  const claimed = await call("/api/farmclaw/handoffs/claim", { headers: farmclaw, body: { agent: "farmclaw", limit: 25 } });
  assert.strictEqual(claimed.status, 200);
  const mine = claimed.body.records.find((record) => record.id === id);
  assert.ok(mine, "the queued handoff is handed to FarmClaw");
  assert.strictEqual(mine.status, "claimed");
  assert.strictEqual(mine.url, url);

  const polled = await call(`/api/farmclaw/handoffs/${id}`, { method: "GET", headers: admin });
  assert.strictEqual(polled.body.status, "claimed");
  assert.strictEqual(polled.body.agent.lastPollAgent, "farmclaw");
  assert.ok(polled.body.agent.lastPollAt);

  const noReceipt = await call(`/api/farmclaw/handoffs/${id}/receipt`, { headers: farmclaw, body: {} });
  assert.strictEqual(noReceipt.status, 400);

  const received = await call(`/api/farmclaw/handoffs/${id}/receipt`, {
    headers: farmclaw,
    body: { receiptId: "task_42", agent: "farmclaw", note: "Delivered to the FarmClaw session: run_1" },
  });
  assert.strictEqual(received.status, 200);
  assert.strictEqual(received.body.status, "received");
  assert.strictEqual(received.body.record.receipt.receiptId, "task_42");

  const repeat = await call(`/api/farmclaw/handoffs/${id}/receipt`, { headers: farmclaw, body: { receiptId: "task_42" } });
  assert.strictEqual(repeat.status, 200);
  const conflict = await call(`/api/farmclaw/handoffs/${id}/receipt`, { headers: farmclaw, body: { receiptId: "task_43" } });
  assert.strictEqual(conflict.status, 409);
  const lateFailure = await call(`/api/farmclaw/handoffs/${id}/fail`, { headers: farmclaw, body: { error: "boom" } });
  assert.strictEqual(lateFailure.status, 409);

  // A received post stays received on a repeat tap rather than re-queueing.
  const tapAgain = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(tapAgain.body.status, "received");
  assert.deepStrictEqual(outboundCalls, []);
});

test("a receipt with no proof of delivery to the agent is re-sent on the next tap", async () => {
  // Earlier collectors acknowledged links they had only written to a local
  // file; the button showed ✓ for posts FarmClaw never saw.
  const url = nextPostUrl();
  const { body: { id } } = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  await call("/api/farmclaw/handoffs/claim", { headers: farmclaw, body: { agent: "farmclaw", limit: 25 } });
  await call(`/api/farmclaw/handoffs/${id}/receipt`, { headers: farmclaw, body: { receiptId: "fct_local_only" } });

  const tapAgain = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(tapAgain.body.status, "pending");
  assert.strictEqual(tapAgain.body.requeued, true);
  assert.strictEqual(tapAgain.body.record.receipt, null);
  assert.strictEqual(tapAgain.body.record.history[0].event, "requeued_without_delivery_proof");
});

test("a FarmClaw failure needs the exact error and a repeat tap re-queues it", async () => {
  const url = nextPostUrl();
  const { body: { id } } = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });

  const vague = await call(`/api/farmclaw/handoffs/${id}/fail`, { headers: farmclaw, body: {} });
  assert.strictEqual(vague.status, 400);
  const failed = await call(`/api/farmclaw/handoffs/${id}/fail`, {
    headers: farmclaw,
    body: { error: "x.com fetch returned 429" },
  });
  assert.strictEqual(failed.body.status, "failed");
  assert.strictEqual(failed.body.record.error, "x.com fetch returned 429");

  const retried = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(retried.body.status, "pending");
  assert.strictEqual(retried.body.requeued, true);
  assert.strictEqual(retried.body.record.error, null);
});

test("a claim whose lease runs out is handed out again instead of sticking", () => {
  let now = Date.parse("2026-10-06T12:00:00Z");
  const store = new FarmclawHandoffStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-lease-")),
    leaseMs: 60 * 1000,
    now: () => now,
  });
  const { record } = store.request({ url: "https://x.com/a/status/1" });
  assert.strictEqual(store.claim({ agent: "farmclaw" }).length, 1);
  assert.strictEqual(store.claim({ agent: "farmclaw" }).length, 0, "an active lease is not handed out twice");

  now += 61 * 1000;
  const reclaimed = store.claim({ agent: "farmclaw" });
  assert.strictEqual(reclaimed.length, 1);
  assert.strictEqual(reclaimed[0].id, record.id);
  assert.strictEqual(reclaimed[0].attempts, 2);
});

test("the waiting tooltip says whether FarmClaw has ever checked in", () => {
  const nowMs = Date.parse("2026-10-06T12:10:00Z");
  assert.match(describeFarmclawWait({ status: "pending", agent: {} }, nowMs), /has not checked in yet/);
  assert.match(
    describeFarmclawWait({ status: "claimed", agent: { lastPollAt: "2026-10-06T12:07:00Z" } }, nowMs),
    /picked this up.*last checked in 3 min ago/,
  );
});
