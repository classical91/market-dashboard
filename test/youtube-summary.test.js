"use strict";

// Gemini video summaries: the service's request/caching/error contract with a
// fake fetch, and the /api/youtube/summary routes on the real app. No real
// Gemini or YouTube calls are made.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "md-yt-summary-"));
process.env.DATA_DIR = tmp;
process.env.GEMINI_API_KEY = "gemini-test-key";
process.env.ADMIN_API_KEY = "admin-test-key";
delete process.env.YOUTUBE_API_KEY;
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { YoutubeSummaryService } = require("../src/services/youtube-summary");
const { PersistentReporterCache } = require("../src/services/persistent-cache");

const VIDEO = "clip1234567";
const GEMINI_HOST = "https://generativelanguage.googleapis.com/";

function geminiOk(text, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: "gemini-test", ...extra }),
  };
}

function geminiError(status, error) {
  return { ok: false, status, json: async () => ({ error }) };
}

let cacheCount = 0;
function makeService(fetchImpl, overrides = {}) {
  cacheCount += 1;
  return new YoutubeSummaryService({
    apiKey: "k",
    model: "gemini-flash-latest",
    cache: new PersistentReporterCache(path.join(tmp, `svc-${cacheCount}.json`)),
    fetchImpl,
    ...overrides,
  });
}

test("sends the YouTube URL as video input with the key in a header", async () => {
  const calls = [];
  const service = makeService(async (url, opts) => {
    calls.push({ url, opts });
    return geminiOk("TL;DR: a summary");
  });
  const result = await service.summarize(VIDEO);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GEMINI_HOST}v1beta/models/gemini-flash-latest:generateContent`);
  assert.equal(calls[0].opts.headers["x-goog-api-key"], "k");
  assert.doesNotMatch(calls[0].url, /key=/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.contents[0].parts[0].fileData.fileUri, `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.match(body.contents[0].parts[1].text, /Market calls/);
  assert.equal(result.summary, "TL;DR: a summary");
  assert.equal(result.model, "gemini-test");
  assert.equal(result.cached, false);
});

test("caches per video and shares concurrent requests", async () => {
  let count = 0;
  const service = makeService(async () => {
    count += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return geminiOk("summary " + count);
  });
  const [a, b] = await Promise.all([service.summarize(VIDEO), service.summarize(VIDEO)]);
  assert.equal(count, 1);
  assert.equal(a.summary, b.summary);
  const again = await service.summarize(VIDEO);
  assert.equal(again.cached, true);
  assert.equal(service.getCached(VIDEO).summary, "summary 1");
  const fresh = await service.summarize(VIDEO, { refresh: true });
  assert.equal(count, 2);
  assert.equal(fresh.summary, "summary 2");
});

test("ignores thought parts and flags truncation", async () => {
  const service = makeService(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer" }] }, finishReason: "MAX_TOKENS" }] }),
  }));
  const result = await service.summarize(VIDEO);
  assert.equal(result.summary, "answer");
  assert.equal(result.truncated, true);
});

test("rejects bad IDs and a missing key without calling Gemini", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return geminiOk("x"); };
  await assert.rejects(makeService(fetchImpl).summarize("../etc/passwd"), { statusCode: 400 });
  await assert.rejects(makeService(fetchImpl, { apiKey: "" }).summarize(VIDEO), { statusCode: 503, code: "not-configured" });
  assert.equal(called, false);
});

test("maps Gemini failures to readable errors and does not cache them", async () => {
  const cases = [
    [geminiError(429, { status: "RESOURCE_EXHAUSTED", message: "quota" }), 429, "rate-limited"],
    [geminiError(400, { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." }), 502, "bad-key"],
    [geminiError(404, { status: "NOT_FOUND", message: "models/x is not found" }), 502, "bad-model"],
    [geminiError(400, { status: "INVALID_ARGUMENT", message: "Cannot fetch content from the provided URL." }), 422, "video-unavailable"],
    [geminiError(500, { status: "INTERNAL", message: "boom" }), 502, "upstream-error"],
    [{ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) }, 502, "empty-summary"],
  ];
  for (const [response, statusCode, code] of cases) {
    let count = 0;
    const service = makeService(async () => { count += 1; return response; });
    await assert.rejects(service.summarize(VIDEO), (err) => {
      assert.equal(err.statusCode, statusCode, code);
      assert.equal(err.code, code);
      assert.equal(err.expose, true);
      assert.doesNotMatch(err.message, /boom|quota$/);
      return true;
    });
    assert.equal(service.getCached(VIDEO), null);
    await assert.rejects(service.summarize(VIDEO));
    assert.equal(count, 2, "a failure is retried, not cached");
  }
});

test("times out a slow request", async () => {
  const service = makeService((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }), { timeoutMs: 20 });
  await assert.rejects(service.summarize(VIDEO), { statusCode: 504, code: "timeout" });
});

test("summary routes: GET reads the cache, POST is admin-gated and generates", async (t) => {
  const { createApp } = require("../src/app");
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  let geminiCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(GEMINI_HOST)) {
      geminiCalls += 1;
      return geminiOk("## Key points\n- [01:05] Point");
    }
    if (String(url).startsWith(base)) return originalFetch(url, opts);
    throw new Error("unexpected network call: " + url);
  };
  t.after(() => {
    global.fetch = originalFetch;
    return new Promise((resolve) => server.close(resolve));
  });

  let res = await originalFetch(`${base}/api/youtube/summary/${VIDEO}`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.summary, null);
  assert.equal(JSON.stringify(body).includes("gemini-test-key"), false);

  res = await originalFetch(`${base}/api/youtube/summary/${VIDEO}`, { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls, 0);

  const post = (payload) => originalFetch(`${base}/api/youtube/summary/${VIDEO}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": "admin-test-key" },
    body: JSON.stringify(payload || {}),
  });
  res = await post();
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.summary.summary, "## Key points\n- [01:05] Point");
  assert.equal(geminiCalls, 1);

  res = await originalFetch(`${base}/api/youtube/summary/${VIDEO}`);
  body = await res.json();
  assert.equal(body.summary.cached, true);

  res = await post({ refresh: true });
  assert.equal(res.status, 200);
  assert.equal(geminiCalls, 2);

  res = await originalFetch(`${base}/api/youtube/summary/not-an-id`);
  assert.equal(res.status, 400);
});
