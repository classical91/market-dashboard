"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { NewsBatchRequestStore, NewsBatchRequestService } = require("../src/services/news-batch-requests");
const { createNewsBatchRequestsRouter } = require("../src/routes/news-batch-requests");
const { createRequireAdmin } = require("../src/middleware/admin-auth");
const { createSiteAuth, encodeSession } = require("../src/middleware/site-auth");

function fixture(t, input = { windowHours: 24 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "news-request-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new NewsBatchRequestStore({ dataDir, logger: { error() {} } });
  const row = store.create(input, "request-key-00001", "owner").request;
  const state = { status: "queued", fail: false, saved: true, match: true, calls: [] };
  const env = { NEWS_BATCH_AGENT_OFFICE_URL: "https://office.example", NEWS_BATCH_SERVICE_TOKEN: "s".repeat(32),
    FARMBOT_NEWS_API_URL: "https://api.example", FARMBOT_NEWS_READER_TOKEN: "r".repeat(32), FARMBOT_NEWS_APPROVAL_BASE_URL: "https://farm.example" };
  const execution = { goalId: `goal-news-${row.id}`, claimedAt: new Date().toISOString(), attempt: 1, sessionKey: `agent:oss:news-${row.id}` };
  const saved = { clientBatchId: row.clientBatchId, batchId: "fnb_00000000-0000-4000-8000-000000000001", revision: 1, payloadHash: `sha256:${"a".repeat(64)}`, persisted: true, validated: true };
  saved.payload = { batchId: row.clientBatchId, candidates: [{ publishedAt: new Date(Date.parse(row.createdAt) - 3600000).toISOString() }], items: [{}] };
  const result = { ...saved, attempt: 1, farmclaw: { agentId: "commentfarm", executionId: "child-run-1" } };
  const service = new NewsBatchRequestService({ store, env, fetcher: async (url, opts) => {
    state.calls.push({ url, opts });
    if (state.fail) throw new Error("secret token must never appear in error");
    const payload = url.startsWith("https://office.example") ? { requestId: row.id, clientBatchId: row.clientBatchId,
      goalId: execution.goalId, status: state.status, execution: state.status === "queued" ? null : execution, result } :
      { ...saved, persisted: state.saved, revision: state.match ? 1 : 2 };
    return { ok: true, json: async () => payload };
  } });
  return { dataDir, store, row, service, state, execution, saved, result };
}

test("request keys, parallel-tab aliases and active-job protection survive restarts", t => {
  const f = fixture(t);
  assert.equal(f.store.create({}, "request-key-00001", "owner").request.id, f.row.id);
  assert.equal(f.store.create({}, "request-key-00002", "owner").request.id, f.row.id);
  const restored = new NewsBatchRequestStore({ dataDir: f.dataDir });
  assert.equal(restored.create({}, "request-key-00002", "owner").created, false);
  assert.equal(restored.list().length, 1);
  assert.throws(() => restored.create({ windowHours: 48 }, "request-key-00001", "owner"), { statusCode: 409 });
  assert.throws(() => restored.create({ windowHours: 48 }, "request-key-00003", "owner"), { statusCode: 409 });
  assert.match(f.row.clientBatchId, /^dashboard-top10-\d{4}-\d{2}-\d{2}-ondemand-[a-f0-9]{32}$/);
});

test("unreadable storage fails closed without destroying idempotency", t => {
  const f = fixture(t);
  fs.writeFileSync(f.store.file, "broken");
  assert.throws(() => f.store.create({}, "request-key-00002", "owner"), { code: "STORE_UNREADABLE" });
  assert.equal(fs.readFileSync(f.store.file, "utf8"), "broken");
});

test("ambiguous handoffs recover the same ticket after restart; queued is not running", async t => {
  const f = fixture(t);
  f.state.fail = true;
  const blocked = await f.service.sync(f.row.id);
  assert.equal(blocked.status, "blocked");
  assert.doesNotMatch(blocked.error, /secret token/);
  f.state.fail = false;
  const service = new NewsBatchRequestService({ store: new NewsBatchRequestStore({ dataDir: f.dataDir }), env: f.service.env, fetcher: f.service.fetcher });
  const assigned = await service.sync(f.row.id);
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.execution, null);
  assert.equal(f.state.calls[0].url, f.state.calls[1].url);
  assert.deepEqual(JSON.parse(f.state.calls[0].opts.body), JSON.parse(f.state.calls[1].opts.body));
  f.state.status = "running";
  assert.equal((await service.sync(f.row.id)).status, "running");
  f.execution.claimedAt = new Date(Date.now() - 21 * 60000).toISOString();
  assert.equal((await service.sync(f.row.id)).status, "blocked");
});

