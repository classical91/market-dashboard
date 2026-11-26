"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { OverviewService } = require("../src/services/overview");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const overviewPage = read("public/index.html");
const overviewJs = read("public/assets/js/overview.js");
const terminalPage = read("public/terminal-suite.html");
const sidebar = read("public/assets/js/sidebar.js");

const TA_INTERVALS = ["15m", "1h", "4h", "1D", "1W", "1M"];

test("Overview is the 30-second read: no duplicate link cards", () => {
  for (const marker of ['id="ovh-technical-analysis"', 'id="ovh-derivatives"', 'id="ovh-liquidity"']) {
    assert.ok(!overviewPage.includes(marker), `${marker} should no longer be on Overview`);
  }
  // Both scripts targeted sections Overview no longer has.
  assert.doesNotMatch(overviewPage, /assets\/js\/tools\.js|assets\/js\/sections\.js/);
  for (const anchor of ["ovh-technical-analysis", "ovh-derivatives", "ovh-liquidity"]) {
    assert.doesNotMatch(sidebar, new RegExp(`href: "/#${anchor}"`), `sidebar still links /#${anchor}`);
  }
  // The links the cards carried are still one click away on the Crypto page.
  const crypto = read("public/crypto.html");
  for (const url of ["coinglass.com/FundingRate/BTC", "coinglass.com/LongShortRatio", "coinglass.com/etf/bitcoin", "coinglass.com/liquidations", "fear-and-greed-index"]) {
    assert.ok(crypto.includes(url), `${url} must stay reachable on /crypto.html`);
  }
});

test("the technical ratings live on Overview: BTC across six timeframes, labelled as TradingView's", () => {
  assert.match(overviewPage, /id="technical-analysis"/);
  const configs = overviewPage.match(/\{ "interval": "[^"]+"[^}]*\}/g) || [];
  assert.deepStrictEqual(configs.map((c) => c.match(/"interval": "([^"]+)"/)[1]), TA_INTERVALS);
  for (const config of configs) {
    assert.match(config, /"symbol": "BINANCE:BTCUSDT"/);
    assert.match(config, /"showIntervalTabs": false/);
  }
  assert.match(overviewPage, /Technical Ratings &middot; TradingView/);
  assert.match(overviewPage, /href="\/directional-bias\.html"/);
  // Terminal no longer embeds them; its tab points at the Overview section.
  assert.ok(!terminalPage.includes("embed-widget-technical-analysis.js"), "ratings should not be duplicated on Terminal");
  assert.match(terminalPage, /href="\/#technical-analysis"/);
});

test("Overview's regime displays read the canonical market state", () => {
  assert.match(overviewJs, /data\.marketState\?\.regime/);
  assert.doesNotMatch(overviewJs, /data\.marketStatus/, "the crypto-only marketStatus is no longer displayed");
  assert.match(overviewJs, /fallbackInputs/);
  assert.match(overviewJs, /proxyInputs/);
});

test("the Crypto Breadth KPI agrees with the regime's breadth input", async () => {
  const feeds = {
    getCryptoPrices: async () => ({
      live: true,
      items: [
        { symbol: "BTC", price: 64000, changePercent: -2 },
        { symbol: "ETH", price: 3200, changePercent: -1.5 },
      ],
    }),
    getEquities: async () => ({ live: true, items: [] }),
    getMacro: async () => ({ live: true, items: [] }),
    getMarketChart: async () => ({ live: true, points: [] }),
    getGlobalDominance: async () => ({ live: true, dominance: [] }),
    getNews: async () => ({ live: false, items: [] }),
    getCalendar: async () => ({ live: true, items: [] }),
  };
  const payload = await new OverviewService({
    marketDataService: feeds,
    cache: { getOrLoad: (_k, _t, load) => load() },
    cacheTtlMs: 0,
  }).getOverview("1D");

  const kpi = payload.kpis.find((k) => k.label === "Crypto Breadth");
  const breadth = payload.marketState.regime.components.find((c) => c.symbol === "AVG");
  assert.ok(kpi && breadth);
  assert.equal(kpi.value, "Negative");
  assert.ok(breadth.vote <= -0.25);
  assert.equal(kpi.quality, "live");
  assert.ok(!payload.kpis.some((k) => k.label === "Crypto Sentiment"), "the separate sentiment label is gone");
});
