"use strict";

const { farmbotQueueUrl } = require("./farmclaw-queue-status");

/**
 * Send one X post straight to FarmBot Queue, without the FarmClaw agent.
 *
 * Uses FarmBot's own single-X-link intake (POST /farmclaw/v1/x-links) with the
 * preparer token the dashboard already holds for Today's Top 10. FarmBot
 * validates the payload, refuses duplicates, and schedules the row on its
 * normal "Minutes Between Queue Posts" timer. Queue rows post themselves, so
 * the caller is the human review: the text sent is exactly what the person
 * confirmed in the dashboard's dialog.
 *
 * Success is FarmBot's read-back of the saved receipt, never the POST alone.
 */

const X_STATUS = /^\/(?:[a-zA-Z0-9_]{1,30}\/status|i\/status|i\/web\/status)\/([1-9]\d{0,24})(?:\/(?:photo|video)\/\d+)?\/?$/;
const CATEGORIES = ["economics", "stocks", "crypto", "general"];
const MAX_POST_CHARS = 280;
const MAX_SOURCE_CHARS = 20000;

function queueError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** The X status id of a post URL, or null. Mirrors FarmBot's xLinkIdentity. */
function xStatusId(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  const match = X_STATUS.exec(url.pathname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !match) return null;
  if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return null;
  return match[1];
}

/** A best guess from the feed's category label; the dialog lets it be changed. */
function guessCategory(label) {
  const text = String(label || "").toLowerCase();
  if (/crypto|bitcoin|btc|eth/.test(text)) return "crypto";
  if (/stock|equit|earning/.test(text)) return "stocks";
  if (/econ|macro|fed|rates|inflation/.test(text)) return "economics";
  return "general";
}

