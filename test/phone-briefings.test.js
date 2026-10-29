"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const LEDGER_KEY = "test-ledger-key";
const SITE_PASSWORD = "site-password";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-phone-briefings-routes-"));
process.env.BROADCAST_LEDGER_API_KEY = LEDGER_KEY;
process.env.ADMIN_API_KEY = "test-admin-key";
// Site login ON so the Shortcut's keyed bypass is exercised.
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = SITE_PASSWORD;

const { createApp } = require("../src/app");
const { PhoneBriefingStore } = require("../src/services/phone-briefings");

function newStore(options = {}) {
  return new PhoneBriefingStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-phone-briefings-")),
    logger: { error() {} },
    ...options,
  });
}

test("a briefing is stored per desk, newest first, and retries are not duplicated", () => {
  const store = newStore();
  const first = store.receive("geopolitics", { text: "1. First\r\n- point" }, new Date("2026-10-27T10:00:00Z"));
  assert.equal(first.created, true);
  assert.equal(first.entry.text, "1. First\n- point");

  const retry = store.receive("geopolitics", { text: "1. First\n- point" }, new Date("2026-10-27T10:01:00Z"));
  assert.equal(retry.created, false);
  assert.equal(retry.entry.id, first.entry.id);

  const second = store.receive("geopolitics", { text: "1. Second" }, new Date("2026-10-29T10:00:00Z"));
  assert.deepEqual(store.history("geopolitics").map((run) => run.id), [second.entry.id, first.entry.id]);
  assert.equal(store.history("geopolitics")[0].text, undefined, "history lists runs without their text");

  const summary = store.summary();
  assert.deepEqual(summary.map((desk) => desk.key), ["geopolitics", "economics", "stocks", "crypto"]);
  assert.equal(summary[0].latest.id, second.entry.id);
  assert.equal(summary[0].count, 2);
  assert.equal(summary[1].latest, null);
});

test("desk names the Reporter Room or Telegram use resolve to the four desks", () => {
  const store = newStore();
  assert.equal(store.receive("Markets", { text: "a" }).entry.category, "stocks");
  assert.equal(store.receive("stock", { text: "b" }).entry.category, "stocks");
  assert.equal(store.receive("ECONOMY", { text: "c" }).entry.category, "economics");
  assert.throws(() => store.receive("weather", { text: "d" }), /Unknown category/);
  assert.throws(() => store.receive("crypto", { text: "   " }), /empty/);
});

test("each desk keeps a bounded history", () => {
  const store = newStore({ historyPerCategory: 3 });
  for (let i = 0; i < 5; i += 1) store.receive("crypto", { text: `run ${i}` }, new Date(Date.UTC(2026, 9, i + 1)));
  assert.deepEqual(store.history("crypto", { withText: true }).map((run) => run.text), ["run 4", "run 3", "run 2"]);
});

test("the Shortcut pushes with the ledger key; reads need the site login", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const push = (pathname, body, { key = LEDGER_KEY, type = "application/json" } = {}) => fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": type, ...(key ? { "x-broadcast-key": key } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  try {
    assert.equal((await push("/api/phone-briefings/geopolitics", { text: "x" }, { key: null })).status, 401);
    assert.equal((await push("/api/phone-briefings/geopolitics", { text: "x" }, { key: "wrong" })).status, 401);

    const created = await push("/api/phone-briefings/geopolitics", { text: "## World\n1. **Story** one" });
    assert.equal(created.status, 201);
    const receipt = await created.json();
    assert.equal(receipt.category, "geopolitics");

    const again = await push("/api/phone-briefings/geopolitics", { text: "## World\n1. **Story** one" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).id, receipt.id);

    // Shortcuts can also send the ChatGPT result as the raw body.
    const plain = await push("/api/phone-briefings/stocks", "1. Plain text story", { type: "text/plain" });
    assert.equal(plain.status, 201);

    const batch = await push("/api/phone-briefings", { economics: "1. Rates", crypto: "1. BTC", ignored: "x" });
    assert.equal(batch.status, 201);
    assert.deepEqual((await batch.json()).results.map((r) => r.category), ["economics", "crypto"]);

    assert.equal((await push("/api/phone-briefings/weather", { text: "x" })).status, 400);
    assert.equal((await push("/api/phone-briefings/crypto", { text: "" })).status, 400);

    // Without the key or a login, nothing is readable.
    const keyedRead = await fetch(`${base}/api/phone-briefings`, { headers: { Accept: "application/json" } });
    assert.equal(keyedRead.status, 401);

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${SITE_PASSWORD}&returnTo=/briefings/geopolitics`,
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const read = (pathname) => fetch(`${base}${pathname}`, { headers: { cookie }, redirect: "manual" });

    const summary = await (await read("/api/phone-briefings")).json();
    const geo = summary.categories.find((desk) => desk.key === "geopolitics");
    assert.equal(geo.latest.id, receipt.id);
    assert.equal(summary.categories.find((desk) => desk.key === "stocks").latest.text, "1. Plain text story");

    const runs = await (await read("/api/phone-briefings/geopolitics")).json();
    assert.deepEqual(runs.runs.map((run) => run.id), [receipt.id]);
    const run = await (await read(`/api/phone-briefings/geopolitics/${receipt.id}`)).json();
    assert.equal(run.text, "## World\n1. **Story** one");
    assert.equal((await read("/api/phone-briefings/geopolitics/nope")).status, 404);

    const page = await read("/briefings/crypto");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /assets\/js\/briefing\.js/);
    assert.equal((await read("/briefings/weather")).status, 404);

    // The old desk pages land on the briefing that replaced them.
    for (const [old, next] of [
      ["/emerging-markets.html", "/briefings/geopolitics"],
      ["/economics-top-10.html", "/briefings/economics"],
      ["/markets-top-10.html", "/briefings/stocks"],
    ]) {
      const res = await read(old);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get("location"), next);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the page renders ChatGPT markdown without letting it inject HTML", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/briefing.js"), "utf8");
  const stub = { textContent: "", innerHTML: "", hidden: false, className: "", classList: { add() {}, remove() {} }, addEventListener() {} };
  const context = {
    window: { location: { pathname: "/briefings/crypto", origin: "http://x" } },
    document: { getElementById: () => ({ ...stub }), title: "" },
    fetch: () => new Promise(() => {}),
  };
  vm.runInNewContext(source, context);
  const render = context.window.PhoneBriefing.renderMarkdown;

  const html = render([
    "## Top stories",
    "1. **Fed** holds <script>alert(1)</script>",
    "- Source: https://example.com/a",
    "- [Read](javascript:alert(1))",
    "---",
  ].join("\n"));
  assert.match(html, /<h4>Top stories<\/h4>/);
  assert.match(html, /<span class="briefing-rank">1<\/span><strong>Fed<\/strong> holds &lt;script&gt;/);
  assert.match(html, /<ul><li>Source: <a href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<hr \/>/);
});
