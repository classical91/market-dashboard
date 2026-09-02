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

async function withScopedBroadcastApp(run) {
  const express = require("express");
  const { createBroadcastLedgerRouter } = require("../src/routes/broadcast-ledger");
  const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
  const calls = [];
  const telegramService = {
    configured: true,
    async postText(text, options = {}) {
      calls.push({ text, options });
      const targets = options.targets || [
        { chatId: "-100111", threadId: "1" },
        { chatId: "-100222", threadId: "2" },
        { chatId: "-100333", threadId: "3" },
      ];
      return {
        posted: targets.length,
        failed: 0,
        destinations: targets.map((target, index) => ({
          channel: "telegram",
          chatId: String(target.chatId),
          threadId: target.threadId == null ? null : String(target.threadId),
          status: "posted",
          messageId: String(900 + index),
        })),
      };
    },
  };
  const broadcastLedgerStore = new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-scoped-")),
    logger: { error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/broadcast-ledger", createBroadcastLedgerRouter({
    broadcastLedgerStore,
    telegramService,
    requireLedgerKey(req, res, next) {
      if (req.get("x-broadcast-key") === LEDGER_KEY) return next();
      res.status(401).json({ error: "Unauthorized" });
    },
    ledgerKey: LEDGER_KEY,
    adminKey: ADMIN_KEY,
    rateLimitPerMinute: 0,
  }));
  const scopedServer = http.createServer(app);
  await new Promise((resolve) => scopedServer.listen(0, resolve));
  const scopedBase = `http://127.0.0.1:${scopedServer.address().port}`;
  try {
    await run(scopedBase, calls, broadcastLedgerStore);
  } finally {
    await new Promise((resolve) => scopedServer.close(resolve));
  }
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

test("the Geopolitics guard stores a visible blocked attempt after the daily success limit", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "shortcut",
    title: "Geopolitics daily success",
    newsType: "Geopolitics",
    status: "posted",
    idempotencyKey: "route-geo-success",
  });
  const res = await post("/api/broadcast-ledger/broadcast/guard", {
    source: "sharebot67",
    headline: "Geopolitics blocked follow-up",
    text: "A second geopolitics attempt",
    newsType: "Geopolitics",
    idempotencyKey: "route-geo-blocked",
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.allowed, false);
  assert.equal(body.receipt.status, "blocked");
  assert.match(body.reason, /daily limit/i);
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

test("Stock, Crypto, and Economics broadcasts send only to the approved finance topics", async () => {
  await withScopedBroadcastApp(async (scopedBase, calls) => {
    for (const newsType of ["Stock", "Crypto", "Economics"]) {
      const res = await fetch(`${scopedBase}/api/broadcast-ledger/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
        body: JSON.stringify({
          source: "sharebot67",
          newsType,
          title: `${newsType} route test`,
          text: `${newsType} route test https://example.com/${newsType.toLowerCase()}-route-test`,
          idempotencyKey: `finance-route-${newsType}`,
        }),
      });
      const body = await res.json();

      assert.equal(res.status, 201);
      assert.equal(body.receipt.newsType, newsType);
      assert.deepEqual(body.receipt.destinations.map((destination) => ({
        chatId: destination.chatId,
        threadId: destination.threadId,
      })), [
        { chatId: "-1001841650798", threadId: "6297" },
        { chatId: "-1001941064823", threadId: "984" },
      ]);
    }

    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => Array.isArray(call.options.targets)));
  });
});

// Geopolitics is locked to the War Room topic, and to that alone. It used to
// follow TELEGRAM_CHAT_IDS like an uncategorized send, which put war-room
// stories into the general channels next to the market digests.
test("Geopolitics broadcasts go to the War Room topic", async () => {
  await withScopedBroadcastApp(async (scopedBase, calls) => {
    const res = await fetch(`${scopedBase}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({
        source: "sharebot67",
        newsType: "Geopolitics",
        title: "Geopolitics route test",
        text: "Geopolitics route test https://example.com/geopolitics-route-test",
        idempotencyKey: "geo-route-test",
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.targets, [{ chatId: "-1001841650798", threadId: "75972" }]);
    assert.deepEqual(body.receipt.destinations.map((destination) => ({
      chatId: destination.chatId,
      threadId: destination.threadId,
    })), [
      { chatId: "-1001841650798", threadId: "75972" },
    ]);
  });
});

// The War Room is its own room: a Geopolitics send must not also reach the
// finance topics, and a finance send must not reach the War Room.
test("Geopolitics and the finance categories do not cross over", async () => {
  await withScopedBroadcastApp(async (scopedBase, calls) => {
    for (const newsType of ["Geopolitics", "Crypto"]) {
      await fetch(`${scopedBase}/api/broadcast-ledger/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
        body: JSON.stringify({
          source: "sharebot67",
          newsType,
          title: `${newsType} crossover test`,
          text: `${newsType} crossover test https://example.com/${newsType.toLowerCase()}-crossover`,
          idempotencyKey: `crossover-${newsType}`,
        }),
      });
    }

    const [geo, crypto] = calls.map((call) => call.options.targets.map((t) => `${t.chatId}:${t.threadId}`));
    assert.deepEqual(geo, ["-1001841650798:75972"]);
    assert.deepEqual(crypto, ["-1001841650798:6297", "-1001941064823:984"]);
    assert.ok(!crypto.includes("-1001841650798:75972"), "finance news must not reach the War Room");
    assert.ok(!geo.some((target) => crypto.includes(target)), "Geopolitics must not reach the finance topics");
  });
});

