"use strict";

// The broadcast endpoints behind the X Intelligence card button, against the
// real app. What is asserted here is mostly refusal: a broadcast that reaches
// the wrong room, or reaches fewer rooms than it claims, is worse than one
// that does not happen.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-broadcast-"));
process.env.ADMIN_API_KEY = "broadcast-test-admin";
process.env.TELEGRAM_BOT_TOKEN = "123:broadcast-test-token";
process.env.X_BROADCAST_CHANNELS = JSON.stringify([
  { label: "Market Desk", chatId: "-1001841650798", threadId: "6297" },
  { label: "War Room", chatId: "-1001841650798", threadId: "75972" },
]);
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");

const originalFetch = global.fetch;
let server;
let base;
let telegramCalls = [];

// Only Telegram is mocked; requests the test makes to the local server have
// to actually reach it.
function mockTelegram(shouldFail = () => false) {
  telegramCalls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(base)) return originalFetch(url, init);
    if (!target.includes("api.telegram.org")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    }
    const body = JSON.parse(init.body);
    telegramCalls.push(body);
    if (shouldFail(body)) {
      return { ok: false, status: 400, text: async () => '{"description":"chat not found"}' };
    }
    return { ok: true, status: 200, json: async () => ({ result: { message_id: 42 } }) };
  };
}

function call(pathname, { method = "GET", body, headers = {} } = {}) {
  return originalFetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const admin = { "x-admin-key": "broadcast-test-admin" };

const post = {
  handle: "Barchart",
  text: "AAPL breaks 200",
  url: "https://x.com/Barchart/status/1",
};

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

test("the channel list is admin-gated, like the Telegram diagnostics it mirrors", async () => {
  const anonymous = await call("/api/x/broadcast/channels");
  assert.equal(anonymous.status, 401, "chat and topic ids are not public");

  const { status, body } = await call("/api/x/broadcast/channels", { headers: admin });
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.deepEqual(body.channels.map((channel) => channel.label), ["Market Desk", "War Room"]);
  assert.equal(body.channels[0].id, "tg--1001841650798-t6297");
});

test("broadcasting is admin-gated too", async () => {
  const { status } = await call("/api/x/broadcast", {
    method: "POST",
    body: { ...post, channels: ["tg--1001841650798-t6297"] },
  });

  assert.equal(status, 401);
  assert.equal(telegramCalls.length, 0, "an unauthenticated request must not reach Telegram");
});

test("a post goes only to the ticked channel, into its topic", async () => {
  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, channels: ["tg--1001841650798-t75972"] },
  });

  assert.equal(status, 200);
  assert.equal(body.sent, 1);
  assert.equal(body.failed, 0);
  assert.equal(telegramCalls.length, 1, "the unticked channel must not receive it");
  assert.equal(telegramCalls[0].chat_id, "-1001841650798");
  assert.equal(telegramCalls[0].message_thread_id, 75972);
  assert.match(telegramCalls[0].text, /AAPL breaks 200/);
  assert.match(telegramCalls[0].text, /x\.com\/Barchart\/status\/1/);
  assert.deepEqual(body.destinations, [
    { id: "tg--1001841650798-t75972", label: "War Room", status: "posted", error: null },
  ]);
});

test("an unknown channel id sends nothing at all", async () => {
  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, channels: ["tg--1001841650798-t6297", "tg--999"] },
  });

  assert.equal(status, 400);
  assert.match(body.error, /tg--999/);
  assert.equal(telegramCalls.length, 0, "a request naming two rooms must not half-deliver into one");
});

test("no channels selected is refused rather than read as every channel", async () => {
  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, channels: [] },
  });

  assert.equal(status, 400);
  assert.match(body.error, /at least one channel/i);
  assert.equal(telegramCalls.length, 0);
});

test("a post with neither text nor link is refused", async () => {
  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { handle: "Barchart", channels: ["tg--1001841650798-t6297"] },
  });

  assert.equal(status, 400);
  assert.match(body.error, /nothing to broadcast/i);
});

test("a non-http image is dropped, and the post still goes as text", async () => {
  const { status } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, image: "javascript:alert(1)", channels: ["tg--1001841650798-t6297"] },
  });

  assert.equal(status, 200);
  assert.equal(telegramCalls.length, 1);
  assert.ok(!("photo" in telegramCalls[0]), "Telegram is never handed a non-http photo url");
  assert.ok(telegramCalls[0].text, "losing the picture does not lose the post");
});

test("a partial delivery reports which channel failed, by the name the picker used", async () => {
  mockTelegram((body) => body.message_thread_id === 75972);

  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, channels: ["tg--1001841650798-t6297", "tg--1001841650798-t75972"] },
  });

  assert.equal(status, 200, "one channel did receive it; that is a result, not an error");
  assert.equal(body.sent, 1);
  assert.equal(body.failed, 1);
  const failed = body.destinations.find((destination) => destination.status !== "posted");
  assert.equal(failed.label, "War Room", "named as the picker named it, not as a chat id");
  assert.match(failed.error, /chat not found/);
});

test("a send that reaches nowhere is an error the page can show", async () => {
  mockTelegram(() => true);

  const { status, body } = await call("/api/x/broadcast", {
    method: "POST",
    headers: admin,
    body: { ...post, channels: ["tg--1001841650798-t6297"] },
  });

  assert.equal(status, 502);
  assert.match(body.error, /failed/i);
});
