"use strict";

/**
 * NewsroomCycleStore
 *
 * One durable record per newsroom reporting run. The reporter generation log
 * already preserves *what was written* and the broadcast ledger preserves
 * *what was sent*; neither answers "did the 13:00 run happen, and how far did
 * it get?" — which is the question an operator actually has when a cron fires
 * into silence. A cycle is that missing spine: it links the two existing
 * records under one id and records the states between them.
 *
 * Persistence follows the same idiom as BroadcastLedgerStore: one JSON file
 * under DATA_DIR, rewritten whole under an exclusive lock and via an atomic
 * rename, capped. No new storage technology — the reporter has no database
 * layer, and the locked/atomic JSON primitives here were built for exactly
 * this fan-out-and-write pattern.
 *
 * File shape:
 *   { "version": 2, "cycles": [ <newest first> ] }
 *
 * Generation failures and delivery failures are deliberately different
 * statuses. A cycle that generated its report and failed to deliver must never
 * be regenerated — the text already exists and costs money to remake — so the
 * status has to distinguish the two rather than collapsing into "failed".
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { classifyFailure } = require("./failure-classification");

// 2 adds `generationRef` to each generated section: the exact stored
// generation that section stands for. Version 1 records have no such field and
// are read as they were written — the reader resolves them by cycle id,
// section and exact timestamp instead, and refuses rather than guessing when
// that cannot identify one generation. Nothing rewrites an old record.
const CYCLE_VERSION = 2;
const DEFAULT_CAP = 200;
const MAX_FAILURES_PER_CYCLE = 30;

const CYCLE_STATUSES = [
  "queued",
  "preflight_failed",
  "generating",
  "generated",
  "generation_failed",
  "delivering",
  "completed",
  "delivery_partial",
  "delivery_failed",
];

// States where work is currently in flight. A second invocation that lands on
// one of these must attach to the existing cycle rather than starting a
// parallel run.
const ACTIVE_STATUSES = new Set(["queued", "generating", "delivering"]);

// States where the report exists and only delivery is outstanding. Re-running
// a cycle in one of these must go straight to delivery.
const GENERATED_STATUSES = new Set(["generated", "delivering", "delivery_partial", "delivery_failed", "completed"]);

const TRIGGERS = ["cron", "manual", "api", "backfill"];

const MAX_ID_LEN = 120;
const MAX_TEXT_LEN = 500;

function clampString(value, max = MAX_TEXT_LEN) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function isFiniteDate(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

/**
 * The scheduled identity of a cycle, floored to the minute.
 *
 * Two cron invocations for the same slot — a retry, an overlapping worker, a
 * webhook replayed by the gateway — produce the same key and therefore the
 * same cycle. Flooring to the minute is what makes "the 13:00 run" a single
 * thing even when the two calls arrive seconds apart with different
 * sub-second timestamps.
 */
function scheduledCycleKey(scheduledAt) {
  const date = isFiniteDate(scheduledAt) ? new Date(scheduledAt) : new Date();
  date.setSeconds(0, 0);
  return `scheduled:${date.toISOString()}`;
}

/** Stable id for a cycle key, so the same slot yields the same id anywhere. */
function cycleIdForKey(cycleKey) {
  return `cyc_${crypto.createHash("sha256").update(String(cycleKey)).digest("hex").slice(0, 16)}`;
}

function normalizeSections(sections, fallback = []) {
  const list = Array.isArray(sections) ? sections : [];
  const cleaned = [...new Set(list.map((section) => clampString(section, 40)).filter(Boolean))];
  return cleaned.length ? cleaned : [...fallback];
}

function normalizeDestination(input) {
  if (!input || typeof input !== "object") return null;
  return {
    newsType: clampString(input.newsType, 40) || null,
    channel: clampString(input.channel || "telegram", 60) || "telegram",
    chatId: clampString(input.chatId, 120) || null,
    threadId: clampString(input.threadId, 120) || null,
    messageId: clampString(input.messageId, 120) || null,
    status: ["posted", "failed", "pending"].includes(input.status) ? input.status : "pending",
    error: clampString(input.error) || null,
  };
}

/**
 * The exact generation a recorded section stands for.
 *
 * A reference is only worth storing if it can identify one generation, so a
 * reference with no usable timestamp is stored as null rather than as a
 * half-reference that would later have to be guessed at. A null `cycleId` is
 * meaningful and preserved: it says the generation was made outside a cycle.
 */
function normalizeGenerationRef(input, fallbackSection) {
  if (!input || typeof input !== "object") return null;
  const generatedAt = isFiniteDate(input.generatedAt) ? new Date(input.generatedAt).toISOString() : null;
  const section = clampString(input.section, 40) || clampString(fallbackSection, 40);
  if (!generatedAt || !section) return null;
  return {
    cycleId: clampString(input.cycleId, MAX_ID_LEN) || null,
    generatedAt,
    section,
  };
}

function destinationKey(destination) {
  return `${destination.newsType || ""}:${destination.channel}:${destination.chatId || ""}:${destination.threadId || ""}`;
}