test("Ledger Settings can return finance categories to the general Telegram route", async () => {
  await withScopedBroadcastApp(async (scopedBase, calls) => {
    const saved = await fetch(`${scopedBase}/api/broadcast-ledger/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ financeTopicRoutingEnabled: false }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.financeTopicRoutingEnabled, false);

    const res = await fetch(`${scopedBase}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({
        source: "sharebot67",
        newsType: "Stock",
        title: "General route setting test",
        text: "General route setting test https://example.com/general-route-setting-test",
        idempotencyKey: "general-route-setting-test",
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.targets, undefined);
    assert.deepEqual(body.receipt.destinations.map((destination) => destination.chatId), [
      "-100111", "-100222", "-100333",
    ]);
  });
});

test("failed retries use the same persisted finance-routing setting as first delivery", async () => {
  await withScopedBroadcastApp(async (scopedBase, calls, store) => {
    const restricted = store.createReceipt({
      source: "sharebot67",
      newsType: "Crypto",
      title: "Restricted retry",
      status: "failed",
      destinations: [{ channel: "telegram", chatId: "-1001841650798", threadId: "6297", status: "failed" }],
    }).receipt;
    const first = await fetch(`${scopedBase}/api/broadcast-ledger/receipts/${restricted.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text: "Restricted retry body" }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(calls[0].options.targets, [
      { chatId: "-1001841650798", threadId: "6297" },
      { chatId: "-1001941064823", threadId: "984" },
    ]);

    store.updateSettings({ financeTopicRoutingEnabled: false });
    const general = store.createReceipt({
      source: "sharebot67",
      newsType: "Economics",
      title: "General retry",
      status: "failed",
      destinations: [{ channel: "telegram", chatId: "-1001841650798", threadId: "6297", status: "failed" }],
    }).receipt;
    const second = await fetch(`${scopedBase}/api/broadcast-ledger/receipts/${general.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text: "General retry body" }),
    });
    assert.equal(second.status, 200);
    assert.equal(calls[1].options.targets, undefined);
  });
});

test("broadcast receipts page is mobile-ready without a manual-entry form", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /Broadcast receipts/);
  assert.doesNotMatch(html, /Record one by hand|Save receipt/);
});

// A blocked receipt has no destinations, and the card only rendered
// per-destination errors — so the phone showed a bare "Blocked" with no way to
// tell a duplicate-window hit from a daily cap or a send failure.
test("a blocked receipt card says why it was blocked", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "sharebot67",
    title: "Blocked reason render check",
    newsType: "Crypto",
    status: "blocked",
    error: { message: "Crypto was already broadcast inside the configured 42h window." },
    idempotencyKey: "blocked-reason-render",
  });

  const res = await fetch(`${base}/api/broadcast-ledger/manual`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /class="receipt-reason"/);
  assert.match(html, /already broadcast inside the configured 42h window/);
});

// The reason is stored text and reaches the page unescaped otherwise.
test("a blocked reason is escaped rather than reflected as markup", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "sharebot67",
    title: "Blocked reason escaping check",
    newsType: "Crypto",
    status: "blocked",
    error: { message: "<script>alert(1)</script>" },
    idempotencyKey: "blocked-reason-escape",
  });

  const html = await (await fetch(`${base}/api/broadcast-ledger/manual`, {
    headers: { "x-broadcast-key": LEDGER_KEY },
  })).text();

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// A healthy receipt must not grow an empty reason line.
test("a posted receipt renders no reason line", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "shortcut",
    title: "Posted with no reason to show",
    newsType: "Crypto",
    status: "posted",
    idempotencyKey: "posted-no-reason",
    destinations: [{ channel: "telegram", chatId: "-100999", status: "posted", messageId: "77" }],
  });

  const html = await (await fetch(`${base}/api/broadcast-ledger/manual`, {
    headers: { "x-broadcast-key": LEDGER_KEY },
  })).text();

  const cards = html.split('class="receipt-card"');
  const card = cards.find((chunk) => chunk.includes("Posted with no reason to show"));
  assert.ok(card, "the posted receipt must be on the page");
  assert.ok(!card.includes("receipt-reason"), "a posted receipt has no reason to render");
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

