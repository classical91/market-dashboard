"use strict";

/**
 * FarmclawHandoffStore
 *
 * The dashboard's half of handing an X post to the FarmClaw agent. It
 * replaces a Telegram relay that sent the link from the dashboard bot and
 * reported success as soon as Telegram accepted it. Telegram accepting a
 * message is not FarmClaw receiving it: a bot's outbound message is not an
 * inbound event for another bot or agent, so "sent" could mean nothing
 * happened at all.
 *
 * So the handoff is a queue FarmClaw pulls from, not a message pushed at it:
 *
 *   pending ──claim──▶ claimed ──receipt──▶ received
 *      └──────────────────┴──────fail──────▶ failed ──re-request──▶ pending
 *
 * - The dashboard can only create a handoff (`request`). That is "queued",
 *   never "done".
 * - FarmClaw claims pending items with the machine key. A claim is a lease:
 *   if FarmClaw dies before acknowledging, the item becomes claimable again
 *   when the lease runs out instead of being stuck as "claimed" forever.
 * - Only FarmClaw's receipt (its own id for the task it created) moves an item
 *   to `received`, and that is the only state the button shows as success.
 *   A receipt outranks an earlier failure or an expired lease: if FarmClaw
 *   says it has the item, it has it.
 *
 * Requests are idempotent on the canonical URL, so a double tap or a retry
 * never queues a post twice. FarmClaw's last poll is recorded so the page can
 * tell "queued, FarmClaw is polling" apart from "FarmClaw has never checked
 * in", which is the difference that would have exposed the old bug.
 *
 * File shape:
 *   { "version": 1, "meta": { "lastPollAt", "lastPollAgent" }, "records": [ <newest first> ] }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { canonicalizeUrl } = require("./broadcast-ledger");

const STORE_VERSION = 1;
const DEFAULT_CAP = 5000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_CLAIM_BATCH = 25;
const MAX_HISTORY_PER_RECORD = 20;
const STATUSES = ["pending", "claimed", "received", "failed"];

const MAX_URL_LEN = 2000;
const MAX_TEXT_LEN = 4000;
const MAX_SHORT_LEN = 120;
const MAX_ERROR_LEN = 500;

function clampString(value, max) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function makeError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  Object.assign(err, extra);
  return err;
}

function leaseExpired(record, now) {
  return record.status === "claimed" && (!record.claimExpiresAt || Date.parse(record.claimExpiresAt) <= now);
}

/**
 * Whether a receipt proves the link reached the FarmClaw agent, rather than
 * only a consumer's own file. Receipts from the dashboard's direct push carry
 * the gateway run id; the collector's carry "Delivered to the FarmClaw
 * session: …". Earlier collector versions acknowledged links they had only
 * written to a local file, which the agent never read, and the button showed
 * those as ✓.
 */
function hasDeliveryProof(receipt) {
  if (!receipt) return false;
  if (String(receipt.receiptId || "").startsWith("openclaw-run:")) return true;
  return String(receipt.note || "").startsWith("Delivered to the FarmClaw session");
}

class FarmclawHandoffStore {
  constructor({ dataDir, logger = console, cap = DEFAULT_CAP, leaseMs = DEFAULT_LEASE_MS, now = () => Date.now() } = {}) {
    this._file = path.join(dataDir, "farmclaw-handoffs.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._cap = cap;
    this._leaseMs = leaseMs;
    this._now = now;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return {
        meta: parsed && typeof parsed.meta === "object" && parsed.meta ? parsed.meta : {},
        records: Array.isArray(parsed?.records) ? parsed.records : [],
      };
    } catch {
      return { meta: {}, records: [] };
    }
  }

