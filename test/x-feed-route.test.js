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
const { X_ACCOUNTS, WAR_ACCOUNTS } = require("../src/config/x-accounts");
const MARKET_ACCOUNT_COUNT = X_ACCOUNTS.length - WAR_ACCOUNTS.length;

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
  assert.equal(body.failedFeeds.length, MARKET_ACCOUNT_COUNT);
  assert.ok(body.generatedAt, "the response says when it was generated");
  assert.equal(body.mostRecentSuccessfulFetchAt, null, "nothing has ever been fetched successfully");
  assert.equal(body.oldestSuccessfulFetchAt, null);

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
  assert.equal(body.cache.storageSource, "data-dir", "DATA_DIR is what chose the directory");
  assert.equal(body.cache.explicitDataDirConfigured, true);
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
  assert.equal(body.counts.live, MARKET_ACCOUNT_COUNT);
  assert.equal(body.posts.length, MARKET_ACCOUNT_COUNT);
  assert.ok(body.mostRecentSuccessfulFetchAt, "a successful refresh is timestamped");
  assert.ok(
    body.oldestSuccessfulFetchAt,
    "the conservative aggregate is exposed for banners that must not overstate",
  );
  assert.ok(
    new Date(body.oldestSuccessfulFetchAt) <= new Date(body.mostRecentSuccessfulFetchAt),
    "oldest confirmation cannot be newer than the most recent one",
  );

  const account = body.accounts[0];
  assert.equal(account.provider, "x-api");
  assert.equal(account.providerState, "ok");
  assert.equal(account.stale, false);
  assert.ok(account.newestPostAt, "content age is reported separately from data freshness");
});


/* ── Tracked-account management ────────────────────────────────────────── */

function send(pathname, method, body, headers = {}) {
  return originalFetch(`${base}${pathname}`, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

const ADMIN = { "x-admin-key": "route-test-admin" };

test("the tracked list is readable and seeded from the static config", async () => {
  const { status, body } = await getJson("/api/x/accounts/config");

  assert.equal(status, 200);
  assert.equal(body.accounts.length, X_ACCOUNTS.length);
  assert.ok(body.categories.includes("Crypto Traders"));
  assert.equal(body.registry.loadState, "loaded");
});

test("templates are public, default to markets, and mutations are admin-gated", async () => {
  const listed = await getJson("/api/x/templates");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.defaultTemplateId, "markets");
  assert.equal(listed.body.templates[0].name, "Crypto & Stocks");
  assert.ok(listed.body.templates[0].memberships.length < X_ACCOUNTS.length);
  assert.equal(listed.body.templates.find((template) => template.id === "war").memberships.length, 17);

  const rejected = await send("/api/x/templates", "POST", {
    id: "wars", name: "Wars & Geopolitics", sections: [], memberships: [],
  });
  assert.equal(rejected.status, 401);

  const unknownAccount = await send("/api/x/templates", "POST", {
    id: "invalid-template",
    name: "Invalid",
    sections: ["Unknown"],
    memberships: [{ handle: "nottracked", section: "Unknown" }],
  }, ADMIN);
  assert.equal(unknownAccount.status, 400);
});

test("a template scopes accounts, posts, counts, failures, and sections", async () => {
  mockUpstream(() => healthySearchResponse());
  const created = await send(
    "/api/x/templates",
    "POST",
    {
      id: "tech",
      name: "Tech & AI",
      accent: "tech",
      sections: ["Researchers"],
      memberships: [{ handle: "TechDev_52", section: "Researchers" }],
    },
    ADMIN,
  );
  assert.equal(created.status, 201);

  const scoped = await getJson("/api/x/accounts?template=tech");
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.template.id, "tech");
  assert.equal(scoped.body.accounts.length, 1);
  assert.equal(scoped.body.accounts[0].handle, "TechDev_52");
  assert.equal(scoped.body.accounts[0].category, "Researchers");
  assert.equal(scoped.body.posts.length, 1);
  assert.equal(Object.values(scoped.body.counts).reduce((sum, count) => sum + count, 0), 1);
  assert.ok(scoped.body.failedFeeds.every((account) => account.handle === "TechDev_52"));

  const missing = await getJson("/api/x/accounts?template=does-not-exist");
  assert.equal(missing.status, 404);
});

test("template duplicate, update, reorder, and safe delete APIs persist", async () => {
  const duplicate = await send("/api/x/templates/tech/duplicate", "POST", { id: "wars", name: "Wars" }, ADMIN);
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.template.id, "wars");

  const updated = await send("/api/x/templates/wars", "PUT", {
    name: "Wars & Geopolitics",
    description: "Conflict intelligence",
    accent: "world",
    sections: ["Official Sources"],
    memberships: [{ handle: "Barchart", section: "Official Sources" }],
  }, ADMIN);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.template.name, "Wars & Geopolitics");

  const ids = updated.body.templates.map((template) => template.id).reverse();
  const reordered = await send("/api/x/templates/order", "PUT", { ids }, ADMIN);
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.templates.map((template) => template.id), ids);

  const removed = await send("/api/x/templates/wars", "DELETE", undefined, ADMIN);
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.templates.some((template) => template.id === "wars"));

  const protectedDefault = await send("/api/x/templates/markets", "DELETE", undefined, ADMIN);
  assert.equal(protectedDefault.status, 400);
});

test("adding and deleting an account requires the admin key", async () => {
  const add = await send("/api/x/accounts/config", "POST", { handle: "temp1", category: "Market Data" });
  assert.equal(add.status, 401, "an unauthenticated add is rejected");

  const remove = await send("/api/x/accounts/config/Barchart", "DELETE");
  assert.equal(remove.status, 401, "an unauthenticated delete is rejected");

  const { body } = await getJson("/api/x/accounts/config");
  assert.equal(body.accounts.length, X_ACCOUNTS.length, "neither rejected call changed anything");
});

test("an added account appears in the feed, and a deleted one disappears from it", async () => {
  mockUpstream(() => healthySearchResponse());

  const added = await send(
    "/api/x/accounts/config",
    "POST",
    { handle: "@tempaccount", label: "Temp", category: "Crypto Traders" },
    ADMIN,
  );
  assert.equal(added.status, 201);
  assert.equal(added.body.added.handle, "tempaccount", "the leading @ is normalized server-side");

  const withAccount = await getJson("/api/x/accounts");
  assert.ok(
    withAccount.body.accounts.some((a) => a.handle === "tempaccount"),
    "the feed reads the registry per request, not a list captured at boot",
  );

  const duplicate = await send(
    "/api/x/accounts/config",
    "POST",
    { handle: "TEMPACCOUNT", category: "Market Data" },
    ADMIN,
  );
  assert.equal(duplicate.status, 409, "duplicates are rejected case-insensitively");

  const malformed = await send(
    "/api/x/accounts/config",
    "POST",
    { handle: "not a handle", category: "Market Data" },
    ADMIN,
  );
  assert.equal(malformed.status, 400);

  const removed = await send("/api/x/accounts/config/tempaccount", "DELETE", undefined, ADMIN);
  assert.equal(removed.status, 200);

  const after = await getJson("/api/x/accounts");
  assert.ok(
    !after.body.accounts.some((a) => a.handle === "tempaccount"),
    "a deleted account must not survive in the feed",
  );
});

test("diagnostics report registry health alongside provider health", async () => {
  const { body } = await getJson("/api/x/diagnostics", ADMIN);
  assert.ok(body.registry.file.endsWith("x-accounts.json"));
  assert.equal(body.registry.loadState, "loaded");
});