test("the receipts page accepts a key in the query without exposing a manual form", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual?key=${LEDGER_KEY}`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /Broadcast receipts/);
  assert.doesNotMatch(html, /Record one by hand|Save receipt/);
  assert.match(html, new RegExp(`name="key" value="${LEDGER_KEY}"`));
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
  assert.match(await res.text(), /Broadcast receipts/);
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

/* ── status probe used by the Settings card ── */

test("status reports the ledger's contents to a key-authenticated caller", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/status`, {
    headers: { "x-broadcast-key": LEDGER_KEY },
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.configured, true);
  assert.ok(body.count > 0);
  assert.ok(body.latest && body.latest.id, "the newest receipt should be summarized");
  assert.ok(body.latest.createdAt);
});

test("status accepts the admin key, which is what the Settings page sends", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/status`, { headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(res.status, 200);
});

test("status accepts an owner site session with no key at all", async () => {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "site-password", returnTo: "/" }).toString(),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const res = await fetch(`${base}/api/broadcast-ledger/status`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).configured, true);
});

test("status 401s an unauthenticated browser, which is how the card knows to ask for a key", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/status`);
  assert.equal(res.status, 401);
});

test("status leaks no message content — only counts and receipt metadata", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "manual",
    title: "Status metadata check",
    text: "a private body that must never surface in a status probe",
    idempotencyKey: "status-privacy-check",
    status: "posted",
  });

  const res = await fetch(`${base}/api/broadcast-ledger/status`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const raw = await res.text();

  assert.ok(!raw.includes("must never surface"));
  assert.ok(!raw.includes("contentHash"), "hashes are an implementation detail, not status output");
});

