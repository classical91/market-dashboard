"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const LEDGER_KEY = "test-ledger-key";
const ADMIN_KEY = "test-admin-key";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-routes-"));
process.env.BROADCAST_LEDGER_API_KEY = LEDGER_KEY;
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Site login ON: the whole point of the site-auth bypass is that machine
// callers still get through when the dashboard itself requires a password.
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "site-password";
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

function post(pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY, ...headers },
    body: JSON.stringify(body),
  });
}

/* ── auth ── */

test("an anonymous request is rejected, not silently accepted", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/receipts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(res.status, 401);
});

test("a wrong key is rejected", async () => {
  const res = await post("/api/broadcast-ledger/receipts", { title: "x" }, { "x-broadcast-key": "nope" });
  assert.equal(res.status, 401);
});

test("site login does not block a key-authenticated machine caller", async () => {
  // The regression this guards: siteAuth.requireAccess runs before every
  // /api/* route and only honors the session cookie, so without the ledger
  // bypass the iOS Shortcut and ShareBot67 would both get "Login required"
  // and never reach their own key check.
  const res = await post("/api/broadcast-ledger/receipts", {
    source: "shortcut",
    title: "Site auth must not block this",
    idempotencyKey: "site-auth-check",
    status: "posted",
  });
  assert.equal(res.status, 201, "a valid ledger key must pass site auth");
});

test("the admin key also works, so an existing deploy keeps functioning", async () => {
  const res = await post(
    "/api/broadcast-ledger/receipts",
    { source: "manual", title: "Admin key path", idempotencyKey: "admin-key-check", status: "posted" },
    { "x-broadcast-key": "", "x-admin-key": ADMIN_KEY },
  );
  assert.equal(res.status, 201);
});

test("a Bearer token is accepted, since Shortcuts sets it more naturally", async () => {
  const res = await post(
    "/api/broadcast-ledger/lookup",
    { url: "https://example.com/anything" },
    { "x-broadcast-key": "", authorization: `Bearer ${LEDGER_KEY}` },
  );
  assert.equal(res.status, 200);
});

/* ── validation ── */

test("a payload with nothing identifying is rejected", async () => {
  const res = await post("/api/broadcast-ledger/receipts", { source: "shortcut" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title, url, text/i);
});

test("an unknown source or status is rejected rather than silently coerced", async () => {
  const bad = await post("/api/broadcast-ledger/receipts", { source: "hacker", title: "x" });
  assert.equal(bad.status, 400);
  const badStatus = await post("/api/broadcast-ledger/receipts", { status: "whatever", title: "x" });
  assert.equal(badStatus.status, 400);
});

test("PATCH on an unknown receipt is a 404", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/receipts/rcpt_missing`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
    body: JSON.stringify({ status: "posted" }),
  });
  assert.equal(res.status, 404);
});

/* ── the three integration paths, end to end over HTTP ── */

test("shortcut path: a retried POST is idempotent over HTTP", async () => {
  const payload = {
    source: "shortcut",
    title: "Shortcut retry story",
    url: "https://example.com/shortcut-retry",
    idempotencyKey: "shortcut-retry-1",
    status: "posted",
    destinations: [{ channel: "telegram", chatId: "-100999", status: "posted", messageId: "12" }],
  };

  const first = await post("/api/broadcast-ledger/receipts", payload);
  const second = await post("/api/broadcast-ledger/receipts", payload);
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.receipt.id, firstBody.receipt.id);
});

test("ShareBot67 preflight: lookup reports a story the shortcut already sent", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "shortcut",
    title: "Already broadcast by shortcut",
    url: "https://example.com/news/already?utm_source=ios",
    idempotencyKey: "preflight-seed",
    status: "posted",
  });

  const res = await fetch(
    `${base}/api/broadcast-ledger/lookup?url=${encodeURIComponent("https://www.example.com/news/already/")}`,
    { headers: { "x-broadcast-key": LEDGER_KEY } },
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.posted, true);
  assert.equal(body.match, "url");
  assert.equal(body.receipt.source, "shortcut");
});

test("ShareBot67 records destination results against its own pending receipt", async () => {
  const created = await post("/api/broadcast-ledger/receipts", {
    source: "sharebot67",
    title: "Agent story",
    url: "https://example.com/agent-story",
    idempotencyKey: "agent-run-1",
    status: "pending",
  });
  const { receipt } = await created.json();

  const patched = await fetch(`${base}/api/broadcast-ledger/receipts/${receipt.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
    body: JSON.stringify({
      source: "sharebot67",
      destinations: [
        { channel: "telegram", chatId: "-1001", status: "posted", messageId: "31" },
        { channel: "telegram", chatId: "-1002", status: "failed", error: "bot was blocked" },
      ],
    }),
  });
  const body = await patched.json();

  assert.equal(patched.status, 200);
  assert.equal(body.receipt.status, "partial");
  assert.equal(body.receipt.attempts.at(-1).actor, "sharebot67");
});

test("manual form renders and is mobile-viewport ready", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /Record a broadcast/);
  assert.match(html, /name="title"/);
});

