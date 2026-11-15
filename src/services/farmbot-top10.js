"use strict";

/**
 * FarmBot Top 10: merge the day's Economics, Stocks and Crypto desks into the
 * ten strongest stories and send them to FarmBot as one news batch for human
 * approval. Nothing here queues or posts: FarmBot creates held queue rows only
 * after Jason approves the exact batch on its News Preview page.
 *
 *   1. Gather   — the day's runs shown on Today's Top 10 (phone first).
 *   2. Rank     — one model call with web search ranks all stories, removes
 *                 duplicates, writes post copy and finds each source article.
 *   3. Verify   — each article is fetched and must be readable, dated within
 *                 48 hours and carry its own preview image; failures are
 *                 skipped and the next-ranked story takes their place.
 *   4. Images   — each image is described by a vision call; that description
 *                 is the recorded image evidence.
 *   5. Send     — POST /news/v1/batches with the preparer token, then the
 *                 server's read-back is the receipt.
 *   6. Slip     — the receipt is saved here and each story is logged in the
 *                 Reporter News Log as verified (logging is not approval).
 */

const crypto = require("crypto");
const { buildDailyTopNews } = require("./daily-top-news");
const { verifyArticle } = require("./article-verifier");

const TARGET_STORIES = 10;
const RANKED_STORIES = 16;
const MAX_POST_CHARS = 270;
const FARMBOT_TIME_ZONE = "America/Vancouver";
const CATEGORY_BY_DESK = { economics: "economics", stocks: "stocks", crypto: "crypto" };
const BATCH_ID_BASE = "dashboard-top10-";

function farmbotError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

function rankingPrompt({ date, stories }) {
  const list = stories.map((story) => `[${story.ref}] (${story.deskLabel}) ${story.title}${story.body ? `\n${story.body}` : ""}`).join("\n\n");
  return `Today is ${date}. Below are today's Economics, Stocks and Crypto news briefings. Each story has a reference like E3, S1 or C7.

Pick the ${RANKED_STORIES} most important stories overall for a markets audience, best first.
- Remove duplicates: the same event in two desks counts once.
- Prefer a useful mix of Economics, Stocks and Crypto, but never force a weak story in.
- For each pick, use web search to find the ORIGINAL article from a reputable publisher, or the official release, published in the last 48 hours and readable without a login or paywall. Give its exact URL. Never use Investing.com, aggregators, X/Twitter, YouTube or press-release wires when the original is available.
- "post": a standalone social post of at most 250 characters. Plain text, no links, no hashtags, at most one emoji. Factual; credit the publisher (e.g. "via Reuters"). No financial advice or buy/sell calls.
- "claimKind": confirmed, forecast, proposal or application.
- "scores": 0-5 integers for recency, impact, relevance, reliability and novelty.

Return only JSON matching the schema.

STORIES
${list}`;
}

const RANKING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stories"],
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "headline", "publisher", "url", "claimKind", "scores", "post"],
        properties: {
          ref: { type: "string" },
          headline: { type: "string" },
          publisher: { type: "string" },
          url: { type: "string" },
          claimKind: { type: "string", enum: ["confirmed", "forecast", "proposal", "application"] },
          scores: {
            type: "object",
            additionalProperties: false,
            required: ["recency", "impact", "relevance", "reliability", "novelty"],
            properties: Object.fromEntries(["recency", "impact", "relevance", "reliability", "novelty"]
              .map((key) => [key, { type: "integer", minimum: 0, maximum: 5 }])),
          },
          post: { type: "string" },
        },
      },
    },
  },
};