test("ready requires a matching FarmClaw receipt, persisted validated read-back, revision and hash", async t => {
  const f = fixture(t);
  f.state.status = "completed";
  f.result.farmclaw.agentId = "oss";
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  f.result.farmclaw.agentId = "commentfarm";
  f.result.attempt = 2;
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  f.result.attempt = 1;
  f.state.saved = false;
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  f.state.saved = true;
  f.state.match = false;
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  f.state.match = true;
  f.result.payloadHash = `sha256:${"b".repeat(64)}`;
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  f.result.payloadHash = f.saved.payloadHash;
  const ready = await f.service.sync(f.row.id);
  assert.equal(ready.status, "preview_ready");
  assert.equal(ready.preview.approvalUrl, `https://farm.example/news-batches/${f.saved.batchId}`);
  assert.equal(f.store.create({}, "request-key-00001", "owner").request.id, ready.id);
  assert.ok(f.state.calls.every(call => call.url.startsWith("https://office.example") || (call.url.startsWith("https://api.example/news/v1/batches/lookup?") && call.opts.method === "GET")));
  assert.ok(f.state.calls.every(call => !/approval|schedule|queue/.test(call.url)));
});

test("24-hour requests reject older stories; 48-hour requests require an explanation", async t => {
  const f = fixture(t);
  f.state.status = "completed";
  f.saved.payload.candidates[0].publishedAt = new Date(Date.parse(f.row.createdAt) - 30 * 3600000).toISOString();
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  const wide = fixture(t, { windowHours: 48 });
  wide.state.status = "completed";
  wide.saved.payload.candidates[0].publishedAt = new Date(Date.parse(wide.row.createdAt) - 30 * 3600000).toISOString();
  assert.equal((await wide.service.sync(wide.row.id)).status, "blocked");
  wide.saved.payload.candidates[0].extendedWindowReason = "Official release still moving markets; no newer primary update.";
  assert.equal((await wide.service.sync(wide.row.id)).status, "preview_ready");
});

test("late polls cannot regress authoritative state, and missing config keeps a saved blocked ticket", async t => {
  const f = fixture(t);
  f.store.update(f.row.id, 0, { status: "assigned" });
  f.store.update(f.row.id, 0, { status: "failed" });
  assert.equal(f.store.get(f.row.id).status, "assigned");
  f.service.env = {};
  assert.equal((await f.service.sync(f.row.id)).status, "blocked");
  assert.equal(f.state.calls.length, 0);
});

test("server reconciliation recovers a saved handoff and completed preview without a browser", async t => {
  const f = fixture(t);
  f.state.fail = true;
  await f.service.sweep();
  assert.equal(f.store.get(f.row.id).status, "blocked");
  f.state.fail = false;
  await Promise.all([f.service.sweep(), f.service.sweep()]);
  assert.equal(f.store.get(f.row.id).status, "assigned");
  assert.equal(f.state.calls.length, 2);
  f.state.status = "completed";
  await f.service.sweep();
  assert.equal(f.store.get(f.row.id).status, "preview_ready");
  const count = f.state.calls.length;
  await f.service.sweep();
  assert.equal(f.state.calls.length, count);
});

test("request routes accept only owner/admin and never expose service credentials", async t => {
  const f = fixture(t);
  const auth = { sitePassword: "owner-password", alphaAccessCode: "readonly", adminKey: "admin" };
  const app = express();
  app.use(createSiteAuth(auth).requireAccess);
  app.use("/api/news-batch-requests", createNewsBatchRequestsRouter({ service: f.service,
    requireOwner: createRequireAdmin({ adminKey: "admin", allowOwnerSession: true }) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/news-batch-requests`;
  assert.equal((await fetch(base)).status, 401);
  const cookie = role => `market_dashboard_session=${encodeSession(role, auth)}`;
  assert.equal((await fetch(base, { headers: { Cookie: cookie("alpha") } })).status, 403);
  const response = await fetch(base, { method: "POST", headers: { Cookie: cookie("owner"), "Content-Type": "application/json", "Idempotency-Key": "request-key-00001" }, body: "{}" });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /request-key|generation/);
  assert.ok(!text.includes(f.service.env.NEWS_BATCH_SERVICE_TOKEN));
  assert.equal((await fetch(base, { method: "POST", headers: { Cookie: cookie("owner"), "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await fetch(`${base}/missing/check`, { method: "POST", headers: { Cookie: cookie("owner") } })).status, 404);
});
