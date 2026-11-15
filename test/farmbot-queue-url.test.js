"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { farmbotQueueUrl, DEFAULT_FARMBOT_QUEUE_URL } = require("../src/services/farmclaw-queue-status");

test("FarmBot Queue link follows the configured FarmBot web origin", () => {
  assert.equal(farmbotQueueUrl({ FARMBOT_NEWS_APPROVAL_BASE_URL: "https://farm.example/news-batches/x" }), "https://farm.example/queue");
});

test("FarmBot Queue link falls back to the default for missing, http or credentialed origins", () => {
  for (const value of [undefined, "", "http://farm.example", "https://u:p@farm.example", "not a url"]) {
    assert.equal(farmbotQueueUrl({ FARMBOT_NEWS_APPROVAL_BASE_URL: value }), DEFAULT_FARMBOT_QUEUE_URL);
  }
});
