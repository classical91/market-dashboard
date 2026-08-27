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
    "AI Analysis",
    "Reporter",
    "Market Intel Links",
    "YouTube",
    "AI Portal",
    "𝕏",
    "Open WorldMonitor.com",
    "Open TradingView.com",
  ];
  let cursor = sidebar.indexOf("var workspace");
  for (const label of labels) {
    const next = sidebar.indexOf(`label: "${label}"`, cursor);
    assert.ok(next > cursor, `${label} is missing or out of order`);
    cursor = next;
  }
  for (const obsolete of ["Open ImageQueue", "AI Market Trader", "Image Converter", "AI Apps"]) {
    assert.doesNotMatch(sidebar, new RegExp(obsolete), `${obsolete} should not remain in navigation`);
  }
});

test("AI Analysis excludes tools that moved to the bottom section", () => {
  const start = sidebar.indexOf('label: "AI Analysis"');
  const end = sidebar.indexOf('label: "Reporter"', start);
  const menu = sidebar.slice(start, end);
  assert.doesNotMatch(menu, /Decision Engine|Backtest Lab/);
});

test("Trading and tools section has one copy of every item in the requested order", () => {
  const labels = ["Trader Lab Telegram", "Trading Lab Backtest", "Bot Commands", "Decision Engine", "Indicators Glossary", "Settings"];
  let cursor = sidebar.indexOf("var tools");
  for (const label of labels) {
    const next = sidebar.indexOf(`label: "${label}"`, cursor);
    assert.ok(next > cursor, `${label} is missing or out of order`);
    cursor = next;
    assert.equal(sidebar.match(new RegExp(`label: "${label}"`, "g")).length, 1, `${label} is duplicated`);
  }
  assert.match(sidebar, /https:\/\/market-dashboard-production-b2f4\.up\.railway\.app\/bot-commands\.html/);
});

test("shared account UI uses the existing auth endpoints", () => {
  assert.match(sidebar, /fetch\("\/api\/auth\/session"/);
  assert.match(sidebar, /action="\/auth\/logout"/);
  assert.match(sidebar, /href="\/login\?returnTo=/);
});
