"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { Top10XDraftStore, Top10XDrafts, cleanPost } = require("../src/services/top10-x-drafts");
const { FarmbotTop10Store } = require("../src/services/farmbot-top10-store");

const DATE = "2026-11-18";
const BATCH = "fnb_00000000-0000-4000-8000-000000000001";
const HASH = `sha256:${"a".repeat(64)}`;

function batchPayload() {
  return {
    schemaVersion: 1, batchId: `dashboard-top10-${DATE}`,
    candidates: [1, 2].map((n) => ({ canonicalUrl: `https://news.example/${n}`, category: n === 1 ? "economics" : "crypto",
      publisher: "Example", headline: `Headline ${n}`, publishedAt: new Date().toISOString() })),
    items: [1, 2].map((n) => ({ itemId: `story-${n}`, number: n, canonicalUrl: `https://news.example/${n}`, text: `Old post ${n}` })),
  };
}

function setup({ batch = {}, draftsReply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-drafts-"));
  const slips = new FarmbotTop10Store({ dataDir: dir, logger: { error() {} } });
  slips.record({ date: DATE, outcome: "sent", batchId: BATCH, clientBatchId: `dashboard-top10-${DATE}`, revision: 1, payloadHash: HASH,
    stories: [1, 2].map((n) => ({ number: n, url: `https://news.example/${n}`, post: `Old post ${n}` })) });
  const state = { revision: 1, payloadHash: HASH, status: "validated", payload: batchPayload(), ...batch };
  const calls = { drafts: [], posts: [], verified: [] };
  const top10 = {
    _slips: slips,
    missingConfig: () => ["OPENAI_API_KEY"],
    _approvalUrl: (id) => `https://farm-bot.test/news-batches/${id}`,
    _verify: async (url) => {
      calls.verified.push(url);
      return { canonicalUrl: url, title: "T", description: "Desc.", bodyText: "Article body. ".repeat(30) };
    },
    _farmbot: async (method, pathname, body) => {
      const reply = (status, data) => ({ status, ok: status < 300, data });
      if (method === "GET" && pathname === `/news/v1/batches/${BATCH}`) return reply(200, { batchId: BATCH, clientBatchId: `dashboard-top10-${DATE}`, ...state });
      if (method === "POST" && pathname === "/news/v1/x-drafts") {
        calls.drafts.push(body);
        return draftsReply ? draftsReply(body, reply) : reply(200, { provider: "xai", model: "grok-4", style: "Viral Hook", drafts: [
          { itemId: "story-1", ok: true, text: "Grok post 1 #Fed", length: 16, attempts: 1 },
          { itemId: "story-2", ok: false, error: "Every draft broke a source rule", attempts: 2 },
        ] });
      }
      if (method === "POST" && pathname === "/news/v1/batches") {
        calls.posts.push(body);
        return reply(201, { batchId: BATCH, revision: 2, payloadHash: `sha256:${"b".repeat(64)}`, status: "validated", approvalEligible: true });
      }
      throw new Error(`unexpected ${method} ${pathname}`);
    },
  };
  const drafts = new Top10XDrafts({ store: new Top10XDraftStore({ dataDir: dir, logger: { error() {} } }), top10 });
  return { drafts, calls, slips, state };
}

test("FarmBot writes the drafts from article text; stories without a draft say why", async () => {
  const { drafts, calls } = setup();
  const set = await drafts.write({ date: DATE, articles: [{ canonicalUrl: "https://news.example/1", description: "Lead.", bodyText: "Fed body. ".repeat(30) }] });
  assert.deepEqual(calls.verified, ["https://news.example/2"], "only the article not passed in is re-read");
  const sent = calls.drafts[0].items;
  assert.equal(sent.length, 2);
  assert.match(sent[0].evidence, /^Lead\.\n\nFed body\./);
  assert.equal(sent[0].headline, "Headline 1");
  assert.ok(!JSON.stringify(sent).includes("Old post"), "the old post copy is never sent as evidence");
  assert.equal(set.status, "review");
  assert.equal(set.provider, "xai");
  assert.deepEqual(set.items.map((i) => [i.state, i.draft, i.original]), [["pending", "Grok post 1 #Fed", "Old post 1"], ["failed", null, "Old post 2"]]);
  assert.match(set.items[1].error, /source rule/);
});

test("approved and edited drafts replace only their stories in a new FarmBot revision", async () => {
  const { drafts, calls, slips } = setup();
  await drafts.write({ date: DATE });
  assert.throws(() => drafts.review({ date: DATE, itemId: "story-2", decision: "rejected" }), /no draft/);
  assert.throws(() => drafts.review({ date: DATE, itemId: "story-1", decision: "approved", text: "x".repeat(281) }), /281 characters/);
  assert.throws(() => drafts.review({ date: DATE, itemId: "story-1", decision: "approved", text: "See https://x.com" }), /links/);
  await assert.rejects(drafts.apply({ date: DATE }), /Approve at least one/);
  const reviewed = drafts.review({ date: DATE, itemId: "story-1", decision: "approved", text: "My edited post #Fed" });
  assert.equal(reviewed.items[0].edited, true);

  const { drafts: applied, slip } = await drafts.apply({ date: DATE });
  const sent = calls.posts[0];
  assert.deepEqual(sent.supersedes, { batchId: BATCH, revision: 1 });
  assert.deepEqual(sent.payload.items.map((i) => i.text), ["My edited post #Fed", "Old post 2"]);
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedRevision, 2);
  assert.equal(applied.items[0].state, "applied");
  assert.equal(slip.revision, 2);
  assert.equal(slips.latest(DATE).id, slip.id);
  assert.deepEqual(slip.stories.map((s) => s.post), ["My edited post #Fed", "Old post 2"]);
  assert.throws(() => drafts.review({ date: DATE, itemId: "story-1", decision: "pending" }), /already in FarmBot/);
});

test("a batch changed or queued in FarmBot is never overwritten", async () => {
  const changed = setup();
  await changed.drafts.write({ date: DATE });
  changed.drafts.review({ date: DATE, itemId: "story-1", decision: "approved" });
  changed.state.revision = 3;
  await assert.rejects(changed.drafts.apply({ date: DATE }), (err) => err.statusCode === 409 && /changed in FarmBot/.test(err.message));
  assert.equal(changed.calls.posts.length, 0);

  const queued = setup({ batch: { status: "queued" } });
  await assert.rejects(queued.drafts.write({ date: DATE }), (err) => err.statusCode === 409 && /already approved and queued/.test(err.message));
  assert.equal(queued.calls.drafts.length, 0);
});

test("an old FarmBot without the endpoint is reported plainly", async () => {
  const { drafts } = setup({ draftsReply: (_body, reply) => reply(404, { error: "Not Found" }) });
  await assert.rejects(drafts.write({ date: DATE }), /deploy the FarmBot X drafts update/);
});

test("drafts need a saved FarmBot batch first", async () => {
  const { drafts } = setup();
  await assert.rejects(drafts.write({ date: "2026-11-17" }), (err) => err.statusCode === 409 && /Send today's Top 10/.test(err.message));
  assert.equal(cleanPost("  Fine post  "), "Fine post");
});