test("ledger settings can be read and updated by an administrator", async () => {
  const read = await fetch(`${base}/api/broadcast-ledger/settings`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const initial = await read.json();
  assert.equal(read.status, 200);
  assert.equal(initial.settings.timezone, "America/Vancouver");
  assert.equal(initial.settings.categoryLimits.Geopolitics, 1);
  assert.equal(initial.settings.financeTopicRoutingEnabled, true);

  const saved = await fetch(`${base}/api/broadcast-ledger/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify({ destinationLabels: { "telegram:-1001:44": "War Room" } }),
  });
  const body = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(body.settings.destinationLabels["telegram:-1001:44"], "War Room");
});

test("the Settings page exposes the persisted finance-routing control and exact topics", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  assert.match(source, /id="ledgerFinanceRouting"/);
  assert.match(source, /financeTopicRoutingEnabled/);
  assert.match(source, /-1001841650798 \/ 6297/);
  assert.match(source, /-1001941064823 \/ 984/);
  assert.match(source, /This setting also controls retries/);
});

/* ── the page must always say whether anything was sent ── */

test("an empty ledger says so explicitly, instead of showing a bare form", async () => {
  // The complaint this fixes: with nothing recorded, the page showed fields to
  // fill in and one muted "Nothing recorded yet" line, so an empty ledger was
  // indistinguishable from a broken one.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-ledger-empty-"));
  const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const store = new BroadcastLedgerStore({ dataDir: emptyDir, logger: { error() {} } });

  const html = renderManualForm({
    recent: store.list({ limit: 10 }),
    total: store.count(),
    bySource: store.sourceBreakdown().bySource,
    watching: false,
  });

  assert.match(html, /No broadcasts recorded yet/i);
  assert.match(html, /Channel watch is off/i, "it must say nothing is watching");
  assert.match(html, /BROADCAST_LEDGER_INGEST_ENABLED/, "and how to turn it on");
});

test("with the watch on, an empty ledger says the watch will fill it", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({ recent: [], total: 0, bySource: {}, watching: true });

  assert.match(html, /Watching your Telegram channels/i);
  assert.match(html, /will appear here on its own/i);
  assert.ok(!/Channel watch is off/i.test(html));
});

test("a populated ledger leads with the count and the per-path breakdown", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({
    recent: [
      { id: "r1", title: "Fed holds rates", source: "shortcut", status: "posted", createdAt: new Date().toISOString() },
    ],
    total: 4,
    bySource: { shortcut: 2, sharebot67: 1, "telegram-ingest": 1 },
    watching: true,
  });

  assert.match(html, /<strong>1<\/strong> ledger entry recorded/);
  assert.doesNotMatch(html, /2 Shortcut|1 ShareBot67/);
  assert.match(html, /Unclassified/);
  assert.doesNotMatch(html, /Unattributed/);
});

test("visible broadcasts show sender-supplied labels and expose missing labels", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const at = "2026-08-20T21:31:00.000Z";
  const html = renderManualForm({
    recent: [
      { id: "a", title: "Bitcoin breaks resistance", newsType: "Crypto", source: "shortcut", status: "posted", createdAt: at },
      { id: "b", title: "Morning update", source: "sharebot67", status: "posted", createdAt: at },
    ],
    total: 2,
    bySource: { shortcut: 1, sharebot67: 1 },
    watching: true,
  });

  assert.match(html, /Crypto/);
  assert.match(html, /Unclassified/);
  assert.match(html, /News Reporter/);
});

test("a generic backfill title becomes a category-first news title", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({
    recent: [{
      id: "backfill",
      title: "Broadcasted today — August 20, 2026",
      newsType: "Crypto",
      source: "manual",
      status: "posted",
      createdAt: "2026-08-20T21:31:00.000Z",
    }],
    total: 1,
    bySource: { manual: 1 },
    watching: true,
  });

  assert.match(html, /Crypto News — August 20, 2026/);
  assert.match(html, /Broadcasted/);
  assert.match(html, /Crypto/);
  assert.match(html, /Manual/);
});

test("visible receipts include an authenticated edit form", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({
    recent: [{ id: "receipt-1", title: "Daily report", newsType: "Economics", source: "shortcut", status: "posted" }],
    total: 1,
    bySource: { shortcut: 1 },
    formKey: "secret-key",
  });

  assert.match(html, /manual\/receipt-1\/edit/);
  assert.match(html, /manual\/receipt-1\/delete/);
  assert.match(html, /Delete receipt/);
  assert.match(html, /cannot be undone/);
  assert.match(html, /name="newsType" required/);
  assert.match(html, /value="Economics" selected/);
  assert.match(html, /name="key" value="secret-key"/);
});

test("ledger cards expose destination labels, attempt history, copy, search, and retry controls", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const { DEFAULT_SETTINGS } = require("../src/services/broadcast-ledger");
  const html = renderManualForm({
    recent: [{
      id: "failed-1", title: "Retry this", newsType: "Geopolitics", source: "sharebot67", status: "failed",
      createdAt: new Date().toISOString(),
      destinations: [{ channel: "telegram", chatId: "-1001", threadId: "44", status: "failed", error: "timeout" }],
      attempts: [{ at: new Date().toISOString(), actor: "sharebot67", action: "broadcast", ok: false, detail: "timeout" }],
    }],
    total: 1,
    bySource: { sharebot67: 1 },
    settings: { ...DEFAULT_SETTINGS, destinationLabels: { "telegram:-1001:44": "War Room" } },
  });
  assert.match(html, /War Room/);
  assert.match(html, /Attempt history/);
  assert.match(html, /News Reporter/);
  assert.match(html, /Copy details/);
  assert.match(html, /Retry/);
  assert.match(html, /Headline or receipt ID/);
});

test("unclassified Channel Watch comments stay out of the visible ledger while classified news remains visible", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({
    recent: [
      { id: "comment-1", title: "ordinary room comment", newsType: "Unclassified", source: "telegram-ingest", status: "posted", createdAt: "2026-08-20T18:24:00.000Z" },
      { id: "watch-1", title: "Bitcoin market update", newsType: "Crypto", source: "telegram-ingest", status: "posted", createdAt: "2026-08-20T18:25:00.000Z" },
    ],
    total: 2,
    bySource: { "telegram-ingest": 2 },
    watching: true,
  });

  assert.doesNotMatch(html, /ordinary room comment|comment-1/);
  assert.match(html, /Bitcoin market update/);
  assert.match(html, /Channel Watch/);
  assert.match(html, /<strong>1<\/strong> ledger entry recorded/);
  assert.match(html, /1 shown/);
  assert.match(html, /Broadcast log/);
});

test("statuses use the operator-facing Broadcasted, Failed, Blocked and Pending vocabulary", async () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const at = new Date().toISOString();
  const html = renderManualForm({
    recent: [
      { id: "a", title: "A", source: "shortcut", status: "posted", createdAt: at },
      { id: "b", title: "B", source: "sharebot67", status: "partial", createdAt: at },
      { id: "c", title: "C", source: "manual", status: "pending", createdAt: at },
    ],
    total: 3,
    bySource: {},
    watching: true,
  });

  assert.match(html, /Broadcasted<\/span>/);
  assert.match(html, /Broadcasted \(partial\)/);
  assert.match(html, /Pending/, "a pending receipt must remain explicit");
});

test("the live page carries the state block, not just the form", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/manual`, { headers: { "x-broadcast-key": LEDGER_KEY } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /ledger entr(?:y|ies) recorded/i);
  assert.match(html, /Watching your Telegram channels|Channel watch is off/);
});

test("the receipts page does not expose the watch diagnostics panel", () => {
  const { renderManualForm } = require("../src/routes/broadcast-ledger");
  const html = renderManualForm({ recent: [], total: 0, bySource: {}, watching: true });
  assert.doesNotMatch(html, /Why is nothing appearing|No chats configured|Last checked/);
});

test("describe() reports what the watch is actually doing", async () => {
  const { BroadcastIngestService } = require("../src/services/broadcast-ingest");
  const service = new BroadcastIngestService({
    telegramService: { configured: true, _chatIds: [{ chatId: "-1001", threadId: null }], async getUpdates() { return []; } },
    broadcastLedgerStore: { hasMessage: () => false, lookup: () => ({ posted: false }), createReceipt() {}, updateReceipt() {} },
    stateCache: { get: () => null, set() {} },
    enabled: true,
    logger: { log() {}, error() {} },
  });

  assert.equal(service.describe().lastPollAt, null);
  await service.runOnce();
  const d = service.describe();
  assert.equal(d.enabled, true);
  assert.deepEqual(d.watchedChatIds, ["-1001"]);
  assert.ok(d.lastPollAt, "a completed poll is timestamped so a stalled watch is visible");
  assert.equal(d.lastSummary.polled, 0);
  assert.equal(d.conflict, false);
});

test("describe() records a chat that posted but is not being watched", async () => {
  const { BroadcastIngestService } = require("../src/services/broadcast-ingest");
  const service = new BroadcastIngestService({
    telegramService: {
      configured: true,
      _chatIds: [{ chatId: "-1001", threadId: null }],
      async getUpdates() {
        return [{ update_id: 1, channel_post: { message_id: 5, chat: { id: -1009999 }, text: "Elsewhere" } }];
      },
    },
    broadcastLedgerStore: { hasMessage: () => false, lookup: () => ({ posted: false }), createReceipt() {}, updateReceipt() {} },
    stateCache: { get: () => null, set() {} },
    enabled: true,
    logger: { log() {}, error() {} },
  });

  await service.runOnce();
  assert.deepEqual(service.describe().unwatchedChatIdsSeen, ["-1009999"]);
});

/* ── send-and-record: the path the channel watch structurally cannot cover ── */

test("broadcast requires text", async () => {
  const res = await post("/api/broadcast-ledger/broadcast", { title: "no body" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text is required/i);
});

test("broadcast rejects an unauthenticated caller", async () => {
  const res = await fetch(`${base}/api/broadcast-ledger/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(res.status, 401);
});

test("broadcast rejects a malformed url before sending anything", async () => {
  const res = await post("/api/broadcast-ledger/broadcast", { text: "story", url: "not-a-url" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid http/i);
});

test("broadcast refuses to resend a story the ledger already shows as sent", async () => {
  await post("/api/broadcast-ledger/receipts", {
    source: "shortcut",
    title: "Duplicate guard",
    url: "https://example.com/dupe-guard",
    idempotencyKey: "dupe-guard-seed",
    status: "posted",
  });

  const res = await post("/api/broadcast-ledger/broadcast", {
    text: "Duplicate guard",
    url: "https://example.com/dupe-guard",
  });
  const body = await res.json();

  assert.equal(res.status, 409, "a second send of a posted story must be refused, not sent");
  assert.equal(body.alreadyBroadcast, true);
  assert.equal(body.match, "url");
  assert.equal(body.receipt.source, "shortcut");
});

test("the duplicate guard runs before Telegram is even consulted", async () => {
  // Proof the 409 is the dedupe and not the unconfigured-Telegram 400: same
  // process, Telegram unconfigured, yet this returns 409.
  const res = await post("/api/broadcast-ledger/broadcast", {
    text: "Duplicate guard",
    url: "https://example.com/dupe-guard",
  });
  assert.equal(res.status, 409);
});

/*
 * Success path, at the router level with a Telegram double. The endpoint's
 * whole reason to exist is that the receipt is written from the real send
 * result, so the double returns realistic per-destination outcomes.
 */
function mountBroadcastRouter({ sendResult, sendError, sendImpl } = {}) {
  const express = require("express");
  const httpMod = require("node:http");
  const { createBroadcastLedgerRouter } = require("../src/routes/broadcast-ledger");
  const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

  const store = new BroadcastLedgerStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-bcast-")),
    logger: { error() {} },
  });
  const sends = [];
  const notifications = [];
  const telegramService = {
    configured: true,
    async postText(text, opts) {
      sends.push({ text, opts });
      if (sendImpl) return sendImpl(text, opts);
      if (sendError) throw sendError;
      return sendResult;
    },
  };
  const notificationService = {
    async notify(type, receipt, detail) {
      notifications.push({ type, receipt, detail });
      return { sent: true };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/broadcast-ledger",
    createBroadcastLedgerRouter({
      broadcastLedgerStore: store,
      broadcastIngestService: null,
      telegramService,
      notificationService,
      requireLedgerKey: (req, res, next) => next(),
      ledgerKey: "k",
      adminKey: "",
    }),
  );
  const server = httpMod.createServer(app);
  return { app, server, store, sends, notifications };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Run a body against a freshly mounted router and always close the listener.
 * Without the finally, one failed assertion leaves a live server and the whole
 * test process hangs instead of reporting the failure.
 */
async function withRouter(options, body) {
  const harness = mountBroadcastRouter(options);
  const url = await listen(harness.server);
  try {
    await body({ ...harness, url });
  } finally {
    await new Promise((r) => harness.server.close(r));
  }
}

test("a successful broadcast records a posted receipt carrying the real message ids", async () => {
  await withRouter({
    sendResult: {
      posted: 2,
      failed: 0,
      destinations: [
        { channel: "telegram", chatId: "-1001", threadId: null, status: "posted", messageId: "4410", error: null },
        { channel: "telegram", chatId: "-1002", threadId: null, status: "posted", messageId: "77", error: null },
      ],
    },
  }, async ({ store, sends, url }) => {

    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Fed holds rates steady\nhttps://example.com/news/fed",
        idempotencyKey: "shortcut-run-1",
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.sent, 2);
    assert.equal(sends.length, 1, "it actually sent");
    assert.equal(body.receipt.status, "posted");
    assert.equal(body.receipt.source, "shortcut", "defaults to the shortcut, the path this exists for");
    assert.equal(body.receipt.title, "Fed holds rates steady", "headline derived from the message");
    assert.equal(body.receipt.canonicalUrl, "https://example.com/news/fed", "link picked out of the body");
    assert.deepEqual(
      body.receipt.destinations.map((d) => d.messageId).sort(),
      ["4410", "77"],
      "the ids come from Telegram's response, not the caller's word",
    );
    assert.equal(store.count(), 1);
  });
});

test("a second geopolitics attempt on the same Vancouver day is blocked and recorded", async () => {
  await withRouter({
    sendResult: { posted: 1, failed: 0, destinations: [] },
  }, async ({ store, sends, url }) => {
    store.createReceipt({
      source: "dashboard",
      title: "Morning geopolitics",
      newsType: "Geopolitics",
      status: "posted",
      idempotencyKey: "geo-morning",
    });

    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "shortcut",
        text: "Different geopolitical report",
        newsType: "Geopolitics",
        idempotencyKey: "geo-evening-attempt",
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 409);
    assert.equal(body.allowed, false);
    assert.equal(body.receipt.status, "blocked");
    assert.equal(body.receipt.source, "shortcut");
    assert.equal(sends.length, 0, "the blocked attempt never reaches Telegram");
    assert.equal(store.list({ limit: 2 })[0].status, "blocked", "the attempt remains visible in the ledger");
  });
});

test("an in-flight geopolitics send reserves capacity before Telegram finishes", async () => {
  let releaseSend;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const sendResult = new Promise((resolve) => { releaseSend = resolve; });

  await withRouter({
    sendImpl() {
      markStarted();
      return sendResult;
    },
  }, async ({ url, sends }) => {
    const firstRequest = fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "shortcut",
        text: "First in-flight geopolitics story",
        newsType: "Geopolitics",
        idempotencyKey: "geo-in-flight-1",
      }),
    });
    await started;

    const secondResponse = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "sharebot67",
        text: "Second concurrent geopolitics story",
        newsType: "Geopolitics",
        idempotencyKey: "geo-in-flight-2",
      }),
    });
    const secondBody = await secondResponse.json();

    assert.equal(secondResponse.status, 409);
    assert.match(secondBody.reason, /reached or reserved/i);
    assert.equal(sends.length, 1, "the second attempt never reaches Telegram");

    releaseSend({
      posted: 1,
      failed: 0,
      destinations: [{ channel: "telegram", chatId: "-1", status: "posted", messageId: "10" }],
    });
    assert.equal((await firstRequest).status, 201);
  });
});

test("ledger notification preferences drive blocked, failed, and missing-category alerts", async () => {
  await withRouter({}, async ({ store, notifications, url }) => {
    store.createReceipt({
      source: "shortcut",
      title: "First geopolitics",
      newsType: "Geopolitics",
      status: "posted",
      idempotencyKey: "notify-geo-first",
    });
    const blocked = await fetch(`${url}/api/broadcast-ledger/broadcast/guard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "sharebot67",
        title: "Blocked geopolitics",
        newsType: "Geopolitics",
        idempotencyKey: "notify-geo-blocked",
      }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(notifications.at(-1).type, "blocked");

    const missing = await fetch(`${url}/api/broadcast-ledger/broadcast/guard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "sharebot67", title: "No category", idempotencyKey: "notify-missing" }),
    });
    assert.equal(missing.status, 409);
    assert.equal(notifications.at(-1).type, "missingCategory");

    const { receipt } = store.createReceipt({
      source: "shortcut",
      title: "Pending failure",
      newsType: "Markets",
      status: "pending",
      idempotencyKey: "notify-failure",
    });
    const failed = await fetch(`${url}/api/broadcast-ledger/receipts/${receipt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "shortcut", status: "failed", error: "send failed" }),
    });
    assert.equal(failed.status, 200);
    assert.equal(notifications.at(-1).type, "failed");

    store.updateSettings({ notifications: { blocked: false, failed: false, missingCategory: false } });
    const countBefore = notifications.length;
    await fetch(`${url}/api/broadcast-ledger/broadcast/guard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "sharebot67", title: "Muted missing category", idempotencyKey: "notify-muted" }),
    });
    assert.equal(notifications.length, countBefore);
  });
});

test("ShareBot67 can record a blocked daily geopolitics preflight", async () => {
  await withRouter({}, async ({ store, url }) => {
    store.createReceipt({
      source: "shortcut",
      title: "First geopolitics",
      newsType: "Geopolitics",
      status: "posted",
    });
    const res = await fetch(`${url}/api/broadcast-ledger/broadcast/guard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "sharebot67", text: "Second attempt", newsType: "Geopolitics", idempotencyKey: "geo-preflight-2" }),
    });
    const body = await res.json();

    assert.equal(res.status, 409);
    assert.equal(body.receipt.status, "blocked");
    assert.equal(body.receipt.source, "sharebot67");
  });
});

