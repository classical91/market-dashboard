"use strict";

// The Reporter Room is now an intelligence dashboard wrapped around the AI
// newsroom rather than the newsroom alone. These pin the properties that keep
// it that way: context before synthesis, the app's own data before a
// third-party panel, nothing third-party fetched until it is needed, and an
// outage that cannot take the Reporter down with it.
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

test("page CSS lives in its own stylesheet, not an inline block", () => {
  assert.doesNotMatch(page, /<style>/);
  assert.match(css, /\.reporter-intel\b/);
  assert.match(css, /\.intel-section\b/);
});

test("market context is ordered ahead of the AI synthesis", () => {
  const order = [
    'id="intelStatusStrip"',
    'data-intel-section="live-intelligence"',
    'data-intel-section="global-macro"',
    'data-intel-section="cross-asset"',
    'data-intel-section="market-breadth"',
    'data-intel-section="fx-rates"',
    'data-intel-section="macro-data"',
    'id="newsroomSection"',
    'id="reporterTabs"',
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

test("the newsroom is still one click from the top of the page", () => {
  assert.match(page, /href="#newsroomSection"/);
});

test("market context reads the dashboard's own overview payload", () => {
  assert.match(market, /\/api\/overview/);
  // No second price source: the hub's payload is the only one this page reads.
  assert.doesNotMatch(market, /coingecko|finnhub|binance/i);
  // The session chip is clock arithmetic, not a request.
  assert.match(market, /MarketSessions/);
  assert.doesNotMatch(market, /\/api\/market-session/);
});

test("a row the macro feed does not carry says so rather than being guessed", () => {
  assert.match(market, /US10Y/);
  assert.match(market, /Not configured/);
  assert.match(market, /MACRO_SYMBOLS or MACRO_DATA_URL/);
});

test("the refresh cadence matches the hub's and pauses on a hidden tab", () => {
  assert.match(market, /REFRESH_MS = 90000/);
  assert.match(market, /if \(doc\.hidden\) return;/);
});

test("third-party panels are declared, never embedded in the page", () => {
  // No TradingView loader may be hard-coded into the markup: everything goes
  // through the lazy mounter, or none of it is lazy.
  assert.doesNotMatch(page, /s3\.tradingview\.com/);
  assert.match(page, /data-intel-widget="economicCalendar"/);
  assert.match(widgets, /IntersectionObserver/);
});

test("every declared panel has a definition, and every definition a source link", () => {
  const declared = [...page.matchAll(/data-intel-widget="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 9, "the dashboard should declare its panels");

  for (const name of new Set(declared)) {
    assert.ok(
      new RegExp(`\\n    ${name}: \\{`).test(widgets),
      `${name} must have a widget definition`,
    );
  }
  // A panel that cannot load has to be able to point somewhere that can.
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
  // Mounting is wrapped, so a throwing embed cannot take the page with it.
  assert.match(widgets, /catch \(error\) \{\n {6}renderError\(el, def\);/);
});

test("a collapsed section and a hidden tab fetch nothing", () => {
  assert.match(widgets, /body\.hidden = collapsed;/);
  assert.match(widgets, /panel\.hidden = !active;/);
  // Only the panel that was just revealed is scanned for widgets to mount.
  assert.match(widgets, /if \(shown\) scan\(shown\);/);
});

test("the macro tabs declare a series each, from one widget definition", () => {
  const symbols = [...page.matchAll(/data-intel-symbol="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(symbols.length, 16, "four categories of four series");
  assert.equal(new Set(symbols).size, 16, "no series is charted twice");
  assert.match(widgets, /config\.symbol = el\.dataset\.intelSymbol/);

  for (const tab of ["inflation", "labor", "rates", "liquidity"]) {
    assert.match(page, new RegExp(`data-intel-tab="${tab}"`));
    assert.match(page, new RegExp(`data-intel-tab-panel="${tab}"`));
  }
});

test("macro series are labelled as published, not as rates they are not", () => {
  // FRED carries CPI as an index level. Calling that line "CPI YoY" would
  // state something the series does not say.
  assert.match(page, /CPI index/);
  assert.doesNotMatch(page, /CPI YoY/);
  assert.match(page, /Breakevens carry the market's inflation rate/);
});

test("Master News has slots for classification it does not have yet", () => {
  assert.match(page, /storyMetaBySection\[section\]\[deskRank\]/);
  assert.match(page, /typeof extra\.impact === 'string' \? extra\.impact : ''/);
  assert.match(page, /Array\.isArray\(extra\.assets\) \? extra\.assets : \[\]/);
  // Source counts are per desk, so a page-wide total is not read as one
  // story's provenance.
  assert.match(page, /function sourceCountBySection/);
  assert.match(page, /desk source/);
});

test("newsroom operations sit together, and Broadcast waits for a report", () => {
  const start = page.indexOf('class="shareclaw-panel"');
  const panel = page.slice(start, page.indexOf("</aside>", start));
  assert.match(panel, /id="shareclawRunBtn"/);
  assert.match(panel, /id="reporterBroadcastBtn"/);
  assert.match(panel, /Newsroom Status/);
  // On screen from the first paint, so it must not offer to send nothing.
  assert.match(panel, /id="reporterBroadcastBtn"[^>]*disabled/);
  assert.match(page, /function syncBroadcastAvailability/);
});

test("the fixed desk pages drop the dashboard rather than hiding it", () => {
  // /emerging-markets.html and friends share this template and are single-desk
  // briefings: a hidden widget is still a declared one.
  assert.match(page, /var intel = document\.getElementById\('reporterIntel'\);/);
  assert.match(page, /intel\.parentNode\.removeChild\(intel\)/);
  assert.match(page, /var newsroom = document\.getElementById\('newsroomSection'\);/);
});

test("the market strip is the only thing allowed to scroll sideways", () => {
  assert.match(css, /\.intel-strip-rail \{[\s\S]*?overflow-x: auto;/);
  // An auto grid track is floored at its contents' min-content width, which
  // would widen the page instead of scrolling the rail inside it.
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\);/);
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
  for (const tab of ["geopolitics", "economics", "markets", "crypto"]) {
    assert.match(page, new RegExp(`data-tab="${tab}"`));
  }
  assert.match(page, /id="reporterLog"/);
  assert.match(page, /id="masterNewsList"/);
});
