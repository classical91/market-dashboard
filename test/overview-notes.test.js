"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const SITE_PASSWORD = "notes-site-password";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-overview-notes-routes-"));
process.env.ADMIN_API_KEY = "notes-admin-key";
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = SITE_PASSWORD;

const { createApp } = require("../src/app");
const { OverviewNotesService } = require("../src/services/overview-notes");

function newService() {
  return new OverviewNotesService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-overview-notes-")), logger: { error() {} } });
}

test("an empty store reads as revision 0 with no folders", () => {
  assert.deepEqual(newService().get(), { revision: 0, updatedAt: null, folders: null });
});

test("saves bump the revision and a stale base revision is refused with the current notes", () => {
  const service = newService();
  const first = service.save({ baseRevision: 0, folders: [{ id: "home", name: "Home", text: "BTC 98k" }] });
  assert.equal(first.revision, 1);
  assert.equal(service.get().folders[0].text, "BTC 98k");

  const second = service.save({ baseRevision: 1, folders: [{ id: "home", name: "x", text: "BTC 99k" }, { id: "f1", name: " Plan  A ", text: "" }] });
  assert.equal(second.revision, 2);
  assert.deepEqual(second.folders.map((f) => f.name), ["Home", "Plan A"], "Home keeps its name; names are tidied");

  assert.throws(() => service.save({ baseRevision: 1, folders: [] }), (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.current.revision, 2);
    assert.equal(err.current.folders[0].text, "BTC 99k");
    return true;
  });
});

test("Home is always present and bad folder lists are rejected", () => {
  const service = newService();
  assert.deepEqual(service.save({ baseRevision: 0, folders: [{ id: "f1", name: "Ideas", text: "x" }] }).folders.map((f) => f.id), ["home", "f1"]);
  assert.throws(() => service.save({ baseRevision: 1, folders: "nope" }), { statusCode: 400 });
  assert.throws(() => service.save({ baseRevision: 1, folders: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }), { statusCode: 400 });
  assert.throws(() => service.save({ baseRevision: 1, folders: [{ id: "a", name: "  " }] }), { statusCode: 400 });
  assert.throws(() => service.save({ baseRevision: 1, folders: [{ id: "home", name: "Home", text: "x".repeat(200001) }] }), { statusCode: 413 });
});

test("an unreadable store file fails closed instead of reading as empty", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-overview-notes-bad-"));
  fs.writeFileSync(path.join(dataDir, "overview-notes.json"), "{not json");
  const service = new OverviewNotesService({ dataDir, logger: { error() {} } });
  assert.throws(() => service.get(), { statusCode: 503 });
});

let server;
let base;
let cookie;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: SITE_PASSWORD, returnTo: "/" }),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("the notes API needs the owner session", async () => {
  assert.equal((await fetch(`${base}/api/overview-notes`, { headers: { Accept: "application/json" } })).status, 401);
  const put = await fetch(`${base}/api/overview-notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, folders: [] }),
  });
  assert.equal(put.status, 401);
});

test("a signed-in device saves notes another signed-in request reads back", async () => {
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  const empty = await fetch(`${base}/api/overview-notes`, { headers });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(await empty.json(), { revision: 0, updatedAt: null, folders: null });

  const saved = await fetch(`${base}/api/overview-notes`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ baseRevision: 0, folders: [{ id: "home", name: "Home", text: "watch 4h close" }] }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const read = await (await fetch(`${base}/api/overview-notes`, { headers })).json();
  assert.equal(read.revision, 1);
  assert.equal(read.folders[0].text, "watch 4h close");

  const stale = await fetch(`${base}/api/overview-notes`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ baseRevision: 0, folders: [{ id: "home", name: "Home", text: "other device" }] }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.folders[0].text, "watch 4h close");

  const bad = await fetch(`${base}/api/overview-notes`, { method: "PUT", headers, body: JSON.stringify({ folders: [] }) });
  assert.equal(bad.status, 400);
});
