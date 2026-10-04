"use strict";

// The FarmClaw card button: POST /api/x/farmclaw sends only the post link to
// the one configured Telegram chat/topic, and refuses rather than guesses.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-farmclaw-"));
process.env.ADMIN_API_KEY = "farmclaw-test-admin";
process.env.TELEGRAM_BOT_TOKEN = "123:farmclaw-test-token";
process.env.TELEGRAM_CHAT_IDS = "-1001841650798:6297";
process.env.FARMCLAW_TELEGRAM_CHAT = "-1002222222222:77";
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");

const originalFetch = global.fetch;
let server;
let base;
let telegramCalls = [];

function mockTelegram() {
  telegramCalls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(base)) return originalFetch(url, init);
    if (!target.includes("api.telegram.org")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    }
    telegramCalls.push({ url: target, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ result: { message_id: 7 } }) };
  };
}

function call(pathname, { method = "POST", body, headers = {} } = {}) {
  return originalFetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const admin = { "x-admin-key": "farmclaw-test-admin" };
const postUrl = "https://x.com/cryptorover/status/2106855957615804682";

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => mockTelegram());

test("sending to FarmClaw is admin-gated", async () => {
  const res = await call("/api/x/farmclaw", { body: { url: postUrl } });
  assert.notStrictEqual(res.status, 200);
  assert.strictEqual(telegramCalls.length, 0);
});

test("sends only the link, to the FarmClaw chat and topic", async () => {
  const res = await call("/api/x/farmclaw", {
    headers: admin,
    body: { url: postUrl, text: "BOOM Bitcoin above $86,000", handle: "cryptorover" },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body, { ok: true, sent: 1 });
  assert.strictEqual(telegramCalls.length, 1);
  const { url, body } = telegramCalls[0];
  assert.match(url, /sendMessage$/);
  assert.strictEqual(String(body.chat_id), "-1002222222222");
  assert.strictEqual(String(body.message_thread_id), "77");
  assert.strictEqual(body.text, postUrl);
});

test("refuses a missing or non-http url without sending", async () => {
  for (const url of [undefined, "", "javascript:alert(1)"]) {
    const res = await call("/api/x/farmclaw", { headers: admin, body: { url } });
    assert.strictEqual(res.status, 400);
  }
  assert.strictEqual(telegramCalls.length, 0);
});
