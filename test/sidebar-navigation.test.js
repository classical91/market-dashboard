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

test("TradeHunter sits above AI Analysis and owns the scanner workflow", () => {
  const tradeHunterStart = sidebar.indexOf('label: "TradeHunter"');
  const aiAnalysisStart = sidebar.indexOf('label: "AI Analysis"');
  const tradeHunter = sidebar.slice(tradeHunterStart, aiAnalysisStart);

  assert.ok(tradeHunterStart > -1, "TradeHunter is missing");
  assert.ok(aiAnalysisStart > tradeHunterStart, "TradeHunter must sit above AI Analysis");
  const labels = ["Pattern Scanner", "My Trades", "Track Record", "Signal Screener", "Decision Engine"];
  let cursor = -1;
  for (const label of labels) {
    const next = tradeHunter.indexOf(`label: "${label}"`, cursor + 1);
    assert.ok(next > cursor, `${label} is missing or out of order in TradeHunter`);
    cursor = next;
    assert.equal(sidebar.match(new RegExp(`label: "${label}"`, "g")).length, 1, `${label} is duplicated`);
  }
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
