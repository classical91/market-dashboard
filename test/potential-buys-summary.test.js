"use strict";
// Main Hub's System Logs card reads Potential Buys' counts with the dashboard's
// admin key. The summary carries counts only, and site auth lets exactly that
// one GET through; the list, images and writes keep needing the owner session.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { PotentialBuysStore, summarize } = require("../src/services/potential-buys");
const { createPotentialBuysRouter } = require("../src/routes/potential-buys");
const { createSiteAuth } = require("../src/middleware/site-auth");

const KEY = "main-hub-potential-buys-test-key";
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test("summarize counts trades, tickers, untagged and recent additions", () => {
  const now = 1_800_000_000_000;
  const summary = summarize([
    { label: "#BTC breakout", createdAt: now - 2 * 60 * 60 * 1000 },
    { label: "#BTC #ETH", createdAt: now - 3 * DAY },
    { label: "watch the NVDA gap", createdAt: now - 20 * DAY },
    { label: "#sol", createdAt: now - 30 * DAY },
  ], now);
  assert.deepEqual(summary, {
    total: 4,
    tickers: 3,
    untagged: 1,
    addedLast24h: 1,
    addedLast7d: 2,
    newestAt: now - 2 * 60 * 60 * 1000,
    oldestAt: now - 30 * DAY,
    generatedAt: now,
  });
});

test("an empty list summarizes to zeros with no times", () => {
  assert.deepEqual(summarize([], 5), {
    total: 0, tickers: 0, untagged: 0, addedLast24h: 0, addedLast7d: 0, newestAt: null, oldestAt: null, generatedAt: 5,
  });
});

async function start(t, adminKey = KEY) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-summary-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new PotentialBuysStore({ dataDir, logger: { error() {} } });
  store.add(PNG, { label: "#BTC secret note" });
  store.add(PNG, { label: "untagged idea" });
  const app = express();
  const auth = createSiteAuth({ sitePassword: "owner-test-password", adminKey });
  app.use(auth.requireAccess);
  app.use("/api/potential-buys", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use((req, res) => res.json({ reached: req.path }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Main Hub can read the summary with a header key, and it holds counts only", async (t) => {
  const base = await start(t);
  const response = await fetch(base + "/api/potential-buys/summary", { headers: { "x-admin-key": KEY } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.tickers, 1);
  assert.equal(body.untagged, 1);
  assert.equal(body.addedLast24h, 2);
  const text = JSON.stringify(body);
  for (const leak of ["secret", "BTC", "idea", ".png", "potential-buys-images"]) {
    assert.ok(!text.includes(leak), `summary must not carry ${leak}`);
  }
  const head = await fetch(base + "/api/potential-buys/summary/", { method: "HEAD", headers: { "x-admin-key": KEY } });
  assert.equal(head.status, 200);
});

test("the summary stays private without the right header, including query-string keys", async (t) => {
  const base = await start(t);
  for (const headers of [{}, { "x-admin-key": "wrong" }, { Authorization: `Bearer ${KEY}` }]) {
    assert.equal((await fetch(base + "/api/potential-buys/summary", { headers })).status, 401);
  }
  assert.equal((await fetch(base + "/api/potential-buys/summary?key=" + KEY)).status, 401);
});

test("the key opens no other Potential Buys route and no write method", async (t) => {
  const base = await start(t);
  const headers = { "x-admin-key": KEY };
  for (const p of ["/api/potential-buys", "/api/potential-buys/", "/api/potential-buys/summary/x",
    "/potential-buys-images/x.png", "/potential-buys.html"]) {
    const status = (await fetch(base + p, { headers, redirect: "manual" })).status;
    assert.ok(status === 401 || status === 302, `${p} answered ${status}`);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await fetch(base + "/api/potential-buys/summary", { method, headers })).status, 401, method);
  }
});

test("the exemption fails closed when the dashboard has no admin key", async (t) => {
  const base = await start(t, "");
  assert.equal((await fetch(base + "/api/potential-buys/summary", { headers: { "x-admin-key": KEY } })).status, 401);
});
