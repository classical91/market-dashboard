"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { PotentialBuysStore, isPotentialBuyId, sniffImage } = require("../src/services/potential-buys");
const { createPotentialBuysRouter } = require("../src/routes/potential-buys");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function makeStore(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-"));
  return { dataDir, store: new PotentialBuysStore({ dataDir, logger: { error() {} }, ...options }) };
}

test("sniffImage trusts the bytes, not the declared type", () => {
  assert.deepEqual(sniffImage(PNG), { kind: "image", mimeType: "image/png" });
  assert.deepEqual(sniffImage(JPEG), { kind: "image", mimeType: "image/jpeg" });
  assert.deepEqual(sniffImage(Buffer.from("hello world, not an image")), { kind: "unknown" });
});

test("add stores the file and metadata; list returns newest first; remove deletes both", () => {
  let clock = 1_700_000_000_000;
  const { dataDir, store } = makeStore({ now: () => (clock += 1000) });

  const first = store.add(PNG, { label: "  SOL   breakout  " });
  const second = store.add(JPEG);

  assert.ok(isPotentialBuyId(first.id));
  assert.equal(first.label, "SOL breakout");
  assert.equal(first.mimeType, "image/png");
  assert.match(first.url, /^\/potential-buys-images\/\d+-[a-f0-9]{8}\.png$/);
  assert.equal(second.mimeType, "image/jpeg");
  assert.ok(fs.existsSync(path.join(dataDir, "potential-buys", first.file)));

  assert.deepEqual(store.list().map((item) => item.id), [second.id, first.id]);

  store.remove(first.id);
  assert.deepEqual(store.list().map((item) => item.id), [second.id]);
  assert.ok(!fs.existsSync(path.join(dataDir, "potential-buys", first.file)));
});

test("screenshots persist across store instances on the same data dir", () => {
  const { dataDir, store } = makeStore();
  const added = store.add(PNG, { label: "NVDA" });
  const reopened = new PotentialBuysStore({ dataDir });
  assert.deepEqual(reopened.list().map((item) => [item.id, item.label]), [[added.id, "$NVDA"]]);
});

test("update relabels; unknown and malformed ids are refused", () => {
  const { store } = makeStore();
  const added = store.add(PNG);
  assert.equal(store.update(added.id, { label: "ETH — reclaim 3k" }).label, "ETH — reclaim 3k");
  assert.throws(() => store.update("1700000000000-deadbeef", { label: "x" }), { statusCode: 404 });
  assert.throws(() => store.remove("../potential-buys.json"), { statusCode: 400 });
});

test("non-images are rejected and nothing is stored", () => {
  const { dataDir, store } = makeStore();
  assert.throws(() => store.add(Buffer.from("definitely text")), { statusCode: 415 });
  assert.throws(() => store.add(Buffer.alloc(0)), { statusCode: 400 });
  assert.deepEqual(store.list(), []);
  assert.ok(!fs.existsSync(path.join(dataDir, "potential-buys")) || fs.readdirSync(path.join(dataDir, "potential-buys")).length === 0);
});

test("the API uploads raw image bytes, relabels, lists and deletes", async (t) => {
  const { store } = makeStore();
  const app = express();
  app.use(express.json());
  app.use("/api/potential-buys", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/potential-buys`;

  const created = await fetch(`${base}?label=BTC`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.label, "$BTC");

  const bad = await fetch(base, { method: "POST", headers: { "Content-Type": "image/png" }, body: "nope" });
  assert.equal(bad.status, 415);

  const patched = await fetch(`${base}/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "BTC weekly" }),
  });
  assert.equal((await patched.json()).item.label, "BTC weekly");

  const listed = await (await fetch(base)).json();
  assert.deepEqual(listed.items.map((i) => i.label), ["BTC weekly"]);

  const deleted = await fetch(`${base}/${item.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await fetch(base)).json()).items, []);
});

test("a named store keeps its own folder and file, and keeps a batch id", () => {
  const { dataDir, store } = makeStore({
    name: "active-trade-shots",
    title: "Active Trades notes",
    urlPrefix: "/active-trade-shots-images",
  });
  const first = store.add(PNG, { label: "btc", batch: "mwykq-bc3b7b95" });
  const second = store.add(PNG, { label: "btc", batch: "mwykq-bc3b7b95" });
  const loose = store.add(PNG, { label: "sol", batch: "../../etc" });

  assert.equal(first.batch, "mwykq-bc3b7b95");
  assert.equal(second.batch, "mwykq-bc3b7b95");
  assert.equal(loose.batch, undefined, "a malformed batch id is dropped, not stored");
  assert.match(first.url, /^\/active-trade-shots-images\//);
  assert.ok(fs.existsSync(path.join(dataDir, "active-trade-shots", first.file)));
  assert.ok(fs.existsSync(path.join(dataDir, "active-trade-shots.json")));
  assert.ok(!fs.existsSync(path.join(dataDir, "potential-buys.json")), "never touches Potential Buys");
  assert.throws(() => store.remove("1700000000000-deadbeef"), /no longer in Active Trades notes/);
});

test("POST / passes ?batch= through to the store", async () => {
  const { store } = makeStore();
  const app = express();
  app.use(express.json());
  app.use("/api/x", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/x?label=eth&batch=abc123-ff`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    assert.equal(res.status, 201);
    const { item } = await res.json();
    assert.equal(item.label, "$ETH");
    assert.equal(item.batch, "abc123-ff");
  } finally {
    server.close();
  }
});

