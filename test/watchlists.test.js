const test = require("node:test");
const assert = require("node:assert/strict");

const W = require("../public/assets/js/watchlists.js");

test("normalizeSymbol upper-cases TradingView symbols and rejects junk", () => {
  assert.equal(W.normalizeSymbol(" binance:btcusdt "), "BINANCE:BTCUSDT");
  assert.equal(W.normalizeSymbol("nasdaq:aapl"), "NASDAQ:AAPL");
  assert.equal(W.normalizeSymbol("BTCUSDT.P"), "BTCUSDT.P");
  assert.equal(W.normalizeSymbol(""), "");
  assert.equal(W.normalizeSymbol("BINANCE:"), "");
  assert.equal(W.normalizeSymbol("A:B:C"), "");
  assert.equal(W.normalizeSymbol("<script>"), "");
  assert.equal(W.normalizeSymbol("x".repeat(41)), "");
});

test("tickerParts splits the exchange prefix off", () => {
  assert.deepEqual(W.tickerParts("KUCOIN:PENDLEUSDT"), { exchange: "KUCOIN", ticker: "PENDLEUSDT" });
  assert.deepEqual(W.tickerParts("SPY"), { exchange: "", ticker: "SPY" });
});

test("normalize falls back to a default folder and repairs bad input", () => {
  const fresh = W.normalize(null);
  assert.equal(fresh.folders.length, 1);
  assert.equal(fresh.activeId, fresh.folders[0].id);

  const repaired = W.normalize({
    activeId: "missing",
    folders: [
      { id: "a", name: "  Kucoin   trades ", bookmark: "neon", tickers: ["btcusdt", "BTCUSDT", "bad sym", 7] },
      { id: "a", name: "", bookmark: "red", tickers: [] },
      "nope",
    ],
  });
  assert.equal(repaired.folders.length, 2);
  assert.equal(repaired.folders[0].name, "Kucoin trades");
  assert.equal(repaired.folders[0].bookmark, null, "unknown colours are dropped");
  assert.deepEqual(repaired.folders[0].tickers, ["BTCUSDT", "7"]);
  assert.notEqual(repaired.folders[1].id, "a", "duplicate ids are reassigned");
  assert.equal(repaired.folders[1].name, "Untitled");
  assert.equal(repaired.activeId, repaired.folders[1].id, "missing active folder falls back to the first in display order (bookmarked)");
});

test("bookmarked folders list first, keeping their relative order", () => {
  let state = W.normalize({ folders: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] });
  state = W.setBookmark(state, "c", "blue");
  state = W.setBookmark(state, "b", "red");
  assert.deepEqual(W.ordered(state).map((f) => f.id), ["b", "c", "a"]);
  state = W.setBookmark(state, "b", null);
  assert.deepEqual(W.ordered(state).map((f) => f.id), ["c", "a", "b"]);
});

test("folder edits are pure and keep the active folder valid", () => {
  const start = W.normalize({ activeId: "a", folders: [{ id: "a", name: "A", tickers: [] }] });
  const created = W.createFolder(start, "  Swing  ");
  assert.equal(start.folders.length, 1, "input state is untouched");
  assert.equal(created.folder.name, "Swing");
  assert.equal(created.state.activeId, created.folder.id);

  const renamed = W.renameFolder(created.state, "a", "   ");
  assert.equal(W.findFolder(renamed, "a").name, "A", "a blank rename keeps the old name");

  const removed = W.deleteFolder(renamed, created.folder.id);
  assert.equal(removed.activeId, "a");
  assert.equal(W.deleteFolder(removed, "a").activeId, null);
});

test("addTickers reports added, duplicate and invalid symbols", () => {
  const state = W.normalize({ folders: [{ id: "a", name: "A", tickers: ["BINANCE:BTCUSDT"] }] });
  const res = W.addTickers(state, "a", "binance:btcusdt, kucoin:pendleusdt  bad$ NASDAQ:AAPL");
  assert.deepEqual(res.added, ["KUCOIN:PENDLEUSDT", "NASDAQ:AAPL"]);
  assert.deepEqual(res.duplicate, ["BINANCE:BTCUSDT"]);
  assert.deepEqual(res.invalid, ["bad$"]);
  assert.deepEqual(W.findFolder(res.state, "a").tickers, ["BINANCE:BTCUSDT", "KUCOIN:PENDLEUSDT", "NASDAQ:AAPL"]);
});

test("moveTicker reorders within bounds and removeTicker drops one", () => {
  let state = W.normalize({ folders: [{ id: "a", name: "A", tickers: ["X", "Y", "Z"] }] });
  state = W.moveTicker(state, "a", "Z", -1);
  assert.deepEqual(W.findFolder(state, "a").tickers, ["X", "Z", "Y"]);
  state = W.moveTicker(state, "a", "X", -1);
  assert.deepEqual(W.findFolder(state, "a").tickers, ["X", "Z", "Y"], "moving past the top is a no-op");
  state = W.removeTicker(state, "a", "Z");
  assert.deepEqual(W.findFolder(state, "a").tickers, ["X", "Y"]);
});

test("foldersFor lists every folder holding a ticker, bookmarked first", () => {
  const state = W.normalize({
    folders: [
      { id: "a", name: "A", tickers: ["BTC"] },
      { id: "b", name: "B", tickers: ["ETH"] },
      { id: "c", name: "C", bookmark: "green", tickers: ["BTC"] },
    ],
  });
  assert.deepEqual(W.foldersFor(state, "BTC").map((f) => f.id), ["c", "a"]);
});

test("read/write round-trip through the in-memory fallback under Node", () => {
  const saved = W.write(W.createFolder(W.defaultState(), "Kucoin trades").state);
  const back = W.read();
  assert.deepEqual(back, saved);
  assert.equal(W.activeFolder(back).name, "Kucoin trades");
});
