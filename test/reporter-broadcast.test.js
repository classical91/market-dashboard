"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "test-secret-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-broadcast-"));
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Keep Telegram unconfigured so these tests never make a network call — the
// route's "not configured" gate is what's under test here.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");
const { ReporterService } = require("../src/services/reporter");
const { MemoryCache } = require("../src/services/cache");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("broadcast rejects a missing admin key with 401", async () => {
  const res = await fetch(`${base}/api/daily-report/broadcast`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("broadcast reports Telegram as unconfigured once the admin guard passes", async () => {
  const res = await fetch(`${base}/api/daily-report/broadcast`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /telegram is not configured/i);
});

test("ReporterService.markBroadcasted round-trips through getBroadcastAt", () => {
  const reporter = new ReporterService({ cache: new MemoryCache(), apiKey: "" });
  assert.equal(reporter.getBroadcastAt(), null);
  const broadcastAt = reporter.markBroadcasted();
  assert.ok(broadcastAt);
  assert.equal(reporter.getBroadcastAt(), broadcastAt);
});
