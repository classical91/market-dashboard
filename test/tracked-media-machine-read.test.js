"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { createSiteAuth } = require("../src/middleware/site-auth");
const KEY = "main-hub-machine-test-key";
const paths = ["/api/youtube/channels", "/api/x/accounts"];

async function start(t, adminKey = KEY) {
  const app = express();
  const auth = createSiteAuth({ sitePassword: "owner-test-password", adminKey });
  app.use(auth.requireAccess);
  // Sentinel downstream handler: a 200 proves site auth reached the feed;
  // neighboring paths/mutations must never reach it with the server key.
  app.use((req, res) => res.json({ reached: req.path }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Main Hub can GET/HEAD only the two existing feeds with a header key", async t => {
  const base = await start(t);
  for (const path of paths) {
    for (const suffix of ["", "/", "?scope=world"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(base + path + suffix, { method, headers: { "x-admin-key": KEY } });
        assert.equal(response.status, 200, method + " " + path + suffix);
      }
    }
  }
});

test("tracked feeds remain private without the right header, including query-string credentials", async t => {
  const base = await start(t);
  for (const path of paths) {
    for (const headers of [{}, { "x-admin-key": "wrong" }, { Authorization: `Bearer ${KEY}` }]) {
      assert.equal((await fetch(base + path, { headers })).status, 401);
    }
    assert.equal((await fetch(base + path + "?key=" + KEY)).status, 401);
  }
});

test("the media server key grants no neighboring routes or write methods", async t => {
  const base = await start(t);
  const headers = { "x-admin-key": KEY };
  for (const path of ["/api/youtube/channels/config", "/api/youtube/channels/test", "/api/youtube/channels.json",
    "/api/x/accounts/config", "/api/x/accounts/test", "/api/x/diagnostics", "/api/x/templates", "/settings.html"]) {
    const response = await fetch(base + path, { headers, redirect: "manual" });
    assert.equal(response.status, path.startsWith("/api/") ? 401 : 302, path);
  }
  for (const path of paths) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await fetch(base + path, { method, headers })).status, 401, method + " " + path);
    }
  }
});

test("the exemption fails closed when the dashboard has no admin key", async t => {
  const base = await start(t, "");
  for (const path of paths) {
    assert.equal((await fetch(base + path, { headers: { "x-admin-key": KEY } })).status, 401);
  }
});
