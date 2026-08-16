"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-site-auth-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.TRADERCLAW_DASHBOARD_LOGIN_PASSWORD = "traderclaw-password";
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-password";
delete process.env.ADMIN_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");
const { createSiteAuth } = require("../src/middleware/site-auth");

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

test("site login redirects anonymous page requests", async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/login\?returnTo=/);
});

test("owner password unlocks the whole dashboard", async () => {
  const { res: loginRes, cookie } = await login("owner-password", "/settings.html");
  assert.equal(loginRes.status, 303);
  assert.equal(loginRes.headers.get("location"), "/settings.html");
  assert.match(cookie, /^market_dashboard_session=/);

  const page = await fetch(`${base}/settings.html`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Settings/i);
});

test("TraderClaw has a distinct full-dashboard identity without admin authorization", async () => {
  const { res: loginRes, cookie } = await login("traderclaw-password", "/trading-lab.html");
  assert.equal(loginRes.status, 303);
  assert.equal(loginRes.headers.get("location"), "/trading-lab.html");

  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    configured: true,
    authenticated: true,
    role: "traderclaw",
  });

  const page = await fetch(`${base}/trading-lab.html`, { headers: { cookie } });
  assert.equal(page.status, 200);

  const action = await fetch(`${base}/api/trading-lab/mark`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ strategyId: "mindset_v1" }),
  });
  assert.equal(action.status, 503, "site identity must not bypass the separate admin API key");
});

test("alpha password unlocks only alpha review pages and read-only alpha data", async () => {
  const { res: loginRes, cookie } = await login("alpha-password", "/signal-screener.html?view=alpha");
  assert.equal(loginRes.status, 303);
  assert.equal(loginRes.headers.get("location"), "/signal-screener.html?view=alpha");
  assert.match(cookie, /^market_dashboard_session=/);

  const alphaPage = await fetch(`${base}/signal-screener.html?view=alpha`, { headers: { cookie } });
  assert.equal(alphaPage.status, 200);

  const alphaData = await fetch(`${base}/api/signal-screener?symbols=BTCUSDT&interval=4h`, { headers: { cookie } });
  assert.equal(alphaData.status, 200);

  const blockedPage = await fetch(`${base}/settings.html`, { redirect: "manual", headers: { cookie } });
  assert.equal(blockedPage.status, 302);
  assert.match(blockedPage.headers.get("location"), /^\/login\?returnTo=/);

  const blockedWrite = await fetch(`${base}/api/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "BTCUSDT", interval: "4h" }),
  });
  assert.equal(blockedWrite.status, 403);
});

test("wrong password stays on login", async () => {
  const { res } = await login("wrong-password", "/");
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Password was not accepted/);
});

test("logout clears the session and the next browser request requires login", async () => {
  const { cookie } = await login("traderclaw-password", "/");
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.match(logout.headers.get("set-cookie"), /market_dashboard_session=;/);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);

  const clearedCookie = cookieFrom(logout);
  const page = await fetch(`${base}/`, { redirect: "manual", headers: { cookie: clearedCookie } });
  assert.equal(page.status, 302);
  assert.match(page.headers.get("location"), /^\/login\?returnTo=/);

  const status = await fetch(`${base}/api/auth/session`, { headers: { cookie: clearedCookie } });
  assert.deepEqual(await status.json(), { configured: true, authenticated: false, role: null });

  const replay = await fetch(`${base}/`, { redirect: "manual", headers: { cookie } });
  assert.equal(replay.status, 302, "a logged-out signed cookie must be revoked server-side");
});

test("website account passwords must be distinct", () => {
  assert.throws(
    () => createSiteAuth({ sitePassword: "same", traderclawPassword: "same", alphaAccessCode: "" }),
    /must be distinct/,
  );
});

test("shared navigation exposes a visible logout control", () => {
  const sidebar = fs.readFileSync(path.join(__dirname, "..", "public", "assets", "js", "sidebar.js"), "utf8");
  assert.match(sidebar, /action=\"\/auth\/logout\"/);
  assert.match(sidebar, />Log out</);
});
