"use strict";

/**
 * ReporterNewsLogStore
 *
 * One canonical record per news candidate the reporter workflow has seen,
 * from the moment ShareBot/FarmClaw verifies it through approval, FarmBot
 * queueing and publication. It is deliberately separate from the broadcast
 * ledger: the ledger records what *went out*, this log records what was
 * *found* — and logging an item here never implies it was approved, queued
 * or published.
 *
 * Deduplication is on the canonical URL (tracking params stripped, the same
 * canonicalizer the broadcast ledger uses), falling back to `source` +
 * `sourceId` for items with no URL. A repeated intake updates the existing
 * record instead of creating a second one.
 *
 * Persistence is the same locked/atomic JSON-file idiom as the broadcast
 * ledger: one file under DATA_DIR, safe on a single replica.
 *
 * File shape:
 *   { "version": 1, "records": [ <newest first> ] }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { canonicalizeUrl } = require("./broadcast-ledger");

const LOG_VERSION = 1;
const DEFAULT_CAP = 20000;
const DEFAULT_TIMEZONE = "America/Vancouver";
const MAX_HISTORY_PER_RECORD = 30;

const STATUSES = ["discovered", "verified", "approved", "queued", "posted", "rejected", "failed"];
// Intake may only log what was found and checked. Approval, queueing and
// publication are separate, later facts and must come through a PATCH.
const INTAKE_STATUSES = ["discovered", "verified"];
const MARKETS = ["stocks", "crypto", "economics", "geopolitics", "general"];
const VERIFICATION_STATUSES = ["unverified", "verified", "disputed"];
const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

// Allowed workflow moves. Re-sending the current status is always accepted
// (idempotent retries); anything not listed here is a 409. `failed` has no
// fixed row: a failure remembers the stage it failed at (`failedFrom`) and may
// only resume from that stage — see allowedTransitions().
const TRANSITIONS = {
  discovered: ["verified", "rejected", "failed"],
  verified: ["approved", "rejected", "failed"],
  approved: ["queued", "rejected", "failed"],
  queued: ["posted", "failed"],
  posted: [],
  rejected: [],
};
const FAILABLE_STATUSES = ["discovered", "verified", "approved", "queued"];

const MAX_TITLE_LEN = 300;
const MAX_URL_LEN = 2000;
const MAX_SUMMARY_LEN = 4000;
const MAX_SHORT_LEN = 120;
const MAX_ERROR_LEN = 500;
const MAX_SYMBOLS = 25;

function nowIso() {
  return new Date().toISOString();
}

function clampString(value, max) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function isFiniteDate(value) {
  if (value === null || value === undefined || value === "") return false;
  return !Number.isNaN(new Date(value).getTime());
}

function toIso(value) {
  return isFiniteDate(value) ? new Date(value).toISOString() : null;
}

function dayKey(value, timeZone = DEFAULT_TIMEZONE) {
  const date = isFiniteDate(value) ? new Date(value) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isDayKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeStatus(value) {
  const status = clampString(value, 20).toLowerCase();
  return STATUSES.includes(status) ? status : null;
}

/** Accept the desk names the rest of the app uses as well as the plan's. */
function normalizeMarket(value) {
  const raw = clampString(value, 40).toLowerCase();
  if (!raw) return null;
  if (["stock", "stocks", "markets", "equities"].includes(raw)) return "stocks";
  if (["crypto", "cryptocurrency"].includes(raw)) return "crypto";
  if (["economics", "economy", "macro"].includes(raw)) return "economics";
  if (["geopolitics", "geopolitical"].includes(raw)) return "geopolitics";
  if (MARKETS.includes(raw)) return raw;
  return "general";
}

function normalizeSymbols(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const symbols = list
    .map((item) => clampString(item, 20).replace(/^\$/, "").toUpperCase())
    .filter((item) => /^[A-Z0-9.\-_/]{1,20}$/.test(item));
  return [...new Set(symbols)].slice(0, MAX_SYMBOLS);
}

function normalizeUrl(value) {
  const raw = clampString(value, MAX_URL_LEN);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function makeError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  Object.assign(err, extra);
  return err;
}

function emptyFarmbot() {
  return { queueId: null, scheduledAt: null, status: null, publication: null, lastCheckedAt: null };
}

/**
 * Merge a FarmBot patch onto the stored block. Only fields present in the
 * patch are touched, so a reconciler that only knows the status cannot wipe
 * the queue ID a previous call recorded.
 */
