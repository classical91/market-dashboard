"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { PhoneBriefingStore } = require("../src/services/phone-briefings");
const { FarmbotTop10Service, fitPost } = require("../src/services/farmbot-top10");
const { FarmbotTop10Store } = require("../src/services/farmbot-top10-store");
const { ReporterNewsLogStore } = require("../src/services/reporter-news-log");
const { Top10XDraftStore } = require("../src/services/top10-x-drafts");
const { readArticle, verifyArticle, isBlockedAddress, checkUrl } = require("../src/services/article-verifier");

const PREPARER = "p".repeat(40);
const ENV = {
  FARMBOT_NEWS_API_URL: "https://api.farmbot.test",
  FARMBOT_NEWS_PREPARER_TOKEN: PREPARER,
  FARMBOT_NEWS_APPROVAL_BASE_URL: "https://farm-bot.test",
};
const DESTINATIONS = { accountHandle: "@fixture", telegramTargets: [{ chatId: "-100123", threadId: 5 }] };

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function numbered(prefix, count) {
  return Array.from({ length: count }, (_, i) => `**#${i + 1} ${prefix} story ${i + 1}**\n- detail ${i + 1}`).join("\n\n");
}

// ── Article reading ─────────────────────────────────────────────────────

test("an article page yields its canonical URL, headline, date, image and body", () => {
  const html = `<html><head>
    <title>Ignored title</title>
    <meta property="og:title" content="Fed holds rates &amp; signals patience">
    <meta property="og:site_name" content="Reuters">
    <meta property="article:published_time" content="2026-11-14T15:00:00Z">
    <meta property="og:image" content="/img/fed.jpg">
    <link rel="canonical" href="https://www.reuters.com/markets/fed-holds">
    </head><body><script>var x = "<p>not body</p>";</script>
    <p>The Federal Reserve kept its benchmark rate unchanged on Friday, as officials signalled patience.</p>
    <p>short</p></body></html>`;
  const info = readArticle(html, "https://reuters.com/markets/fed-holds?utm_source=x");
  assert.equal(info.title, "Fed holds rates & signals patience");
  assert.equal(info.siteName, "Reuters");
  assert.equal(info.publishedAt, "2026-11-14T15:00:00.000Z");
  assert.equal(info.imageUrl, "https://reuters.com/img/fed.jpg");
  assert.equal(info.canonicalUrl, "https://www.reuters.com/markets/fed-holds");
  assert.match(info.excerpt, /^The Federal Reserve kept/);
  assert.doesNotMatch(info.excerpt, /not body/);
});

test("JSON-LD dates and images are read when meta tags are missing; a cross-site canonical is ignored", () => {
  const html = `<link rel="canonical" href="https://elsewhere.example/x">
    <script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","headline":"ETF inflows hit a record","datePublished":"2026-11-14T10:00:00-05:00","image":[{"url":"https://cdn.example/etf.png"}]}]}</script>
    <p>${"Spot bitcoin ETFs drew record inflows on Thursday. ".repeat(3)}</p>`;
  const info = readArticle(html, "https://news.example/etf");
  assert.equal(info.title, "ETF inflows hit a record");
  assert.equal(info.publishedAt, "2026-11-14T15:00:00.000Z");
  assert.equal(info.imageUrl, "https://cdn.example/etf.png");
  assert.equal(info.canonicalUrl, "https://news.example/etf");
});

