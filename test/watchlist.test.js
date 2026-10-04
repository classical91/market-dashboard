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

test("the My Trades search catalog is a top-30 superset of the scanner universe", () => {
  const { TOP_TOKENS, TRACKABLE_TOKENS } = require("../src/config/market-symbols");
  assert.equal(TRACKABLE_TOKENS.length, 30);
  assert.equal(new Set(TRACKABLE_TOKENS).size, 30);
  for (const symbol of TOP_TOKENS) assert.ok(TRACKABLE_TOKENS.includes(symbol), symbol);
});

test("GET /api/watchlist/tokens serves the catalog without the admin gate", async () => {
  const express = require("express");
  const { createWatchlistRouter } = require("../src/routes/watchlist");
  const { TRACKABLE_TOKENS } = require("../src/config/market-symbols");
  const app = express();
  const denied = (req, res) => res.status(401).end();
  app.use("/api/watchlist", createWatchlistRouter({ watchlistService: makeService(), requireAdmin: denied }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/watchlist/tokens`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tokens, TRACKABLE_TOKENS);
  } finally {
    server.close();
  }
});
