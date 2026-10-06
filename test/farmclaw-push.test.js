"use strict";

// The dashboard sends a FarmClaw tap straight to the FarmClaw OpenClaw agent
// through the gateway's POST /hooks/agent, with no collector in between. The
// button's ✓ must mean the gateway admitted an agent run for that link.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TOKEN = "hook-secret";
const gateway = { runs: [], mode: "ok", byKey: new Map() };
let gatewayServer;
let app;
let base;

const admin = { "x-admin-key": "push-test-admin" };
const farmclaw = { "x-broadcast-key": "push-test-ledger" };
let seq = 0;
const nextUrl = () => `https://x.com/unusual_whales/status/21076031693920952${String((seq += 1)).padStart(2, "0")}`;

function call(pathname, { method = "POST", body, headers = {} } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

test.before(async () => {
  gatewayServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end("Unauthorized");
      if (gateway.mode === "down") {
        return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "gateway_unavailable" }));
      }
      const key = req.headers["idempotency-key"];
      let runId = gateway.byKey.get(key);
      if (!runId) {
        runId = `run_${gateway.runs.length + 1}`;
        gateway.runs.push({ runId, key, body: JSON.parse(raw) });
        gateway.byKey.set(key, runId);
      }
      if (gateway.mode === "silent") return req.socket.destroy();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, runId }));
    });
  });
  await new Promise((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-push-"));
  process.env.ADMIN_API_KEY = "push-test-admin";
  process.env.BROADCAST_LEDGER_API_KEY = "push-test-ledger";
  process.env.FARMCLAW_OPENCLAW_HOOKS_URL = `http://127.0.0.1:${gatewayServer.address().port}/hooks`;
  process.env.FARMCLAW_OPENCLAW_HOOK_TOKEN = TOKEN;
  process.env.FARMCLAW_OPENCLAW_TIMEOUT_MS = "2000";
  delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;
  const { createApp } = require("../src/app");
  app = http.createServer(createApp());
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => gatewayServer.close(resolve));
});

test.beforeEach(() => { gateway.mode = "ok"; });

test("a tap sends the X link to the FarmClaw agent and answers ✓ with the run id", async () => {
  const url = nextUrl();
  const before = gateway.runs.length;
  const res = await call("/api/farmclaw/handoffs", {
    headers: admin,
    body: { url, handle: "unusual_whales", text: "JUST IN: Netanyahu's odds climb to 37%" },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, "received", JSON.stringify(res.body));
  assert.strictEqual(res.body.push.enabled, true);

  const run = gateway.runs[before];
  assert.strictEqual(gateway.runs.length, before + 1);
  assert.strictEqual(run.body.agentId, "farmclaw");
  assert.strictEqual(run.key, `farmclaw-${res.body.id}`);
  assert.match(run.body.message, new RegExp(url.replace(/[.?]/g, "\\$&")));
  assert.match(run.body.message, /@unusual_whales: JUST IN: Netanyahu's odds climb to 37%/);
  assert.match(run.body.message, new RegExp(`Ref: handoff ${res.body.id}$`));

  assert.strictEqual(res.body.record.receipt.receiptId, `openclaw-run:${run.runId}`);
  assert.match(res.body.record.receipt.note, /^Delivered to the FarmClaw session: OpenClaw agent "farmclaw"/);

  const polled = await call(`/api/farmclaw/handoffs/${res.body.id}`, { method: "GET", headers: admin });
  assert.strictEqual(polled.body.status, "received");
  assert.strictEqual(polled.body.push.enabled, true);
  assert.strictEqual(polled.body.agent.lastPollAt, null, "the dashboard's push is not FarmClaw polling");

  // A second tap doesn't send it again.
  const again = await call("/api/x/farmclaw", { headers: admin, body: { url } });
  assert.strictEqual(again.body.status, "received");
  assert.strictEqual(gateway.runs.length, before + 1);
});

test("the older /api/x/farmclaw route pushes the same way", async () => {
  const res = await call("/api/x/farmclaw", { headers: admin, body: { url: nextUrl() } });
  assert.strictEqual(res.body.status, "received");
  assert.match(res.body.record.receipt.receiptId, /^openclaw-run:run_\d+$/);
});

test("a gateway rejection shows its exact error, and the next tap retries", async () => {
  const url = nextUrl();
  gateway.mode = "down";
  const failed = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(failed.body.status, "failed");
  assert.strictEqual(failed.body.record.error, "OpenClaw hook rejected the run (HTTP 503): gateway_unavailable");

  gateway.mode = "ok";
  const retried = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(retried.body.status, "received");
});

test("no answer from the gateway is a failure that says the run may already exist", async () => {
  gateway.mode = "silent";
  const res = await call("/api/farmclaw/handoffs", { headers: admin, body: { url: nextUrl() } });
  assert.strictEqual(res.body.status, "failed");
  assert.match(res.body.record.error, /no answer after 3 attempts\. The run may already be in FarmClaw: check it before tapping again/);
});

test("a post acknowledged without reaching the agent is sent on the next tap", async () => {
  const url = nextUrl();
  gateway.mode = "down";
  const { body: { id } } = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  gateway.mode = "ok";
  // What an old local-only collector did: a receipt naming only its own file's task.
  const acked = await call(`/api/farmclaw/handoffs/${id}/receipt`, { headers: farmclaw, body: { receiptId: "fct_local_only" } });
  assert.strictEqual(acked.body.status, "received");
  const before = gateway.runs.length;

  const tap = await call("/api/farmclaw/handoffs", { headers: admin, body: { url } });
  assert.strictEqual(tap.body.status, "received");
  assert.match(tap.body.record.receipt.receiptId, /^openclaw-run:/);
  assert.strictEqual(gateway.runs.length, before + 1);
});

test("the sweep sends handoffs that were queued before the hook was configured", async () => {
  const { FarmclawHandoffStore } = require("../src/services/farmclaw-handoffs");
  const { FarmclawPusher } = require("../src/services/farmclaw-pusher");
  const { createOpenclawHookDeliverer } = require("../src/services/farmclaw-openclaw");
  const store = new FarmclawHandoffStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-push-sweep-")) });
  const queued = [store.request({ url: nextUrl() }).record, store.request({ url: nextUrl() }).record];
  const pusher = new FarmclawPusher({
    store,
    agentId: "farmclaw",
    logger: { log() {}, error() {} },
    deliver: createOpenclawHookDeliverer({ url: process.env.FARMCLAW_OPENCLAW_HOOKS_URL, token: TOKEN }),
  });
  await pusher.sweep();
  queued.forEach((record) => assert.strictEqual(store.get(record.id).status, "received"));
  assert.strictEqual(store.agentStatus().lastPollAt, null);
  assert.deepStrictEqual(await pusher.sweep(), [], "nothing left to send");
});
