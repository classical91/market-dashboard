"use strict";

/**
 * Engagement X drafts for the Top 10 sent to FarmBot.
 *
 *   1. Write   — after a Top 10 batch is saved in FarmBot, ask FarmBot's
 *                POST /news/v1/x-drafts to write one X post per story. FarmBot
 *                uses its own Settings → AI & Generation (Grok, the post
 *                prompt, style and niche) and checks each draft against the
 *                article. The drafts are saved here for review.
 *   2. Review  — in News Reporter, each draft is approved (optionally edited)
 *                or rejected. Nothing is posted from here.
 *   3. Apply   — approved drafts replace those stories' text in a new revision
 *                of the same FarmBot batch (`supersedes`). FarmBot's News
 *                Preview approval still decides what is queued, and a batch
 *                that is already approved and queued is never changed.
 *
 * File shape: { "version": 1, "sets": [ <newest first> ] }
 */

const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");

const MAX_SETS = 60;
const MAX_POST_CHARS = 280;
const MIN_EVIDENCE_CHARS = 200;
const MAX_EVIDENCE_CHARS = 7000;
const REVIEW_STATES = new Set(["pending", "approved", "rejected"]);

function draftError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

class Top10XDraftStore {
  constructor({ dataDir, file, logger = console } = {}) {
    this.file = file || path.join(dataDir, "top10-x-drafts.json");
    this.logger = logger;
    this.lockState = { depth: 0 };
  }

  _read() {
    const stored = readJsonStore(this.file, this.logger, "Top 10 X drafts");
    return Array.isArray(stored?.sets) ? stored.sets : [];
  }

  _write(sets) {
    if (!writeJsonAtomic(this.file, { version: 1, sets: sets.slice(0, MAX_SETS) }, this.logger, "Top 10 X drafts")) {
      throw draftError("Could not save the X drafts; try again.", 503);
    }
  }

  /** Newest draft set for a day (or overall, without a day), or null. */
  latest(date) {
    const sets = this._read();
    return (date ? sets.find((set) => set.date === date) : sets[0]) || null;
  }