test("verification refuses undated, stale, imageless and bot-walled articles", async () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const page = (meta, body = "<p>" + "Readable article body text. ".repeat(12) + "</p>") => async () => ({
    finalUrl: "https://news.example/a", html: `<meta property="og:title" content="Headline">${meta}${body}`,
  });
  const ok = '<meta property="article:published_time" content="2026-11-15T08:00:00Z"><meta property="og:image" content="https://img.example/a.jpg">';
  assert.equal((await verifyArticle("https://news.example/a", { fetchHtml: page(ok), now })).title, "Headline");
  await assert.rejects(verifyArticle("x", { fetchHtml: page('<meta property="og:image" content="https://img.example/a.jpg">'), now }), /no publish date/);
  await assert.rejects(verifyArticle("x", { fetchHtml: page(ok.replace("2026-11-15T08", "2026-11-12T08")), now }), /older than 48 hours/);
  await assert.rejects(verifyArticle("x", { fetchHtml: page('<meta property="article:published_time" content="2026-11-15T08:00:00Z">'), now }), /no preview image/);
  await assert.rejects(verifyArticle("x", { fetchHtml: page(ok, "<p>Please complete the CAPTCHA to continue reading this page now.</p>"), now }), /login, paywall or bot check/);
});

test("only public https addresses are fetched", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "151.101.1.69", "2606:4700::6810:85e5"]) assert.equal(isBlockedAddress(ip), false, ip);
  assert.throws(() => checkUrl("http://news.example/a"), /https/);
  assert.throws(() => checkUrl("https://user:pw@news.example/a"), /credentials/);
  assert.throws(() => checkUrl("https://news.example:8443/a"), /ports/);
  assert.throws(() => checkUrl("https://127.0.0.1/a"), /IP/);
  assert.equal(checkUrl("https://news.example/a").hostname, "news.example");
});

test("post copy is cut to 270 characters at a word and loses links", () => {
  assert.equal(fitPost("Fed holds https://x.com/a rates"), "Fed holds rates");
  const long = fitPost("word ".repeat(100));
  assert.ok(long.length <= 270);
  assert.ok(long.endsWith("…"));
});

// ── The send flow ───────────────────────────────────────────────────────