test("the broadcast is immediately visible to a ShareBot67 preflight", async () => {
  await withRouter({
    sendResult: { posted: 1, failed: 0, destinations: [{ channel: "telegram", chatId: "-1", status: "posted", messageId: "9" }] },
  }, async ({ store, url }) => {

    await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Story\nhttps://example.com/visible" }),
    });

    // The whole point: the Shortcut sent it, and the agent can now see it.
    assert.equal(store.lookup({ url: "https://www.example.com/visible/" }).posted, true);
  });
});

test("a partial send is recorded as partial, keeping the ids that landed", async () => {
  await withRouter({
    sendResult: {
      posted: 1,
      failed: 1,
      destinations: [
        { channel: "telegram", chatId: "-1001", status: "posted", messageId: "12", error: null },
        { channel: "telegram", chatId: "-1002", status: "failed", messageId: null, error: "bot was blocked" },
      ],
    },
  }, async ({ url }) => {

    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Partial story\nhttps://example.com/partial" }),
    });
    const body = await res.json();

    assert.equal(body.receipt.status, "partial");
    assert.equal(body.failed, 1);
    assert.equal(body.receipt.destinations.find((d) => d.chatId === "-1001").messageId, "12");
  });
});

test("a failed send leaves a failed receipt, not a phantom success", async () => {
  await withRouter({
    sendError: Object.assign(new Error("Telegram send failed for all 1 destination(s): chat not found"), {
      statusCode: 502,
      destinations: [{ channel: "telegram", chatId: "-1001", status: "failed", error: "chat not found" }],
    }),
  }, async ({ store, url }) => {

    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Doomed story\nhttps://example.com/doomed" }),
    });
    const body = await res.json();

    assert.equal(res.status, 502);
    assert.equal(body.receipt.status, "failed");
    // And it must not read as broadcast to anyone asking later.
    assert.equal(store.lookup({ url: "https://example.com/doomed" }).posted, false);
  });
});