test("manual form submission stores a posted receipt and redirects", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-broadcast-key": LEDGER_KEY },
    body: new URLSearchParams({
      title: "Posted by hand while the gateway was down",
      url: "https://example.com/manual-story",
      channels: "telegram, x",
      status: "posted",
    }).toString(),
    redirect: "manual",
  });

  assert.equal(res.status, 303);

  const lookup = await post("/api/broadcast-ledger/lookup", { url: "https://example.com/manual-story" });
  const body = await lookup.json();
  assert.equal(body.posted, true);
  assert.equal(body.receipt.source, "manual");
  assert.equal(body.receipt.destinations.length, 2);
});

test("the manual form escapes submitted values rather than reflecting markup", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-broadcast-key": LEDGER_KEY },
    body: new URLSearchParams({ title: "", url: "<script>alert(1)</script>" }).toString(),
  });
  const html = await res.text();

  assert.equal(res.status, 400);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;/);
});

/* ── offline reconciliation over HTTP ── */

test("reconcile resolves the agent's pending work against a manual post", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "sharebot67",
    title: "Gateway died mid-post",
    url: "https://example.com/reconcile-me",
    idempotencyKey: "reconcile-pending",
    status: "pending",
  });
  await post("/api/broadcast-ledger/receipts", {
    source: "manual",
    title: "Gateway died mid-post",
    url: "https://example.com/reconcile-me",
    idempotencyKey: "reconcile-manual",
    status: "posted",
  });

  const res = await post("/api/broadcast-ledger/reconcile", {});
  const body = await res.json();

  assert.equal(res.status, 200);
  const entry = body.reconciled.find((r) => r.source === "manual");
  assert.ok(entry, "the pending agent receipt should be reconciled against the manual post");

  // And the story now reads as posted, so the agent will not send it again.
  const lookup = await post("/api/broadcast-ledger/lookup", { url: "https://example.com/reconcile-me" });
  assert.equal((await lookup.json()).posted, true);
});

test("receipts listing supports the recovery query", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/receipts?limit=5&source=manual`, {
    headers: { "x-broadcast-key": LEDGER_KEY },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.receipts));
  assert.ok(body.receipts.length <= 5);
  assert.ok(body.receipts.every((r) => r.source === "manual"));
});

/* ── rate limiting ── */

test("the public endpoint is rate limited", async () => {
  const { createRateLimit } = require("../src/middleware/rate-limit");
  const limiter = createRateLimit({ limit: 2, windowMs: 60_000 });

  function call() {
    let statusCode = 200;
    let body = null;
    const req = { get: () => "203.0.113.9", ip: "203.0.113.9" };
    const res = {
      setHeader() {},
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
        return this;
      },
    };
    let passed = false;
    limiter(req, res, () => {
      passed = true;
    });
    return { passed, statusCode, body };
  }

  assert.equal(call().passed, true);
  assert.equal(call().passed, true);
  const blocked = call();
  assert.equal(blocked.passed, false);
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.body.retryAfter >= 1);
});

test("rate limit buckets are per caller, not global", async () => {
  const { createRateLimit } = require("../src/middleware/rate-limit");
  const limiter = createRateLimit({ limit: 1, windowMs: 60_000 });
  const run = (ip) => {
    let passed = false;
    limiter({ get: () => ip, ip }, { setHeader() {}, status: () => ({ json() {} }) }, () => {
      passed = true;
    });
    return passed;
  };

  assert.equal(run("198.51.100.1"), true);
  assert.equal(run("198.51.100.1"), false);
  assert.equal(run("198.51.100.2"), true, "a different caller must not be blocked by someone else's usage");
});

/* ── manual form access from a phone browser ── */

test("the manual form is reachable with a key in the query, since a browser cannot set headers", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual?key=${LEDGER_KEY}`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /Record a broadcast/);
  // The key is carried forward so the form's own POST is authorized too.
  assert.match(html, new RegExp(`<input type="hidden" name="key" value="${LEDGER_KEY}"`));
});

test("the manual form rejects a browser with no credentials at all", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`);
  assert.equal(res.status, 401);
});

test("the manual form rejects a wrong query key", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual?key=wrong`);
  assert.equal(res.status, 401);
});

test("an owner site session reaches the manual form without any key", async () => {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "site-password", returnTo: "/" }).toString(),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "login should issue a session cookie");

  const res = await fetch(`${base}/api/broadcast-ledger/manual`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Record a broadcast/);
});

test("a form POST authorized by query key is stored, and the key is not saved as receipt content", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key: LEDGER_KEY,
      title: "Filed from the phone",
      url: "https://example.com/from-phone",
      channels: "telegram",
      status: "posted",
    }).toString(),
    redirect: "manual",
  });
  assert.equal(res.status, 303);

  const lookup = await post("/api/broadcast-ledger/lookup", { url: "https://example.com/from-phone" });
  const body = await lookup.json();
  assert.equal(body.posted, true);
  assert.equal(body.receipt.source, "manual");
  assert.ok(!JSON.stringify(body.receipt).includes(LEDGER_KEY), "the auth key must never be persisted");
});

test("machine endpoints stay key-only — an owner cookie is not enough", async () => {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "site-password", returnTo: "/" }).toString(),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const res = await fetch(`${base}/api/broadcast-ledger/receipts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ title: "no key" }),
  });
  assert.equal(res.status, 401);
});
