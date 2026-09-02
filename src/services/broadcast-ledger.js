"use strict";

/**
 * BroadcastLedgerStore
 *
 * Durable record of every completed news broadcast, shared by all three
 * posting paths (the iOS/GPT shortcut, the ShareBot67 OpenClaw agent, and
 * manual posting). It exists because a live acknowledgment can be missed
 * while the OpenClaw gateway is down, but a stored receipt cannot: when
 * ShareBot67 reconnects it reconciles against this ledger instead of
 * assuming a story it can't see was never sent.
 *
 * Persistence follows the same idiom as SignalActionStore / ExperimentStore —
 * one JSON file under DATA_DIR (a Railway volume in production), rewritten
 * whole on each mutation and capped. That keeps the dependency footprint at
 * zero and survives restarts, but it is safe on a single replica only.
 *
 * File shape:
 *   { "version": 2, "settings": { ... }, "receipts": [ <newest first> ] }
 *
 * Message bodies are never stored — only a normalized hash plus the
 * headline — so the ledger can dedupe without holding private text.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");

const LEDGER_VERSION = 2;
const DEFAULT_CAP = 5000;
const MAX_ATTEMPTS_PER_RECEIPT = 20;

// "telegram-ingest" means the post was observed in the channel rather than
// reported by a posting path. It is deliberately its own source: we know the
// story went out, but not which of the three paths sent it.
const SOURCES = ["shortcut", "sharebot67", "manual", "dashboard", "telegram-ingest"];

// Sources that name the path that actually did the broadcasting. Everything
// here is a claim by the sender itself; "telegram-ingest" is the residual —
// a post nobody claimed, which in practice means it was sent by hand.
const ATTRIBUTED_SOURCES = SOURCES.filter((source) => source !== "telegram-ingest");
const UNATTRIBUTED_SOURCE = "telegram-ingest";
const KINDS = ["story", "digest"];
const STATUSES = ["pending", "posted", "partial", "failed", "blocked", "reconciled"];
const DESTINATION_STATUSES = ["pending", "posted", "failed"];
const ALLOWED_CATEGORIES = ["Stock", "Crypto", "Geopolitics", "Economics", "Markets", "Technology", "General News"];
const DUPLICATE_WINDOWS = ["off", "same-day", "6h", "24h", "42h"];
const HISTORY_DAYS = [30, 90, 180, null];
const DEFAULT_SETTINGS = Object.freeze({
  requireExactCategory: true,
  recordBlockedAttempts: true,
  // Keep finance broadcasts off the general Telegram fan-out unless an
  // operator explicitly disables this policy in Ledger Settings.
  financeTopicRoutingEnabled: true,
  allowedCategories: ALLOWED_CATEGORIES,
  categoryLimits: { Geopolitics: 1 },
  duplicateWindows: Object.fromEntries(ALLOWED_CATEGORIES.map((category) => [category, "42h"])),
  timezone: "America/Vancouver",
  historyDays: null,
  notifications: { blocked: true, failed: true, missingCategory: true },
  editDeleteEnabled: true,
  visibleSources: ["shortcut", "dashboard", "sharebot67", "manual", "telegram-ingest"],
  destinationLabels: {},
});

// Query/campaign parameters that never change which story a URL points at.
// Stripping them is what lets the same article shared from Telegram, X and a
// newsletter collapse onto one canonical URL.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^igshid$/i,
  /^mc_(cid|eid)$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^cmpid$/i,
  /^s$/i,
  /^t$/i,
];

const MAX_TITLE_LEN = 300;
const MAX_URL_LEN = 2000;
const MAX_TEXT_LEN = 50000;
const MAX_ERROR_LEN = 500;
const MAX_NEWS_TYPE_LEN = 40;
const MAX_DESTINATIONS = 50;
const MAX_ID_LEN = 120;

/** Default window for the conservative tier-3 headline match. */
const DEFAULT_HEADLINE_WINDOW_MS = 36 * 60 * 60 * 1000;
const CAPACITY_RESERVATION_TTL_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clampString(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function normalizeSettings(input = {}) {
  const defaults = cloneDefaults();
  const allowedCategories = Array.isArray(input.allowedCategories)
    ? [...new Set(input.allowedCategories.map((value) => clampString(String(value), MAX_NEWS_TYPE_LEN)).filter(Boolean))].slice(0, 20)
    : defaults.allowedCategories;
  const categories = allowedCategories.length ? allowedCategories : defaults.allowedCategories;
  const categoryLimits = {};
  categories.forEach((category) => {
    const value = Number(input.categoryLimits?.[category]);
    if (Number.isInteger(value) && value > 0 && value <= 100) categoryLimits[category] = value;
  });
  if (!Object.keys(categoryLimits).length && !input.categoryLimits) Object.assign(categoryLimits, defaults.categoryLimits);
  const duplicateWindows = {};
  categories.forEach((category) => {
    const value = input.duplicateWindows?.[category];
    duplicateWindows[category] = DUPLICATE_WINDOWS.includes(value) ? value : defaults.duplicateWindows[category] || "42h";
  });
  const historyDays = input.historyDays === null || input.historyDays === "forever"
    ? null
    : HISTORY_DAYS.includes(Number(input.historyDays)) ? Number(input.historyDays) : defaults.historyDays;
  const timezone = clampString(input.timezone, 80) || defaults.timezone;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date()); } catch { return { ...defaults, allowedCategories: categories, categoryLimits, duplicateWindows }; }
  const destinationLabels = {};
  if (input.destinationLabels && typeof input.destinationLabels === "object") {
    Object.entries(input.destinationLabels).slice(0, 100).forEach(([key, value]) => {
      const label = clampString(String(value), 80);
      if (label) destinationLabels[clampString(String(key), 260)] = label;
    });
  }
  return {
    requireExactCategory: input.requireExactCategory !== false,
    recordBlockedAttempts: input.recordBlockedAttempts !== false,
    financeTopicRoutingEnabled: input.financeTopicRoutingEnabled !== false,
    allowedCategories: categories,
    categoryLimits,
    duplicateWindows,
    timezone,
    historyDays,
    notifications: {
      blocked: input.notifications?.blocked !== false,
      failed: input.notifications?.failed !== false,
      missingCategory: input.notifications?.missingCategory !== false,
    },
    editDeleteEnabled: input.editDeleteEnabled !== false,
    visibleSources: Array.isArray(input.visibleSources)
      ? input.visibleSources.filter((source) => SOURCES.includes(source))
      : defaults.visibleSources,
    destinationLabels,
  };
}