test("a retried broadcast with the same idempotency key does not double-send", async () => {
  await withRouter({
    sendResult: { posted: 1, failed: 0, destinations: [{ channel: "telegram", chatId: "-1", status: "posted", messageId: "5" }] },
  }, async ({ sends, url }) => {
    const payload = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Retry story\nhttps://example.com/retry", idempotencyKey: "retry-1" }),
    };

    const first = await fetch(`${url}/api/broadcast-ledger/broadcast`, payload);
    const second = await fetch(`${url}/api/broadcast-ledger/broadcast`, payload);

    assert.equal(first.status, 201);
    assert.equal(second.status, 409, "the phone retrying must not fire a second Telegram message");
    assert.equal(sends.length, 1, "exactly one send reached Telegram");
  });
});

test("the default 42-hour window blocks rewritten news in the same category after 30 hours", async () => {
  await withScopedBroadcastApp(async (url, sends, store) => {
    const payload = {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text: "Rolling-day story\nhttps://example.com/rolling-day", newsType: "Stock" }),
    };

    const first = await fetch(`${url}/api/broadcast-ledger/broadcast`, payload);
    assert.equal(first.status, 201);

    const document = JSON.parse(fs.readFileSync(store._file, "utf8"));
    document.receipts[0].createdAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(store._file, JSON.stringify(document), "utf8");

    const duplicate = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      ...payload,
      body: JSON.stringify({ text: "Completely rewritten digest with different stories and no URL", newsType: "Stock" }),
    });
    assert.equal(duplicate.status, 409);
    const body = await duplicate.json();
    assert.equal(body.alreadyBroadcast, true);
    assert.equal(body.match, "category-window");
    assert.equal(body.receipt.status, "blocked");
    assert.equal(sends.length, 1);
  });
});

