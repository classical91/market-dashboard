"use strict";

// With site login and ADMIN_API_KEY configured: TraderClaw may read
// /api/gann/observations with an x-admin-key and no session. Nothing else
// under /api/gann opens that way.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "gann-machine-read-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-gann-auth-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-password";
process.env.ADMIN_API_KEY = ADMIN_KEY;
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

// An unsupported symbol is rejected by the route with 400 before any fetch,
// so reaching the router is observable without network access.
test("observations pass site auth with the admin key", async () => {
  const res = await fetch(`${base}/api/gann/observations?symbol=NOTREAL`, { headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(res.status, 400);
});

test("observations without a key or with a wrong key stay behind login", async () => {
  assert.equal((await fetch(`${base}/api/gann/observations?symbol=NOTREAL`)).status, 401);
  assert.equal((await fetch(`${base}/api/gann/observations?symbol=NOTREAL`, { headers: { "x-admin-key": "nope" } })).status, 401);
});

test("the admin key opens no other Gann route", async () => {
  for (const p of ["/api/gann/analysis?symbol=NOTREAL", "/api/gann/backtest?symbol=NOTREAL", "/api/gann/meta"]) {
    const res = await fetch(`${base}${p}`, { headers: { "x-admin-key": ADMIN_KEY } });
    assert.equal(res.status, 401, p);
  }
});
