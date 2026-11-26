"use strict";

// Potential Buys' Chart ↗ links: which free TradingView chart a ticker
// folder opens.

const test = require("node:test");
const assert = require("node:assert");
const { chartSymbol, chartUrl, marketHint, CRYPTO } = require("../public/assets/js/chart-links");
const { TRACKABLE_TOKENS } = require("../src/config/market-symbols");

test("stocks stay bare so TradingView opens the main listing", () => {
  assert.equal(chartSymbol("NVDA"), "NVDA");
  assert.equal(chartSymbol("BRK.B"), "BRK.B");
  assert.equal(chartSymbol("SPY"), "SPY");
});

test("known coins and pairs open the Binance USDT chart", () => {
  assert.equal(chartSymbol("BTC"), "BINANCE:BTCUSDT");
  assert.equal(chartSymbol("SOL"), "BINANCE:SOLUSDT");
  assert.equal(chartSymbol("ETHUSDT"), "BINANCE:ETHUSDT");
  assert.equal(chartSymbol("SOL-USD"), "BINANCE:SOLUSDT");
  assert.equal(chartSymbol("ETHUSD"), "BINANCE:ETHUSDT");
  // XAUUSD is gold, not a coin pair: left for TradingView to resolve.
  assert.equal(chartSymbol("XAUUSD"), "XAUUSD");
});

test("market-cap and dominance charts are CRYPTOCAP indices", () => {
  assert.equal(chartSymbol("TOTAL3"), "CRYPTOCAP:TOTAL3");
  assert.equal(chartSymbol("TOTAL"), "CRYPTOCAP:TOTAL");
  assert.equal(chartSymbol("BTC.D"), "CRYPTOCAP:BTC.D");
  assert.equal(chartSymbol("USDT.D"), "CRYPTOCAP:USDT.D");
});

test("#crypto and #stock in a label decide an unknown or shared symbol", () => {
  assert.equal(marketHint(["ZRO", "CRYPTO"]), "crypto");
  assert.equal(marketHint(["NVDA", "STOCKS"]), "stock");
  assert.equal(marketHint(["NVDA"]), "");
  assert.equal(chartSymbol("ZRO", "crypto"), "BINANCE:ZROUSDT");
  assert.equal(chartSymbol("ZRO"), "ZRO");
  // A coin symbol that is also a stock ticker, labelled #stock.
  assert.equal(chartSymbol("OP", "stock"), "OP");
});

test("category words get no chart, and the URL is TradingView's free chart", () => {
  for (const word of ["CRYPTO", "STOCKS", "WATCHLIST", "ALTS"]) assert.equal(chartUrl(word), "");
  assert.equal(chartUrl(""), "");
  assert.equal(chartUrl("NVDA"), "https://www.tradingview.com/chart/?symbol=NVDA");
  assert.equal(chartUrl("BTC"), "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT");
  assert.equal(chartUrl("BTC.D"), "https://www.tradingview.com/chart/?symbol=CRYPTOCAP%3ABTC.D");
});

test("every coin the rest of the dashboard tracks charts as crypto", () => {
  for (const pair of TRACKABLE_TOKENS) {
    const base = pair.replace(/USDT$/, "");
    assert.ok(CRYPTO.includes(base), `${base} is missing from chart-links.js CRYPTO`);
    assert.equal(chartSymbol(base), `BINANCE:${pair}`);
  }
});
