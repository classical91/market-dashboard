"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createApp } = require("../src/app");

test("/btc-research opens Crypto Hub on the Bitcoin Research dropdown", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const alias of ["/btc-research", "/bitcoin-research"]) {
      const res = await fetch(`${base}${alias}`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/crypto.html#crypto-research");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
