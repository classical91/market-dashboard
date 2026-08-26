"use strict";

// Boots the real app and checks the /api/x/accounts freshness contract: that
// a total X outage is reported as an outage rather than as an empty feed,
// that a healthy refresh reports itself live, and that the admin diagnostics
// expose provider health without leaking the credential.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-feed-"));
process.env.X_API_BEARER_TOKEN = "route-test-token";
process.env.ADMIN_API_KEY = "route-test-admin";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");
const { X_ACCOUNTS } = require("../src/config/x-accounts");

const originalFetch = global.fetch;
let server;
let base;

// Every handle gets one recent post, so a healthy refresh is unambiguous.
function healthySearchResponse() {
  const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const users = X_ACCOUNTS.map((account, index) => ({
    id: `u${index}`,
    username: account.handle,
  }));
  const tweets = X_ACCOUNTS.map((account, index) => ({
    id: `${1000 + index}`,
    text: `post from ${account.handle}`,
    author_id: `u${index}`,
    created_at: createdAt,
  }));
  return { ok: true, status: 200, json: async () => ({ data: tweets, includes: { users }, meta: {} }) };
}

function failure(status) {
  return { ok: false, status, json: async () => ({}), text: async () => "" };
}

// Only upstream calls are mocked — requests the test itself makes to the
// local server have to reach it.
function mockUpstream(handler) {
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(base)) return originalFetch(url, init);
    return handler(target);
  };
}

function getJson(pathname, headers = {}) {
  return originalFetch(`${base}${pathname}`, { headers }).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

// Runs first, while nothing is cached: a rejected credential must surface as
// an outage. This is the case that used to reach the browser as `posts: []`.
test("a total X outage is reported as unavailable, not as an empty feed", async () => {
  mockUpstream(() => failure(401));

  const { status, body } = await getJson("/api/x/accounts");

  assert.equal(status, 200, "the page still renders; the payload carries the bad news");
  assert.equal(body.status, "unavailable");
  assert.equal(body.posts.length, 0);
  assert.equal(body.failedFeeds.length, X_ACCOUNTS.length);
  assert.ok(body.generatedAt, "the response says when it was generated");
  assert.equal(body.lastSuccessfulFetchAt, null, "nothing has ever been fetched successfully");

  const account = body.accounts[0];
  assert.equal(account.dataState, "unavailable");
  assert.ok(account.lastCheckedAt, "an account reports being checked even when the check failed");
  assert.equal(account.lastSuccessfulFetchAt, null);

  assert.equal(body.providers.official.open, true, "the breaker is reported to the client");
  assert.equal(body.providers.official.state, "auth_failed");
});

test("diagnostics report provider health and cache persistence without leaking the token", async () => {
  const { status, body } = await getJson("/api/x/diagnostics", { "x-admin-key": "route-test-admin" });

  assert.equal(status, 200);
  assert.equal(body.providers.official.configured, true);
  assert.equal(body.cache.persistent, true);
  assert.ok(body.cache.file.endsWith("x-feed-cache.json"));
  assert.equal(body.cache.volumeConfigured, true, "DATA_DIR is set for this test run");
  assert.ok("loadState" in body.cache, "a corrupt cache file must be distinguishable from an empty one");

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("route-test-token"), "the bearer token must never appear in diagnostics");
});

test("diagnostics are admin-gated", async () => {
  const { status } = await getJson("/api/x/diagnostics");
  assert.equal(status, 401);
});

test("a repaired credential recovers once the circuits are reset", async () => {
  mockUpstream(() => healthySearchResponse());

  const reset = await originalFetch(`${base}/api/x/diagnostics/reset-circuits`, {
    method: "POST",
    headers: { "x-admin-key": "route-test-admin" },
  });
  assert.equal(reset.status, 200);

  const { body } = await getJson("/api/x/accounts");

  assert.equal(body.status, "live");
  assert.equal(body.counts.live, X_ACCOUNTS.length);
  assert.equal(body.posts.length, X_ACCOUNTS.length);
  assert.ok(body.lastSuccessfulFetchAt, "a successful refresh is timestamped");

  const account = body.accounts[0];
  assert.equal(account.provider, "x-api");
  assert.equal(account.providerState, "ok");
  assert.equal(account.stale, false);
  assert.ok(account.newestPostAt, "content age is reported separately from data freshness");
});
