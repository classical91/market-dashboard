"use strict";

// Delivery into the FarmClaw OpenClaw agent through the gateway's
// POST /hooks/agent. A fake gateway here follows the documented contract:
// Bearer token, 200 { ok, runId } on admission, and replay of the same run
// for a repeated Idempotency-Key. Pins that a link actually reaches the agent,
// that a lost response never starts a second run, and that the dashboard
// receipt follows only an admitted run.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-openclaw-"));
process.env.ADMIN_API_KEY = "openclaw-test-admin";
process.env.BROADCAST_LEDGER_API_KEY = "openclaw-test-ledger";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { FarmclawIntakeStore } = require("../src/services/farmclaw-intake");
const { createHandoffClient, collectOnce } = require("../src/services/farmclaw-collector");
const { createOpenclawHookDeliverer, hooksAgentUrl } = require("../src/services/farmclaw-openclaw");

const CLI = path.resolve(__dirname, "..", "scripts", "farmclaw-collector.js");
const quiet = { log() {}, warn() {}, error() {} };
const noWait = () => Promise.resolve();
const TOKEN = "hook-secret";

/** A minimal OpenClaw gateway: /hooks/agent with auth, admission and idempotent replay. */
async function fakeGateway({ dropResponses = 0, status = 200, rawBody = null } = {}) {
  const runs = [];
  const byKey = new Map();
  let toDrop = dropResponses;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url !== "/hooks/agent" || req.method !== "POST") {
        res.writeHead(404).end("Not Found");
        return;
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "gateway_unavailable" }));
        return;
      }
      if (rawBody !== null) {
        res.writeHead(200, { "content-type": "text/html" }).end(rawBody);
        return;
      }
      const key = req.headers["idempotency-key"];
      let runId = key && byKey.get(key);
      if (!runId) {
        runId = `run_${runs.length + 1}`;
        runs.push({ runId, key, headers: req.headers, body: JSON.parse(raw) });
        if (key) byKey.set(key, runId);
      }
      if (toDrop > 0) {
        // Admitted, but the response never arrives.
        toDrop -= 1;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, runId }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    runs,
    url: `http://127.0.0.1:${server.address().port}/hooks`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const payload = (taskId = "fct_1") => ({
  handoffId: "fch_1",
  taskId,
  url: "https://www.coindesk.com/markets/2026/10/06/story",
  message: "FarmClaw handoff from X Intelligence\nhttps://www.coindesk.com/markets/2026/10/06/story\nRef: fct_1 (handoff fch_1)",
});

