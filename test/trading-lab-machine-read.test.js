"use strict";

// Runs with both site login and ADMIN_API_KEY configured: the shape a real
// deploy has. Pins the narrow machine-read exemption that lets the TraderClaw
// learning-journal sync read Trading Lab evidence with an x-admin-key instead
// of an owner browser session — and pins that it opens nothing else.
//
// The sibling assertions for a deploy with no ADMIN_API_KEY set live in
// test/site-auth.test.js, which must keep that variable unset to prove the
// admin guard fails closed.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "machine-read-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-machine-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-password";
process.env.ADMIN_API_KEY = ADMIN_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");

const MACHINE_READ_PATHS = [
  "/api/trading-lab/pipeline?limit=5",
  "/api/trading-lab/strategy-accounts",
  "/api/trading-lab/signal-actions?limit=2",
];

let server;
let base;
let adminHeaders;

function cookieFrom(res) {
  return String(res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(password) {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, returnTo: "/" }).toString(),
  });
  return cookieFrom(res);
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  adminHeaders = { "x-admin-key": ADMIN_KEY };
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("a valid admin key reads the Trading Lab surfaces the journal sync needs", async () => {
  for (const target of MACHINE_READ_PATHS) {
    const res = await fetch(`${base}${target}`, { headers: adminHeaders });
    assert.equal(res.status, 200, `${target} must be readable with x-admin-key`);
  }

  const pipeline = await fetch(`${base}/api/trading-lab/pipeline?limit=5`, { headers: adminHeaders });
  const body = await pipeline.json();
  assert.ok(body.evaluation, "pipeline payload must carry the evaluation block");
  assert.equal(typeof body.reconciled, "boolean");
});

test("the per-account detail route is readable with a valid admin key", async () => {
  const list = await fetch(`${base}/api/trading-lab/strategy-accounts`, { headers: adminHeaders });
  const { accounts } = await list.json();
  assert.ok(Array.isArray(accounts) && accounts.length > 0, "expected registered strategy accounts");

  for (const account of accounts) {
    const res = await fetch(`${base}/api/trading-lab/strategy-accounts/${account.id}`, { headers: adminHeaders });
    assert.equal(res.status, 200, `${account.id} detail must be readable with x-admin-key`);
  }
});

test("anonymous and wrong-key callers stay locked out of the same surfaces", async () => {
  for (const target of MACHINE_READ_PATHS) {
    const anonymous = await fetch(`${base}${target}`);
    assert.equal(anonymous.status, 401, `${target} must stay closed to anonymous callers`);

    const wrongKey = await fetch(`${base}${target}`, { headers: { "x-admin-key": "not-the-key" } });
    assert.equal(wrongKey.status, 401, `${target} must reject a wrong admin key`);
  }
});

// The whole point of the narrow list: an admin key is a read credential for the
// journal sync's four surfaces, not a second owner session.
test("a valid admin key does not open the rest of the Trading Lab namespace", async () => {
  const closedReads = [
    "/api/trading-lab/",
    "/api/trading-lab/metrics",
    "/api/trading-lab/experiments",
    "/api/trading-lab/research/queue",
    "/api/trading-lab/positions",
    "/api/trading-lab/history",
    "/api/trading-lab/books",
    "/api/trading-lab/strategies",
  ];
  for (const target of closedReads) {
    const res = await fetch(`${base}${target}`, { headers: adminHeaders });
    assert.equal(res.status, 401, `${target} must stay behind the owner session`);
  }
});

test("a valid admin key cannot mutate through the machine-read paths", async () => {
  const writes = [
    ["POST", "/api/trading-lab/positions"],
    ["POST", "/api/trading-lab/reset"],
    ["POST", "/api/trading-lab/mark"],
    ["POST", "/api/trading-lab/evaluate"],
    ["POST", "/api/trading-lab/pipeline"],
    ["POST", "/api/trading-lab/signal-actions"],
    ["DELETE", "/api/trading-lab/strategy-accounts"],
    ["PUT", "/api/trading-lab/strategy-accounts/mindset_v1"],
  ];
  for (const [method, target] of writes) {
    const res = await fetch(`${base}${target}`, {
      method,
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: method === "DELETE" ? undefined : "{}",
    });
    assert.equal(res.status, 401, `${method} ${target} must not inherit the machine-read bypass`);
  }
});

test("the owner session still reads everything and alpha still cannot", async () => {
  const ownerCookie = await login("owner-password");
  const alphaCookie = await login("alpha-password");

  for (const target of MACHINE_READ_PATHS) {
    const owner = await fetch(`${base}${target}`, { headers: { cookie: ownerCookie } });
    assert.equal(owner.status, 200, `${target} must stay readable for the owner session`);

    const alpha = await fetch(`${base}${target}`, { headers: { cookie: alphaCookie } });
    assert.equal(alpha.status, 403, `${target} must stay closed to alpha read-only sessions`);
  }

  const ownerMetrics = await fetch(`${base}/api/trading-lab/metrics`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerMetrics.status, 200);
});
