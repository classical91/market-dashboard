"use strict";

// The iPhone Shortcut's route into Potential Buys, through the whole app with
// the site login switched on: the ledger key opens POST /upload and nothing
// else under /api/potential-buys.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-upload-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "owner-password";
process.env.BROADCAST_LEDGER_API_KEY = "ledger-key";
delete process.env.ADMIN_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_IDS;

const { createApp } = require("../src/app");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

let server;
let base;

async function ownerCookie() {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "owner-password", returnTo: "/" }).toString(),
  });
  return String(res.headers.get("set-cookie") || "").split(";")[0];
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("a Shortcut with the ledger key uploads a File body, labelled from the query", async () => {
  const res = await fetch(`${base}/api/potential-buys/upload?label=SOL`, {
    method: "POST",
    headers: { "x-broadcast-key": "ledger-key", "content-type": "image/png" },
    body: PNG,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.label, "SOL");

  const cookie = await ownerCookie();
  const list = await (await fetch(`${base}/api/potential-buys`, { headers: { cookie } })).json();
  assert.ok(list.items.some((item) => item.id === body.id && item.label === "SOL"));
});

test("octet-stream bodies, Bearer auth and JSON base64 are accepted too", async () => {
  const raw = await fetch(`${base}/api/potential-buys/upload`, {
    method: "POST",
    headers: { authorization: "Bearer ledger-key", "content-type": "application/octet-stream", "x-label": "NVDA" },
    body: PNG,
  });
  assert.equal(raw.status, 201);
  assert.equal((await raw.json()).label, "NVDA");

  const json = await fetch(`${base}/api/potential-buys/upload`, {
    method: "POST",
    headers: { "x-broadcast-key": "ledger-key", "content-type": "application/json" },
    body: JSON.stringify({ imageBase64: `data:image/png;base64,${PNG.toString("base64")}`, label: "ETH" }),
  });
  assert.equal(json.status, 201);
  assert.equal((await json.json()).label, "ETH");
});

test("HEIC and non-images get an error the Shortcut can show", async () => {
  const heic = await fetch(`${base}/api/potential-buys/upload`, {
    method: "POST",
    headers: { "x-broadcast-key": "ledger-key", "content-type": "image/heic" },
    body: HEIC,
  });
  assert.equal(heic.status, 415);
  assert.match((await heic.json()).error, /Convert Image/);

  const text = await fetch(`${base}/api/potential-buys/upload`, {
    method: "POST",
    headers: { "x-broadcast-key": "ledger-key", "content-type": "text/plain" },
    body: "Shortcut Input",
  });
  assert.equal(text.status, 415);
});

test("without a valid key the upload is refused with JSON, not the login page", async () => {
  for (const headers of [{}, { "x-broadcast-key": "wrong" }]) {
    const res = await fetch(`${base}/api/potential-buys/upload`, {
      method: "POST",
      headers: { ...headers, "content-type": "image/png" },
      body: PNG,
      redirect: "manual",
    });
    assert.equal(res.status, 401);
    assert.ok((await res.json()).error);
  }
});

test("the ledger key opens only the upload: list, delete and images still need the login", async () => {
  const keyed = { "x-broadcast-key": "ledger-key" };
  const list = await fetch(`${base}/api/potential-buys`, { headers: keyed, redirect: "manual" });
  assert.equal(list.status, 401);

  const cookie = await ownerCookie();
  const { items } = await (await fetch(`${base}/api/potential-buys`, { headers: { cookie } })).json();
  const target = items[0];

  const del = await fetch(`${base}/api/potential-buys/${target.id}`, { method: "DELETE", headers: keyed, redirect: "manual" });
  assert.equal(del.status, 401);
  const image = await fetch(`${base}${target.url}`, { headers: keyed, redirect: "manual" });
  assert.notEqual(image.status, 200);
  const imageWithLogin = await fetch(`${base}${target.url}`, { headers: { cookie } });
  assert.equal(imageWithLogin.status, 200);
});
