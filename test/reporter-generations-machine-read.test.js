"use strict";
// Main Hub's News Reporter card reads each desk's Reporter Room runs from its
// server with the dashboard's admin key. Site auth lets exactly that one GET
// through; every neighboring Reporter route keeps needing the owner session.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { createSiteAuth } = require("../src/middleware/site-auth");
const KEY = "main-hub-machine-test-key";
const PATH = "/api/daily-report/generations";

async function start(t, adminKey = KEY) {
  const app = express();
  const auth = createSiteAuth({ sitePassword: "owner-test-password", adminKey });
  app.use(auth.requireAccess);
  app.use((req, res) => res.json({ reached: req.path }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Main Hub can GET/HEAD a desk's run list with a header key", async t => {
  const base = await start(t);
  for (const suffix of ["?section=markets&fields=meta", "/?section=crypto"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(base + PATH + suffix, { method, headers: { "x-admin-key": KEY } });
      assert.equal(response.status, 200, method + " " + suffix);
    }
  }
});

test("the run list stays private without the right header, including query-string keys", async t => {
  const base = await start(t);
  for (const headers of [{}, { "x-admin-key": "wrong" }, { Authorization: `Bearer ${KEY}` }]) {
    assert.equal((await fetch(base + PATH + "?section=crypto", { headers })).status, 401);
  }
  assert.equal((await fetch(base + PATH + "?section=crypto&key=" + KEY)).status, 401);
});

test("the key opens no other Reporter route and no write method", async t => {
  const base = await start(t);
  const headers = { "x-admin-key": KEY };
  for (const path of ["/api/daily-report", "/api/daily-report/generate", "/api/daily-report/generations/x",
    "/api/daily-report/send-telegram"]) {
    assert.equal((await fetch(base + path, { headers })).status, 401, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await fetch(base + PATH, { method, headers })).status, 401, method);
  }
});

test("the exemption fails closed when the dashboard has no admin key", async t => {
  const base = await start(t, "");
  assert.equal((await fetch(base + PATH + "?section=crypto", { headers: { "x-admin-key": KEY } })).status, 401);
});
