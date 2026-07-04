"use strict";

// Runs with ADMIN_API_KEY unset: action endpoints must be *disabled*, and
// public probes must not leak configuration detail. Node runs each test file
// in its own process, so the env we set here does not affect other files.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-public-"));
delete process.env.ADMIN_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("health probe stays minimal for anonymous callers", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.ok(!("etherscanKeySet" in body), "must not leak provider key status");
  assert.ok(!("covalentKeySet" in body));
  assert.ok(!("cacheSize" in body));
  assert.ok(!("dataSource" in body));
});

test("telegram status stays public", async () => {
  const res = await fetch(`${base}/api/telegram/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.configured, "boolean");
});

test("action endpoints are disabled (503) when ADMIN_API_KEY is unset", async () => {
  const routes = [
    "/api/daily-report/generate",
    "/api/daily-report/logs/import",
    "/api/ai-analysis/generate",
    "/api/ai-analysis/broadcast",
    "/api/layout-analysis/generate",
    "/api/layout-analysis/broadcast",
    "/api/telegram/test",
  ];
  for (const route of routes) {
    const res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 503, `${route} should be disabled`);
  }
});

test("telegram diagnose is disabled (503) when ADMIN_API_KEY is unset", async () => {
  const res = await fetch(`${base}/api/telegram/diagnose`);
  assert.equal(res.status, 503);
});
