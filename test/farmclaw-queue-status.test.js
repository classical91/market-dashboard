"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFarmclawQueueStatus } = require("../src/services/farmclaw-queue-status");
const env = { FARMBOT_NEWS_API_URL: "https://api.example", FARMBOT_NEWS_READER_TOKEN: "reader-fixture-".repeat(4) };
const record = { url: "https://twitter.com/example/status/123?s=20", status: "received" };
const receipt = { persisted: true, queued: true, statusId: "123", queueItemId: "42", payloadHash: `sha256:${"a".repeat(64)}`,
  queue: { id: "42", dispatchActive: false, dispatchStatus: "PENDING" } };
test("FarmBot queue confirmation requires authoritative receipt and scoped read-only lookup", async () => {
  let calls=0;
  const lookup=createFarmclawQueueStatus({env,fetcher:async(url,init)=>{
    calls++;assert.equal(url,"https://api.example/farmclaw/v1/x-links/123");
    assert.equal(init.headers.Authorization,`Bearer ${env.FARMBOT_NEWS_READER_TOKEN}`);
    return Response.json(receipt);
  }});
  assert.deepEqual(await lookup(record),{confirmed:true,queueItemId:"42",dispatchActive:false,dispatchStatus:"PENDING",xPublishedUrl:null});
  await lookup(record); assert.equal(calls,1);
});
test("missing, failed, corrupt or wrong-source receipt never claims queue success",async()=>{
  for(const body of [{}, {...receipt,statusId:"999"},{...receipt,queued:false},{...receipt,payloadHash:"invalid"}]) {
    assert.equal(await createFarmclawQueueStatus({env,fetcher:async()=>Response.json(body)})(record),null);
  }
  assert.equal(await createFarmclawQueueStatus({env,fetcher:async()=>{throw new Error("private detail");}})(record),null);
  assert.deepEqual(await createFarmclawQueueStatus({env,fetcher:async()=>Response.json({...receipt,queued:false,removed:true,queue:null})})(record),
    {confirmed:false,removed:true,queueItemId:"42"});
});