function setup({ farmbotReply, existing = {}, verify, xDrafts = null } = {}) {
  const dir = tmp("md-farmbot-top10-");
  const briefingStore = new PhoneBriefingStore({ dataDir: dir, logger: { error() {} } });
  const now = new Date();
  briefingStore.receive("economics", { text: numbered("Econ", 10) }, now);
  briefingStore.receive("stocks", { text: numbered("Stock", 10) }, now);
  briefingStore.receive("crypto", { text: numbered("Crypto", 10) }, now);

  const calls = { rank: 0, vision: 0, posts: [], lookups: [] };
  const openai = {
    responses: {
      create: async (req) => {
        if (Array.isArray(req.input)) {
          calls.vision += 1;
          return { output_text: "A trader looks at screens on an exchange floor.\nMATCH: yes" };
        }
        calls.rank += 1;
        assert.ok(req.tools.some((t) => t.type === "web_search"), "ranking searches the web");
        assert.match(req.input, /\[E1\] \(Economics\) Econ story 1/);
        const refs = ["E1", "S1", "C1", "E2", "S2", "C2", "E3", "S3", "C3", "E4", "S4", "C4", "E1"];
        return { output_text: JSON.stringify({ stories: refs.map((ref, i) => ({
          ref, headline: `Pick ${i + 1}`, publisher: "Example", url: `https://news.example/${i === 12 ? 0 : i}`,
          claimKind: "confirmed", scores: { recency: 5, impact: 4, relevance: 4, reliability: 4, novelty: 9 },
          post: `Post ${i + 1} via Example https://news.example/${i}`,
        })) }) };
      },
    },
  };
  const defaultVerify = async (url) => {
    if (url.endsWith("/3")) { const err = new Error("Article is behind a login, paywall or bot check"); err.verification = true; throw err; }
    return { canonicalUrl: url, title: `Article ${url.split("/").pop()}`, publishedAt: new Date(Date.now() - 3600000).toISOString(),
      imageUrl: `https://img.example/${url.split("/").pop()}.jpg`, siteName: "Example", description: "", excerpt: "Body text.", ageMs: 3600000 };
  };
  const fetcher = async (url, opts) => {
    assert.equal(opts.headers.Authorization, `Bearer ${PREPARER}`);
    assert.equal(opts.redirect, "error");
    const u = new URL(url);
    const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (u.pathname === "/news/v1/batches/capabilities") return reply(200, { persisted: true, destinations: DESTINATIONS, supportedWorkflows: ["top5", "top10"] });
    if (u.pathname === "/news/v1/batches/lookup") {
      const id = u.searchParams.get("clientBatchId");
      calls.lookups.push(id);
      return existing[id] ? reply(200, existing[id]) : reply(404, { error: "Batch not found" });
    }
    if (xDrafts && u.pathname.startsWith("/news/v1/batches/fnb_") && opts.method === "GET") {
      const payload = calls.posts[calls.posts.length - 1];
      return reply(200, { batchId: "fnb_00000000-0000-4000-8000-000000000001", clientBatchId: payload.batchId, revision: 1,
        payloadHash: `sha256:${"a".repeat(64)}`, status: "validated", payload });
    }
    if (xDrafts && u.pathname === "/news/v1/x-drafts" && opts.method === "POST") return xDrafts(JSON.parse(opts.body), reply);
    if (u.pathname === "/news/v1/batches" && opts.method === "POST") {
      const { payload } = JSON.parse(opts.body);
      calls.posts.push(payload);
      if (farmbotReply) return farmbotReply(payload, reply, calls.posts.length);
      return reply(201, { batchId: "fnb_00000000-0000-4000-8000-000000000001", clientBatchId: payload.batchId, revision: 1,
        payloadHash: `sha256:${"a".repeat(64)}`, status: "validated", approvalEligible: true, payload });
    }
    throw new Error(`unexpected ${opts.method} ${url}`);
  };
  const newsLogStore = new ReporterNewsLogStore({ dataDir: dir });
  const service = new FarmbotTop10Service({
    briefingStore, reporterService: null, slipStore: new FarmbotTop10Store({ dataDir: dir, logger: { error() {} } }),
    newsLogStore, openai, env: ENV, fetcher, verify: verify || defaultVerify, logger: { warn() {} },
    xDraftStore: xDrafts ? new Top10XDraftStore({ dataDir: dir, logger: { error() {} } }) : null,
  });
  return { service, calls, newsLogStore };
}

