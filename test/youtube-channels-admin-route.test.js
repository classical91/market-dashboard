"use strict";

// Boots the real app with an admin key set and pins the channel-management
// contract: reads are public, mutations need the key, and an added channel
// reaches both the tracked list and the theme its category names.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-yt-admin-"));
process.env.ADMIN_API_KEY = "channel-admin-key";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function api(pathname, options = {}) {
  return fetch(`${base}${pathname}`, options);
}

function adminApi(pathname, options = {}) {
  return api(pathname, {
    ...options,
    headers: { ...(options.headers || {}), "x-admin-key": process.env.ADMIN_API_KEY },
  });
}

test("reading the tracked channels needs no key — the panel renders before anyone is asked", async () => {
  const res = await api("/api/youtube/channels/config");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body.channels));
  assert.ok(body.channels.length, "the seed is served");
  assert.ok(Array.isArray(body.categories));
  assert.ok(body.categories.includes("Archaeology"), "theme sections are offered as categories");
  assert.equal(body.registry.loadState !== "corrupt", true);
});

test("mutations without the admin key are refused and change nothing", async () => {
  const before = (await (await api("/api/youtube/channels/config")).json()).channels.length;

  const add = await api("/api/youtube/channels/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "intruder", category: "Archaeology" }),
  });
  assert.equal(add.status, 401);

  const remove = await api("/api/youtube/channels/config/stockmoe", { method: "DELETE" });
  assert.equal(remove.status, 401);

  const after = (await (await api("/api/youtube/channels/config")).json()).channels.length;
  assert.equal(after, before, "a refused mutation saved nothing");
});

test("an added channel lands in the theme its category names", async () => {
  const res = await adminApi("/api/youtube/channels/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "@Diggers", label: "Diggers", category: "Archaeology" }),
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.added.handle, "Diggers");
  assert.ok(body.channels.some((channel) => channel.handle === "Diggers"));

  // The theme list is derived from the same registry, so the switcher's count
  // and the feed cannot disagree about what the theme holds.
  const feed = await (await api("/api/youtube/channels")).json();
  const dig = feed.themes.find((theme) => theme.id === "dig");
  assert.deepEqual(dig.channels.map((entry) => entry.handle), ["diggers"]);

  const markets = feed.themes.find((theme) => theme.id === "markets");
  assert.ok(
    markets.channels.some((entry) => entry.handle === "diggers"),
    "and is still reachable from the derived theme",
  );
});

test("adding the same channel twice is a 409, whatever the spelling", async () => {
  const res = await adminApi("/api/youtube/channels/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "DIGGERS", category: "Unexplained" }),
  });
  assert.equal(res.status, 409);

  const body = await (await api("/api/youtube/channels/config")).json();
  assert.equal(
    body.channels.filter((channel) => channel.handle.toLowerCase() === "diggers").length,
    1,
  );
});

test("a malformed channel is rejected with a reason, not a 500", async () => {
  const res = await adminApi("/api/youtube/channels/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "ok_handle", category: "Stocks", channelId: "not-an-id" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not a valid channel ID/);
});

test("deleting a channel removes it from the list and from its theme", async () => {
  const res = await adminApi("/api/youtube/channels/config/Diggers", { method: "DELETE" });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.removed.handle, "Diggers");
  assert.ok(!body.channels.some((channel) => channel.handle === "Diggers"));

  const feed = await (await api("/api/youtube/channels")).json();
  const dig = feed.themes.find((theme) => theme.id === "dig");
  assert.deepEqual(dig.channels, [], "the theme is empty again");
});

test("deleting a channel that is not tracked is a 404", async () => {
  const res = await adminApi("/api/youtube/channels/config/nobody", { method: "DELETE" });
  assert.equal(res.status, 404);
});
