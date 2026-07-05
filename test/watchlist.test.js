"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WatchlistService } = require("../src/services/watchlist");

function makeService() {
  return new WatchlistService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-watchlist-")) });
}

test("add appends a new item, list returns it, remove takes it back out", () => {
  const service = makeService();
  assert.deepEqual(service.list(), []);

  const afterAdd = service.add("BTCUSDT", "4h", "BTC");
  assert.equal(afterAdd.length, 1);
  assert.equal(afterAdd[0].symbol, "BTCUSDT");
  assert.equal(afterAdd[0].interval, "4h");
  assert.equal(afterAdd[0].label, "BTC");
  assert.ok(afterAdd[0].addedAt);

  const afterRemove = service.remove("BTCUSDT", "4h");
  assert.deepEqual(afterRemove, []);
});

test("adding the same symbol/interval twice does not duplicate it", () => {
  const service = makeService();
  service.add("ETHUSDT", "1D", "ETH");
  const second = service.add("ETHUSDT", "1D", "ETH");
  assert.equal(second.length, 1);
});

test("same symbol on a different interval is tracked separately", () => {
  const service = makeService();
  service.add("SOLUSDT", "4h", "SOL");
  service.add("SOLUSDT", "1D", "SOL");
  assert.equal(service.list().length, 2);
});

test("persists across service instances against the same data dir", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-watchlist-"));
  const first = new WatchlistService({ dataDir });
  first.add("XRPUSDT", "4h", "XRP");

  const second = new WatchlistService({ dataDir });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].symbol, "XRPUSDT");
});
