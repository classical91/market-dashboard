"use strict";

// Runs with ADMIN_API_KEY set: protected routes must reject callers without a
// valid x-admin-key header and pass valid ones through to the handler.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "test-secret-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-admin-"));
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Keep Telegram unconfigured so the passthrough test never makes a network call.
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

test("protected POST rejects a missing admin key with 401", async () => {
  const res = await fetch(`${base}/api/telegram/test`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("protected POST rejects a wrong admin key with 401", async () => {
  const res = await fetch(`${base}/api/telegram/test`, {
    method: "POST",
    headers: { "x-admin-key": "not-the-key" },
  });
  assert.equal(res.status, 401);
});

test("a valid admin key passes the guard through to the handler", async () => {
  // Telegram is unconfigured, so a request that clears the guard reaches the
  // handler and returns its own 400 — proving the guard let it through.
  const res = await fetch(`${base}/api/telegram/test`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not configured/i);
});

test("watchlist POST rejects a missing admin key, then succeeds and is readable anonymously", async () => {
  const rejected = await fetch(`${base}/api/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "BTCUSDT", interval: "4h" }),
  });
  assert.equal(rejected.status, 401);

  const added = await fetch(`${base}/api/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify({ symbol: "BTCUSDT", interval: "4h", label: "BTC" }),
  });
  assert.equal(added.status, 200);

  // GET is public/unauthenticated, same as every other read-only route.
  const anon = await (await fetch(`${base}/api/watchlist`)).json();
  assert.ok(anon.items.some((i) => i.symbol === "BTCUSDT" && i.interval === "4h"));

  const removed = await fetch(`${base}/api/watchlist`, {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify({ symbol: "BTCUSDT", interval: "4h" }),
  });
  assert.equal(removed.status, 200);
  const afterRemove = await removed.json();
  assert.ok(!afterRemove.items.some((i) => i.symbol === "BTCUSDT" && i.interval === "4h"));
});

test("health reveals provider detail to a valid admin key", async () => {
  const anon = await (await fetch(`${base}/api/health`)).json();
  assert.ok(!("etherscanKeySet" in anon));

  const res = await fetch(`${base}/api/health`, { headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.ok("etherscanKeySet" in body);
  assert.ok("covalentKeySet" in body);
  assert.ok("dataSource" in body);
});
