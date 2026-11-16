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

test("Overview v2 URLs serve the new page instead of redirecting to v1", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-owner-password", returnTo: "/overview-v2" }),
    });
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    for (const url of ["/overview-v2", "/overview-v2.html"]) {
      const response = await fetch(base + url, { redirect: "manual", headers: { cookie } });
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get("location"), null);
      assert.match(await response.text(), /assets\/js\/overview-v2\.js/);
    }
    const legacy = await fetch(`${base}/overview-hybrid.html`, { redirect: "manual", headers: { cookie } });
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.get("location"), "/");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
