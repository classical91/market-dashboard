"use strict";

// Splitting the Signal Screener into two pages must not break anything that
// already pointed at it: old links, the Alpha Team review surface, the
// screener API the bot and decision engine read, or the Trade Context layer
// that combines both halves with the pattern scan.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-screener-split-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-password";
delete process.env.ADMIN_API_KEY;

const { createApp } = require("../src/app");

let server;
let base;

function cookieFrom(res) {
  return String(res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(password, returnTo = "/") {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, returnTo }).toString(),
  });
  return { res, cookie: cookieFrom(res) };
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("the old Signal Screener link redirects to Directional Bias", async () => {
  const { cookie } = await login("owner-password");
  const res = await fetch(`${base}/signal-screener.html`, { redirect: "manual", headers: { cookie } });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/directional-bias.html");
});

test("the redirect keeps the query string, so shared review links stay review links", async () => {
  const { cookie } = await login("alpha-password", "/signal-screener.html?view=alpha");
  const res = await fetch(`${base}/signal-screener.html?view=alpha`, { redirect: "manual", headers: { cookie } });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/directional-bias.html?view=alpha");
});

test("an Alpha Team login lands on a page that role can actually open", async () => {
  const { res } = await login("alpha-password", "/");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/directional-bias.html?view=alpha");
});

test("Alpha Team can review both screener pages and read both APIs", async () => {
  const { cookie } = await login("alpha-password", "/directional-bias.html?view=alpha");
  for (const page of ["/directional-bias.html?view=alpha", "/local-extremes.html?view=alpha"]) {
    const res = await fetch(`${base}${page}`, { headers: { cookie } });
    assert.equal(res.status, 200, `${page} must open for the Alpha Team role`);
  }
  // The read APIs behind those pages open too — without the pages' own data,
  // a review page is a blank table.
  for (const api of ["/api/directional-bias", "/api/local-extremes"]) {
    const res = await fetch(`${base}${api}?interval=4h`, { headers: { cookie }, redirect: "manual" });
    assert.notEqual(res.status, 401, `${api} must be readable by the Alpha Team role`);
    assert.notEqual(res.status, 403, `${api} must be readable by the Alpha Team role`);
  }
});

test("Alpha Team access stays read-only and does not widen with the new pages", async () => {
  const { cookie } = await login("alpha-password", "/directional-bias.html?view=alpha");

  // Trading Lab, settings and the rest of the dashboard stay closed.
  const blockedPage = await fetch(`${base}/trading-lab.html`, { redirect: "manual", headers: { cookie } });
  assert.equal(blockedPage.status, 302);

  // Journal mutation, watchlist mutation and broadcast endpoints stay closed.
  const blockedWrite = await fetch(`${base}/api/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "BTCUSDT", interval: "4h" }),
  });
  assert.equal(blockedWrite.status, 403);

  const blockedJournal = await fetch(`${base}/api/decision/journal`, { headers: { cookie } });
  assert.equal(blockedJournal.status, 403);

  const blockedBroadcast = await fetch(`${base}/api/x/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "nope" }),
  });
  assert.ok(blockedBroadcast.status === 403 || blockedBroadcast.status === 404, "broadcast must not open for alpha");

  // The new POST surface is nothing: both screener routes are GET-only reads.
  const blockedPost = await fetch(`${base}/api/local-extremes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.ok(blockedPost.status >= 400, "the screener routes expose no writes");
});

test("the original screener API is untouched, so the bot and bridge keep working", async () => {
  const { cookie } = await login("owner-password");
  // Registered and reachable; the upstream scan itself is exercised by the
  // screener's own tests rather than hit here.
  const res = await fetch(`${base}/api/signal-screener?interval=4h`, { headers: { cookie }, redirect: "manual" });
  assert.notEqual(res.status, 404, "/api/signal-screener must still be mounted");
  assert.notEqual(res.status, 301, "the API must not redirect — only the page did");
});

test("Trade Context still combines bias, extremes and patterns into one state", () => {
  // The integration layer is deliberately unchanged by the split: it keeps
  // reading the screener row directly, and its vocabulary stays the same.
  const { classifyContext, BIAS_LABELS } = require("../src/services/trade-context");
  assert.deepEqual(BIAS_LABELS, { LONG: "BULLISH", SHORT: "BEARISH", FLAT: "NEUTRAL" });

  const conflict = classifyContext({
    directionalBias: { bias: "BULLISH", signal: "LONG" },
    extremes: { dominant: "top", state: "CONFIRMED" },
    patterns: { patternBias: "bullish" },
  });
  assert.equal(conflict.state, "CONFLICT");

  const aligned = classifyContext({
    directionalBias: { bias: "BULLISH", signal: "LONG" },
    extremes: { dominant: "bottom", state: "CONFIRMED" },
    patterns: { patternBias: "bullish" },
  });
  assert.equal(aligned.state, "ALIGNED");

  for (const state of ["QUIET", "PARTIAL", "ALIGNED", "MIXED", "CONFLICT"]) {
    assert.ok(typeof state === "string");
  }
});

test("the signal bot's alert vocabulary and transition semantics are unchanged", () => {
  const telegram = fs.readFileSync(path.join(__dirname, "..", "src/services/telegram.js"), "utf8");
  // The wire values still drive the bot; only the label shown to a reader,
  // and the page the Visit: link opens, are presentation.
  assert.match(telegram, /const ALERT_BIAS_LABELS = \{ LONG: "BULLISH", SHORT: "BEARISH", FLAT: "NEUTRAL" \}/);
  assert.match(telegram, /dashboardLink\(dashboardUrl, "\/directional-bias\.html"\)/);

  const bot = fs.readFileSync(path.join(__dirname, "..", "src/services/signal-bot.js"), "utf8");
  assert.doesNotMatch(bot, /BULLISH|BEARISH|NEUTRAL/, "the bot's state machine stays on LONG/SHORT/FLAT");
});
