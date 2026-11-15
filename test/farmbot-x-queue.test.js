"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFarmbotXQueue, buildPayload, xStatusId } = require("../src/services/farmbot-x-queue");

const env = { FARMBOT_NEWS_API_URL: "https://api.farm.example", FARMBOT_NEWS_PREPARER_TOKEN: "p".repeat(40), FARMBOT_NEWS_APPROVAL_BASE_URL: "https://farm.example" };
const now = Date.parse("2026-11-15T20:00:00Z");
const destinations = { accountHandle: "@farm", telegramTargets: [{ chatId: "-100" }] };
const input = { url: "https://x.com/unusual_whales/status/2122072397121560616", handle: "unusual_whales",
  sourceText: "The national debt is growing.\nMore text https://t.co/abc", publishedAt: "2026-11-15T19:59:00Z",
  text: "US debt held by the public now tops the whole economy, per the WSJ.", category: "economics" };

function farmbot(overrides = {}) {
  const calls = [];
  const queue = { id: "777", text: input.text, dispatchActive: true, dispatchStatus: "PENDING", dispatchNotBefore: "2026-11-15T20:30:00Z" };
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const path = new URL(url).pathname;
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (overrides[path]) return overrides[path](options);
    if (path === "/news/v1/batches/capabilities") return reply(200, { persisted: true, supportedWorkflows: ["x-link-queue"], xLinkQueueMode: "timed", destinations });
    if (path === "/farmclaw/v1/x-links" && options.method === "POST") return reply(201, { persisted: true, queueItemId: "777", duplicate: false });
    if (path === "/farmclaw/v1/x-links/2122072397121560616") return reply(200, { persisted: true, statusId: "2122072397121560616", queueItemId: "777", queued: true, removed: false, queue });
    return reply(404, { error: "nope" });
  };
  return { calls, service: createFarmbotXQueue({ env, fetcher, now: () => now }) };
}

test("xStatusId accepts X/Twitter status links only", () => {
  assert.equal(xStatusId("https://twitter.com/a/status/123/photo/1"), "123");
  assert.equal(xStatusId("https://evil.com/a/status/123"), null);
  assert.equal(xStatusId("http://x.com/a/status/123"), null);
});

test("enqueue sends a single-X-link payload with the preparer token and confirms by read-back", async () => {
  const { calls, service } = farmbot();
  const result = await service.enqueue(input);
  assert.equal(result.queueItemId, "777"); assert.equal(result.queued, true); assert.equal(result.duplicate, false);
  assert.equal(result.queueUrl, "https://farm.example/queue");
  const post = calls.find((c) => c.options.method === "POST");
  assert.equal(post.options.headers.Authorization, `Bearer ${env.FARMBOT_NEWS_PREPARER_TOKEN}`);
  const p = post.body.payload;
  assert.equal(p.batchId, "farmclaw-xlink-2122072397121560616");
  assert.equal(p.candidates[0].canonicalUrl, "https://x.com/i/status/2122072397121560616");
  assert.equal(p.candidates[0].verificationMethod, "x-post-body");
  assert.equal(p.candidates[0].category, "economics");
  assert.equal(p.items[0].itemId, "x-2122072397121560616");
  assert.equal(p.items[0].text, input.text); assert.equal(p.items[0].textOnly, true);
  assert.deepEqual(p.destinations, destinations);
  assert.equal(calls.at(-1).url.endsWith("/farmclaw/v1/x-links/2122072397121560616"), true);
});

test("a photo is sent with subject evidence instead of textOnly", async () => {
  const { calls, service } = farmbot();
  await service.enqueue({ ...input, image: "https://pbs.twimg.com/media/a.jpg" });
  const item = calls.find((c) => c.options.method === "POST").body.payload.items[0];
  assert.equal(item.imageUrl, "https://pbs.twimg.com/media/a.jpg"); assert.ok(item.imageSubjectEvidence); assert.equal(item.textOnly, undefined);
});

test("enqueue refuses bad input before calling FarmBot", async () => {
  const { calls, service } = farmbot();
  await assert.rejects(service.enqueue({ ...input, text: "x".repeat(281) }), /over 280/);
  await assert.rejects(service.enqueue({ ...input, text: "  " }), /Write the post text/);
  await assert.rejects(service.enqueue({ ...input, url: "https://example.com/post" }), /Only an X post link/);
  await assert.rejects(service.enqueue({ ...input, publishedAt: null }), /no publish time/);
  await assert.rejects(service.enqueue({ ...input, image: "http://insecure/a.jpg" }), /not an https link/);
  assert.equal(calls.length, 0);
});

test("missing configuration names the variables", async () => {
  const service = createFarmbotXQueue({ env: {}, fetcher: async () => { throw new Error("no"); } });
  await assert.rejects(service.enqueue(input), (err) => err.statusCode === 503 && /FARMBOT_NEWS_API_URL, FARMBOT_NEWS_PREPARER_TOKEN/.test(err.message));
});

test("FarmBot's refusal is passed through and a missing read-back is not success", async () => {
  const conflict = farmbot({ "/farmclaw/v1/x-links": () => ({ ok: false, status: 409, json: async () => ({ error: "Source already has a queue record" }) }) });
  await assert.rejects(conflict.service.enqueue(input), (err) => err.statusCode === 409 && /already has a queue record/.test(err.message));
  const noReadback = farmbot({ "/farmclaw/v1/x-links/2122072397121560616": () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(noReadback.service.enqueue(input), /did not confirm/);
});

test("a FarmBot without timed X-link queue support is refused", async () => {
  const old = farmbot({ "/news/v1/batches/capabilities": () => ({ ok: true, status: 200, json: async () => ({ persisted: true, supportedWorkflows: ["top5"], destinations }) }) });
  await assert.rejects(old.service.enqueue(input), /does not accept timed X-link/);
});

test("lookup returns null when FarmBot has nothing for the post", async () => {
  const { service } = farmbot();
  assert.equal(await service.lookup("https://x.com/a/status/999"), null);
  assert.equal((await service.lookup(input.url)).queueItemId, "777");
});

test("payload matches FarmBot's documented single-X-link shape", () => {
  const p = buildPayload({ statusId: "5", handle: "h", sourceText: "Line one\nline two", publishedAt: "2026-01-01T00:00:00.000Z",
    text: "t", category: "general", imageUrl: null, destinations, now });
  assert.deepEqual(Object.keys(p).sort(), ["batchId", "candidates", "createdAt", "destinations", "items", "schemaVersion", "timezone"]);
  assert.deepEqual(Object.keys(p.candidates[0]).sort(), ["canonicalUrl", "category", "claimKind", "evidence", "headline", "publishedAt", "publisher", "score", "verificationMethod", "verifiedAt"]);
  assert.equal(p.candidates[0].headline, "Line one"); assert.deepEqual(p.candidates[0].score, [0, 0, 0, 0, 0]);
});