/** The JSON object in a model reply, tolerating a fenced or prefixed answer. */
function parseJsonReply(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function clampScore(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 0;
}

/** Shorten post copy to the limit at a word boundary. Links are FarmBot's to drop. */
function fitPost(text) {
  const clean = String(text || "").replace(/https?:\/\/\S+/gi, "").replace(/[ \t]+/g, " ").trim();
  if (clean.length <= MAX_POST_CHARS) return clean;
  const cut = clean.slice(0, MAX_POST_CHARS - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_POST_CHARS - 40)).trim()}…`;
}

function vancouverDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FARMBOT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

class FarmbotTop10Service {
  constructor({
    briefingStore,
    reporterService,
    slipStore,
    newsLogStore = null,
    openai = null,
    model,
    env = process.env,
    fetcher = fetch,
    verify = verifyArticle,
    logger = console,
  }) {
    this._briefings = briefingStore;
    this._reporter = reporterService;
    this._slips = slipStore;
    this._newsLog = newsLogStore;
    this._openai = openai;
    this._model = model || "gpt-5.4-mini";
    this._env = env;
    this._fetch = fetcher;
    this._verify = verify;
    this._logger = logger;
    this._running = false;
  }

  /** What is missing before a Top 10 can be sent; empty when ready. */
  missingConfig() {
    const missing = [];
    if (!this._openai) missing.push("OPENAI_API_KEY");
    if (!this._env.FARMBOT_NEWS_API_URL) missing.push("FARMBOT_NEWS_API_URL");
    const token = this._env.FARMBOT_NEWS_PREPARER_TOKEN || "";
    if (token.length < 32) missing.push("FARMBOT_NEWS_PREPARER_TOKEN");
    if (!this._env.FARMBOT_NEWS_APPROVAL_BASE_URL) missing.push("FARMBOT_NEWS_APPROVAL_BASE_URL");
    return missing;
  }

  status(date) {
    return { configured: this.missingConfig().length === 0, missing: this.missingConfig(), running: this._running, slip: this._slips.latest(date) };
  }

  _apiOrigin() {
    const api = new URL(this._env.FARMBOT_NEWS_API_URL);
    if (api.protocol !== "https:" || api.username || api.password) throw farmbotError("FARMBOT_NEWS_API_URL must be a plain https URL", 503);
    return api.origin;
  }

  _approvalUrl(batchId) {
    const web = new URL(this._env.FARMBOT_NEWS_APPROVAL_BASE_URL);
    return new URL(`/news-batches/${batchId}`, web.origin).toString();
  }

  async _farmbot(method, pathname, body) {
    let response;
    try {
      response = await this._fetch(`${this._apiOrigin()}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${this._env.FARMBOT_NEWS_PREPARER_TOKEN}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw farmbotError(`FarmBot could not be reached (${err.name === "TimeoutError" ? "timed out" : err.message})`, 503);
    }
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  /** The first free dashboard-top10 ID for the day, or the batch already sent. */
  async _resolveBatchId(date) {
    for (let run = 1; run <= 9; run += 1) {
      const clientBatchId = `${BATCH_ID_BASE}${date}${run === 1 ? "" : `-r${run}`}`;
      const found = await this._farmbot("GET", `/news/v1/batches/lookup?clientBatchId=${encodeURIComponent(clientBatchId)}`);
      if (found.status === 404) return { clientBatchId };
      if (!found.ok) throw farmbotError(found.data.error || `FarmBot lookup failed (HTTP ${found.status})`, 503);
      // A batch waiting for approval, or already queued, is today's Top 10:
      // never prepare a second one alongside it.
      if (["validated", "queued"].includes(found.data.status)) return { existing: found.data };
    }
    throw farmbotError("Nine Top 10 batches were already prepared for this day; review them in FarmBot first.", 409);
  }

  _gather(date, timeZone, runIds = {}) {
    const day = buildDailyTopNews({ briefingStore: this._briefings, reporterService: this._reporter, date, timeZone });
    const stories = [];
    const runs = {};
    day.desks.forEach((desk) => {
      const run = desk.runs.find((r) => r.id === runIds[desk.key]) || desk.runs[0];
      if (!run || !run.stories.length) return;
      runs[desk.key] = { id: run.id, source: run.source, at: run.at };
      run.stories.forEach((story) => {
        stories.push({
          ref: `${desk.key[0].toUpperCase()}${story.number}`,
          desk: desk.key,
          deskLabel: desk.label,
          title: story.title,
          body: story.body.slice(0, 600),
        });
      });
    });
    return { day, stories, runs };
  }

  async _rank(date, stories) {
    const res = await this._openai.responses.create({
      model: this._model,
      tools: [{ type: "web_search" }],
      input: rankingPrompt({ date, stories }),
      text: { format: { type: "json_schema", name: "top10_ranking", schema: RANKING_SCHEMA, strict: true } },
    });
    const parsed = parseJsonReply(res.output_text);
    const picks = parsed && Array.isArray(parsed.stories) ? parsed.stories : null;
    if (!picks || !picks.length) throw farmbotError("The ranking step returned no stories; nothing was sent to FarmBot.");
    const byRef = new Map(stories.map((story) => [story.ref, story]));
    return picks
      .map((pick) => ({ ...pick, story: byRef.get(String(pick.ref || "").toUpperCase()) }))
      .filter((pick) => pick.story && typeof pick.url === "string" && pick.post);
  }

  async _describeImage(headline, imageUrl) {
    const res = await this._openai.responses.create({
      model: this._model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: `News headline: ${headline}\nDescribe this image's actual subject in one sentence of at most 20 words. Then on a new line write "MATCH: yes" if it plausibly illustrates the story, or "MATCH: no" if it is a logo, placeholder or unrelated.` },
          { type: "input_image", image_url: imageUrl, detail: "low" },
        ],
      }],
    });
    const text = String(res.output_text || "").trim();
    const match = /MATCH:\s*(yes|no)/i.exec(text);
    const description = text.replace(/MATCH:\s*(yes|no)/i, "").trim().split("\n")[0].slice(0, 200);
    if (!description) throw new Error("empty image description");
    return { description, matches: match ? match[1].toLowerCase() === "yes" : null };
  }

  /**
   * Verify ranked picks and keep the best ten that pass. Articles are fetched
   * in parallel; images are described in parallel for the current top ten,
   * and a story whose image can't be checked gives its place to the next one.
   */
  async _verifyPicks(picks, now) {
    const skipped = [];
    const label = (pick) => ({ ref: pick.ref, desk: pick.story.desk, headline: pick.headline || pick.story.title, url: pick.url });
    const results = await Promise.allSettled(picks.map((pick) => this._verify(pick.url, { now })));
    const verified = [];
    const seen = new Set();
    results.forEach((result, index) => {
      const pick = picks[index];
      if (result.status === "rejected") {
        const err = result.reason || {};
        skipped.push({ ...label(pick), reason: err.verification ? err.message : `Could not verify (${err.message || "error"})` });
        return;
      }
      const article = result.value;
      const key = article.canonicalUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
      if (seen.has(key)) { skipped.push({ ...label(pick), reason: "Same article as a higher-ranked story" }); return; }
      seen.add(key);
      verified.push({ pick, article });
    });

    const accepted = [];
    let next = 0;
    while (accepted.length < TARGET_STORIES && next < verified.length) {
      const batch = verified.slice(next, next + (TARGET_STORIES - accepted.length));
      next += batch.length;
      const described = await Promise.allSettled(batch.map(({ article }) => this._describeImage(article.title, article.imageUrl)));
      described.forEach((result, index) => {
        const { pick, article } = batch[index];
        if (result.status === "fulfilled") accepted.push({ pick, article, image: result.value });
        else skipped.push({ ...label(pick), reason: `Image could not be checked (${result.reason && result.reason.message})` });
      });
    }
    // Keep the model's ranking order whatever order the checks finished in.
    const rank = new Map(picks.map((pick, index) => [pick, index]));
    accepted.sort((a, b) => rank.get(a.pick) - rank.get(b.pick));
    verified.slice(next).forEach(({ pick }) => skipped.push({ ...label(pick), reason: "Verified, but ranked below the top ten" }));
    return { accepted, skipped };
  }

  _payload({ clientBatchId, accepted, destinations, totals, now }) {
    const verifiedAt = now.toISOString();
    const candidates = accepted.map(({ pick, article }) => ({
      canonicalUrl: article.canonicalUrl,
      category: CATEGORY_BY_DESK[pick.story.desk],
      publisher: (article.siteName || pick.publisher || new URL(article.canonicalUrl).hostname).slice(0, 80),
      headline: article.title,
      evidence: `Fetched the article page at ${new URL(article.canonicalUrl).hostname}: "${article.title}". ${article.excerpt || article.description}`.slice(0, 900),
      verificationMethod: "article-body",
      publishedAt: article.publishedAt,
      verifiedAt,
      ...(article.ageMs > 24 * 3600 * 1000
        ? { extendedWindowReason: `Published within 48 hours and still among the day's top ${pick.story.deskLabel} stories in the dashboard briefing.` }
        : {}),
      claimKind: pick.claimKind,
      score: ["recency", "impact", "relevance", "reliability", "novelty"].map((key) => clampScore(pick.scores && pick.scores[key])),
    }));
    const items = accepted.map(({ pick, article, image }, index) => ({
      itemId: `story-${index + 1}`,
      number: index + 1,
      canonicalUrl: article.canonicalUrl,
      text: fitPost(pick.post),
      imageUrl: article.imageUrl,
      imageSubjectEvidence: `Vision check of the article's preview image: ${image.description}${image.matches === false ? " (does not illustrate the story itself)" : ""}`.slice(0, 400),
    }));
    return {
      schemaVersion: 1,
      batchId: clientBatchId,
      timezone: FARMBOT_TIME_ZONE,
      createdAt: now.toISOString(),
      destinations,
      shortfall: `Market Dashboard merged the day's desk briefings (${totals.economics} Economics, ${totals.stocks} Stocks, ${totals.crypto} Crypto stories) `
        + `and verified source articles only for the ${items.length} selected stories; full ten-candidate pools per category were not built.`,
      candidates,
      items,
    };
  }

  _logStories(accepted, batch) {
    if (!this._newsLog) return;
    accepted.forEach(({ pick, article }, index) => {
      try {
        this._newsLog.intake({
          url: article.canonicalUrl,
          headline: article.title,
          source: (article.siteName || pick.publisher || "").slice(0, 80) || new URL(article.canonicalUrl).hostname,
          publishedAt: article.publishedAt,
          market: pick.story.desk,
          summary: `Today's Top 10 #${index + 1}, sent to FarmBot for approval in batch ${batch.clientBatchId} (${batch.batchId}). Post: ${fitPost(pick.post)}`,
          imageUrl: article.imageUrl,
          capturedBy: "today-top-10",
          status: "verified",
        }, { actor: "today-top-10" });
      } catch (err) {
        this._logger.warn?.(`[FarmBot Top 10] news log intake failed: ${err.message}`);
      }
    });
  }

  /**
   * Prepare and send the day's Top 10. Resolves with the saved slip.
   * Throws (with statusCode) only before anything reached FarmBot.
   */
  async send({ date, timeZone, runIds, now = new Date() } = {}) {
    const missing = this.missingConfig();
    if (missing.length) throw farmbotError(`Sending to FarmBot needs: ${missing.join(", ")}`, 503);
    if (this._running) throw farmbotError("A Top 10 is already being prepared; wait for it to finish.", 409);
    this._running = true;
    try {
      const { day, stories, runs } = this._gather(date, timeZone, runIds);
      if (day.date !== day.today) throw farmbotError("Only today's news can be sent to FarmBot.", 400);
      if (stories.length < 3) throw farmbotError("Not enough stories today; run the news first.", 400);

      const capabilities = await this._farmbot("GET", "/news/v1/batches/capabilities");
      if (!capabilities.ok || capabilities.data.persisted !== true || !capabilities.data.destinations) {
        throw farmbotError(capabilities.data.error || "FarmBot's news preview storage is unavailable; nothing was sent.", 503);
      }
      if (Array.isArray(capabilities.data.supportedWorkflows) && !capabilities.data.supportedWorkflows.includes("top10")) {
        throw farmbotError("FarmBot doesn't accept Top 10 batches yet; deploy the FarmBot Top 10 update first.", 503);
      }

      // FarmBot dates batches in Vancouver; the page's day decides the content.
      const batchDate = vancouverDate(now);
      const resolved = await this._resolveBatchId(batchDate);
      if (resolved.existing) {
        const b = resolved.existing;
        return this._slips.record({
          date: day.date, outcome: "already-sent", clientBatchId: b.clientBatchId, batchId: b.batchId,
          farmbotStatus: b.status, payloadHash: b.payloadHash, approvalUrl: this._approvalUrl(b.batchId),
          stories: (b.payload?.items || []).map((item) => ({ number: item.number, url: item.canonicalUrl, post: item.text })),
          skipped: [], runs,
        }, now);
      }

      const picks = await this._rank(day.date, stories);
      let { accepted, skipped } = await this._verifyPicks(picks, now);
      if (!accepted.length) {
        return this._slips.record({ date: day.date, outcome: "failed", error: "No story's source article could be verified.", stories: [], skipped, runs }, now);
      }

      const totals = { economics: 0, stocks: 0, crypto: 0 };
      stories.forEach((story) => { totals[story.desk] += 1; });

      // A story already chosen by another active batch is dropped, not resent.
      let created = null;
      for (let attempt = 0; attempt < 4 && accepted.length; attempt += 1) {
        const payload = this._payload({ clientBatchId: resolved.clientBatchId, accepted, destinations: capabilities.data.destinations, totals, now });
        const res = await this._farmbot("POST", "/news/v1/batches", { payload });
        if (res.ok) { created = res.data; break; }
        const taken = /Story (\d+) is already selected in active batch/.exec(res.data.error || "");
        if (res.status === 409 && taken) {
          const [removed] = accepted.splice(Number(taken[1]) - 1, 1);
          skipped.push({ ref: removed.pick.ref, desk: removed.pick.story.desk, headline: removed.article.title, url: removed.article.canonicalUrl, reason: "Already in another FarmBot batch" });
          continue;
        }
        return this._slips.record({
          date: day.date, outcome: "failed", clientBatchId: resolved.clientBatchId,
          error: `FarmBot refused the batch (HTTP ${res.status}): ${res.data.error || "no reason given"}`, stories: [], skipped, runs,
        }, now);
      }
      if (!created) {
        return this._slips.record({ date: day.date, outcome: "failed", error: "Every verified story is already in another FarmBot batch.", stories: [], skipped, runs }, now);
      }

      const batch = { clientBatchId: created.clientBatchId, batchId: created.batchId };
      this._logStories(accepted, batch);
      return this._slips.record({
        date: day.date,
        outcome: created.duplicate ? "already-sent" : "sent",
        clientBatchId: created.clientBatchId,
        batchId: created.batchId,
        revision: created.revision,
        payloadHash: created.payloadHash,
        farmbotStatus: created.status,
        approvalEligible: Boolean(created.approvalEligible),
        approvalUrl: this._approvalUrl(created.batchId),
        stories: accepted.map(({ pick, article, image }, index) => ({
          number: index + 1,
          desk: pick.story.desk,
          ref: pick.ref,
          headline: article.title,
          publisher: article.siteName || pick.publisher,
          url: article.canonicalUrl,
          publishedAt: article.publishedAt,
          imageUrl: article.imageUrl,
          imageMatches: image.matches,
          post: fitPost(pick.post),
        })),
        skipped,
        runs,
        requestId: crypto.randomUUID(),
      }, now);
    } finally {
      this._running = false;
    }
  }
}

module.exports = { FarmbotTop10Service, fitPost, parseJsonReply, rankingPrompt };
