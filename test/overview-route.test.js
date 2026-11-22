"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "overview-v2-route-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "test-owner-password";
const { createApp } = require("../src/app");

test("Overview is the default page and the removed Overview v2 URLs redirect to it", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-owner-password", returnTo: "/" }),
    });
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    for (const url of ["/", "/overview-v1", "/overview-v1.html", "/index.html"]) {
      const response = await fetch(base + url, { redirect: "manual", headers: { cookie } });
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get("location"), null);
      const html = await response.text();
      assert.match(html, /assets\/js\/overview\.js/, url);
      assert.doesNotMatch(html, /overview-v2/, url);
    }
    for (const url of ["/overview-v2", "/overview-v2.html", "/overview-hybrid.html"]) {
      const response = await fetch(base + url, { redirect: "manual", headers: { cookie } });
      assert.equal(response.status, 301, url);
      assert.equal(response.headers.get("location"), "/", url);
    }
    for (const asset of ["/assets/js/overview-v2.js", "/assets/styles/overview-v2.css"]) {
      const response = await fetch(base + asset, { redirect: "manual", headers: { cookie } });
      assert.equal(response.status, 404, asset);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
