"use strict";

// /api/live-scanner/status must be readable without an admin key (it is the
// dashboard's health panel), must report the scanner as disabled by default,
// and must never leave a scan loop running just because the app was created.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-scanner-route-"));
process.env.ADMIN_API_KEY = "route-test-key";
delete process.env.ENABLE_LIVE_SCANNER;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");

let server;
let base;
let app;

test.before(async () => {
  app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("status is public and reports the scanner disabled by default", async () => {
  const res = await fetch(`${base}/api/live-scanner/status`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.enabled, false);
  assert.equal(body.running, false);
  assert.equal(body.mode, "paper");
  assert.equal(body.symbol, "BTCUSDT.P");
  assert.equal(body.timeframe, "15m");
  assert.equal(body.strategy, "mindset_v1");
  // Nothing has run, so the dashboard's panel renders empty rather than stale.
  assert.equal(body.lastScanAt, null);
  assert.equal(body.lastSignal, null);
  assert.equal(body.lastError, null);
  assert.equal(body.scanCount, 0);
});

test("creating the app does not start the scan loop", () => {
  // Timers belong to server.js; createApp() is also used by tests and the
  // build check, which must not leave a 60s interval running.
  assert.equal(app.locals.liveScanner.status().running, false);
});

test("the manual scan trigger is admin-gated", async () => {
  const res = await fetch(`${base}/api/live-scanner/scan`, { method: "POST" });
  assert.equal(res.status, 401);
});
