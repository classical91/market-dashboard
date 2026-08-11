"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-alpha-access-"));
process.env.ALPHA_TEAM_ACCESS_CODE = "alpha-review-code";

const { createApp, matchesSecret } = require("../src/app");

let server;
let base;

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("matchesSecret accepts exact code only", () => {
  assert.equal(matchesSecret("alpha-review-code", "alpha-review-code"), true);
  assert.equal(matchesSecret("wrong", "alpha-review-code"), false);
  assert.equal(matchesSecret("", "alpha-review-code"), false);
});

test("alpha team access gate rejects missing or wrong code", async () => {
  for (const body of [{}, { code: "wrong" }]) {
    const res = await fetch(`${base}/api/alpha-team/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 401);
  }
});

test("alpha team access gate accepts configured code", async () => {
  const res = await fetch(`${base}/api/alpha-team/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "alpha-review-code" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
});
