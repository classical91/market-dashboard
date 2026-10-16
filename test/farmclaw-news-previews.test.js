"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createFarmclawNewsPreviewsRouter } = require("../src/routes/farmclaw-news-previews");

const env = { FARMBOT_NEWS_API_URL: "https://api.example", FARMBOT_NEWS_READER_TOKEN: "reader-fixture-".repeat(4), FARMBOT_NEWS_APPROVAL_BASE_URL: "https://farmbot.example" };
async function withServer(options, fn) {
  const app = express(); app.use("/previews", createFarmclawNewsPreviewsRouter(options));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/previews`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test("read-only preview bridge uses only its scoped credential and links to FarmBot", async () => {
  const row = { batchId: "fnb_00000000-0000-4000-8000-000000000001", clientBatchId: "farmclaw-top5-2026-10-16", revision: 1, status: "validated", payloadHash: `sha256:${"a".repeat(64)}`, persisted: true, validated: true, approvalEligible: true };
  let calls = 0;
  await withServer({ env, fetcher: async (url, init) => {
    calls++; assert.equal(url, "https://api.example/news/v1/batches");
    assert.deepEqual(init.headers, { Authorization: `Bearer ${env.FARMBOT_NEWS_READER_TOKEN}` });
    return Response.json([row]);
  } }, async url => {
    const response = await fetch(url); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.batches[0].approvalUrl, `https://farmbot.example/news-batches/${row.batchId}`);
    assert.doesNotMatch(JSON.stringify(body), /reader-fixture|APPROVER_KEY|authorization/i);
    for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await fetch(url, { method })).status, 405);
    assert.equal(calls, 1);
  });
});
test("missing, invalid, corrupt or inaccessible upstream state fails closed", async () => {
  for (const options of [
    { env: {}, fetcher: async () => { throw new Error("must not fetch"); } },
    { env: { ...env, FARMBOT_NEWS_API_URL: "http://api.example" }, fetcher: async () => { throw new Error("must not fetch"); } },
    { env, fetcher: async () => Response.json([{ persisted: false }]) },
    { env, fetcher: async () => Response.json({ error: "upstream secret detail" }, { status: 403 }) },
    { env, fetcher: async () => { throw new Error("credential detail"); } },
  ]) await withServer(options, async url => {
    const response = await fetch(url); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /credential detail|upstream secret detail/);
  });
});