function isoOrNull(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function httpsOrNull(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

/** The schema-v1 single-X-link envelope FarmBot's validator accepts. */
function buildPayload({ statusId, handle, sourceText, publishedAt, text, category, imageUrl, destinations, now }) {
  const canonicalUrl = `https://x.com/i/status/${statusId}`;
  const at = new Date(now).toISOString();
  const publisher = handle ? `@${handle}` : "X post";
  const firstLine = sourceText.split(/\n/).find((line) => line.trim()) || sourceText;
  const item = { itemId: `x-${statusId}`, number: 1, canonicalUrl, text };
  if (imageUrl) {
    item.imageUrl = imageUrl;
    item.imageSubjectEvidence = `Photo attached to the source X post by ${publisher}, as shown in Market Dashboard's X feed.`;
  } else {
    item.textOnly = true;
  }
  return {
    schemaVersion: 1,
    batchId: `farmclaw-xlink-${statusId}`,
    timezone: "America/Vancouver",
    createdAt: at,
    destinations,
    candidates: [{
      canonicalUrl,
      category,
      publisher,
      headline: firstLine.trim().slice(0, 200),
      evidence: `Source post text by ${publisher} as shown in Market Dashboard's X feed; selected and sent directly by the dashboard owner, not verified by FarmClaw. Text: ${sourceText}`.slice(0, MAX_SOURCE_CHARS),
      verificationMethod: "x-post-body",
      publishedAt,
      verifiedAt: at,
      claimKind: "confirmed",
      // Not scored: a person picked this post by hand, so no rubric was run.
      score: [0, 0, 0, 0, 0],
    }],
    items: [item],
  };
}

function createFarmbotXQueue({ env = process.env, fetcher = fetch, now = () => Date.now() } = {}) {
  function missingConfig() {
    const missing = [];
    if (!env.FARMBOT_NEWS_API_URL) missing.push("FARMBOT_NEWS_API_URL");
    if ((env.FARMBOT_NEWS_PREPARER_TOKEN || "").length < 32) missing.push("FARMBOT_NEWS_PREPARER_TOKEN");
    return missing;
  }

  function apiOrigin() {
    let api;
    try { api = new URL(env.FARMBOT_NEWS_API_URL); } catch { throw queueError("FARMBOT_NEWS_API_URL is not a valid URL", 503); }
    if (api.protocol !== "https:" || api.username || api.password) throw queueError("FARMBOT_NEWS_API_URL must be a plain https URL", 503);
    return api.origin;
  }

  async function farmbot(method, pathname, body) {
    let response;
    try {
      response = await fetcher(`${apiOrigin()}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.FARMBOT_NEWS_PREPARER_TOKEN}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      const reason = err && err.name === "TimeoutError" ? "timed out" : (err && err.message) || "network error";
      throw queueError(`FarmBot could not be reached (${reason}). The post may or may not be queued; check FarmBot Queue before sending again.`, 503);
    }
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  function summary(readback, duplicate) {
    const queue = readback.queue || null;
    return {
      ok: true,
      duplicate: Boolean(duplicate),
      statusId: readback.statusId,
      queueItemId: readback.queueItemId,
      queued: readback.queued === true,
      removed: readback.removed === true,
      dispatchActive: queue ? queue.dispatchActive : null,
      dispatchStatus: queue ? queue.dispatchStatus : null,
      dispatchNotBefore: queue ? queue.dispatchNotBefore : null,
      text: queue ? queue.text : null,
      queueUrl: farmbotQueueUrl(env),
    };
  }

  /** What FarmBot already holds for this post, or null. */
  async function lookup(url) {
    const statusId = xStatusId(url);
    if (!statusId) throw queueError("Not an X post link");
    const missing = missingConfig();
    if (missing.length) throw queueError(`FarmBot is not configured here (set ${missing.join(", ")})`, 503);
    const found = await farmbot("GET", `/farmclaw/v1/x-links/${statusId}`);
    if (found.status === 404) return null;
    if (!found.ok) throw queueError(found.data.error || `FarmBot lookup failed (HTTP ${found.status})`, 502);
    return summary(found.data, true);
  }

  async function enqueue(input = {}) {
    const statusId = xStatusId(input.url);
    if (!statusId) throw queueError("Only an X post link (x.com/<handle>/status/<id>) can be queued");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw queueError("Write the post text to queue");
    if ([...text].length > MAX_POST_CHARS) throw queueError(`Post text is over ${MAX_POST_CHARS} characters`);
    const sourceText = (typeof input.sourceText === "string" ? input.sourceText.trim() : "") || text;
    const publishedAt = isoOrNull(input.publishedAt);
    if (!publishedAt) throw queueError("The post has no publish time, so FarmBot cannot record its source");
    if (Date.parse(publishedAt) > now() + 60000) throw queueError("The post's publish time is in the future");
    const category = CATEGORIES.includes(input.category) ? input.category : "general";
    const handle = typeof input.handle === "string" ? input.handle.replace(/^@/, "").trim().slice(0, 30) : "";
    let imageUrl = null;
    if (input.image) {
      imageUrl = httpsOrNull(input.image);
      if (!imageUrl) throw queueError("The post's photo is not an https link; untick Include photo to send it as text only");
    }

    const missing = missingConfig();
    if (missing.length) throw queueError(`FarmBot is not configured here (set ${missing.join(", ")})`, 503);

    const caps = await farmbot("GET", "/news/v1/batches/capabilities");
    if (!caps.ok || caps.data.persisted !== true || !caps.data.destinations) {
      throw queueError(caps.data.error || `FarmBot's queue storage is unavailable (HTTP ${caps.status}); nothing was sent.`, 503);
    }
    const workflows = Array.isArray(caps.data.supportedWorkflows) ? caps.data.supportedWorkflows : [];
    if (!workflows.includes("x-link-queue") || caps.data.xLinkQueueMode !== "timed") {
      throw queueError("This FarmBot does not accept timed X-link queue entries; nothing was sent.", 503);
    }

    const payload = buildPayload({
      statusId, handle, sourceText, publishedAt, text, category, imageUrl,
      destinations: caps.data.destinations, now: now(),
    });
    const saved = await farmbot("POST", "/farmclaw/v1/x-links", { payload });
    if (!saved.ok) {
      throw queueError(saved.data.error || `FarmBot refused the post (HTTP ${saved.status})`, saved.status === 409 ? 409 : saved.status >= 500 ? 502 : 422);
    }
    const readback = await farmbot("GET", `/farmclaw/v1/x-links/${statusId}`);
    if (!readback.ok || readback.data.persisted !== true || readback.data.queueItemId !== saved.data.queueItemId) {
      throw queueError("FarmBot did not confirm the saved Queue entry on read-back; check FarmBot Queue before sending again.", 502);
    }
    return summary(readback.data, saved.data.duplicate);
  }

  return { missingConfig, lookup, enqueue };
}

module.exports = { createFarmbotXQueue, buildPayload, xStatusId, guessCategory, MAX_POST_CHARS, CATEGORIES };