test("the displayed ten are logged first; nine passing stories form the FarmBot batch", async () => {
  const { service, calls, newsLogStore } = setup();
  const slip = await service.send({ timeZone: "America/Vancouver" });

  assert.equal(slip.outcome, "sent");
  assert.equal(calls.rank, 1);
  assert.equal(calls.posts.length, 1);
  const payload = calls.posts[0];
  assert.match(payload.batchId, /^dashboard-top10-\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.timezone, "America/Vancouver");
  assert.deepEqual(payload.destinations, DESTINATIONS, "destinations come from FarmBot, never invented");
  assert.equal(payload.items.length, 9);
  assert.deepEqual(payload.items.map((i) => i.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Only the displayed ten are considered; the paywalled E2 is retained in
  // the log and never replaced by an unseen eleventh story.
  assert.deepEqual(payload.items.map((i) => i.canonicalUrl.split("/").pop()), ["0", "1", "2", "4", "5", "6", "7", "8", "9"]);
  assert.ok(payload.items.every((i) => i.imageUrl && /Vision check/.test(i.imageSubjectEvidence)));
  assert.ok(payload.items.every((i) => !/https?:/.test(i.text) && i.text.length <= 270));
  assert.deepEqual(payload.candidates.map((c) => c.category).slice(0, 3), ["economics", "stocks", "crypto"]);
  assert.ok(payload.candidates.every((c) => c.verificationMethod === "article-body" && c.score.every((n) => n >= 0 && n <= 5)));
  assert.match(payload.shortfall, /4 Economics, 3 Stocks, 3 Crypto/);

  assert.equal(slip.approvalUrl, "https://farm-bot.test/news-batches/fnb_00000000-0000-4000-8000-000000000001");
  assert.equal(slip.stories.length, 9);
  assert.ok(slip.skipped.some((s) => /paywall/.test(s.reason)));
  assert.equal(service.status(slip.date).slip.id, slip.id, "the receipt is kept for the day");

  // The "news reporter room" slip: each story is in the Reporter News Log as
  // verified, which records it without approving or queueing it.
  for (const item of payload.items) {
    const record = newsLogStore.find({ url: item.canonicalUrl });
    assert.ok(record, `${item.canonicalUrl} is in the news log`);
    assert.equal(record.status, "verified");
    assert.equal(record.capturedBy, "today-top-10");
    assert.match(record.summary, /sent to FarmBot for approval in batch dashboard-top10-/);
  }
});

test("a Top 10 already waiting for approval is not prepared again", async () => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const existing = { [`dashboard-top10-${day}`]: { batchId: "fnb_00000000-0000-4000-8000-000000000009", clientBatchId: `dashboard-top10-${day}`,
    status: "validated", payloadHash: `sha256:${"b".repeat(64)}`, payload: { items: [{ number: 1, canonicalUrl: "https://news.example/x", text: "t" }] } } };
  const { service, calls } = setup({ existing });
  const slip = await service.send({});
  assert.equal(slip.outcome, "already-sent");
  assert.equal(calls.rank, 0, "no credits spent");
  assert.equal(calls.posts.length, 0);
  assert.match(slip.approvalUrl, /fnb_00000000-0000-4000-8000-000000000009$/);
});

test("a rejected batch gets a fresh run ID, and a story taken by another batch is dropped", async () => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const existing = { [`dashboard-top10-${day}`]: { batchId: "fnb_x", clientBatchId: `dashboard-top10-${day}`, status: "rejected" } };
  const farmbotReply = (payload, reply, attempt) => attempt === 1
    ? reply(409, { error: `Story 2 is already selected in active batch farmclaw-top5-${day}; remove it or reject that batch first` })
    : reply(201, { batchId: "fnb_00000000-0000-4000-8000-000000000002", clientBatchId: payload.batchId, revision: 1, payloadHash: `sha256:${"c".repeat(64)}`, status: "validated", payload });
  const { service, calls } = setup({ existing, farmbotReply });
  const slip = await service.send({});
  assert.equal(slip.outcome, "sent");
  assert.equal(calls.posts[0].batchId, `dashboard-top10-${day}-r2`);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.posts[1].items.length, 8);
  assert.ok(!calls.posts[1].items.some((i) => i.canonicalUrl.endsWith("/1")));
  assert.ok(slip.skipped.some((s) => s.reason === "Already in another FarmBot batch"));
});

test("FarmBot refusing the batch is recorded as a failed receipt, never as sent", async () => {
  const { service } = setup({ farmbotReply: (p, reply) => reply(422, { error: "Preview schema or evidence validation failed" }) });
  const slip = await service.send({});
  assert.equal(slip.outcome, "failed");
  assert.match(slip.error, /HTTP 422.*validation failed/);
  assert.equal(slip.approvalUrl, undefined);
});

test("missing settings stop the send before anything is spent", async () => {
  const dir = tmp("md-farmbot-top10-cfg-");
  const service = new FarmbotTop10Service({
    briefingStore: new PhoneBriefingStore({ dataDir: dir, logger: { error() {} } }),
    slipStore: new FarmbotTop10Store({ dataDir: dir }), openai: null, env: { FARMBOT_NEWS_PREPARER_TOKEN: "short" },
  });
  assert.deepEqual(service.missingConfig(), ["OPENAI_API_KEY", "FARMBOT_NEWS_API_URL", "FARMBOT_NEWS_PREPARER_TOKEN", "FARMBOT_NEWS_APPROVAL_BASE_URL"]);
  await assert.rejects(service.send({}), (err) => err.statusCode === 503 && /needs: OPENAI_API_KEY/.test(err.message));
});

