"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

const { PhoneBriefingStore } = require("../src/services/phone-briefings");
const { buildDailyTopNews } = require("../src/services/daily-top-news");
const { Top10RunStore, recordTop10Run } = require("../src/services/top10-runs");
const { FarmbotTop10Service } = require("../src/services/farmbot-top10");
const { FarmbotTop10Store } = require("../src/services/farmbot-top10-store");
const { createDailyTopNewsRouter } = require("../src/routes/daily-top-news");

const TZ = "America/Vancouver";

function numbered(prefix, count) {
  return Array.from({ length: count }, (_, i) => `**#${i + 1} ${prefix} story ${i + 1}**\n- detail ${i + 1}`).join("\n\n");
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-top10-runs-"));
  const briefingStore = new PhoneBriefingStore({ dataDir: dir, logger: { error() {} } });
  const runStore = new Top10RunStore({ dataDir: dir, logger: { error() {} } });
  return { dir, briefingStore, runStore };
}

test("no Top 10 exists until Run is recorded, even when all desks have news", () => {
  const { briefingStore, runStore } = setup();
  const now = new Date();
  ["economics", "stocks", "crypto"].forEach((desk) => briefingStore.receive(desk, { text: numbered(desk, 10) }, now));
  const before = buildDailyTopNews({ briefingStore, runStore, timeZone: TZ, now });
  assert.equal(before.top10Run, null);
  assert.deepEqual(before.top10, []);

  const run = recordTop10Run({ store: runStore, briefingStore, timeZone: TZ, now });
  assert.equal(run.stories, 10);
  assert.deepEqual(Object.keys(run.runIds).sort(), ["crypto", "economics", "stocks"]);
  const after = buildDailyTopNews({ briefingStore, runStore, timeZone: TZ, now });
  assert.equal(after.top10Run.id, run.id);
  assert.equal(after.top10.length, 10);
});

test("Run makes no Top 10 unless all three desks have a report from today", () => {
  const { briefingStore, runStore } = setup();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 36 * 3600 * 1000);
  briefingStore.receive("economics", { text: numbered("Econ", 10) }, now);
  briefingStore.receive("stocks", { text: numbered("Stock", 10) }, yesterday);
  briefingStore.receive("crypto", { text: "Just a paragraph, no numbered stories." }, now);
  assert.throws(() => recordTop10Run({ store: runStore, briefingStore, timeZone: TZ, now }), (err) =>
    err.statusCode === 409 && /all three desks must finish today/.test(err.message) &&
    err.missing.includes("Stocks has no report today") &&
    err.missing.includes("Crypto's report today has no numbered stories"));
  assert.equal(runStore.latest(buildDailyTopNews({ briefingStore, timeZone: TZ, now }).date), null);
});

test("logging and Send to FarmBot refuse a day without a recorded Run", async () => {
  const { dir, briefingStore, runStore } = setup();
  const now = new Date();
  ["economics", "stocks", "crypto"].forEach((desk) => briefingStore.receive(desk, { text: numbered(desk, 10) }, now));
  const service = new FarmbotTop10Service({
    briefingStore, reporterService: null, runStore,
    slipStore: new FarmbotTop10Store({ dataDir: dir, logger: { error() {} } }),
    newsLogStore: { find() { return null; }, intake() { throw new Error("must not log"); } },
    env: {}, logger: { warn() {} },
  });
  assert.throws(() => service.logCandidates({ timeZone: TZ }), (err) => err.statusCode === 409 && /hit Run first/.test(err.message));
  await assert.rejects(service.send({ timeZone: TZ }), (err) => err.statusCode === 409);
});

test("POST /run needs the admin key and reports the missing desks", async () => {
  const { briefingStore, runStore } = setup();
  briefingStore.receive("economics", { text: numbered("Econ", 10) }, new Date());
  const app = express();
  app.use("/api/daily-top-news", createDailyTopNewsRouter({
    briefingStore, reporterService: null, runStore,
    requireAdmin(req, res, next) { if (req.headers["x-admin-key"] === "test") next(); else res.sendStatus(401); },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/daily-top-news`;
  const post = (headers) => fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ tz: TZ }) });
  try {
    assert.equal((await post({})).status, 401);
    const refused = await post({ "x-admin-key": "test" });
    assert.equal(refused.status, 409);
    assert.deepEqual((await refused.json()).missing, ["Stocks has no report today", "Crypto has no report today"]);
    ["stocks", "crypto"].forEach((desk) => briefingStore.receive(desk, { text: numbered(desk, 10) }, new Date()));
    assert.equal((await post({ "x-admin-key": "test" })).status, 201);
    const day = await (await fetch(`${base}?tz=${encodeURIComponent(TZ)}`)).json();
    assert.equal(day.top10.length, 10);
    assert.ok(day.top10Run);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