  create(set, now = new Date()) {
    return withExclusiveLock(this.file, this.lockState, () => {
      const entry = {
        id: `xd-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), ...set,
      };
      this._write([entry, ...this._read()]);
      return entry;
    }, { busyMessage: "X drafts are busy; retry the request." });
  }

  /** Change one set under the lock. `change` returns the new set. */
  update(id, change, now = new Date()) {
    return withExclusiveLock(this.file, this.lockState, () => {
      const sets = this._read();
      const index = sets.findIndex((set) => set.id === id);
      if (index < 0) throw draftError("These X drafts no longer exist; write them again.", 404);
      const next = { ...change(structuredClone(sets[index])), updatedAt: now.toISOString() };
      sets[index] = next;
      this._write(sets);
      return next;
    }, { busyMessage: "X drafts are busy; retry the request." });
  }
}

/** Length as people see it: one per character, so an emoji counts once. */
function postLength(text) {
  return [...text].length;
}

function cleanPost(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text) throw draftError("The post is empty.");
  if (postLength(text) > MAX_POST_CHARS) throw draftError(`The post is ${postLength(text)} characters; X allows ${MAX_POST_CHARS}.`);
  if (/https?:\/\/|\bwww\./i.test(text)) throw draftError("Leave links out; FarmBot attaches the article.");
  return text;
}

class Top10XDrafts {
  /**
   * @param {object} options
   * @param {Top10XDraftStore} options.store
   * @param {object} options.top10  FarmbotTop10Service (FarmBot requests, slips, article checks)
   */
  constructor({ store, top10 }) {
    this._store = store;
    this._top10 = top10;
  }

  current(date) {
    return this._store.latest(date || null);
  }

  /** The newest slip for the day that FarmBot saved as a batch. */
  _sentSlip(date) {
    const slip = this._top10._slips.forDay(date).find((item) => item.batchId && ["sent", "already-sent"].includes(item.outcome));
    if (!slip) throw draftError("Send today's Top 10 to FarmBot first; drafts are written from the saved batch.", 409);
    return slip;
  }

  async _batch(batchId) {
    const res = await this._top10._farmbot("GET", `/news/v1/batches/${encodeURIComponent(batchId)}`);
    if (!res.ok) throw draftError(res.data.error || `FarmBot could not read the batch (HTTP ${res.status}).`, 502);
    if (!res.data.payload || !Array.isArray(res.data.payload.items)) throw draftError("FarmBot returned the batch without its stories.", 502);
    return res.data;
  }

  /** Text FarmBot writes from: the article's description and body, never the old post. */
  async _evidence(item, articles, now) {
    let article = articles.get(item.canonicalUrl);
    if (!article) {
      try { article = await this._top10._verify(item.canonicalUrl, { now }); } catch (err) {
        return { error: `Could not re-read the article (${err.message || "error"}).` };
      }
    }
    const evidence = [article.description, article.bodyText || article.excerpt].filter(Boolean).join("\n\n").slice(0, MAX_EVIDENCE_CHARS);
    if (evidence.length < MIN_EVIDENCE_CHARS) return { article, error: "Not enough article text to write an X post from." };
    return { article, evidence };
  }

  /**
   * Ask FarmBot for one engagement X post per story in the day's batch, and
   * save them for review. `articles` are the verified articles from the send,
   * when available, so nothing is fetched twice.
   */
  async write({ date, articles = [], now = new Date() } = {}) {
    const missing = this._top10.missingConfig().filter((key) => key !== "OPENAI_API_KEY");
    if (missing.length) throw draftError(`X drafts need: ${missing.join(", ")}`, 503);
    const slip = this._sentSlip(date);
    const batch = await this._batch(slip.batchId);
    if (batch.status === "queued") throw draftError("This batch is already approved and queued in FarmBot; its posts can no longer change.", 409);

    const byUrl = new Map(articles.filter(Boolean).map((article) => [article.canonicalUrl, article]));
    const candidates = new Map((batch.payload.candidates || []).map((c) => [c.canonicalUrl, c]));
    const prepared = await Promise.all(batch.payload.items.map(async (item) => ({ item, ...await this._evidence(item, byUrl, now) })));
    const ready = prepared.filter((entry) => entry.evidence);

    let reply = { drafts: [] };
    if (ready.length) {
      const res = await this._top10._farmbot("POST", "/news/v1/x-drafts", {
        items: ready.map(({ item, article, evidence }) => {
          const candidate = candidates.get(item.canonicalUrl) || {};
          return {
            itemId: item.itemId,
            canonicalUrl: item.canonicalUrl,
            headline: String(candidate.headline || article.title || "News story").slice(0, 500),
            ...(candidate.publisher ? { publisher: String(candidate.publisher).slice(0, 200) } : {}),
            ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
            ...(candidate.category ? { category: candidate.category } : {}),
            evidence,
          };
        }),
      });
      if (res.status === 404) throw draftError("FarmBot can't write X drafts yet; deploy the FarmBot X drafts update first.", 503);
      if (!res.ok) throw draftError(res.data.error || `FarmBot could not write X drafts (HTTP ${res.status}).`, 502);
      reply = res.data;
    }
    const drafts = new Map((reply.drafts || []).map((draft) => [draft.itemId, draft]));

    return this._store.create({
      date,
      batchId: batch.batchId,
      clientBatchId: batch.clientBatchId,
      revision: batch.revision,
      payloadHash: batch.payloadHash,
      provider: reply.provider || null,
      model: reply.model || null,
      style: reply.style || null,
      status: "review",
      items: prepared.map(({ item, error }) => {
        const candidate = candidates.get(item.canonicalUrl) || {};
        const draft = drafts.get(item.itemId);
        const ok = Boolean(draft && draft.ok && draft.text);
        return {
          itemId: item.itemId,
          number: item.number,
          category: candidate.category || null,
          headline: candidate.headline || null,
          publisher: candidate.publisher || null,
          url: item.canonicalUrl,
          original: item.text,
          draft: ok ? draft.text : null,
          state: ok ? "pending" : "failed",
          error: ok ? null : error || (draft && draft.error) || "FarmBot returned no draft for this story.",
        };
      }),
    }, now);
  }

  /** Approve (optionally with edited text), reject, or reset one draft. */
  review({ date, itemId, decision, text, now = new Date() } = {}) {
    const set = this._store.latest(date);
    if (!set) throw draftError("No X drafts for this day.", 404);
    if (!REVIEW_STATES.has(decision)) throw draftError("decision must be approved, rejected or pending.");
    return this._store.update(set.id, (draft) => {
      if (draft.status === "applied") throw draftError("These drafts are already in FarmBot. Write drafts again to change them.", 409);
      const item = draft.items.find((entry) => entry.itemId === itemId);
      if (!item) throw draftError("No such story in these drafts.", 404);
      if (decision === "approved") {
        const post = cleanPost(text === undefined ? item.draft : text);
        if (post !== item.draft) item.edited = true;
        item.draft = post;
        item.error = null;
      } else if (item.state === "failed") {
        throw draftError("This story has no draft; approve it with your own text or leave it.", 409);
      }
      item.state = decision;
      item.reviewedAt = now.toISOString();
      return draft;
    }, now);
  }

  /**
   * Put the approved drafts into a new revision of the same FarmBot batch.
   * FarmBot must still show the revision the drafts were written from, so a
   * change made in FarmBot meanwhile is never overwritten.
   */
  async apply({ date, now = new Date() } = {}) {
    const set = this._store.latest(date);
    if (!set) throw draftError("No X drafts for this day.", 404);
    if (set.status === "applied") throw draftError(`Already in FarmBot as revision ${set.appliedRevision}.`, 409);
    const approved = set.items.filter((item) => item.state === "approved" && item.draft);
    if (!approved.length) throw draftError("Approve at least one draft first.");

    const batch = await this._batch(set.batchId);
    if (batch.revision !== set.revision || batch.payloadHash !== set.payloadHash) {
      throw draftError("The batch changed in FarmBot after these drafts were written. Write drafts again.", 409);
    }
    if (batch.status === "queued") throw draftError("This batch is already approved and queued in FarmBot; its posts can no longer change.", 409);
    if (batch.status === "expired") throw draftError("The FarmBot preview expired. Send a new Top 10 first.", 409);

    const payload = structuredClone(batch.payload);
    approved.forEach((draft) => {
      const item = payload.items.find((entry) => entry.itemId === draft.itemId);
      if (item) item.text = draft.draft;
    });
    const res = await this._top10._farmbot("POST", "/news/v1/batches", {
      payload, supersedes: { batchId: batch.batchId, revision: batch.revision },
    });
    if (!res.ok) throw draftError(`FarmBot refused the new revision (HTTP ${res.status}): ${res.data.error || "no reason given"}`, 502);
    const created = res.data;

    const updated = this._store.update(set.id, (draft) => {
      draft.status = "applied";
      draft.appliedRevision = created.revision;
      draft.appliedPayloadHash = created.payloadHash;
      draft.appliedAt = now.toISOString();
      draft.items.forEach((item) => { if (item.state === "approved") item.state = "applied"; });
      return draft;
    }, now);

    // A new receipt so Today's Top 10 shows the revision waiting for approval.
    const previous = this._sentSlip(date);
    const { id, recordedAt, requestId, ...rest } = previous;
    const posts = new Map(payload.items.map((item) => [item.canonicalUrl, item.text]));
    const slip = this._top10._slips.record({
      ...rest,
      outcome: "sent",
      revision: created.revision,
      payloadHash: created.payloadHash,
      farmbotStatus: created.status,
      approvalEligible: Boolean(created.approvalEligible),
      approvalUrl: this._top10._approvalUrl(created.batchId || batch.batchId),
      stories: (rest.stories || []).map((story) => ({ ...story, post: posts.get(story.url) || story.post })),
      xDraftsApplied: approved.length,
    }, now);
    return { drafts: updated, slip };
  }
}

module.exports = { Top10XDraftStore, Top10XDrafts, cleanPost };
