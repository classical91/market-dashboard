"use strict";

// The Reporter Room is a newsroom. News Intelligence is its workspace tab —
// live news, headlines per asset, scheduled catalysts, how markets reacted,
// and what the four desks made of it — sitting alongside the four generated
// desk reports, not above them. These pin the properties that keep it that
// way, and keep it from drifting back into a second Terminal Suite.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const page = read("public/reporter.html");
const widgets = read("public/assets/js/reporter-widgets.js");
const market = read("public/assets/js/reporter-market.js");
const css = read("public/assets/styles/reporter.css");

test("the page loads the assets it references, and they all exist", () => {
  for (const asset of [
    "/assets/styles/command.css",
    "/assets/styles/reporter.css",
    "/assets/js/sidebar.js",
    "/assets/js/admin-key.js",
    "/assets/js/trading-sessions.js",
    "/assets/js/reporter-widgets.js",
    "/assets/js/reporter-market.js",
  ]) {
    assert.ok(page.includes(asset), `${asset} must be referenced`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", asset)), `${asset} must exist`);
  }
});

test("the modules load before the page script that drives them", () => {
  // The page script calls ReporterWidgets.init() itself, after the shell is
  // configured. It can only do that if the globals already exist.
  const widgetsAt = page.indexOf('src="/assets/js/reporter-widgets.js"');
  const marketAt = page.indexOf('src="/assets/js/reporter-market.js"');
  const pageScriptAt = page.indexOf("/* ── Reporter ─");
  assert.ok(widgetsAt !== -1 && marketAt !== -1 && pageScriptAt !== -1);
  assert.ok(widgetsAt < pageScriptAt, "reporter-widgets.js must load before the page script");
  assert.ok(marketAt < pageScriptAt, "reporter-market.js must load before the page script");
});

test("page CSS lives in its own stylesheet, not an inline block", () => {
  assert.doesNotMatch(page, /<style>/);
  assert.match(css, /\.news-intel\b/);
  assert.match(css, /\.intel-section\b/);
});

test("News Intelligence is the first tab, ahead of the four desks", () => {
  // Scope to the tab row: data-tab also appears in the fixed-page selector.
  const row = page.slice(page.indexOf('id="reporterTabs"'), page.indexOf('id="reporterExternalLinks"'));
  const tabs = [...row.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["news", "geopolitics", "economics", "markets", "crypto"]);
  assert.match(page, /<button class="reporter-tab active" data-tab="news">/);
});

test("news is a workspace tab and never a report section", () => {
  // The backend has exactly four sections. Letting 'news' reach generation,
  // broadcast routing or the log would invent a fifth.
  assert.match(page, /var sectionOrder = \['geopolitics', 'economics', 'markets', 'crypto'\];/);
  assert.match(page, /function isReportTab\(tab\) \{\s*return sectionOrder\.indexOf\(tab\) !== -1;/);
  // Generation refuses anything that is not a desk, before it takes the lock.
  assert.match(page, /if \(!isReportTab\(section\)\) return;\s*\n\s*generating = true;/);
  // An empty workspace tab must not be "fixed" by jumping to a desk.
  assert.match(page, /if \(isReportTab\(activeTab\) && !data\[activeTab\] && data\.latestSection\)/);
});

test("the tab swaps the two views and leaves mounted panels alone", () => {
  assert.match(page, /if \(workspace\) workspace\.hidden = !onNews;/);
  assert.match(page, /if \(report\) report\.hidden = onNews;/);
  // Hiding, not tearing down: returning to the workspace must not re-fetch
  // every embed.
  assert.doesNotMatch(page, /workspace\.innerHTML = ''/);
});

test("the workspace runs raw news, then reaction, then reporter output", () => {
  const order = [
    'id="reporterTabs"',
    'id="newsIntelligence"',
    'data-intel-section="live-news"',
    'data-intel-section="news-discovery"',
    'data-intel-section="market-reaction"',
    'id="newsroomOverview"',
    'id="deskStatusList"',
    'data-intel-section="global-context"',
    'id="reporterReport"',
    'id="reporterLog"',
  ];
  let previous = -1;
  for (const marker of order) {
    const index = page.indexOf(marker);
    assert.ok(index !== -1, `${marker} must be on the page`);
    assert.ok(index > previous, `${marker} must come after the section before it`);
    previous = index;
  }
});

test("Master News, the desk list and newsroom controls live in the workspace", () => {
  const start = page.indexOf('id="newsIntelligence"');
  const end = page.indexOf('id="reporterReport"');
  const workspace = page.slice(start, end);
  for (const marker of [
    'id="masterNewsList"',
    'data-master-limit="5"',
    'id="deskStatusList"',
    'id="shareclawRunBtn"',
    'id="reporterBroadcastBtn"',
    'id="marketReaction"',
    'id="catalystList"',
  ]) {
    assert.ok(workspace.includes(marker), `${marker} must sit inside News Intelligence`);
  }
});

test("the Reporter does not carry the screener pages' modules", () => {
  // If a panel answers "what should I trade?", it belongs on the Terminal
  // Suite or a screener, not in the newsroom.
  const declared = [...page.matchAll(/data-intel-widget="([A-Za-z]+)"/g)].map((m) => m[1]);
  for (const banned of ["sectorHeatmap", "etfHeatmap", "forexHeatmap", "ratesMonitor", "macroChart"]) {
    assert.ok(!declared.includes(banned), `${banned} must not be mounted by the Reporter`);
  }
  // The definitions stay available for other pages to declare.
  for (const kept of ["sectorHeatmap", "etfHeatmap", "forexHeatmap", "ratesMonitor", "macroChart"]) {
    assert.match(widgets, new RegExp(`\\n {4}${kept}: \\{`), `${kept} should remain reusable`);
  }
});

test("the workspace's panels are the news-oriented ones", () => {
  const declared = [...page.matchAll(/data-intel-widget="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(declared)].sort(),
    ["economicCalendar", "globalEquityMap", "symbolNews", "topStories", "worldMarkets"],
  );
});

test("third-party panels are declared, never embedded in the page", () => {
  assert.doesNotMatch(page, /s3\.tradingview\.com/);
  assert.match(widgets, /IntersectionObserver/);
  const definitions = [...widgets.matchAll(/\n {4}([A-Za-z]+): \{([\s\S]*?)\n {4}\},?\n/g)];
  for (const [, name, body] of definitions) {
    assert.match(body, /source: '/, `${name} must carry a source link for its error state`);
    assert.match(body, /script: 'embed-widget-/, `${name} must name its embed loader`);
  }
});

test("a panel that never loads degrades instead of leaving a blank box", () => {
  assert.match(widgets, /Market data unavailable/);
  assert.match(widgets, /Open source ↗/);
  assert.match(widgets, /LOAD_TIMEOUT_MS/);
  assert.match(widgets, /catch \(error\) \{\n {6}renderError\(el, def\);/);
});

test("a collapsed section fetches nothing, and Global Context starts closed", () => {
  assert.match(widgets, /body\.hidden = collapsed;/);
  assert.match(page, /data-intel-section="global-context"[\s\S]{0,120}data-intel-collapsed="true"/);
  assert.match(widgets, /section\.getAttribute\('data-intel-collapsed'\) === 'true'/);
  // Opening it once should keep it open on the next visit.
  assert.match(widgets, /rememberOpened\(id\)/);
});

test("Market News holds one live frame, not one per asset", () => {
  const options = [...page.matchAll(/data-intel-symbol-option="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(options.length, 8, "SPY, QQQ, BTC, ETH, DXY, Gold, Oil, US10Y");
  assert.equal(new Set(options).size, 8);
  // One widget element, repointed — not eight retained iframes.
  assert.equal((page.match(/data-intel-widget="symbolNews"/g) || []).length, 1);
  assert.match(widgets, /function remount\(el\)/);
  assert.match(widgets, /config\.symbol = el\.dataset\.intelSymbol/);
});

test("market reaction is a strip, and reads the app's own payload", () => {
  assert.match(market, /\/api\/overview/);
  // No second price source: the hub's payload is the only one this page reads.
  assert.doesNotMatch(market, /coingecko|finnhub|binance/i);
  // The session chip is clock arithmetic, not a request.
  assert.match(market, /MarketSessions/);
  assert.doesNotMatch(market, /\/api\/market-session/);
  assert.match(market, /REFRESH_MS = 90000/);
  assert.match(market, /if \(doc\.hidden\) return;/);
  // It is a strip, not a charting surface: no canvas, no chart library.
  assert.doesNotMatch(market, /createElement\('canvas'\)|new Chart\(|<canvas/);
});

test("a row the macro feed does not carry says so rather than being guessed", () => {
  assert.match(market, /US10Y/);
  assert.match(market, /not configured/i);
  assert.match(market, /MACRO_SYMBOLS or MACRO_DATA_URL/);
});

test("catalysts come from the calendar already in the payload", () => {
  // Same request as the reaction strip — the panel adds no second call, and
  // no new data dependency was taken on for it.
  assert.match(market, /state\.calendar = Array\.isArray\(payload\.calendar\)/);
  assert.equal((market.match(/fetch\(/g) || []).length, 1, "one request feeds both panels");
  // A fallback calendar has no confirmed times, and must not pretend to.
  assert.match(market, /item\.precision === 'exact'/);
  assert.match(page, /Earnings calendar ↗/);
});

test("newsroom operations sit together, and Broadcast waits for a report", () => {
  const start = page.indexOf('class="shareclaw-panel"');
  const panel = page.slice(start, page.indexOf("</aside>", start));
  assert.match(panel, /id="shareclawRunBtn"/);
  assert.match(panel, /id="reporterBroadcastBtn"/);
  assert.match(panel, /Newsroom Status/);
  assert.match(panel, /id="reporterBroadcastBtn"[^>]*disabled/);
  assert.match(page, /function syncBroadcastAvailability/);
});

test("the fixed desk pages open straight into their report", () => {
  // /emerging-markets.html and friends share this template and are one fixed
  // desk: no workspace, no news tab, and no third-party panels at all.
  assert.match(page, /var workspace = document\.getElementById\('newsIntelligence'\);/);
  assert.match(page, /workspace\.parentNode\.removeChild\(workspace\)/);
  assert.match(page, /\.reporter-tab\[data-tab="news"\]/);
  assert.match(page, /if \(report\) report\.hidden = false;/);
});

test("existing Reporter behaviour is untouched", () => {
  for (const marker of [
    "/api/daily-report?ttlHours=",
    "/api/daily-report/generate?ttlHours=",
    "/api/daily-report/broadcast?ttlHours=",
    "/api/daily-report/logs/import?ttlHours=",
    "/api/newsroom/health",
    "/api/newsroom/cycles/run?ttlHours=",
  ]) {
    assert.ok(page.includes(marker), `${marker} must still be called`);
  }
  assert.match(page, /id="reporterLog"/);
  assert.match(page, /id="masterNewsList"/);
  assert.match(page, /function sourceCountBySection/);
  assert.match(page, /storyMetaBySection\[section\]\[deskRank\]/);
});
