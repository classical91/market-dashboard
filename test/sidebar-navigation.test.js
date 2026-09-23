"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sidebar = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/sidebar.js"), "utf8");

test("primary sidebar order and removed links stay exact", () => {
  const labels = [
    "Terminal Suite",
    "Overview",
    "TradeHunter",
    "AI Analysis",
    "Reporter",
    "Market Intel Links",
    "YouTube Intelligence",
    "X Intelligence",
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
  // The three desk pages share reporter.html but strip the News Intelligence
  // tab, Master News, the desk statuses and the newsroom controls. Without a
  // link to /reporter.html the newsroom is unreachable from the navigation.
  const start = sidebar.indexOf('label: "Reporter"');
  const reporter = sidebar.slice(start, sidebar.indexOf('label: "Market Intel Links"'));
  assert.match(reporter, /href: "\/reporter\.html", label: "Reporter Room"/);
  const order = ["Reporter Room", "Emerging Markets", "Economics Top 10", "Markets Top 10"];
  let cursor = -1;
  for (const label of order) {
    const next = reporter.indexOf(`label: "${label}"`, cursor + 1);
    assert.ok(next > cursor, `${label} is missing or out of order under Reporter`);
    cursor = next;
  }
});

test("TradeHunter sits above AI Analysis and owns the scanner workflow", () => {
  const tradeHunterStart = sidebar.indexOf('label: "TradeHunter"');
  const aiAnalysisStart = sidebar.indexOf('label: "AI Analysis"');
  const tradeHunter = sidebar.slice(tradeHunterStart, aiAnalysisStart);

  assert.ok(tradeHunterStart > -1, "TradeHunter is missing");
  assert.ok(aiAnalysisStart > tradeHunterStart, "TradeHunter must sit above AI Analysis");
  const labels = ["Screeners", "Directional Bias", "Local Extremes", "Pattern Scanner", "Crypto Open Interest", "Cross-Market Open Interest", "My Trades", "Track Record", "Decision Engine"];
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
  assert.match(menu, /href: "\/cross-market-oi\.html", label: "Cross-Market Open Interest"/);
  assert.match(menu, /href: "\/pattern-scanner-trades\.html"/);
  assert.doesNotMatch(sidebar, /label: "Signal Screener"/);
  // Future screeners join this group; none of them may ship as a dead link yet.
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

test("AI Analysis owns presets, layouts, Backtest, and Signal Diagnostics", () => {
  const start = sidebar.indexOf('label: "AI Analysis"');
  const end = sidebar.indexOf('label: "Reporter"', start);
  const menu = sidebar.slice(start, end);

  assert.match(menu, /label: "Presets"/);
  assert.match(menu, /label: "My Layouts"/);
  assert.match(menu, /label: "Trading Lab Backtest"/);
  assert.match(menu, /label: "Signal Diagnostics"/);
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
  for (const [label, featured] of [["YouTube Intelligence", "youtube"], ["X Intelligence", "x"]]) {
    const start = sidebar.indexOf(`label: "${label}"`);
    assert.ok(start > 0, `${label} is missing`);
    assert.match(sidebar.slice(start, start + 120), new RegExp(`featured: "${featured}"`));
  }
  assert.doesNotMatch(sidebar, /featured: "(worldmonitor|tradingview)"/);
});

test("Trading and tools section has one copy of every item in the requested order", () => {
  const labels = ["Trader Lab Telegram", "Bot Commands", "Indicators Glossary", "Settings"];
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

test("Overview opens its page directly and nests Widgets and Heatmaps", () => {
  const start = sidebar.indexOf('label: "Overview"');
  const menu = sidebar.slice(sidebar.lastIndexOf("{", start), sidebar.indexOf('label: "TradeHunter"'));
  // The label itself is a link; the caret expands the sub-menus.
  assert.match(menu, /href: "\/",\s*label: "Overview"/);
  const widgets = menu.indexOf('label: "Widgets"');
  const heatmaps = menu.indexOf('label: "Heatmaps"');
  assert.ok(widgets > -1 && heatmaps > widgets, "Widgets then Heatmaps sit under Overview");
  assert.match(menu, /href: "\/heatmaps\.html",\s*label: "Heatmaps"/);
  for (const anchor of ["market-heatmap", "crypto-heatmap", "stock-heatmap", "forex-heatmap"]) {
    assert.match(menu.slice(heatmaps), new RegExp(`href: "/heatmaps\\.html#${anchor}"`));
  }
  assert.doesNotMatch(menu, /href: "\/#(market-heatmap|ovh-heatmap)"/, "heatmap anchors left Overview");
  // A dropdown with its own href renders as a split link + caret button.
  assert.match(sidebar, /nav-split-link/);
  assert.match(sidebar, /nav-split-toggle/);
});

test("both Open Interest pages sit side by side under Screeners", () => {
  const start = sidebar.indexOf('label: "Screeners"');
  const menu = sidebar.slice(start, sidebar.indexOf('label: "Track Record"', start));
  const crypto = menu.indexOf('href: "/open-interest.html", label: "Crypto Open Interest"');
  const cross = menu.indexOf('href: "/cross-market-oi.html", label: "Cross-Market Open Interest"');
  assert.ok(crypto > -1, "crypto OI is under Screeners");
  assert.equal(cross > crypto, true, "cross-market OI sits right after crypto OI");
});
