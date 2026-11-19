"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { PotentialBuysStore, extractTags, buildFolders } = require("../src/services/potential-buys");
const { createPotentialBuysRouter } = require("../src/routes/potential-buys");
const Crop = require("../public/assets/js/crop-rect");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function makeStore(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-folders-"));
  return { dataDir, store: new PotentialBuysStore({ dataDir, logger: { error() {} }, ...options }) };
}

test("extractTags finds #tickers, upper-cases and de-duplicates them", () => {
  assert.deepEqual(extractTags("#BTC breakout, #btc again and #eth."), ["BTC", "ETH"]);
  assert.deepEqual(extractTags("#SOL-USD #brk.b"), ["SOL-USD", "BRK.B"]);
  assert.deepEqual(extractTags("no tags, #1 rank, a&#39;s, foo#BAR"), []);
  assert.deepEqual(extractTags(""), []);
  assert.deepEqual(extractTags(undefined), []);
});

test("buildFolders counts each tag and keeps its newest change", () => {
  const { folders, untagged } = buildFolders([
    { label: "#BTC", createdAt: 100 },
    { label: "#BTC #ETH", createdAt: 200, updatedAt: 500 },
    { label: "#ETH", createdAt: 300 },
    { label: "plain", createdAt: 400 },
  ]);
  assert.deepEqual(folders, [
    { tag: "BTC", count: 2, updatedAt: 500 },
    { tag: "ETH", count: 2, updatedAt: 500 },
  ]);
  assert.equal(untagged, 1);
});

test("relabelling bumps updatedAt and moves the screenshot between folders", () => {
  let clock = 1_700_000_000_000;
  const { store } = makeStore({ now: () => (clock += 1000) });
  const a = store.add(PNG, { label: "#BTC" });
  const b = store.add(PNG, { label: "#BTC weekly" });
  assert.deepEqual(a.tags, ["BTC"]);
  assert.equal(a.updatedAt, a.createdAt);

  assert.deepEqual(store.folders().folders, [{ tag: "BTC", count: 2, updatedAt: b.createdAt }]);

  const moved = store.update(a.id, { label: "#ETH now" });
  assert.ok(moved.updatedAt > b.createdAt);
  assert.deepEqual(moved.tags, ["ETH"]);
  assert.deepEqual(store.folders().folders, [
    { tag: "ETH", count: 1, updatedAt: moved.updatedAt },
    { tag: "BTC", count: 1, updatedAt: b.createdAt },
  ]);

  // Saving the same label again changes nothing.
  assert.equal(store.update(a.id, { label: "#ETH now" }).updatedAt, moved.updatedAt);
});

test("replaceImage swaps the picture under a new file and removes the old one", () => {
  let clock = 1_700_000_000_000;
  const { dataDir, store } = makeStore({ now: () => (clock += 1000) });
  const added = store.add(PNG, { label: "#NVDA" });
  const cropped = store.replaceImage(added.id, JPEG);

  assert.equal(cropped.id, added.id);
  assert.equal(cropped.label, "#NVDA");
  assert.equal(cropped.mimeType, "image/jpeg");
  assert.notEqual(cropped.file, added.file);
  assert.match(cropped.file, /\.jpg$/);
  assert.ok(cropped.croppedAt > added.createdAt);
  assert.equal(cropped.updatedAt, cropped.croppedAt);
  assert.ok(fs.existsSync(path.join(dataDir, "potential-buys", cropped.file)));
  assert.ok(!fs.existsSync(path.join(dataDir, "potential-buys", added.file)));
  assert.deepEqual(store.list().map((i) => i.file), [cropped.file]);

  assert.throws(() => store.replaceImage(added.id, Buffer.from("nope")), { statusCode: 415 });
  assert.throws(() => store.replaceImage("../etc", PNG), { statusCode: 400 });
  assert.throws(() => store.replaceImage("1700000000000-deadbeef", PNG), { statusCode: 404 });
  assert.deepEqual(store.list().map((i) => i.file), [cropped.file]);
});

test("the API lists folders and accepts a cropped image", async (t) => {
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

  const created = await fetch(`${base}?label=${encodeURIComponent("#BTC dip")}`, {
    method: "POST", headers: { "Content-Type": "image/png" }, body: PNG,
  });
  const { item } = await created.json();
  await fetch(base, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });

  const listed = await (await fetch(base)).json();
  assert.deepEqual(listed.folders.map((f) => [f.tag, f.count]), [["BTC", 1]]);
  assert.equal(listed.untagged, 1);
  assert.ok(listed.folders[0].updatedAt > 0);

  const put = await fetch(`${base}/${item.id}/image`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: JPEG });
  assert.equal(put.status, 200);
  const replaced = (await put.json()).item;
  assert.equal(replaced.mimeType, "image/jpeg");
  assert.deepEqual(replaced.tags, ["BTC"]);

  const bad = await fetch(`${base}/${item.id}/image`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: "x" });
  assert.equal(bad.status, 415);
});

test("crop geometry keeps the box inside the image and honours aspect", () => {
  const square = Crop.fitAspect(1, 2, null);
  assert.deepEqual(square, { x: 0.25, y: 0, width: 0.5, height: 1 });

  const moved = Crop.dragCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, "move", 0.9, -0.9, null, 1);
  assert.deepEqual(moved, { x: 0.5, y: 0, width: 0.5, height: 0.5 });

  const shrunk = Crop.dragCrop(Crop.FULL_CROP, "se", -2, -2, null, 1);
  assert.ok(shrunk.width >= Crop.MIN_CROP && shrunk.height >= Crop.MIN_CROP);

  const locked = Crop.dragCrop({ x: 0, y: 0, width: 0.5, height: 1 }, "se", -0.1, 0, 1, 2);
  assert.ok(Math.abs(locked.width / locked.height - 0.5) < 1e-9);

  assert.ok(Crop.isFullCrop(Crop.FULL_CROP));
  assert.deepEqual(Crop.cropToPixels({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 100, 50), { sx: 50, sy: 25, sw: 50, sh: 25 });
  assert.deepEqual(Crop.outputSize(8000, 4000, 4096), { width: 4096, height: 2048 });
});