test("end to end: a queued link starts a FarmClaw agent run, then the dashboard shows it received", async () => {
  const app = http.createServer(createApp());
  await new Promise((resolve) => app.listen(0, resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const gateway = await fakeGateway();
  try {
    const url = "https://www.coindesk.com/markets/2026/10/06/latest";
    const queued = await fetch(`${base}/api/farmclaw/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "openclaw-test-admin" },
      body: JSON.stringify({ url, handle: "CoinDesk", text: "ETF flows turn positive" }),
    }).then((res) => res.json());

    const store = new FarmclawIntakeStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fc-")), "intake.json") });
    const deliver = createOpenclawHookDeliverer({ url: gateway.url, token: TOKEN, agentId: "farmclaw", sleep: noWait });
    const client = createHandoffClient({ baseUrl: base, key: "openclaw-test-ledger" });

    const summary = await collectOnce({ client, store, deliver, logger: quiet });
    assert.deepStrictEqual(
      { delivered: summary.delivered, received: summary.received, errors: summary.errors },
      { delivered: 1, received: 1, errors: [] },
    );

    const [run] = gateway.runs;
    const [task] = store.list();
    assert.strictEqual(gateway.runs.length, 1);
    assert.strictEqual(run.body.agentId, "farmclaw");
    assert.strictEqual(run.body.deliver, true);
    assert.match(run.body.message, /coindesk\.com\/markets\/2026\/10\/06\/latest/);
    assert.match(run.body.message, /@CoinDesk: ETF flows turn positive/);
    assert.strictEqual(run.headers["idempotency-key"], `farmclaw-${task.id}`);
    assert.ok(!("channel" in run.body), "no announce destination unless configured");

    const after = await fetch(`${base}/api/farmclaw/handoffs/${queued.id}`, {
      headers: { "x-admin-key": "openclaw-test-admin" },
    }).then((res) => res.json());
    assert.strictEqual(after.status, "received");
    assert.strictEqual(after.receipt.note, "Delivered to the FarmClaw session: openclaw-run:run_1");
  } finally {
    await gateway.close();
    await new Promise((resolve) => app.close(resolve));
  }
});

test("a lost response is retried with the same key and never starts a second run", async () => {
  const gateway = await fakeGateway({ dropResponses: 2 });
  try {
    const deliver = createOpenclawHookDeliverer({ url: gateway.url, token: TOKEN, sleep: noWait });
    const result = await deliver(payload());
    assert.deepStrictEqual(result, { outcome: "delivered", deliveryId: "openclaw-run:run_1" });
    assert.strictEqual(gateway.runs.length, 1);
  } finally {
    await gateway.close();
  }
});

test("no answer at all is unknown, so the collector won't re-send it later", async () => {
  const gateway = await fakeGateway({ dropResponses: 10 });
  try {
    const deliver = createOpenclawHookDeliverer({ url: gateway.url, token: TOKEN, retries: 2, sleep: noWait });
    const result = await deliver(payload());
    assert.strictEqual(result.outcome, "unknown");
    assert.match(result.error, /OpenClaw hook request failed: .*no answer after 3 attempts/);
    assert.strictEqual(gateway.runs.length, 1);
  } finally {
    await gateway.close();
  }
});

test("a rejected run is a plain failure with the gateway's reason", async () => {
  const unavailable = await fakeGateway({ status: 503 });
  try {
    const result = await createOpenclawHookDeliverer({ url: unavailable.url, token: TOKEN, sleep: noWait })(payload());
    assert.deepStrictEqual(result, { outcome: "failed", error: "OpenClaw hook rejected the run (HTTP 503): gateway_unavailable" });
  } finally {
    await unavailable.close();
  }

  const gateway = await fakeGateway();
  try {
    const wrongToken = await createOpenclawHookDeliverer({ url: gateway.url, token: "nope", sleep: noWait })(payload());
    assert.deepStrictEqual(wrongToken, { outcome: "failed", error: "OpenClaw hook rejected the run (HTTP 401): Unauthorized" });
    const wrongPath = await createOpenclawHookDeliverer({ url: `${gateway.url}/x`, token: TOKEN, sleep: noWait })(payload());
    assert.strictEqual(wrongPath.outcome, "failed");
    assert.match(wrongPath.error, /HTTP 404/);
    assert.strictEqual(gateway.runs.length, 0);
  } finally {
    await gateway.close();
  }
});

test("a 200 that isn't the admission shape is not taken as proof", async () => {
  const gateway = await fakeGateway({ rawBody: "<html>proxy login</html>" });
  try {
    const result = await createOpenclawHookDeliverer({ url: gateway.url, token: TOKEN, sleep: noWait })(payload());
    assert.strictEqual(result.outcome, "unknown");
    assert.match(result.error, /without \{ ok: true, runId \}/);
  } finally {
    await gateway.close();
  }
});

test("an announce destination is sent only as a complete pair", async () => {
  assert.throws(() => createOpenclawHookDeliverer({ url: "http://127.0.0.1:1/hooks", token: TOKEN, channel: "telegram" }), /both channel and to/);
  assert.throws(() => createOpenclawHookDeliverer({ url: "", token: TOKEN }), /hooks URL is required/);
  assert.throws(() => createOpenclawHookDeliverer({ url: "http://127.0.0.1:1/hooks" }), /hook token is required/);
  assert.strictEqual(hooksAgentUrl("http://127.0.0.1:18789/hooks/"), "http://127.0.0.1:18789/hooks/agent");
  assert.strictEqual(hooksAgentUrl("http://127.0.0.1:18789/hooks/agent"), "http://127.0.0.1:18789/hooks/agent");

  const gateway = await fakeGateway();
  try {
    await createOpenclawHookDeliverer({
      url: gateway.url, token: TOKEN, channel: "telegram", to: "-1001234", accountId: "farmclaw", sleep: noWait,
    })(payload());
    const [{ body }] = gateway.runs;
    assert.deepStrictEqual([body.channel, body.to, body.accountId], ["telegram", "-1001234", "farmclaw"]);
  } finally {
    await gateway.close();
  }
});

test("the CLI takes the OpenClaw hook as the delivery, and refuses two at once", async () => {
  const gateway = await fakeGateway();
  try {
    const env = {
      ...process.env,
      FARMCLAW_DELIVER_CMD: "",
      FARMCLAW_INTAKE_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fc-")), "intake.json"),
      FARMCLAW_OPENCLAW_HOOKS_URL: gateway.url,
      FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN,
      FARMCLAW_OPENCLAW_AGENT_ID: "farmclaw",
    };
    const tested = await new Promise((resolve) => {
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [CLI, "deliver-test", "--link", "https://x.com/a/status/9"], { env });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (code) => resolve({ code, out }));
    });
    assert.strictEqual(tested.code, 0, tested.out);
    assert.strictEqual(JSON.parse(tested.out).result.deliveryId, "openclaw-run:run_1");
    assert.strictEqual(gateway.runs[0].body.agentId, "farmclaw");

    const both = spawnSync(process.execPath, [CLI, "run"], { env: { ...env, FARMCLAW_DELIVER_CMD: "echo" }, encoding: "utf8" });
    assert.strictEqual(both.status, 1);
    assert.match(both.stderr, /not both/);
  } finally {
    await gateway.close();
  }
});
