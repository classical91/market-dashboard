"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sidebar = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/sidebar.js"), "utf8");

test("primary sidebar order and removed links stay exact", () => {
  const labels = [
    "Overview v2",
    "Terminal Suite",
    "Reporter Room",
    "My Trades",
    "TradeHunter",
    "AI Analysis",
    "Reporter",
    "Market Intel Links",
    "Intelligent Portal",
    "YouTube Links",
    "X Links",
  ];
  let cursor = sidebar.indexOf("var workspace");
  for (const label of labels) {
    const next = sidebar.indexOf(`label: "${label}"`, cursor);
    assert.ok(next > cursor, `${label} is missing or out of order`);
    cursor = next;
  }
  for (const obsolete of ["Open ImageQueue", "AI Market Trader", "Image Converter", "AI Apps", "AI Portal"]) {
    assert.doesNotMatch(sidebar, new RegExp(obsolete), `${obsolete} should not remain in navigation`);
  }
});

test("the Reporter menu can actually reach the Reporter Room", () => {
  // The four briefing pages only show what the phone Shortcut sent; without a
  // link to /reporter.html the newsroom is unreachable from the navigation.
  const start = sidebar.indexOf('label: "Reporter"');
  const reporter = sidebar.slice(start, sidebar.indexOf('label: "Market Intel Links"'));
  assert.match(reporter, /href: "\/reporter\.html", label: "Reporter Room"/);
  const order = ["Reporter Room", "Markets", "Crypto", "Stocks", "Economics", "Top 10 News", "Geopolitics"];
  let cursor = -1;
  for (const label of order) {
    const next = reporter.indexOf(`label: "${label}"`, cursor + 1);
    assert.ok(next > cursor, `${label} is missing or out of order under Reporter`);
    cursor = next;
  }
  const markets = reporter.slice(reporter.indexOf('label: "Markets"'), reporter.indexOf('href: "/briefings/top-10"'));
  assert.match(markets, /^label: "Markets",\s*collapsed: true,\s*children: \[/);
  for (const desk of ["crypto", "stocks", "economics"]) {
    assert.match(markets, new RegExp(`href: "/briefings/${desk}"`));
  }
  assert.doesNotMatch(markets, /href: "\/briefings\/(top-10|geopolitics)"/);
  assert.doesNotMatch(reporter, /label: "Briefings"/);
  for (const obsolete of ["Emerging Markets", "Economics Top 10", "Markets Top 10"]) {
    assert.doesNotMatch(reporter, new RegExp(`label: "${obsolete}"`));
  }
});

test("Trades sits above TradeHunter and holds the trade workflow", () => {
  const tradesStart = sidebar.indexOf('label: "My Trades"');
  const tradeHunterStart = sidebar.indexOf('label: "TradeHunter"');
  const trades = sidebar.slice(tradesStart, tradeHunterStart);

  assert.ok(tradesStart > -1, "Trades is missing");
  assert.ok(tradeHunterStart > tradesStart, "Trades must sit above TradeHunter");
  assert.match(trades, /href: "\/pattern-scanner-trades\.html", label: "Active Trades"/);
  assert.match(trades, /href: "\/potential-buys\.html", label: "Potential Buys"/);
  assert.match(trades, /label: "Decision Engine"/);
  assert.match(trades, /href: "\/trading-lab\.html", label: "Trading Lab Backtest"/);
  let cursor = -1;
  for (const label of ["Active Trades", "Potential Buys", "Decision Engine", "Trading Lab Backtest"]) {
    const next = trades.indexOf(`label: "${label}"`, cursor + 1);
    assert.ok(next > cursor, `${label} is missing or out of order in Trades`);
    cursor = next;
    assert.equal(sidebar.match(new RegExp(`label: "${label}"`, "g")).length, 1, `${label} is duplicated`);
  }
});

test("TradeHunter sits above AI Analysis and owns the scanner workflow", () => {
  const tradeHunterStart = sidebar.indexOf('label: "TradeHunter"');
  const aiAnalysisStart = sidebar.indexOf('label: "AI Analysis"');
  const tradeHunter = sidebar.slice(tradeHunterStart, aiAnalysisStart);

  assert.ok(tradeHunterStart > -1, "TradeHunter is missing");
  assert.ok(aiAnalysisStart > tradeHunterStart, "TradeHunter must sit above AI Analysis");
  const labels = ["Screeners", "Directional Bias", "Local Extremes", "Pattern Scanner", "Crypto Open Interest", "Market Matrix", "Live Trades", "Track Record"];
  let cursor = -1;
  for (const label of labels) {
    const next = tradeHunter.indexOf(`label: "${label}"`, cursor + 1);
    assert.ok(next > cursor, `${label} is missing or out of order in TradeHunter`);
    cursor = next;
    assert.equal(sidebar.match(new RegExp(`label: "${label}"`, "g")).length, 1, `${label} is duplicated`);
  }
});

// Each screener answers one question, so each gets its own entry. The old
// combined Signal Screener link is gone from navigation; /signal-screener.html
// itself still resolves, by redirect (see screener-split-compat.test.js).
test("the Screeners group holds one entry per screener and no combined page", () => {
  const start = sidebar.indexOf('label: "Screeners"');
  const end = sidebar.indexOf('label: "Track Record"', start);
  const menu = sidebar.slice(start, end);

  assert.ok(start > -1, "the Screeners group is missing");
  assert.match(menu, /href: "\/directional-bias\.html"/);
  assert.match(menu, /href: "\/local-extremes\.html"/);
  assert.match(menu, /href: "\/pattern-scanner\.html"/);
  assert.match(menu, /href: "\/open-interest\.html", label: "Crypto Open Interest"/);
  // Cross-Market OI and the RSI Matrix are sections of Overview v2, not menu entries.
  assert.doesNotMatch(sidebar, /href: "\/cross-market-oi\.html"/);
  assert.doesNotMatch(sidebar, /href: "\/rsi-matrix\.html"/);
  assert.doesNotMatch(sidebar, /label: "Signal Screener"/);
  // Future screeners join this group; none of them may ship as a dead link yet.
  // Live Trades is an execution tape, not a directional screener: it follows
  // the Screeners group's closing entry (Market Matrix), not inside it.
  assert.doesNotMatch(menu.slice(0, menu.indexOf('href: "/tradehunter/market-matrix"')), /kucoin-live-trades/);
  for (const unbuilt of ["Derivatives", "Volatility", "Relative Strength"]) {
    assert.doesNotMatch(menu, new RegExp(`label: "${unbuilt}"`), `${unbuilt} is not built yet`);
  }
});

// Alpha Team review mode renders everything else as a disabled BETA item, so
// the list of review-able pages has to follow the split.
test("both screener pages are available in Alpha review mode", () => {
  const start = sidebar.indexOf("function isAlphaAvailable");
  const body = sidebar.slice(start, sidebar.indexOf("function alphaHref"));
  assert.match(body, /"\/directional-bias\.html"/);
  assert.match(body, /"\/local-extremes\.html"/);
  assert.match(body, /"\/pattern-scanner\.html"/);
});

test("AI Analysis owns presets, layouts, and Signal Diagnostics", () => {
  const start = sidebar.indexOf('label: "AI Analysis"');
  const end = sidebar.indexOf('label: "Reporter"', start);
  const menu = sidebar.slice(start, end);

  assert.match(menu, /label: "Presets"/);
  assert.match(menu, /label: "My Layouts"/);
  assert.match(menu, /label: "Signal Diagnostics"/);
  assert.doesNotMatch(menu, /Trading Lab Backtest/);
  assert.doesNotMatch(menu, /label: "Trading"/);
  assert.doesNotMatch(menu, /Decision Engine/);
});

test("Other section holds the external sites above Trading and tools", () => {
  const start = sidebar.indexOf("var other");
  const end = sidebar.indexOf("var tools", start);
  assert.ok(start > sidebar.indexOf("var workspace"), "Other must come after the primary nav");
  assert.ok(end > start, "Trading & Tools must come after Other");
  const menu = sidebar.slice(start, end);
  for (const label of ["Open WorldMonitor.com"]) {
    assert.match(menu, new RegExp(`label: "${label}"`), `${label} belongs in the Other section`);
  }
  assert.doesNotMatch(menu, /Open TradingView\.com|https:\/\/www\.tradingview\.com\//);
  assert.doesNotMatch(menu, /featured/, "Other links are no longer colour-featured");
  assert.match(sidebar, /'nav-other" aria-label="Other"/);
});

test("the intelligence menus are the colour-featured tabs", () => {
  for (const [label, featured] of [["YouTube Links", "youtube"], ["X Links", "x"]]) {
    const start = sidebar.indexOf(`label: "${label}"`);
    assert.ok(start > 0, `${label} is missing`);
    assert.match(sidebar.slice(start, start + 120), new RegExp(`featured: "${featured}"`));
  }
  assert.doesNotMatch(sidebar, /featured: "(worldmonitor|tradingview)"/);
});

test("Trading and tools section has one copy of every item in the requested order", () => {
  const labels = ["CoinTrendz Telegram", "Bot Commands", "Indicators Glossary", "Settings"];
  let cursor = sidebar.indexOf("var tools");
  for (const label of labels) {
    const next = sidebar.indexOf(`label: "${label}"`, cursor);
    assert.ok(next > cursor, `${label} is missing or out of order`);
    cursor = next;
    assert.equal(sidebar.match(new RegExp(`label: "${label}"`, "g")).length, 1, `${label} is duplicated`);
  }
  const toolsMenu = sidebar.slice(sidebar.indexOf("var tools"));
  assert.doesNotMatch(toolsMenu, /label: "Trading Lab Backtest"/, "Backtest belongs in AI Analysis");
  assert.doesNotMatch(toolsMenu, /label: "Decision Engine"/, "Decision Engine belongs in TradeHunter");
  assert.match(sidebar, /https:\/\/market-dashboard-production-b2f4\.up\.railway\.app\/bot-commands\.html/);
});

test("shared account UI uses the existing auth endpoints", () => {
  assert.match(sidebar, /fetch\("\/api\/auth\/session"/);
  assert.match(sidebar, /action="\/auth\/logout"/);
  assert.match(sidebar, /href="\/login\?returnTo=/);
});

test("Overview remains a direct child link without the Widgets menu", () => {
  const start = sidebar.indexOf('label: "Overview"');
  const menu = sidebar.slice(sidebar.lastIndexOf("{", start), sidebar.indexOf('label: "TradeHunter"'));
  assert.match(menu, /href: "\/overview-v1",\s*label: "Overview"/);
  const overview = sidebar.slice(sidebar.lastIndexOf("{", start), sidebar.indexOf("}", start) + 1);
  assert.doesNotMatch(overview, /children:/, "Overview has no empty dropdown");
  assert.doesNotMatch(sidebar, /label: "Widgets"|href: "\/#/, "widget jump links left the sidebar");
  assert.doesNotMatch(menu, /heatmaps\.html|label: "Heatmaps"/, "Heatmaps belongs under Screeners");
  assert.doesNotMatch(menu, /href: "\/#(market-heatmap|ovh-heatmap)"/, "heatmap anchors left Overview");
  // A dropdown with its own href renders as a split link + caret button.
  assert.match(sidebar, /nav-split-link/);
  assert.match(sidebar, /nav-split-toggle/);
});

test("Screeners nests Heatmaps with all four section links", () => {
  const start = sidebar.indexOf('label: "Screeners"');
  const menu = sidebar.slice(start, sidebar.indexOf('label: "Market Matrix"', start));
  const heatmaps = menu.indexOf('label: "Heatmaps"');
  assert.ok(start > -1 && heatmaps > -1, "Heatmaps sits under Screeners");
  assert.equal(sidebar.match(/label: "Heatmaps"/g).length, 1, "Heatmaps is not duplicated");
  assert.match(menu, /href: "\/heatmaps\.html",\s*label: "Heatmaps"/);
  for (const anchor of ["market-heatmap", "crypto-heatmap", "stock-heatmap", "forex-heatmap"]) {
    assert.match(menu.slice(heatmaps), new RegExp(`href: "/heatmaps\\.html#${anchor}"`));
  }
});

test("Cross-Market OI and the RSI Matrix are merged into Overview v2", () => {
  const overview = fs.readFileSync(path.join(__dirname, "..", "public", "overview-v2.html"), "utf8");
  assert.match(sidebar, /href: "\/open-interest\.html", label: "Crypto Open Interest"/);
  assert.match(overview, /id="cross-market-oi"/);
  assert.match(overview, /id="xoi-plot"/);
  assert.match(overview, /assets\/js\/cross-market-oi\.js/);
  assert.match(overview, /id="rsi-matrix"/);
  assert.match(overview, /id="rm-groups"/);
  assert.match(overview, /assets\/js\/rsi-matrix\.js/);
  // The standalone pages stay reachable and highlight Overview in the menu.
  assert.match(sidebar, /path === "\/cross-market-oi\.html" \|\| path === "\/rsi-matrix\.html"\) return "\/"/);
});

test("one standalone Intelligent Portal replaces the nested portal links", () => {
  const portalStart = sidebar.indexOf('label: "Intelligent Portal"');
  const ytStart = sidebar.indexOf('label: "YouTube Links"');
  const xStart = sidebar.indexOf('label: "X Links"');
  assert.ok(ytStart > -1 && xStart > ytStart, "YouTube Links must sit above X Links");
  const xMenu = sidebar.slice(xStart, sidebar.indexOf("var other", xStart));
  const ytMenu = sidebar.slice(ytStart, xStart);
  assert.ok(portalStart > -1 && portalStart < ytStart, "the shared portal sits above the platform menus");
  const workspace = sidebar.slice(sidebar.indexOf("var workspace"), sidebar.indexOf("var other"));
  assert.equal((workspace.match(/href: "\/intelligence-portal\.html"/g) || []).length, 1);
  assert.match(workspace, /^    \{ href: "\/intelligence-portal\.html", label: "Intelligent Portal" \},$/m);
  assert.doesNotMatch(workspace, /label: "(?:X|YouTube) Portal"|intelligence-portal\.html#/);
  // The platform pages remain available through their existing menus.
  assert.match(ytMenu, /href: "\/youtube-v2\.html", label: "YouTube Intelligence"/);
  assert.match(xMenu, /href: "\/x-intelligence\.html", label: "X Intelligence"/);
});