function mergeFarmbot(current, input) {
  const next = { ...emptyFarmbot(), ...(current || {}) };
  if (!input || typeof input !== "object") return next;
  if ("queueId" in input) next.queueId = clampString(input.queueId, MAX_SHORT_LEN) || null;
  if ("scheduledAt" in input) next.scheduledAt = toIso(input.scheduledAt);
  if ("status" in input) next.status = clampString(input.status, 40) || null;
  if ("lastCheckedAt" in input) next.lastCheckedAt = toIso(input.lastCheckedAt);
  if ("publication" in input) {
    const pub = input.publication;
    next.publication = pub && typeof pub === "object"
      ? {
        receiptId: clampString(pub.receiptId, MAX_SHORT_LEN) || null,
        postId: clampString(pub.postId ?? pub.messageId, MAX_SHORT_LEN) || null,
        url: normalizeUrl(pub.url),
        postedAt: toIso(pub.postedAt),
      }
      : null;
  }
  return next;
}

function hasPublicationProof(farmbot) {
  const pub = farmbot?.publication;
  return Boolean(pub && (pub.receiptId || pub.postId || pub.url));
}

/**
 * The stage a failed record failed at. Records written before `failedFrom`
 * existed fall back to what their approval field proves: approved if it was
 * ever approved, otherwise verified — never further than the evidence goes.
 */
function failedStage(record) {
  if (FAILABLE_STATUSES.includes(record.failedFrom)) return record.failedFrom;
  return record.approval === "approved" ? "approved" : "verified";
}

/**
 * Where a record may move next. A failed record resumes only at the stage it
 * failed from, or that stage's own next step — so a failure can never be used
 * to skip verification or approval (discovered → failed → queued is refused).
 */
function allowedTransitions(record) {
  if (record.status !== "failed") return TRANSITIONS[record.status] || [];
  const stage = failedStage(record);
  return [stage, ...TRANSITIONS[stage].filter((status) => status !== "failed")];
}

/**
 * Evidence each status must carry for as long as the record holds it — not
 * only at the moment of transition, so a later metadata PATCH cannot erase it.
 */
function evidenceError(status, farmbot, error) {
  if (status === "queued" && !farmbot?.queueId) return "Queued requires farmbot.queueId.";
  if (status === "posted" && !hasPublicationProof(farmbot)) {
    return "Posted requires farmbot.publication with a receiptId, postId or url.";
  }
  if (status === "failed" && !error) return "Failed requires the exact error.";
  return null;
}

class ReporterNewsLogStore {
  constructor({ dataDir, logger = console, cap = DEFAULT_CAP, timeZone = DEFAULT_TIMEZONE } = {}) {
    this._dataDir = dataDir;
    this._file = path.join(dataDir, "reporter-news-log.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._cap = cap;
    this._timeZone = timeZone;
  }

  get timeZone() {
    return this._timeZone;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed?.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  _write(records) {
    const ok = writeJsonAtomic(
      this._file,
      { version: LOG_VERSION, records: records.slice(0, this._cap) },
      this._logger,
      "[ReporterNewsLog]",
    );
    // Intake promises a durable receipt. A write that didn't land must not be
    // reported back as one.
    if (!ok) throw makeError("Reporter news log could not be written; retry the request.", 503);
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "Reporter news log is busy; retry the request.",
    });
  }