class NewsroomCycleStore {
  constructor({ dataDir, logger = console, cap = DEFAULT_CAP } = {}) {
    this._file = path.join(dataDir, "newsroom-cycles.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._cap = cap;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed?.cycles) ? parsed.cycles : [];
    } catch {
      return [];
    }
  }

  _write(cycles) {
    writeJsonAtomic(
      this._file,
      { version: CYCLE_VERSION, cycles: cycles.slice(0, this._cap) },
      this._logger,
      "[Newsroom]",
    );
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "Newsroom cycle store is busy; retry the request.",
    });
  }

  /**
   * Start the cycle for this key, or hand back the one that already exists.
   *
   * The find-or-create runs inside the exclusive lock, which is what makes a
   * doubled cron invocation impossible to fork: the second caller either sees
   * the first caller's cycle or waits for the lock and then sees it.
   */
  startCycle(input = {}) {
    return this._withLock(() => this._startCycle(input));
  }

  _startCycle(input = {}) {
    const cycles = this._read();
    const cycleKey = clampString(input.cycleKey, MAX_ID_LEN) || scheduledCycleKey(input.scheduledAt);
    const existing = cycles.find((cycle) => cycle.cycleKey === cycleKey);
    if (existing) return { cycle: existing, created: false };

    const scheduledAt = isFiniteDate(input.scheduledAt) ? new Date(input.scheduledAt).toISOString() : nowIso();
    const cycle = {
      id: cycleIdForKey(cycleKey),
      cycleKey,
      version: CYCLE_VERSION,
      status: "queued",
      trigger: TRIGGERS.includes(input.trigger) ? input.trigger : "manual",
      scheduledAt,
      startedAt: nowIso(),
      completedAt: null,
      updatedAt: nowIso(),
      reporter: {
        model: clampString(input.reporter?.model, 80) || null,
        // Where the model is actually routed from. In this deployment that is
        // OpenAI directly for the dashboard and OpenClaw for ShareBot; the
        // repository can only record what it was told.
        provider: clampString(input.reporter?.provider, 80) || null,
      },
      sectionsExpected: normalizeSections(input.sectionsExpected),
      sectionsGenerated: [],
      receiptIds: [],
      destinations: [],
      failures: [],
      preflight: null,
      // Newest failure, duplicated here so a health read does not have to scan
      // the whole failure list.
      lastError: null,
    };

    cycles.unshift(cycle);
    this._write(cycles);
    return { cycle, created: true };
  }

  getCycle(idOrKey) {
    const wanted = clampString(idOrKey, MAX_ID_LEN);
    if (!wanted) return null;
    return this._read().find((cycle) => cycle.id === wanted || cycle.cycleKey === wanted) || null;
  }

  /**
   * Apply `mutate` to the stored cycle under the lock and persist the result.
   * Every public mutator goes through here so no caller can read-modify-write
   * a cycle outside the lock.
   */
  _mutate(id, mutate) {
    return this._withLock(() => {
      const cycles = this._read();
      const index = cycles.findIndex((cycle) => cycle.id === id || cycle.cycleKey === id);
      if (index === -1) return null;
      const next = mutate({ ...cycles[index] });
      if (!next) return cycles[index];
      next.updatedAt = nowIso();
      cycles[index] = next;
      this._write(cycles);
      return next;
    });
  }

  setStatus(id, status, { completedAt } = {}) {
    if (!CYCLE_STATUSES.includes(status)) throw new Error(`Unknown cycle status: ${status}`);
    return this._mutate(id, (cycle) => {
      cycle.status = status;
      if (status === "completed" || status === "delivery_failed" || status === "generation_failed" || status === "preflight_failed") {
        cycle.completedAt = completedAt || cycle.completedAt || nowIso();
      }
      if (status === "completed") cycle.lastError = null;
      return cycle;
    });
  }

  recordPreflight(id, preflight) {
    return this._mutate(id, (cycle) => {
      cycle.preflight = {
        at: nowIso(),
        ok: Boolean(preflight?.ok),
        checks: Array.isArray(preflight?.checks)
          ? preflight.checks.slice(0, 30).map((check) => ({
              name: clampString(check.name, 60),
              ok: Boolean(check.ok),
              // pass / warn / fail. A check can be ok and still be a warn —
              // an unverifiable external route lets the cycle run but is not
              // evidence that the route works.
              status: clampString(check.status, 20) || (check.ok ? "pass" : "fail"),
              detail: clampString(check.detail),
              ...(check.code ? { code: clampString(check.code, 60) } : {}),
              ...(check.skipped ? { skipped: true } : {}),
            }))
          : [],
      };
      return cycle;
    });
  }

  /**
   * Record that a section now exists for this cycle.
   *
   * `sources` is whatever evidence the generation actually returned. It is
   * never synthesized: a provider response with no citations records an empty
   * list, because an invented source URL is worse than none.
   *
   * `generationRef` is the entry's link to the exact stored generation it
   * represents — `{ cycleId, generatedAt, section }`, with a null `cycleId`
   * for a generation made outside a cycle. Delivery reads the report back
   * through it, so a retry sends this cycle's text rather than whatever is
   * newest. For a reused same-day section the reference points at the
   * *original* generation, and `reusedFromCycleId` names the cycle that wrote
   * it, so the reuse stays traceable.
   */
  recordSectionGenerated(id, input = {}) {
    return this._mutate(id, (cycle) => {
      const section = clampString(input.section, 40);
      if (!section) return cycle;
      const entry = {
        section,
        generatedAt: isFiniteDate(input.generatedAt) ? new Date(input.generatedAt).toISOString() : nowIso(),
        model: clampString(input.model, 80) || null,
        // The prompt body lives in the reporter generation log. Only a hash
        // travels on the cycle, so a custom prompt is traceable without this
        // record carrying text an operator may not want in a health read.
        promptHash: clampString(input.promptHash, 64) || null,
        hasCustomPrompt: Boolean(input.hasCustomPrompt),
        contentLength: Number.isFinite(Number(input.contentLength)) ? Number(input.contentLength) : null,
        // True when the section was already generated today and reused rather
        // than re-requested from the provider.
        reused: Boolean(input.reused),
        generationRef: normalizeGenerationRef(input.generationRef, section),
        // Readability only: the same cycle id the reference already carries,
        // surfaced where a reader looking at a reused section expects it.
        reusedFromCycleId: clampString(input.reusedFromCycleId, MAX_ID_LEN) || null,
        sources: Array.isArray(input.sources)
          ? input.sources.slice(0, 50).map((source) => ({
              url: clampString(source?.url, 2000) || null,
              title: clampString(source?.title, 300) || null,
            })).filter((source) => source.url || source.title)
          : [],
        sourceMetadata: {
          available: Array.isArray(input.sources) && input.sources.length > 0,
          reason: clampString(input.sourcesUnavailableReason) || null,
        },
      };
      const rest = cycle.sectionsGenerated.filter((item) => item.section !== section);
      cycle.sectionsGenerated = [...rest, entry].sort((a, b) => a.section.localeCompare(b.section));
      return cycle;
    });
  }

  /** Attach ledger receipts and the destinations they actually reached. */
  recordDelivery(id, input = {}) {
    return this._mutate(id, (cycle) => {
      const receiptIds = Array.isArray(input.receiptIds) ? input.receiptIds : [];
      cycle.receiptIds = [...new Set([...cycle.receiptIds, ...receiptIds.map((value) => clampString(value, MAX_ID_LEN)).filter(Boolean)])];

      if (Array.isArray(input.destinations)) {
        const merged = new Map(cycle.destinations.map((destination) => [destinationKey(destination), destination]));
        input.destinations
          .map(normalizeDestination)
          .filter(Boolean)
          .forEach((destination) => {
            const key = destinationKey(destination);
            merged.set(key, { ...(merged.get(key) || {}), ...destination });
          });
        cycle.destinations = [...merged.values()];
      }
      return cycle;
    });
  }

  /**
   * Append a classified failure. Classification happens here rather than at
   * the call site so every stored failure carries the same vocabulary, and so
   * "was this retryable?" survives in the record instead of only in the code
   * path that made the decision at the time.
   */
  recordFailure(id, input = {}) {
    const classification = input.classification || classifyFailure(input.error, { phase: input.phase });
    return this._mutate(id, (cycle) => {
      const failure = {
        at: nowIso(),
        phase: clampString(input.phase, 40) || classification.phase || "unknown",
        section: clampString(input.section, 40) || null,
        newsType: clampString(input.newsType, 40) || null,
        class: classification.class,
        retryable: classification.retryable,
        code: classification.code,
        status: classification.status ?? null,
        message: clampString(classification.message),
        reason: clampString(classification.reason),
      };
      cycle.failures = [...cycle.failures, failure].slice(-MAX_FAILURES_PER_CYCLE);
      cycle.lastError = failure;
      return cycle;
    });
  }

  list({ limit = 50, status, since, trigger } = {}) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const sinceMs = since && isFiniteDate(since) ? new Date(since).getTime() : null;
    return this._read()
      .filter((cycle) => (status ? cycle.status === status : true))
      .filter((cycle) => (trigger ? cycle.trigger === trigger : true))
      .filter((cycle) => (sinceMs ? isFiniteDate(cycle.startedAt) && new Date(cycle.startedAt).getTime() >= sinceMs : true))
      .slice(0, cap);
  }

  /** Most recent cycle, optionally restricted to a status. */
  latest({ status } = {}) {
    const cycles = this._read();
    if (!status) return cycles[0] || null;
    return cycles.find((cycle) => cycle.status === status) || null;
  }

  count() {
    return this._read().length;
  }
}

module.exports = {
  NewsroomCycleStore,
  scheduledCycleKey,
  cycleIdForKey,
  CYCLE_STATUSES,
  ACTIVE_STATUSES,
  GENERATED_STATUSES,
  TRIGGERS,
  CYCLE_VERSION,
};
