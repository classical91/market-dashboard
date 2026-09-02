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
  assert.ok(body.categories.some((category) => category.name === "Archaeology"), "theme sections seed categories");
  assert.equal(
    body.categories.some((category) => category.id === "uncategorized"),
    false,
    "an empty fallback does not appear as an extra category",
  );
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

test("category CRUD is canonical and renames assigned channels centrally", async () => {
  const created = await adminApi("/api/youtube/categories/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Research" }),
  });
  assert.equal(created.status, 201);
  const category = (await created.json()).added;

  const duplicate = await adminApi("/api/youtube/categories/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: " research " }),
  });
  assert.equal(duplicate.status, 409);

  const channel = await adminApi("/api/youtube/channels/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "researchdesk", categoryId: category.id }),
  });
  assert.equal(channel.status, 201);

  const renamed = await adminApi(`/api/youtube/categories/config/${encodeURIComponent(category.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Deep Research" }),
  });
  assert.equal(renamed.status, 200);
  const renamedBody = await renamed.json();
  assert.equal(renamedBody.channels.find((item) => item.handle === "researchdesk").category, "Deep Research");
});

test("category filtering happens before YouTube intelligence is fetched", async () => {
  const config = await (await api("/api/youtube/channels/config")).json();
  const research = config.categories.find((category) => category.name === "Deep Research");
  const filtered = await api(`/api/youtube/channels?categoryId=${encodeURIComponent(research.id)}`);
  assert.equal(filtered.status, 200);
  const body = await filtered.json();
  assert.equal(body.selectedCategoryId, research.id);
  assert.deepEqual(body.channels.map((channel) => channel.handle), ["researchdesk"]);
});

test("editing a channel moves it without delete and re-add", async () => {
  const config = await (await api("/api/youtube/channels/config")).json();
  const crypto = config.categories.find((category) => category.name === "Crypto");
  const updated = await adminApi("/api/youtube/channels/config/researchdesk", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "researchdesk", label: "Research Desk", categoryId: crypto.id }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).updated.categoryId, crypto.id);
});

test("deleting a used category requires and applies reassignment", async () => {
  const created = await adminApi("/api/youtube/categories/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Temporary" }),
  });
  const temporary = (await created.json()).added;
  await adminApi("/api/youtube/channels/config/researchdesk", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "researchdesk", categoryId: temporary.id }),
  });
  const refused = await adminApi(`/api/youtube/categories/config/${encodeURIComponent(temporary.id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "CATEGORY_NOT_EMPTY");

  const removed = await adminApi(`/api/youtube/categories/config/${encodeURIComponent(temporary.id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reassignToCategoryId: "uncategorized" }),
  });
  assert.equal(removed.status, 200);
  const body = await removed.json();
  assert.equal(body.channels.find((item) => item.handle === "researchdesk").categoryId, "uncategorized");
  assert.equal(body.categories.find((item) => item.id === "uncategorized").channelCount, 1);
});