test("the default category window expires after 42 rolling hours", async () => {
  await withScopedBroadcastApp(async (url, sends, store) => {
    const send = (text) => fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text, newsType: "Stock" }),
    });

    assert.equal((await send("Old stock report")).status, 201);
    const document = JSON.parse(fs.readFileSync(store._file, "utf8"));
    document.receipts[0].createdAt = new Date(Date.now() - 43 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(store._file, JSON.stringify(document), "utf8");

    assert.equal((await send("Fresh stock report")).status, 201);
    assert.equal(sends.length, 2);
  });
});

test("Geopolitics keeps accepting the Shortcut text and newsType payload without an idempotency key", async () => {
  await withScopedBroadcastApp(async (url, sends) => {
    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text: "Geopolitics briefing", newsType: "Geopolitics" }),
    });

    assert.equal(res.status, 201);
    assert.equal(sends.length, 1);
    assert.equal((await res.json()).receipt.newsType, "Geopolitics");
  });
});

test("the category window does not block a different news category", async () => {
  await withScopedBroadcastApp(async (url, sends) => {
    const send = (newsType, text) => fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text, newsType }),
    });

    assert.equal((await send("Stock", "Stock digest")).status, 201);
    assert.equal((await send("Crypto", "Crypto digest")).status, 201);
    assert.equal(sends.length, 2);
  });
});