test("labels keep line breaks, and a store can take longer notes", () => {
  const { store } = makeStore();
  const multi = store.add(PNG, { label: "$sol  plan\r\n\r\n\r\n  entry 140,\tstop 132  \n" });
  assert.equal(multi.label, "$SOL plan\n\nentry 140, stop 132");
  assert.deepEqual(multi.tags, ["SOL"]);
  assert.equal(store.add(PNG, { label: "x".repeat(500) }).label.length, 140);

  const { store: notes } = makeStore({ name: "active-trade-shots", maxLabelChars: 1000 });
  assert.equal(notes.add(PNG, { label: "x".repeat(1500) }).label.length, 1000);
  const item = notes.add(PNG, { label: "$BTC short" });
  assert.equal(notes.update(item.id, { label: "y".repeat(600) }).label.length, 600);
});

test("a ticker goes on its own line above a multi-line note, keeping its heading intact", () => {
  const { withTicker, extractTags } = require("../public/assets/js/ticker-label");
  assert.equal(withTicker("btc", "## **BTC plan**\n\n- entry 61k"), "$BTC\n## **BTC plan**\n\n- entry 61k");
  assert.equal(withTicker("btc", "one-line note"), "$BTC one-line note");
  assert.deepEqual(extractTags("$BTC\n## Heading #1 and $61,717"), ["BTC"]);
});

test("trade notes record how a trade ended; outcome-only changes keep the label", () => {
  const { store: notes } = makeStore({ name: "active-trade-shots", outcomes: true });
  const item = notes.add(PNG, { label: "$BTC long from 60k" });
  assert.equal(item.outcome, undefined);

  const tp = notes.update(item.id, { outcome: "TP" });
  assert.equal(tp.outcome, "tp");
  assert.equal(tp.label, "$BTC long from 60k");
  assert.equal(notes.update(item.id, { outcome: "liquidated" }).outcome, "liquidated");
  // A relabel alone keeps the outcome.
  assert.equal(notes.update(item.id, { label: "$BTC long, closed" }).outcome, "liquidated");
  assert.equal(notes.update(item.id, { outcome: "" }).outcome, undefined);
  assert.equal(notes.list()[0].label, "$BTC long, closed");

  assert.throws(() => notes.update(item.id, { outcome: "breakeven" }), { statusCode: 400 });
  // Potential Buys doesn't track trades.
  const { store: buys } = makeStore();
  assert.throws(() => buys.update(buys.add(PNG).id, { outcome: "tp" }), { statusCode: 400 });
});

test("the API sets and clears a trade note's outcome", async (t) => {
  const { store } = makeStore({ name: "active-trade-shots", outcomes: true });
  const app = express();
  app.use(express.json());
  app.use("/api/active-trade-shots", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/active-trade-shots`;
  const item = store.add(PNG, { label: "$SOL short" });
  const patch = (body) => fetch(`${base}/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const sl = await (await patch({ outcome: "sl" })).json();
  assert.equal(sl.item.outcome, "sl");
  assert.equal(sl.item.label, "$SOL short");
  assert.equal((await patch({ outcome: "moon" })).status, 400);
  assert.equal((await (await patch({ outcome: "" })).json()).item.outcome, undefined);
});
