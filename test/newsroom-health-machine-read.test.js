"use strict";

// Runs with both site login and ADMIN_API_KEY set: the shape a real deploy has.
//
// Agent Office reads ShareBot67's live newsroom health from its own server, so
// it presents an x-admin-key and no browser session. This pins the exemption
// that lets it through — and, more importantly, pins that the same key opens
// nothing else in the newsroom namespace. An admin key here is a read
// credential for one endpoint, not a second owner session.
//
// The sibling assertions for a deploy with no ADMIN_API_KEY live in
// test/site-auth.test.js, which must keep that variable unset.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ADMIN_KEY = "newsroom-health-machine-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-newsroom-machine-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-password";
process.env.ADMIN_API_KEY = ADMIN_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");

const HEALTH = "/api/newsroom/health";
const PREFLIGHT = "/api/newsroom/preflight";

// Everything else the newsroom exposes. None of it may be reachable with the
// verification credential: cycle detail carries report text, and the two POSTs
// spend provider credits or post to Telegram.
const CLOSED_READS = [
  "/api/newsroom/cycles",
  "/api/newsroom/cycles/cyc_anything",
];
const CLOSED_WRITES = [
  ["POST", "/api/newsroom/cycles/run"],
  ["POST", "/api/newsroom/cycles/cyc_anything/deliver"],
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

test("a valid admin key reads newsroom health", async () => {
  const res = await fetch(`${base}${HEALTH}`, { headers: adminHeaders });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok("status" in body, "the health payload is what came back");
  assert.ok("lastAttemptedCycle" in body);
  assert.ok("agentRoute" in body);
  assert.ok("counts" in body);

  const head = await fetch(`${base}${HEALTH}`, { method: "HEAD", headers: adminHeaders });
  assert.equal(head.status, 200);
});

test("a valid admin key runs the read-only newsroom preflight", async () => {
  const res = await fetch(`${base}${PREFLIGHT}`, { headers: adminHeaders });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, false, "missing test credentials make the preflight fail closed");
  assert.ok(Array.isArray(body.checks));

  const head = await fetch(`${base}${PREFLIGHT}`, { method: "HEAD", headers: adminHeaders });
  assert.equal(head.status, 200);
});

test("anonymous and wrong-key callers stay locked out of health", async () => {
  const anonymous = await fetch(`${base}${HEALTH}`);
  assert.equal(anonymous.status, 401, "site login still guards health for a browser with no session");

  const wrongKey = await fetch(`${base}${HEALTH}`, { headers: { "x-admin-key": "not-the-key" } });
  assert.equal(wrongKey.status, 401);

  const emptyKey = await fetch(`${base}${HEALTH}`, { headers: { "x-admin-key": "" } });
  assert.equal(emptyKey.status, 401);
});

// A key in a URL ends up in history, proxy logs and referrers. /health is read
// by a server, which can always set a header, so there is no reason to accept
// one any other way.
test("the key cannot travel in the query string", async () => {
  for (const target of [
    `${HEALTH}?key=${encodeURIComponent(ADMIN_KEY)}`,
    `${HEALTH}?adminKey=${encodeURIComponent(ADMIN_KEY)}`,
    `${HEALTH}?x-admin-key=${encodeURIComponent(ADMIN_KEY)}`,
  ]) {
    const res = await fetch(`${base}${target}`);
    assert.equal(res.status, 401, `${target} must not authenticate`);
  }
});

test("the verification key does not open the rest of the newsroom API", async () => {
  for (const target of CLOSED_READS) {
    const res = await fetch(`${base}${target}`, { headers: adminHeaders });
    assert.equal(res.status, 401, `${target} must stay behind the owner session`);
  }

  for (const [method, target] of CLOSED_WRITES) {
    const res = await fetch(`${base}${target}`, {
      method,
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401, `${method} ${target} must not inherit the health exemption`);
  }
});

test("the exemption is scoped to the exact path and to read methods", async () => {
  const write = await fetch(`${base}${HEALTH}`, {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(write.status, 401, "a write to the health path is not a machine read");

  for (const target of ["/api/newsroom/healthz", "/api/newsroom/health/cycles", "/api/newsroom"]) {
    const res = await fetch(`${base}${target}`, { headers: adminHeaders });
    assert.equal(res.status, 401, `${target} must not ride on the health exemption`);
  }
});

test("the health key does not open unrelated protected APIs", async () => {
  // The broadcast ledger is absent on purpose: its own routes have accepted a
  // valid x-admin-key since long before this change, and that is its contract,
  // not a side effect of the health exemption.
  const elsewhere = [
    "/api/reporter",
    "/api/trading-lab/metrics",
    "/api/x/accounts",
    "/api/decision/journal",
    "/api/watchlist",
  ];
  for (const target of elsewhere) {
    const res = await fetch(`${base}${target}`, { headers: adminHeaders });
    assert.notEqual(res.status, 200, `${target} must not become readable with the newsroom health key`);
  }
});

test("the owner session still reads health, and alpha read-only still cannot", async () => {
  const ownerCookie = await login("owner-password");
  const alphaCookie = await login("alpha-password");

  const owner = await fetch(`${base}${HEALTH}`, { headers: { cookie: ownerCookie } });
  assert.equal(owner.status, 200);

  const alpha = await fetch(`${base}${HEALTH}`, { headers: { cookie: alphaCookie } });
  assert.equal(alpha.status, 403, "the read-only alpha session is unchanged by the machine exemption");

  const ownerCycles = await fetch(`${base}/api/newsroom/cycles`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerCycles.status, 200, "the owner session still reads the whole namespace");
});

test("a health read carries no credential, prompt body or report content", async () => {
  const raw = await (await fetch(`${base}${HEALTH}`, { headers: adminHeaders })).text();
  assert.equal(raw.includes(ADMIN_KEY), false);
  assert.equal(raw.includes("owner-password"), false);
  assert.equal(raw.toLowerCase().includes("prompt"), false);
});