test("force:true allows a deliberate resend", async () => {
  await withRouter({
    sendResult: { posted: 1, failed: 0, destinations: [{ channel: "telegram", chatId: "-1", status: "posted", messageId: "6" }] },
  }, async ({ sends, url }) => {
    const send = (extra) =>
      fetch(`${url}/api/broadcast-ledger/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Resend me\nhttps://example.com/resend", ...extra }),
      });

    await send({});
    const forced = await send({ force: true });

    assert.equal(forced.status, 201);
    assert.equal(sends.length, 2);
  });
});

test("force:true overrides the Geopolitics category window and daily limit", async () => {
  await withScopedBroadcastApp(async (url, sends) => {
    const send = (text, force = false) => fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": LEDGER_KEY },
      body: JSON.stringify({ text, newsType: "Geopolitics", force }),
    });

    assert.equal((await send("First geopolitics report")).status, 201);
    assert.equal((await send("Deliberate geopolitics override", true)).status, 201);
    assert.equal(sends.length, 2);
  });
});

test("source is honoured so ShareBot67 can use the same endpoint", async () => {
  await withRouter({
    sendResult: { posted: 1, failed: 0, destinations: [{ channel: "telegram", chatId: "-1", status: "posted", messageId: "8" }] },
  }, async ({ url }) => {

    const res = await fetch(`${url}/api/broadcast-ledger/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "sharebot67", text: "Agent story\nhttps://example.com/agent" }),
    });

    assert.equal((await res.json()).receipt.source, "sharebot67");
  });
});