  _write(state) {
    const ok = writeJsonAtomic(
      this._file,
      { version: STORE_VERSION, meta: state.meta, records: state.records.slice(0, this._cap) },
      this._logger,
      "[FarmclawHandoffs]",
    );
    // The button reports "queued" off this write; one that didn't land must
    // not be reported back as queued.
    if (!ok) throw makeError("FarmClaw handoff queue could not be written; retry the request.", 503);
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "FarmClaw handoff queue is busy; retry the request.",
    });
  }

  _iso() {
    return new Date(this._now()).toISOString();
  }

  _push(record, event, detail = {}) {
    record.history = [{ at: record.updatedAt, event, ...detail }, ...(record.history || [])].slice(0, MAX_HISTORY_PER_RECORD);
  }

  /** What FarmClaw's polling looks like, for the page to explain a wait. */
  agentStatus() {
    const { meta } = this._read();
    return { lastPollAt: meta.lastPollAt || null, lastPollAgent: meta.lastPollAgent || null };
  }

  /**
   * Queue one post for FarmClaw. Returns `{ record, created, requeued }`.
   * A repeat of the same canonical URL returns the existing handoff; a
   * failed one goes back to pending, since a retry is what the tap means.
   */
  request(input = {}) {
    const url = clampString(input.url, MAX_URL_LEN);
    const canonicalUrl = canonicalizeUrl(url);
    if (!canonicalUrl) throw makeError("url must be an http(s) link to the post", 400);

    return this._withLock(() => {
      const state = this._read();
      const now = this._iso();
      const existing = state.records.find((record) => record.canonicalUrl === canonicalUrl);
      if (existing) {
        existing.requestCount = (existing.requestCount || 1) + 1;
        let requeued = false;
        if (existing.status === "failed") {
          existing.status = "pending";
          existing.error = null;
          existing.updatedAt = now;
          this._push(existing, "requeued");
          requeued = true;
        } else if (existing.status === "received" && !hasDeliveryProof(existing.receipt)) {
          // Acknowledged without ever reaching the agent: a tap sends it.
          this._push(existing, "requeued_without_delivery_proof", { receiptId: existing.receipt?.receiptId || null });
          existing.status = "pending";
          existing.receipt = null;
          existing.updatedAt = now;
          requeued = true;
        }
        this._write(state);
        return { record: existing, created: false, requeued };
      }

      const record = {
        id: `fch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
        url,
        canonicalUrl,
        handle: clampString(input.handle, MAX_SHORT_LEN).replace(/^@+/, "") || null,
        text: clampString(input.text, MAX_TEXT_LEN) || null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        requestCount: 1,
        attempts: 0,
        claimedAt: null,
        claimedBy: null,
        claimExpiresAt: null,
        receipt: null,
        error: null,
        history: [],
      };
      this._push(record, "requested");
      state.records.unshift(record);
      this._write(state);
      return { record, created: true, requeued: false };
    });
  }

  /**
   * FarmClaw takes up to `limit` items: pending ones, oldest first, plus any
   * whose lease ran out. Every call records the poll, including an empty one,
   * so "FarmClaw is alive and the queue is empty" is visible too.
   */
  claim({ agent, limit } = {}) {
    const claimant = clampString(agent, MAX_SHORT_LEN) || "farmclaw";
    const max = Math.max(1, Math.min(Number(limit) || 10, MAX_CLAIM_BATCH));
    return this._withLock(() => {
      const state = this._read();
      const nowMs = this._now();
      const now = this._iso();
      const claimable = state.records
        .filter((record) => record.status === "pending" || leaseExpired(record, nowMs))
        .reverse()
        .slice(0, max);
      claimable.forEach((record) => {
        record.status = "claimed";
        record.attempts = (record.attempts || 0) + 1;
        record.claimedAt = now;
        record.claimedBy = claimant;
        record.claimExpiresAt = new Date(nowMs + this._leaseMs).toISOString();
        record.updatedAt = now;
        this._push(record, "claimed", { by: claimant });
      });
      state.meta = { ...state.meta, lastPollAt: now, lastPollAgent: claimant };
      this._write(state);
      return claimable;
    });
  }

  /**
   * Claim one specific handoff (the dashboard's own push on a tap). Returns
   * the claimed record, or null when it isn't claimable: unknown id, already
   * received or failed, or under someone else's live lease.
   */
  claimById(id, { agent } = {}) {
    const claimant = clampString(agent, MAX_SHORT_LEN) || "farmclaw";
    return this._withLock(() => {
      const state = this._read();
      const nowMs = this._now();
      const record = state.records.find((entry) => entry.id === id);
      if (!record || !(record.status === "pending" || leaseExpired(record, nowMs))) return null;
      const now = this._iso();
      record.status = "claimed";
      record.attempts = (record.attempts || 0) + 1;
      record.claimedAt = now;
      record.claimedBy = claimant;
      record.claimExpiresAt = new Date(nowMs + this._leaseMs).toISOString();
      record.updatedAt = now;
      this._push(record, "claimed", { by: claimant });
      this._write(state);
      return record;
    });
  }

  /** Claim without recording a FarmClaw poll (the dashboard's own sweep). */
  claimPending({ agent, limit } = {}) {
    return this._withLock(() => {
      const before = this._read().meta;
      const records = this.claim({ agent, limit });
      const state = this._read();
      state.meta = before;
      this._write(state);
      return records;
    });
  }

  /**
   * FarmClaw's proof that it took the item into its own workflow. The same
   * receiptId may be re-sent (idempotent); a different one is a 409, because
   * two receipts for one handoff means something upstream is confused.
   */
  receipt(id, input = {}) {
    const receiptId = clampString(input.receiptId, MAX_SHORT_LEN);
    if (!receiptId) throw makeError("receiptId is required: FarmClaw's own id for the task it created.", 400);
    return this._withLock(() => {
      const state = this._read();
      const record = state.records.find((entry) => entry.id === id);
      if (!record) return null;
      if (record.status === "received") {
        if (record.receipt?.receiptId === receiptId) return record;
        throw makeError("Handoff already has a different FarmClaw receipt.", 409, { currentStatus: record.status });
      }
      const now = this._iso();
      record.status = "received";
      record.receipt = {
        receiptId,
        agent: clampString(input.agent, MAX_SHORT_LEN) || record.claimedBy || "farmclaw",
        receivedAt: now,
        note: clampString(input.note, MAX_ERROR_LEN) || null,
      };
      record.error = null;
      record.claimExpiresAt = null;
      record.updatedAt = now;
      this._push(record, "received", { receiptId });
      this._write(state);
      return record;
    });
  }

  /** FarmClaw could not take the item. Needs the exact error. */
  fail(id, input = {}) {
    const error = clampString(input.error, MAX_ERROR_LEN);
    if (!error) throw makeError("error is required: the exact reason FarmClaw could not take the item.", 400);
    return this._withLock(() => {
      const state = this._read();
      const record = state.records.find((entry) => entry.id === id);
      if (!record) return null;
      if (record.status === "received") {
        throw makeError("Handoff was already received; a receipt outranks a later failure.", 409, {
          currentStatus: record.status,
        });
      }
      const now = this._iso();
      record.status = "failed";
      record.error = error;
      record.claimExpiresAt = null;
      record.updatedAt = now;
      this._push(record, "failed", { error });
      this._write(state);
      return record;
    });
  }

  get(id) {
    return this._read().records.find((record) => record.id === id) || null;
  }

  list({ status, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    return this._read().records
      .filter((record) => !status || record.status === status)
      .slice(0, max);
  }
}

module.exports = { FarmclawHandoffStore, hasDeliveryProof, STATUSES, DEFAULT_LEASE_MS };
