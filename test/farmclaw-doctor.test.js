"use strict";

// `doctor` names the broken hop between the FarmClaw button and the FarmClaw
// OpenClaw agent, and never starts an agent run while doing it. The fake
// gateway follows the real handler's order: token first (401), then an empty
// message is a 400 "message required" before any dispatch.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-farmclaw-doctor-"));
process.env.ADMIN_API_KEY = "doctor-test-admin";
process.env.BROADCAST_LEDGER_API_KEY = "doctor-test-ledger";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { FarmclawIntakeStore } = require("../src/services/farmclaw-intake");
const { runDoctor } = require("../src/services/farmclaw-doctor");

const TOKEN = "hook-secret";
let app;
let base;

async function fakeGateway({ hooksEnabled = true } = {}) {
  const runs = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!hooksEnabled || req.url !== "/hooks/agent") return res.writeHead(404).end("Not Found");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end("Unauthorized");
      const body = JSON.parse(raw || "{}");
      if (!body.message) {
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "message required" }));
      }
      runs.push(body);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, runId: "r1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { runs, url: `http://127.0.0.1:${server.address().port}/hooks`, close: () => new Promise((r) => server.close(r)) };
}

function env(extra = {}) {
  return { BROADCAST_LEDGER_API_KEY: "doctor-test-ledger", ...extra };
}

function store() {
  return new FarmclawIntakeStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fc-doc-")), "intake.json") });
}

function text(lines) {
  return lines.map(([level, line]) => `[${level}] ${line}`).join("\n");
}

test.before(async () => {
  app = http.createServer(createApp());
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(() => new Promise((resolve) => app.close(resolve)));

test("before any collector has polled, doctor says watch isn't running", async () => {
  const gateway = await fakeGateway();
  try {
    await fetch(`${base}/api/farmclaw/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "doctor-test-admin" },
      body: JSON.stringify({ url: "https://www.coindesk.com/markets/2026/10/06/a" }),
    });
    const { ok, lines } = await runDoctor({
      env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: gateway.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN }),
      dashboardUrl: base,
      store: store(),
    });
    const out = text(lines);
    assert.strictEqual(ok, false);
    assert.match(out, /\[PASS\] delivery: OpenClaw agent "farmclaw"/);
    assert.match(out, /\[PASS\] dashboard reachable/);
    assert.match(out, /pending 1/);
    assert.match(out, /\[FAIL\] the collector has never polled/);
    assert.match(out, /\[PASS\] OpenClaw gateway hook .* token accepted \(no run started\)/);
    assert.strictEqual(gateway.runs.length, 0, "doctor never starts an agent run");
  } finally {
    await gateway.close();
  }
});

test("with a live collector and a working gateway, every hop passes", async () => {
  await fetch(`${base}/api/farmclaw/handoffs/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-broadcast-key": "doctor-test-ledger" },
    body: JSON.stringify({ agent: "farmclaw" }),
  });
  const gateway = await fakeGateway();
  try {
    const { ok, lines } = await runDoctor({
      env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: gateway.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN }),
      dashboardUrl: base,
      store: store(),
    });
    assert.strictEqual(ok, true, text(lines));
    assert.match(text(lines), /\[PASS\] the collector last polled/);
    assert.match(text(lines), /deliver-test/);
    assert.strictEqual(gateway.runs.length, 0);

    const later = await runDoctor({
      env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: gateway.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN }),
      dashboardUrl: base,
      now: Date.now() + 60 * 60 * 1000,
    });
    assert.strictEqual(later.ok, false);
    assert.match(text(later.lines), /\[FAIL\] the collector last polled 1\.0 h ago .*isn't running now/);
  } finally {
    await gateway.close();
  }
});

test("each broken gateway hop is named", async () => {
  const gateway = await fakeGateway();
  try {
    const wrongToken = await runDoctor({
      env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: gateway.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: "nope" }),
      dashboardUrl: base,
    });
    assert.match(text(wrongToken.lines), /HTTP 401: token rejected/);
  } finally {
    await gateway.close();
  }

  const disabled = await fakeGateway({ hooksEnabled: false });
  try {
    const off = await runDoctor({
      env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: disabled.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN }),
      dashboardUrl: base,
    });
    assert.match(text(off.lines), /HTTP 404: no hook here: hooks\.enabled is false/);
  } finally {
    await disabled.close();
  }

  const down = await runDoctor({
    env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: disabled.url, FARMCLAW_OPENCLAW_HOOK_TOKEN: TOKEN }),
    dashboardUrl: base,
  });
  assert.match(text(down.lines), /\[FAIL\] OpenClaw gateway unreachable .*ECONNREFUSED/);
});

test("missing configuration and a wrong dashboard key are named", async () => {
  const nothing = await runDoctor({ env: env(), dashboardUrl: base });
  assert.match(text(nothing.lines), /\[FAIL\] delivery: nothing configured/);

  const half = await runDoctor({ env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: "http://127.0.0.1:9/hooks" }), dashboardUrl: base });
  assert.match(text(half.lines), /\[FAIL\] delivery: FARMCLAW_OPENCLAW_HOOK_TOKEN is missing/);

  const both = await runDoctor({
    env: env({ FARMCLAW_OPENCLAW_HOOKS_URL: "http://x/hooks", FARMCLAW_OPENCLAW_HOOK_TOKEN: "t", FARMCLAW_DELIVER_CMD: "echo" }),
    dashboardUrl: base,
  });
  assert.match(text(both.lines), /\[FAIL\] both the OpenClaw hook and FARMCLAW_DELIVER_CMD are set/);

  const badKey = await runDoctor({ env: { BROADCAST_LEDGER_API_KEY: "wrong" }, dashboardUrl: base });
  assert.match(text(badKey.lines), /\[FAIL\] dashboard rejected the machine key \(HTTP 401\)/);

  const noKey = await runDoctor({ env: {}, dashboardUrl: base });
  assert.match(text(noKey.lines), /\[FAIL\] BROADCAST_LEDGER_API_KEY is not set/);
});

test("an unknown delivery in the task file is flagged with how to resolve it", async () => {
  const tasks = store();
  const { task } = tasks.intake({ id: "fch_x", url: "https://x.com/a/status/1" });
  tasks.beginDelivery(task.id);
  tasks.deliveryUnknown(task.id, { error: "OpenClaw hook request failed: fetch failed" });
  const { lines } = await runDoctor({ env: env(), dashboardUrl: base, store: tasks });
  assert.match(text(lines), new RegExp(`\\[WARN\\] ${task.id} .* UNKNOWN delivery: OpenClaw hook request failed: fetch failed\\. .*--delivery delivered\\|retry`));
});
