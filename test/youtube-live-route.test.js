"use strict";

// GET /api/youtube/live, booted through the real app with a site password set.
//
// The thing worth testing here is the bypass, not the JSON: every other YouTube
// route answers `401 Login required` before it runs, and this one must not —
// while its neighbours must still keep doing exactly that.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-yt-live-"));
process.env.YOUTUBE_API_KEY = "live-route-test-key";
process.env.YOUTUBE_CHANNEL_IDS = "stockmoe=UCaaaaaaaaaaaaaaaaaaaaaa";
// The whole point of this file: the site is locked, and this one path is not.
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "a-long-enough-test-password";
delete process.env.ADMIN_API_KEY;

const { createApp } = require("../src/app");

const originalFetch = global.fetch;
let server;
let base;

/**
 * Break every call that leaves this machine, and only those.
 *
 * The test client reaches the app over the loopback address with the same
 * `fetch`, so a stub that throws unconditionally takes down the request under
 * test along with the upstream it meant to sever.
 */
function severUpstream() {
  global.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (url.startsWith(base)) return originalFetch(input, init);
    throw new Error("upstream down");
  };
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

test("the live feed answers without a session cookie", async () => {
  // Every upstream call fails, which is the harshest case: the route must still
  // answer with a shape rather than a 500 or a login page.
  severUpstream();

  const response = await fetch(`${base}/api/youtube/live`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.live), "live is a list");
  assert.ok(Array.isArray(body.upcoming), "upcoming is a list");
  assert.ok(["api", "degraded", "unavailable"].includes(body.meta.liveDetection));
});

test("nothing in the response names a credential or this server's state", async () => {
  severUpstream();

  const body = await (await fetch(`${base}/api/youtube/live`)).text();

  assert.ok(!body.includes("live-route-test-key"), "the API key never travels");
  assert.ok(!body.includes("quotaCoolingDown"), "quota state never travels");
  assert.ok(!body.includes("apiConfigured"), "configuration state never travels");
  assert.ok(!body.includes("failedFeeds"), "per-channel failures never travel");
});

test("the bypass is read-only", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${base}/api/youtube/live`, { method });
    assert.notEqual(response.status, 200, `${method} is not a way in`);
  }
});

// The bypass must not have widened into the routes beside it.
test("the neighbouring YouTube routes still require a session", async () => {
  for (const path of ["/api/youtube/channels", "/api/youtube/channels/config", "/api/youtube/live/extra"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401, `${path} stays behind the login`);
  }
});
