"use strict";

// The market-session contract: the rule itself, the endpoint that serves it,
// and the login exemption that lets Main Hub read it.
//
// This runs with MARKET_DASHBOARD_LOGIN_PASSWORD set on purpose. The whole point
// of the exemption is that the route answers while the rest of the site does
// not, and a suite with the login turned off would pass without proving it.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-session-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "test-owner-password";
delete process.env.ALPHA_TEAM_ACCESS_CODE;
delete process.env.ADMIN_API_KEY;

const { createApp } = require("../src/app");
const sessions = require("../public/assets/js/trading-sessions.js");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// A fixed instant, named by what it is. Sept 2026: the 7th is a Monday, the
// 11th a Friday, the 12th a Saturday, the 13th a Sunday.
const at = (iso) => sessions.describeSession(new Date(iso));

test("each session is open in its own window", () => {
  assert.deepStrictEqual(at("2026-09-07T23:00:00Z").sessions, ["Sydney"]);
  assert.deepStrictEqual(at("2026-09-08T07:30:00Z").sessions, ["Tokyo"]);
  assert.deepStrictEqual(at("2026-09-08T10:00:00Z").sessions, ["London"]);
  assert.deepStrictEqual(at("2026-09-08T20:00:00Z").sessions, ["New York"]);
});

test("the London / New York overlap is reported as one", () => {
  const overlap = at("2026-09-08T14:00:00Z");
  assert.deepStrictEqual(overlap.sessions, ["London", "New York"]);
  assert.strictEqual(overlap.overlap, true);
  assert.strictEqual(overlap.label, "London + New York Session (Overlap)");
});

test("the Sydney / Tokyo overlap is reported as one", () => {
  const overlap = at("2026-09-08T02:00:00Z");
  assert.deepStrictEqual(overlap.sessions, ["Sydney", "Tokyo"]);
  assert.strictEqual(overlap.overlap, true);
});

test("the forex week closes Friday 22:00 UTC and opens Sunday 22:00 UTC", () => {
  // Friday, still open until New York shuts.
  assert.strictEqual(at("2026-09-11T21:59:00Z").open, true);
  assert.strictEqual(at("2026-09-11T22:00:00Z").open, false);

  // All of Saturday.
  assert.strictEqual(at("2026-09-12T00:00:00Z").open, false);
  assert.strictEqual(at("2026-09-12T12:00:00Z").open, false);
  assert.strictEqual(at("2026-09-12T23:00:00Z").open, false);

  // Sunday, until Sydney opens.
  assert.strictEqual(at("2026-09-13T21:00:00Z").open, false);
  assert.strictEqual(at("2026-09-13T22:00:00Z").open, true);
  assert.deepStrictEqual(at("2026-09-13T23:00:00Z").sessions, ["Sydney"]);
});

test("a weekend says so, and names no sessions", () => {
  const weekend = at("2026-09-12T12:00:00Z");
  assert.strictEqual(weekend.weekend, true);
  assert.deepStrictEqual(weekend.sessions, []);
  assert.strictEqual(weekend.overlap, false);
  assert.strictEqual(weekend.label, "Markets Closed — Weekend");
});

test("outside the weekend close something is always open", () => {
  // Sydney, Tokyo, London and New York together span all 24 hours. A gap here
  // would show on the chip as "  Session" with no name in it.
  for (let hour = 0; hour < 24; hour += 1) {
    const stamp = `2026-09-09T${String(hour).padStart(2, "0")}:30:00Z`;
    const state = at(stamp);
    assert.strictEqual(state.open, true, `${stamp} reported closed midweek`);
    assert.ok(state.sessions.length > 0, `${stamp} named no session`);
  }
});

test("GET /api/market-session answers without a login", async () => {
  const response = await fetch(`${base}/api/market-session`);
  assert.strictEqual(response.status, 200);

  const payload = await response.json();
  assert.strictEqual(payload.timezone, "UTC");
  assert.ok(typeof payload.open === "boolean");
  assert.ok(Array.isArray(payload.sessions));
  assert.ok(typeof payload.label === "string" && payload.label.length > 0);

  // The same answer the chip would draw for the instant the server reported.
  const expected = sessions.describeSession(new Date(payload.now));
  assert.strictEqual(payload.open, expected.open);
  assert.strictEqual(payload.label, expected.label);
  assert.deepStrictEqual(payload.sessions, expected.sessions);
});

test("the exemption does not open anything else", async () => {
  // Same server, same missing cookie. If these start answering, the exemption
  // has stopped being about one path.
  for (const route of ["/api/overview", "/api/watchlist", "/index.html"]) {
    const response = await fetch(`${base}${route}`, { redirect: "manual" });
    assert.ok(
      response.status === 401 || response.status === 403 || response.status === 302,
      `${route} answered ${response.status} without a session`,
    );
  }
});

test("the exemption is read-only and does not reach deeper paths", async () => {
  const write = await fetch(`${base}/api/market-session`, { method: "POST" });
  assert.ok(write.status >= 400, `POST answered ${write.status}`);

  const deeper = await fetch(`${base}/api/market-session/anything`, { redirect: "manual" });
  assert.ok(
    deeper.status === 401 || deeper.status === 403 || deeper.status === 404,
    `a deeper path answered ${deeper.status}`,
  );
});

test("the session hours live in one file, not two", () => {
  // overview.js used to carry its own copy of the table and the two window
  // helpers. If they come back, the chip and the API can disagree.
  const overview = fs.readFileSync(
    path.join(__dirname, "..", "public", "assets", "js", "overview.js"),
    "utf8",
  );

  assert.ok(!overview.includes("TRADING_SESSIONS"), "overview.js carries its own session table");
  assert.ok(!/function isWeekendClose/.test(overview), "overview.js carries its own weekend rule");
  assert.ok(!/function inSessionWindow/.test(overview), "overview.js carries its own window rule");
  assert.match(overview, /window\.MarketSessions/);
});

test("index.html loads the session hours before the page that reads them", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const hours = html.indexOf('src="/assets/js/trading-sessions.js"');
  const page = html.indexOf('src="/assets/js/overview.js"');

  assert.ok(hours !== -1, "index.html does not load trading-sessions.js");
  assert.ok(page !== -1, "index.html does not load overview.js");
  assert.ok(hours < page, "trading-sessions.js must load before overview.js");
});