test("all ten are logged without contacting FarmBot, ranking, or checking images; repeat intake is idempotent", () => {
  const { service, calls, newsLogStore } = setup();
  const result = service.logCandidates({});
  assert.equal(result.records.length, 10);
  assert.ok(result.records.every((r) => r.status === "discovered" && r.approval === "pending" && r.farmbot.status === "needs-verification" && !r.farmbot.queueId));
  const again = service.logCandidates({});
  assert.deepEqual(again.records.map((r) => r.id), result.records.map((r) => r.id));
  assert.equal(newsLogStore.daily({ date: result.records[0].reporterDate }).total, 10);
  assert.equal(calls.rank, 0);
  assert.equal(calls.vision, 0);
  assert.equal(calls.posts.length, 0);
});

test("two passing articles still leave all ten visible, with the other eight blocked and exact errors", async () => {
  const { service, calls, newsLogStore } = setup({ verify: async (url) => {
    if (!url.endsWith("/0") && !url.endsWith("/1")) {
      const err = new Error("Article has no preview image"); err.verification = true; throw err;
    }
    return { canonicalUrl: url, title: "News", publishedAt: new Date().toISOString(), imageUrl: "https://img.example/pic.jpg", ageMs: 0, excerpt: "Article" };
  } });
  const slip = await service.send({});
  assert.equal(slip.stories.length, 2);
  const records = newsLogStore.daily({ date: newsLogStore.get(service.logCandidates({}).records[0].id).reporterDate }).records;
  assert.equal(records.length, 10);
  assert.equal(records.filter((r) => r.farmbot.status === "awaiting-approval").length, 2);
  const blocked = records.filter((r) => r.farmbot.status === "blocked");
  assert.equal(blocked.length, 8);
  assert.ok(blocked.every((r) => r.status === "discovered" && r.error === "Article has no preview image"));
  assert.ok(records.every((r) => r.approval === "pending" && !r.farmbot.queueId));
  assert.equal(calls.posts.length, 1);
});

test("image check failures stay in the news log even if nothing can be sent", async () => {
  const { service, newsLogStore, calls } = setup();
  const create = service._openai.responses.create;
  service._openai.responses.create = async (req) => {
    if (Array.isArray(req.input)) throw new Error("image download failed");
    return create(req);
  };
  const slip = await service.send({});
  assert.equal(slip.outcome, "failed");
  const records = service.logCandidates({}).records;
  assert.equal(records.length, 10);
  assert.ok(records.every((r) => r.farmbot.status === "blocked"));
  assert.ok(records.some((r) => r.error === "Image could not be checked (image download failed)"));
  assert.equal(calls.posts.length, 0);
  assert.ok(newsLogStore.get(records[0].id));
});

test("missing FarmBot configuration still records the ten without approving or queueing them", async () => {
  const { service, calls } = setup();
  service._env = {};
  await assert.rejects(service.send({}), /Sending to FarmBot needs/);
  const records = service.logCandidates({}).records;
  assert.equal(records.length, 10);
  assert.ok(records.every((r) => r.farmbot.status === "blocked" && /needs/.test(r.error) && r.approval === "pending"));
  assert.equal(calls.rank, 0);
  assert.equal(calls.posts.length, 0);
});

test("repeated preparation preserves human approval and the reviewed content", async () => {
  const { service, newsLogStore } = setup();
  await service.send({});
  const record = service.logCandidates({}).records.find((r) => r.status === "verified");
  const { contentHash } = require("../src/services/reporter-news-log");
  const approved = newsLogStore.decide(record.id, { decision: "approved", contentHash: contentHash(record) }).record;
  await service.send({});
  const after = newsLogStore.get(record.id);
  assert.equal(after.status, "approved");
  assert.equal(contentHash(after), contentHash(approved));
  assert.equal(after.approvalReceipt.contentHash, approved.approvalReceipt.contentHash);
  assert.equal(after.farmbot.queueId, null);
});

