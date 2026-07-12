"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { BotCommandsService } = require("../src/services/bot-commands");

function makeService() {
  return new BotCommandsService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-bot-commands-")) });
}

test("upsert creates a new entry with a generated id, list returns it", () => {
  const service = makeService();
  assert.deepEqual(service.list(), []);

  const created = service.upsert({ title: "News Bot", purpose: "Sends headlines", command: "/news" });
  assert.ok(created.id);
  assert.equal(created.title, "News Bot");
  assert.equal(created.command, "/news");
  assert.ok(created.updatedAt);
  assert.equal(service.list().length, 1);
});

test("upsert with an existing id updates that entry in place instead of duplicating it", () => {
  const service = makeService();
  const created = service.upsert({ title: "Alert Bot", command: "/alert" });
  const updated = service.upsert({ id: created.id, title: "Alert Bot v2", command: "/alert v2" });

  assert.equal(updated.id, created.id);
  const items = service.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Alert Bot v2");
});

test("upsert rejects a missing title or command", () => {
  const service = makeService();
  assert.throws(() => service.upsert({ command: "/x" }), /title and command are required/);
  assert.throws(() => service.upsert({ title: "X" }), /title and command are required/);
});

test("remove takes an entry back out by id", () => {
  const service = makeService();
  const created = service.upsert({ title: "Bot", command: "/cmd" });
  const remaining = service.remove(created.id);
  assert.deepEqual(remaining, []);
});

test("persists across service instances against the same data dir", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-bot-commands-"));
  const first = new BotCommandsService({ dataDir });
  first.upsert({ title: "Bot", command: "/persist" });

  const second = new BotCommandsService({ dataDir });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].command, "/persist");
});

// Route-level: confirms these endpoints are deliberately NOT admin-gated,
// unlike Watchlist/Journal — a personal reference list, not a credit-
// spending or broadcast action, and the point is to sync across devices
// without re-entering a key on each one.
test("bot-commands routes work with no admin key at all", async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-bot-commands-route-"));
  delete process.env.ADMIN_API_KEY;
  delete require.cache[require.resolve("../src/app")];
  const { createApp } = require("../src/app");

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await (
      await fetch(`${base}/api/bot-commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "News Bot", command: "/news" }),
      })
    ).json();
    assert.equal(created.item.title, "News Bot");

    const listed = await (await fetch(`${base}/api/bot-commands`)).json();
    assert.ok(listed.items.some((i) => i.id === created.item.id));

    const removed = await fetch(`${base}/api/bot-commands/${created.item.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const afterRemove = await removed.json();
    assert.ok(!afterRemove.items.some((i) => i.id === created.item.id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