  _nextId() {
    return `rnl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /** The dedupe identity: canonical URL first, then source + sourceId. */
  static dedupeKey({ canonicalUrl, source, sourceId }) {
    if (canonicalUrl) return `url:${canonicalUrl}`;
    // Without a URL, an ID only identifies a story within its source: two
    // providers can both have item "123", so both halves are required.
    if (source && sourceId) return `src:${source.toLowerCase()}:${sourceId}`;
    return null;
  }

  /**
   * Log a verified (or merely discovered) candidate. Returns a durable receipt:
   * `{ record, created, deduplicated }`. A repeat of the same canonical URL or
   * source ID updates the existing record — filling blanks, refreshing the
   * summary — and never moves its workflow status backwards.
   */
  intake(input = {}, { actor = "system" } = {}) {
    return this._withLock(() => this._intake(input, { actor }));
  }

  _intake(input, { actor }) {
    const headline = clampString(input.headline || input.title, MAX_TITLE_LEN);
    const url = normalizeUrl(input.url || input.canonicalUrl);
    const canonicalUrl = canonicalizeUrl(input.canonicalUrl || input.url);
    const source = clampString(input.source, 80);
    const sourceId = clampString(input.sourceId, MAX_SHORT_LEN) || null;
    const key = ReporterNewsLogStore.dedupeKey({ canonicalUrl, source, sourceId });

    if (!headline) throw makeError("headline is required.", 400);
    if (!key) throw makeError("A valid http(s) url, or both source and sourceId, is required for deduplication.", 400);

    const requestedStatus = input.status === undefined ? "verified" : normalizeStatus(input.status);
    if (!requestedStatus || !INTAKE_STATUSES.includes(requestedStatus)) {
      throw makeError(
        `Intake status must be one of ${INTAKE_STATUSES.join(", ")}. Approval, queueing and posting are recorded with PATCH.`,
        400,
      );
    }

    const records = this._read();
    const now = nowIso();
    const existing = records.find((record) => record.dedupeKey === key);
    const fields = {
      headline,
      url,
      canonicalUrl,
      source: source || null,
      sourceId,
      publishedAt: toIso(input.publishedAt),
      market: normalizeMarket(input.market || input.category || input.newsType),
      symbols: normalizeSymbols(input.symbols),
      summary: clampString(input.summary, MAX_SUMMARY_LEN) || null,
      imageUrl: normalizeUrl(input.imageUrl || input.image),
      capturedBy: clampString(input.capturedBy, 60) || null,
    };

    if (existing) {
      // Fill blanks and refresh descriptive fields; identity and dates stay.
      Object.entries(fields).forEach(([field, value]) => {
        if (field === "symbols") {
          if (value.length) existing.symbols = [...new Set([...(existing.symbols || []), ...value])].slice(0, MAX_SYMBOLS);
          return;
        }
        if (value !== null && value !== "" && (field === "summary" || field === "imageUrl" || !existing[field])) {
          existing[field] = value;
        }
      });
      // discovered -> verified is the only status a repeat intake may advance.
      if (existing.status === "discovered" && requestedStatus === "verified") {
        this._applyStatus(existing, "verified", { actor, claimedBy: fields.capturedBy, at: now });
      }
      existing.intakeCount = (existing.intakeCount || 1) + 1;
      existing.lastSeenAt = now;
      existing.updatedAt = now;
      this._write(records);
      return { record: existing, created: false, deduplicated: true };
    }

    const capturedAt = toIso(input.capturedAt) || now;
    const record = {
      id: this._nextId(),
      dedupeKey: key,
      ...fields,
      capturedAt,
      // Always derived, never taken from the caller: the nightly close
      // depends on every record landing on the Vancouver day it was captured.
      // Backfills supply a historical capturedAt instead.
      reporterDate: dayKey(capturedAt, this._timeZone),
      status: requestedStatus,
      verification: requestedStatus === "verified" ? "verified" : "unverified",
      approval: "pending",
      farmbot: emptyFarmbot(),
      error: null,
      intakeCount: 1,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      history: [{
        at: now,
        status: requestedStatus,
        actor,
        ...(fields.capturedBy ? { claimedBy: fields.capturedBy } : {}),
        note: "logged",
      }],
    };
    records.unshift(record);
    this._write(records);
    return { record, created: true, deduplicated: false };
  }

  _applyStatus(record, status, { actor, claimedBy, at, note } = {}) {
    if (status === "failed") record.failedFrom = record.status;
    else delete record.failedFrom;
    record.status = status;
    if (status === "verified") record.verification = "verified";
    if (status === "approved" || status === "queued" || status === "posted") record.approval = "approved";
    if (status === "rejected") record.approval = "rejected";
    record.history = [
      ...(record.history || []),
      {
        at,
        status,
        actor: actor || "system",
        ...(claimedBy ? { claimedBy } : {}),
        ...(note ? { note } : {}),
      },
    ].slice(-MAX_HISTORY_PER_RECORD);
  }

  /**
   * Advance a record's workflow and/or link FarmBot receipts. Enforces the
   * state machine and the evidence each state needs, checked against the
   * record as it would be saved — on every PATCH, not only on transitions:
   *   queued  -> a FarmBot queue ID
   *   posted  -> a publication receipt (receipt ID, post ID or URL) — never
   *              inferred from a helper response alone
   *   failed  -> the exact error
   *
   * `actor` is the trusted channel the write came through (set by the route);
   * `claimedBy` is the caller's own, unverified attribution, kept apart so a
   * key holder cannot write a trusted identity into the history.
   */
  update(id, patch = {}, { actor = "system", claimedBy = null } = {}) {
    return this._withLock(() => this._update(id, patch, { actor, claimedBy }));
  }

  _update(id, patch, { actor, claimedBy }) {
    const records = this._read();
    const record = records.find((item) => item.id === id);
    if (!record) return null;
    const now = nowIso();

    let nextStatus = record.status;
    if (patch.status !== undefined) {
      nextStatus = normalizeStatus(patch.status);
      if (!nextStatus) throw makeError(`status must be one of ${STATUSES.join(", ")}.`, 400);
      if (nextStatus !== record.status && !allowedTransitions(record).includes(nextStatus)) {
        throw makeError(`Cannot move a ${record.status} record to ${nextStatus}.`, 409, { currentStatus: record.status });
      }
    }
    const changing = nextStatus !== record.status;

    const farmbot = patch.farmbot ? mergeFarmbot(record.farmbot, patch.farmbot) : record.farmbot || emptyFarmbot();
    let error = patch.error !== undefined ? clampString(patch.error, MAX_ERROR_LEN) || null : record.error;
    // A record that leaves `failed` keeps its history but sheds the stale error.
    if (changing && record.status === "failed" && patch.error === undefined) error = null;

    const missing = evidenceError(nextStatus, farmbot, error);
    if (missing) throw makeError(missing, 400);

    let verification = record.verification;
    if (patch.verification !== undefined) {
      verification = clampString(patch.verification, 20).toLowerCase();
      if (!VERIFICATION_STATUSES.includes(verification)) {
        throw makeError(`verification must be one of ${VERIFICATION_STATUSES.join(", ")}.`, 400);
      }
    }

    // Everything is validated; only now mutate.
    record.verification = verification;
    if (patch.symbols !== undefined) record.symbols = normalizeSymbols(patch.symbols);
    if (patch.market !== undefined) record.market = normalizeMarket(patch.market);
    if (patch.summary !== undefined) record.summary = clampString(patch.summary, MAX_SUMMARY_LEN) || null;
    record.farmbot = farmbot;
    record.error = error;
    if (changing) {
      this._applyStatus(record, nextStatus, {
        actor,
        claimedBy: clampString(claimedBy, 60) || null,
        at: now,
        note: clampString(patch.note, 200) || undefined,
      });
    }
    record.updatedAt = now;
    this._write(records);
    return record;
  }

  get(id) {
    return this._read().find((record) => record.id === id) || null;
  }

  /** Look up by canonical URL or source ID without creating anything. */
  find({ url, source, sourceId } = {}) {
    const key = ReporterNewsLogStore.dedupeKey({
      canonicalUrl: canonicalizeUrl(url),
      source: clampString(source, 80),
      sourceId: clampString(sourceId, MAX_SHORT_LEN) || null,
    });
    if (!key) return null;
    return this._read().find((record) => record.dedupeKey === key) || null;
  }

  /**
   * Records for one America/Vancouver reporter day, filtered, with counts.
   * Counts are taken before the status filter so the summary strip always
   * describes the whole day.
   */
  daily({ date, market, source, symbol, status } = {}) {
    const day = isDayKey(date) ? date : dayKey(new Date(), this._timeZone);
    const wantMarket = market ? normalizeMarket(market) : null;
    const wantSource = clampString(source, 80).toLowerCase();
    const wantSymbol = normalizeSymbols(symbol)[0] || null;
    const wantStatus = status ? normalizeStatus(status) : null;

    const dayRecords = this._read().filter((record) => record.reporterDate === day);
    const scoped = dayRecords.filter((record) =>
      (!wantMarket || record.market === wantMarket)
      && (!wantSource || String(record.source || "").toLowerCase() === wantSource)
      && (!wantSymbol || (record.symbols || []).includes(wantSymbol)));

    const counts = Object.fromEntries(STATUSES.map((value) => [value, 0]));
    scoped.forEach((record) => { if (counts[record.status] !== undefined) counts[record.status] += 1; });

    const records = wantStatus ? scoped.filter((record) => record.status === wantStatus) : scoped;
    const sources = [...new Set(dayRecords.map((record) => record.source).filter(Boolean))].sort();
    const symbols = [...new Set(dayRecords.flatMap((record) => record.symbols || []))].sort();

    return {
      date: day,
      timeZone: this._timeZone,
      total: scoped.length,
      counts,
      records: records.map(({ history, dedupeKey, ...rest }) => rest),
      facets: { sources, symbols, markets: MARKETS },
    };
  }

  /** Recent reporter days with record totals, newest first. */
  days({ limit = 30 } = {}) {
    const totals = new Map();
    this._read().forEach((record) => {
      totals.set(record.reporterDate, (totals.get(record.reporterDate) || 0) + 1);
    });
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 30, 366)))
      .map(([date, total]) => ({ date, total }));
  }
}

module.exports = {
  ReporterNewsLogStore,
  STATUSES,
  INTAKE_STATUSES,
  MARKETS,
  TRANSITIONS,
  allowedTransitions,
  dayKey,
  normalizeMarket,
  normalizeSymbols,
};