test("a temporary post-send log failure preserves the FarmBot receipt and is reconciled on retry", async () => {
  const { service, newsLogStore } = setup();
  const update = newsLogStore.update.bind(newsLogStore);
  newsLogStore.update = (id, patch, actor) => {
    if (patch.farmbot?.status === "awaiting-approval") throw new Error("temporary log write failure");
    return update(id, patch, actor);
  };
  const slip = await service.send({});
  assert.equal(slip.outcome, "sent");
  assert.ok(slip.batchId);
  newsLogStore.update = update;
  // Simulate the lookup finding the accepted batch on the next request.
  service._resolveBatchId = async () => ({ existing: {
    batchId: slip.batchId, clientBatchId: slip.clientBatchId, status: "validated",
    payload: { items: slip.stories.map((story) => ({ canonicalUrl: story.url, text: story.post })) },
  } });
  const retry = await service.send({});
  assert.equal(retry.outcome, "already-sent");
  const records = service.logCandidates({}).records;
  assert.equal(records.filter((r) => r.farmbot.status === "awaiting-approval").length, 9);
});

test("a duplicate article failure stays on its candidate and cannot overwrite another story's readiness", async () => {
  const { service } = setup();
  const create = service._openai.responses.create;
  service._openai.responses.create = async (req) => {
    const reply = await create(req);
    if (!Array.isArray(req.input)) {
      const parsed = JSON.parse(reply.output_text);
      parsed.stories[1].url = parsed.stories[0].url;
      return { output_text: JSON.stringify(parsed) };
    }
    return reply;
  };
  await service.send({});
  const result = service.logCandidates({});
  assert.equal(result.records.length, 10);
  const first = result.records.find((r) => r.headline === "Econ story 1");
  const second = result.records.find((r) => r.headline === "Stock story 1");
  assert.notEqual(first.id, second.id);
  assert.equal(first.farmbot.status, "awaiting-approval");
  assert.equal(second.farmbot.status, "blocked");
  assert.equal(second.error, "Same article as a higher-ranked story");
});

test("after the batch is saved, FarmBot writes X drafts for review; a drafting failure never fails the send", async () => {
  const requests = [];
  const verify = async (url) => ({ canonicalUrl: url, title: `Article ${url.split("/").pop()}`, publishedAt: new Date(Date.now() - 3600000).toISOString(),
    imageUrl: `https://img.example/${url.split("/").pop()}.jpg`, siteName: "Example", description: "Lead.", excerpt: "Body text.",
    bodyText: "Long article body. ".repeat(20), ageMs: 3600000 });
  const { service } = setup({
    verify,
    xDrafts: (body, reply) => {
      requests.push(body);
      return reply(200, { provider: "xai", model: "grok-4", drafts: body.items.map((item) => ({ itemId: item.itemId, ok: true, text: `Draft ${item.itemId}`, length: 10, attempts: 1 })) });
    },
  });
  const slip = await service.send({});
  assert.equal(slip.outcome, "sent");
  assert.deepEqual(slip.xDrafts, { status: "review", drafted: 10, total: 10 });
  assert.equal(requests[0].items.length, 10);
  assert.match(requests[0].items[0].evidence, /^Lead\.\n\nLong article body/);
  const set = service.xDrafts.current(slip.date);
  assert.equal(set.items[0].draft, "Draft story-1");

  const failing = setup({ verify, xDrafts: (_body, reply) => reply(503, { error: "FarmBot Settings has no API key" }) });
  const failed = await failing.service.send({});
  assert.equal(failed.outcome, "sent");
  assert.equal(failed.xDrafts.status, "failed");
  assert.match(failed.xDrafts.error, /no API key/);
});
