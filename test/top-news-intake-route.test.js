"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createDailyTopNewsRouter } = require("../src/routes/daily-top-news");

test("Top 10 intake requires admin access and logs selected runs without sending", async () => {
  const calls = [];
  const app = express();
  app.use("/api/daily-top-news", createDailyTopNewsRouter({
    farmbotTop10: {
      logCandidates(options) { calls.push(options); return { records: [{ id: "one" }, { id: "two" }] }; },
      send() { throw new Error("intake must not send"); },
    },
    requireAdmin(req, res, next) { if (req.headers["x-admin-key"] === "test") next(); else res.sendStatus(401); },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/daily-top-news/intake`;
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal(calls.length, 0);
    const data = { date: "2026-11-13", tz: "America/Vancouver", runs: { crypto: "run-1" } };
    const response = await fetch(url, { method: "POST", headers: { "x-admin-key": "test", "Content-Type": "application/json" }, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, logged: 2, ids: ["one", "two"] });
    assert.deepEqual(calls, [{ date: data.date, timeZone: data.tz, runIds: data.runs }]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