function dayKey(value, timeZone) {
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

function isFiniteDate(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

/**
 * Reduce a URL to the form two different posting paths would agree on:
 * https, lowercase host, no `www.`, no tracking params, no fragment, no
 * trailing slash. Returns null for anything that isn't a parseable http(s)
 * URL, which is what makes tier-1 dedupe safe to trust.
 */
function canonicalizeUrl(value) {
  const raw = clampString(value, MAX_URL_LEN);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;

  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.some((pattern) => pattern.test(key)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const query = params.length
    ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
    : "";

  let pathname = parsed.pathname || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");

  // Port is dropped when it's the protocol default so http://x:80 and
  // http://x canonicalize together.
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";

  return `https://${host}${port}${pathname}${query}`;
}

/**
 * Normalize free text down to the words that carry the story, so the same
 * item posted with different emoji, links, casing or spacing hashes alike.
 */
function normalizeText(value) {
  return clampString(value, MAX_TEXT_LEN)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(value) {
  const normalized = normalizeText(value);
  return normalized ? sha256(normalized) : null;
}

/** Headline comparison key for the advisory tier-3 match. */
function headlineKey(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const words = normalized.split(" ").filter((word) => word.length > 2);
  if (words.length < 3) return null;
  return words.slice(0, 12).join(" ");
}

function normalizeDestination(input) {
  if (!input || typeof input !== "object") return null;
  const channel = clampString(input.channel || input.platform || "telegram", 60) || "telegram";
  const status = DESTINATION_STATUSES.includes(input.status) ? input.status : "pending";
  const destination = {
    channel,
    chatId: clampString(String(input.chatId ?? input.chat_id ?? ""), 120) || null,
    threadId: clampString(String(input.threadId ?? input.thread_id ?? ""), 120) || null,
    label: clampString(input.label || input.name || "", 80) || null,
    status,
    messageId: clampString(String(input.messageId ?? input.message_id ?? ""), 120) || null,
    messageUrl: clampString(input.messageUrl || input.message_url || "", MAX_URL_LEN) || null,
    error: clampString(input.error || "", MAX_ERROR_LEN) || null,
  };
  return destination;
}

/** Stable identity for a destination so repeated PATCHes update in place. */
function destinationKey(destination) {
  return `${destination.channel}:${destination.chatId || ""}:${destination.threadId || ""}`;
}

/**
 * Derive the receipt status from its destination results. Callers may still
 * set status explicitly (a shortcut reporting a finished post knows more
 * than we can infer), but this is what keeps partial delivery honest when
 * results are recorded one channel at a time.
 */
function deriveStatus(destinations) {
  if (!destinations.length) return null;
  const posted = destinations.filter((d) => d.status === "posted").length;
  const failed = destinations.filter((d) => d.status === "failed").length;
  const pending = destinations.filter((d) => d.status === "pending").length;
  if (pending) return posted || failed ? "partial" : "pending";
  if (posted && failed) return "partial";
  if (posted) return "posted";
  if (failed) return "failed";
  return null;
}

/** A receipt counts as evidence the story went out if anything landed. */
function isPostedStatus(status) {
  return status === "posted" || status === "partial" || status === "reconciled";
}

class BroadcastLedgerStore {
  constructor({ dataDir, logger = console, cap = DEFAULT_CAP, headlineWindowMs } = {}) {
    this._dataDir = dataDir;
    this._file = path.join(dataDir, "broadcast-ledger.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._cap = cap;
    this._headlineWindowMs = headlineWindowMs || DEFAULT_HEADLINE_WINDOW_MS;
  }

  _readDocument() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      // Tolerate a bare array so a hand-edited or pre-version-1 file still
      // loads rather than silently starting over.
      if (Array.isArray(parsed)) return { receipts: parsed, settings: cloneDefaults() };
      return {
        receipts: Array.isArray(parsed?.receipts) ? parsed.receipts : [],
        settings: normalizeSettings(parsed?.settings),
      };
    } catch {
      return { receipts: [], settings: cloneDefaults() };
    }
  }

  _read() {
    return this._readDocument().receipts;
  }

  _withExclusiveLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "Broadcast ledger is busy; retry the request.",
    });
  }

  _write(receipts, settings = this._readDocument().settings) {
    const normalizedSettings = normalizeSettings(settings);
    const cutoff = normalizedSettings.historyDays
      ? Date.now() - normalizedSettings.historyDays * 24 * 60 * 60 * 1000
      : null;
    const retained = cutoff
      ? receipts.filter((receipt) => !isFiniteDate(receipt.createdAt) || new Date(receipt.createdAt).getTime() >= cutoff)
      : receipts;
    writeJsonAtomic(
      this._file,
      {
        version: LEDGER_VERSION,
        settings: normalizedSettings,
        receipts: retained.slice(0, this._cap),
      },
      this._logger,
      "[BroadcastLedger]",
    );
  }

  /** Where receipts are written — read by the preflight report. */
  get dataDir() {
    return this._dataDir;
  }

  getSettings() {
    return this._readDocument().settings;
  }

  updateSettings(patch = {}) {
    return this._withExclusiveLock(() => this._updateSettings(patch));
  }

  _updateSettings(patch = {}) {
    const data = this._readDocument();
    const settings = normalizeSettings({ ...data.settings, ...patch });
    this._write(data.receipts, settings);
    return settings;
  }

  _nextId() {
    return `rcpt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Create a receipt, or return the existing one when this idempotency key
   * has already been seen. Retries from a flaky phone connection therefore
   * cost nothing — the shortcut can POST the same payload as often as it
   * likes and the ledger holds one row.
   */
  createReceipt(input = {}) {
    return this._withExclusiveLock(() => this._createReceipt(input));
  }

  _createReceipt(input = {}) {
    const data = this._readDocument();
    const receipts = data.receipts;
    const settings = data.settings;
    const idempotencyKey = clampString(input.idempotencyKey, 200);

    if (idempotencyKey) {
      const existing = receipts.find((r) => r.idempotencyKey === idempotencyKey);
      if (existing) {
        // A repeat of the same key is an update, not a duplicate: a shortcut
        // that posts "pending" then re-posts "posted" under one key should
        // advance the receipt rather than fork it.
        const updated = this.updateReceipt(existing.id, input, { actor: input.source || "unknown" });
        return { receipt: updated || existing, created: false };
      }
    }

    const source = SOURCES.includes(input.source) ? input.source : "manual";

    // A path reporting itself claims the unattributed receipt the channel
    // watch may already have written for the same story, rather than adding a
    // second one. Without this the answer to "which path sent this?" depends
    // on a race: the watch polls on a timer, so whether it saw the post before
    // the sender's own call landed decided whether you got one receipt or two.
    //
    // Deliberately narrow. Only a "telegram-ingest" receipt is claimable,
    // because that source explicitly means "we know it went out, not who sent
    // it" — merging two receipts that both name a path would be guessing.
    if (ATTRIBUTED_SOURCES.includes(source)) {
      const claimable = this._findClaimable(input);
      if (claimable) {
        const updated = this.updateReceipt(
          claimable.id,
          {
            source,
            idempotencyKey: idempotencyKey || claimable.idempotencyKey,
            title: input.title || input.headline,
            url: input.url,
            destinations: Array.isArray(input.destinations) ? input.destinations : [],
            status: STATUSES.includes(input.status) ? input.status : undefined,
            action: "claim",
          },
          { actor: source },
        );
        return { receipt: updated || claimable, created: false, claimed: true };
      }
    }

    const title = clampString(input.title || input.headline, MAX_TITLE_LEN);
    const url = clampString(input.url, MAX_URL_LEN);
    const canonicalUrl = canonicalizeUrl(url);
    const text = clampString(input.text || input.content, MAX_TEXT_LEN);
    // Hash whatever the caller gave us: the body when present, otherwise the
    // headline, so a URL-less manual entry still has a tier-2 key.
    const contentHash = clampString(input.contentHash, 64) || hashText(text || title);

    const destinations = Array.isArray(input.destinations)
      ? input.destinations.slice(0, MAX_DESTINATIONS).map(normalizeDestination).filter(Boolean)
      : [];

    const explicitStatus = STATUSES.includes(input.status) ? input.status : null;
    const derivedStatus = deriveStatus(destinations);
    // An explicit status normally wins — the manual form's "partial" knows
    // something the destination rows don't. The exception is "pending": once
    // a destination has actually reported, the receipt is no longer pending
    // whatever the caller's default said, so a create that ships a failed
    // destination is recorded as failed rather than left looking unstarted.
    const status =
      explicitStatus && !(explicitStatus === "pending" && derivedStatus)
        ? explicitStatus
        : derivedStatus || explicitStatus || "pending";

    const receipt = {
      id: this._nextId(),
      idempotencyKey: idempotencyKey || null,
      // The newsroom cycle this delivery belongs to, when one exists. Null for
      // every other sender and for every receipt written before cycles
      // existed — the field is additive and nothing reads it as required.
      cycleId: clampString(input.cycleId, MAX_ID_LEN) || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source,
      kind: KINDS.includes(input.kind) ? input.kind : "story",
      // Category is sender-owned data. Never guess from keywords: missing or
      // unsupported labels stay visibly Unclassified.
      newsType: settings.allowedCategories.includes(clampString(input.newsType || input.category, MAX_NEWS_TYPE_LEN))
        ? clampString(input.newsType || input.category, MAX_NEWS_TYPE_LEN)
        : "Unclassified",
      title: title || null,
      url: url || null,
      canonicalUrl,
      urlHash: canonicalUrl ? sha256(canonicalUrl).slice(0, 32) : null,
      contentHash: contentHash || null,
      headlineKey: headlineKey(title),
      destinations,
      status,
      error: input.error ? { message: clampString(input.error.message || input.error, MAX_ERROR_LEN) } : null,
      reconciledWith: null,
      attempts: [
        {
          at: nowIso(),
          actor: source,
          action: clampString(input.action, 60) || "create",
          ok: isPostedStatus(status),
          detail: clampString(input.detail, MAX_ERROR_LEN) || `status=${status}`,
        },
      ],
    };

    receipts.unshift(receipt);
    this._write(receipts, settings);
    return { receipt, created: true };
  }

  /**
   * Record destination results or a status change against an existing
   * receipt. Destinations merge by channel+chat+thread so a broadcast that
   * reports each channel separately ends up with one row per channel.
   */
  updateReceipt(id, patch = {}, { actor = "unknown" } = {}) {
    return this._withExclusiveLock(() => this._updateReceipt(id, patch, { actor }));
  }

  _updateReceipt(id, patch = {}, { actor = "unknown" } = {}) {
    const receipts = this._read();
    const index = receipts.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const receipt = { ...receipts[index] };

    if (Array.isArray(patch.destinations)) {
      const merged = new Map(receipt.destinations.map((d) => [destinationKey(d), d]));
      patch.destinations
        .slice(0, MAX_DESTINATIONS)
        .map(normalizeDestination)
        .filter(Boolean)
        .forEach((destination) => {
          const key = destinationKey(destination);
          merged.set(key, { ...(merged.get(key) || {}), ...destination });
        });
      receipt.destinations = [...merged.values()].slice(0, MAX_DESTINATIONS);
    }

    if (typeof patch.title === "string" && patch.title.trim()) {
      receipt.title = clampString(patch.title, MAX_TITLE_LEN);
      receipt.headlineKey = headlineKey(receipt.title);
    }
    if (typeof patch.url === "string" && patch.url.trim() && !receipt.canonicalUrl) {
      const canonicalUrl = canonicalizeUrl(patch.url);
      receipt.url = clampString(patch.url, MAX_URL_LEN);
      receipt.canonicalUrl = canonicalUrl;
      receipt.urlHash = canonicalUrl ? sha256(canonicalUrl).slice(0, 32) : null;
    }

    if (patch.error) {
      receipt.error = { message: clampString(patch.error.message || patch.error, MAX_ERROR_LEN) };
    } else if (patch.error === null) {
      receipt.error = null;
    }

    const explicitStatus = STATUSES.includes(patch.status) ? patch.status : null;
    const derived = deriveStatus(receipt.destinations);
    // An explicit status wins, but a receipt that already reached "posted"
    // is never walked back to "pending" by a late-arriving partial result.
    if (explicitStatus) {
      receipt.status = explicitStatus;
    } else if (derived) {
      receipt.status = isPostedStatus(receipt.status) && derived === "pending" ? receipt.status : derived;
    }

    // Only ever set by a claim: the sender naming itself is strictly better
    // information than "observed in the channel".
    if (SOURCES.includes(patch.source) && receipt.source === UNATTRIBUTED_SOURCE) {
      receipt.source = patch.source;
    }
    if (typeof patch.idempotencyKey === "string" && patch.idempotencyKey) {
      receipt.idempotencyKey = clampString(patch.idempotencyKey, 200);
    }
    // A cycle id is only ever set, never cleared: the first sender to name its
    // cycle owns the link, and a later plain update must not orphan the
    // receipt from the cycle that produced it.
    if (typeof patch.cycleId === "string" && patch.cycleId.trim() && !receipt.cycleId) {
      receipt.cycleId = clampString(patch.cycleId, MAX_ID_LEN);
    }
    if (typeof patch.newsType === "string" && patch.newsType.trim()) {
      const category = clampString(patch.newsType, MAX_NEWS_TYPE_LEN);
      const settings = this.getSettings();
      receipt.newsType = settings.allowedCategories.includes(category) ? category : "Unclassified";
    }

    if (typeof patch.reconciledWith === "string") {
      receipt.reconciledWith = clampString(patch.reconciledWith, 80) || null;
    }

    receipt.updatedAt = nowIso();
    receipt.attempts = [
      ...(receipt.attempts || []),
      {
        at: nowIso(),
        actor: clampString(actor, 60) || "unknown",
        action: clampString(patch.action, 60) || "update",
        ok: isPostedStatus(receipt.status),
        detail:
          clampString(patch.detail, MAX_ERROR_LEN) ||
          clampString(patch.error?.message || patch.error || "", MAX_ERROR_LEN) ||
          `status=${receipt.status}`,
      },
    ].slice(-MAX_ATTEMPTS_PER_RECEIPT);

    receipts[index] = receipt;
    this._write(receipts);
    return receipt;
  }

  deleteReceipt(id) {
    return this._withExclusiveLock(() => this._deleteReceipt(id));
  }

  _deleteReceipt(id) {
    const receipts = this._read();
    const index = receipts.findIndex((receipt) => receipt.id === id);
    if (index === -1) return null;
    const [deleted] = receipts.splice(index, 1);
    this._write(receipts);
    return deleted;
  }

  /**
   * True when some receipt already records this exact platform message.
   *
   * This is what keeps the channel watcher from re-recording a broadcast the
   * dashboard itself just sent: that receipt already carries the Telegram
   * message ID, so the post coming back as an update is recognized rather
   * than duplicated — regardless of whether Telegram echoes a bot's own
   * channel posts back to it.
   */
  hasMessage(channel, chatId, messageId) {
    if (!chatId || !messageId) return false;
    const wanted = { channel: String(channel), chatId: String(chatId), messageId: String(messageId) };
    return this._read().some((receipt) =>
      (receipt.destinations || []).some(
        (destination) =>
          destination.channel === wanted.channel &&
          String(destination.chatId) === wanted.chatId &&
          String(destination.messageId) === wanted.messageId,
      ),
    );
  }

  /**
   * The unattributed receipt covering this same story, if there is one.
   * Uses the authoritative dedupe tiers only — a headline/time-window guess is
   * far too loose to hang a merge on.
   */
  _findClaimable(input) {
    const canonicalUrl = canonicalizeUrl(input.url);
    const contentHash =
      clampString(input.contentHash, 64) ||
      hashText(clampString(input.text || input.content, MAX_TEXT_LEN) || clampString(input.title || input.headline, MAX_TITLE_LEN));
    if (!canonicalUrl && !contentHash) return null;

    return (
      this._read().find(
        (receipt) =>
          receipt.source === UNATTRIBUTED_SOURCE &&
          ((canonicalUrl && receipt.canonicalUrl === canonicalUrl) ||
            (contentHash && receipt.contentHash === contentHash)),
      ) || null
    );
  }

  /**
   * How many broadcasts came from each path. `unattributed` is the count the
   * channel watch recorded without anyone claiming them — stories that went
   * out by hand, or from a path that isn't reporting itself yet.
   */
  sourceBreakdown({ since } = {}) {
    const counts = {};
    SOURCES.forEach((source) => {
      counts[source] = 0;
    });
    this.list({ limit: 500, since }).forEach((receipt) => {
      if (counts[receipt.source] === undefined) counts[receipt.source] = 0;
      counts[receipt.source] += 1;
    });
    return { bySource: counts, unattributed: counts[UNATTRIBUTED_SOURCE] || 0 };
  }

  getReceipt(id) {
    return this._read().find((r) => r.id === id) || null;
  }

  /**
   * Three-tier dedupe, most trustworthy first:
   *   1. canonical URL   — authoritative
   *   2. content hash    — authoritative
   *   3. headline + time — ADVISORY ONLY
   *
   * Tier 3 never reports `posted: true`. A false positive there would
   * silently suppress a real story forever, which is worse than the
   * occasional duplicate this whole ledger exists to prevent — so it
   * returns `match: "likely"` with candidates and lets the caller decide.
   */
  lookup({ url, headline, title, text, hash, windowMs } = {}) {
    const receipts = this._read().filter((r) => isPostedStatus(r.status));
    const empty = { posted: false, match: "none", receipt: null, candidates: [] };

    const canonicalUrl = canonicalizeUrl(url);
    if (canonicalUrl) {
      const hit = receipts.find((r) => r.canonicalUrl === canonicalUrl);
      if (hit) return { posted: true, match: "url", receipt: hit, candidates: [] };
    }

    const contentHash = clampString(hash, 64) || hashText(text || "");
    if (contentHash) {
      const hit = receipts.find((r) => r.contentHash === contentHash);
      if (hit) return { posted: true, match: "hash", receipt: hit, candidates: [] };
    }

    const key = headlineKey(headline || title);
    if (key) {
      const cutoff = Date.now() - (Number(windowMs) > 0 ? Number(windowMs) : this._headlineWindowMs);
      const candidates = receipts.filter(
        (r) => r.headlineKey === key && isFiniteDate(r.createdAt) && new Date(r.createdAt).getTime() >= cutoff,
      );
      if (candidates.length) {
        return { posted: false, match: "likely", receipt: null, candidates: candidates.slice(0, 5) };
      }
    }

    return empty;
  }

  list({ limit = 50, status, source, newsType, since, query, cycleId } = {}) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const sinceMs = since && isFiniteDate(since) ? new Date(since).getTime() : null;
    const needle = normalizeText(query || "");
    return this._read()
      .filter((r) => (status === "broadcasted" ? isPostedStatus(r.status) : status ? r.status === status : true))
      .filter((r) => (source ? r.source === source : true))
      .filter((r) => (newsType ? r.newsType === newsType : true))
      .filter((r) => (cycleId ? r.cycleId === cycleId : true))
      .filter((r) => (sinceMs ? isFiniteDate(r.createdAt) && new Date(r.createdAt).getTime() >= sinceMs : true))
      .filter((r) => (needle ? normalizeText(`${r.id} ${r.title || ""}`).includes(needle) : true))
      .slice(0, cap);
  }

  dailySummary({ at = new Date(), timeZone } = {}) {
    const settings = this.getSettings();
    const zone = timeZone || settings.timezone;
    const targetDay = dayKey(at, zone);
    const summary = { date: targetDay, timeZone: zone, total: 0, byCategory: {}, byStatus: {} };
    this._read().forEach((receipt) => {
      if (!isFiniteDate(receipt.createdAt) || dayKey(receipt.createdAt, zone) !== targetDay) return;
      summary.total += 1;
      const category = receipt.newsType || "Unclassified";
      const status = isPostedStatus(receipt.status) ? "broadcasted" : receipt.status;
      summary.byCategory[category] = summary.byCategory[category] || {};
      summary.byCategory[category][status] = (summary.byCategory[category][status] || 0) + 1;
      summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
    });
    return summary;
  }

  guard(input = {}) {
    return this._withExclusiveLock(() => this._guard(input));
  }

  _guard(input = {}) {
    const settings = this.getSettings();
    const requested = clampString(input.newsType || input.category, MAX_NEWS_TYPE_LEN);
    const newsType = settings.allowedCategories.includes(requested) ? requested : "Unclassified";
    const source = SOURCES.includes(input.source) ? input.source : "sharebot67";
    const idempotencyKey = clampString(input.idempotencyKey || input.attemptId, 200);
    const title = clampString(input.title || input.headline, MAX_TITLE_LEN);
    const text = clampString(input.text || input.content, MAX_TEXT_LEN);
    const url = clampString(input.url, MAX_URL_LEN);
    let reason = null;

    if (idempotencyKey) {
      const existing = this._read().find((receipt) => receipt.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.status === "blocked") {
          return { allowed: false, reason: existing.error?.message || "Attempt already blocked.", receipt: existing };
        }
        if (isPostedStatus(existing.status)) {
          return { allowed: false, reason: "Attempt already broadcast.", receipt: existing };
        }
        return { allowed: true, reason: null, receipt: existing, settings: { newsType: existing.newsType, dailyLimit: settings.categoryLimits[existing.newsType] || null } };
      }
    }

    if (settings.requireExactCategory && newsType === "Unclassified") {
      reason = requested
        ? `Category "${requested}" is not allowed.`
        : "An exact news category is required.";
    }

    const dailyLimit = settings.categoryLimits[newsType];
    if (!reason && dailyLimit) {
      const today = dayKey(new Date(), settings.timezone);
      const reservationCutoff = Date.now() - CAPACITY_RESERVATION_TTL_MS;
      const capacityUsed = this._read().filter(
        (receipt) =>
          receipt.newsType === newsType &&
          isFiniteDate(receipt.createdAt) &&
          dayKey(receipt.createdAt, settings.timezone) === today &&
          (
            isPostedStatus(receipt.status) ||
            (
              receipt.status === "pending" &&
              isFiniteDate(receipt.updatedAt || receipt.createdAt) &&
              new Date(receipt.updatedAt || receipt.createdAt).getTime() >= reservationCutoff
            )
          ),
      ).length;
      if (capacityUsed >= dailyLimit) {
        reason = `${newsType} daily limit reached or reserved (${capacityUsed}/${dailyLimit}, resets in ${settings.timezone}).`;
      }
    }

    if (reason) {
      let receipt = null;
      if (settings.recordBlockedAttempts) {
        receipt = this.createReceipt({
          source,
          newsType,
          title: title || "Blocked broadcast attempt",
          text,
          url,
          status: "blocked",
          error: reason,
          idempotencyKey,
          action: "guard-blocked",
          detail: reason,
        }).receipt;
      }
      return { allowed: false, reason, receipt, settings: { newsType, dailyLimit: dailyLimit || null } };
    }

    const receipt = this.createReceipt({
      source,
      newsType,
      title,
      text,
      url,
      status: "pending",
      idempotencyKey,
      action: "guard",
      detail: `${newsType} allowed`,
    }).receipt;
    return { allowed: true, reason: null, receipt, settings: { newsType, dailyLimit: dailyLimit || null } };
  }

  /**
   * Recovery path. For each unfinished receipt in the window, look for an
   * independently posted receipt covering the same story. When one exists
   * the work is already done — mark it reconciled so ShareBot67 neither
   * reports a failure nor reposts. Anything with no match is returned as
   * genuinely outstanding.
   */
  reconcile({ ids, windowMs = 48 * 60 * 60 * 1000 } = {}) {
    const receipts = this._read();
    const cutoff = Date.now() - (Number(windowMs) > 0 ? Number(windowMs) : 48 * 60 * 60 * 1000);

    const targets = receipts.filter((r) => {
      if (Array.isArray(ids) && ids.length) return ids.includes(r.id);
      if (r.status !== "pending" && r.status !== "failed") return false;
      return isFiniteDate(r.createdAt) && new Date(r.createdAt).getTime() >= cutoff;
    });

    const reconciled = [];
    const outstanding = [];

    targets.forEach((target) => {
      if (isPostedStatus(target.status)) return;
      const match = receipts.find(
        (other) =>
          other.id !== target.id &&
          isPostedStatus(other.status) &&
          ((target.canonicalUrl && other.canonicalUrl === target.canonicalUrl) ||
            (target.contentHash && other.contentHash === target.contentHash)),
      );
      if (match) {
        const updated = this.updateReceipt(target.id, {
          status: "reconciled",
          reconciledWith: match.id,
          action: "reconcile",
        }, { actor: "reconcile" });
        reconciled.push({ id: target.id, reconciledWith: match.id, source: match.source, receipt: updated });
      } else {
        outstanding.push({ id: target.id, status: target.status, title: target.title, url: target.canonicalUrl });
      }
    });

    return { checked: targets.length, reconciled, outstanding };
  }

  count() {
    return this._read().length;
  }
}

module.exports = {
  BroadcastLedgerStore,
  canonicalizeUrl,
  normalizeText,
  hashText,
  headlineKey,
  deriveStatus,
  isPostedStatus,
  SOURCES,
  ATTRIBUTED_SOURCES,
  UNATTRIBUTED_SOURCE,
  KINDS,
  STATUSES,
  ALLOWED_CATEGORIES,
  DEFAULT_SETTINGS,
  LEDGER_VERSION,
};
