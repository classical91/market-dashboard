"use strict";

// The Research Queue — experiments worth running, before they have been run.
//
// ── Why this is a separate store from ExperimentStore ───────────────────────
//
// ExperimentStore records what a backtest DID: a finished run, its metrics, the
// rules it was scored under, the commit that produced it. It is a log, and a log
// entry only exists once the work is over.
//
// The research workflow needs the other half — what is worth running and why,
// before anyone runs it:
//
//   Market Research  →  Backtest  →  Demo Account  →  Promotion Decision
//        ^^^^^^^^
//
// Bolting a `status: "queued"` field onto an experiment record would mean a
// research log where most rows have no metrics, no scoring version and no
// commit — every consumer of that log would then have to remember to filter.
// A queued item and a finished experiment are different shapes because they
// answer different questions, and they are linked by `experimentId` once the
// run completes.
//
// ── What a queue item is not ────────────────────────────────────────────────
//
// It is not permission, and it is not a demo account. Queuing
// "smc_v1 × ETHUSDT × 1h" says a BACKTEST is worth running. Live Research is
// single-symbol (LIVE_RESEARCH_SYMBOL, BTCUSDT by default), so no queue entry
// can produce forward-paper evidence on another pair, and nothing here touches
// a strategy ledger or lifecycle status.

const fs = require("fs");
const path = require("path");

const { resolveDataDir } = require("../../utils/data-dir");

// Where a queue item came from. Recorded because "why is this worth testing?"
// is the first question a researcher asks of a candidate list, and an answer
// reconstructed later is a guess.
const ORIGINS = Object.freeze([
  // A pair the screener surfaced as worth testing.
  "market-discovery",
  // A regime read that suggests a strategy family may behave differently here.
  "regime-discovery",
  // A Decision Engine execution plan, used as a seed rather than as a trade.
  "decision-engine",
  // Someone asked for it directly.
  "manual",
]);

const STATUSES = Object.freeze(["queued", "running", "done", "failed"]);

// Bounded like the experiment log, for the same reason: a queue nobody drains
// should not make every read slower forever.
const DEFAULT_CAP = 500;

function newQueueId() {
  return `rq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The identity of an experiment candidate.
 *
 * Strategy, symbol and timeframe — the three things that make one backtest
 * different from another. Case-insensitive on symbol and timeframe because
 * "btcusdt" and "BTCUSDT" are the same experiment, and a queue that holds both
 * is a queue that runs the same work twice.
 */
function candidateKey({ strategy, symbol, timeframe }) {
  return [
    String(strategy || "").toLowerCase(),
    String(symbol || "").toLowerCase(),
    String(timeframe || "").toLowerCase(),
  ].join("|");
}

class ResearchQueue {
  constructor({ dataDir = resolveDataDir(), cap = DEFAULT_CAP, logger = console } = {}) {
    this.dir = path.join(dataDir, "research");
    this.file = path.join(this.dir, "queue.json");
    this.cap = Number(cap) > 0 ? Number(cap) : DEFAULT_CAP;
    this._logger = logger;
  }

  // A corrupt or half-written file degrades to an empty queue rather than
  // taking the dashboard down. Research planning is not load-bearing for
  // trading, and the next successful write repairs the file.
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8").trim();
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this._logger.error?.(`[ResearchQueue] Ignoring unreadable queue file: ${err.message}`);
      return [];
    }
  }

  _write(entries) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries.slice(0, this.cap), null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /**
   * Add a candidate, or return the existing one.
   *
   * Enqueuing is idempotent on strategy × symbol × timeframe while an item is
   * still outstanding: discovery runs on a schedule and would otherwise pile up
   * hundreds of copies of "smc_v1 × ETHUSDT × 1h" every time it ran.
   *
   * A COMPLETED item does not block a new one — re-testing a pair after new
   * candles have arrived is the normal research loop, not a duplicate.
   */
  enqueue({ strategy, symbol, timeframe, origin = "manual", rationale = null, regime = null }) {
    if (!strategy || !symbol || !timeframe) {
      throw Object.assign(new Error("A research candidate needs strategy, symbol and timeframe"), {
        statusCode: 400,
        expose: true,
      });
    }
    if (!ORIGINS.includes(origin)) {
      throw Object.assign(new Error(`Unknown research origin "${origin}" (expected ${ORIGINS.join(", ")})`), {
        statusCode: 400,
        expose: true,
      });
    }

    const entries = this._read();
    const key = candidateKey({ strategy, symbol, timeframe });
    const outstanding = entries.find(
      (entry) => candidateKey(entry) === key && (entry.status === "queued" || entry.status === "running"),
    );
    if (outstanding) return { ...outstanding, deduped: true };

    const item = {
      id: newQueueId(),
      createdAt: new Date().toISOString(),
      strategy: String(strategy),
      symbol: String(symbol).toUpperCase(),
      timeframe: String(timeframe),
      status: "queued",
      origin,
      // Why this is worth running, in the words of whatever proposed it.
      rationale: rationale ? String(rationale) : null,
      // The environment at the moment it was proposed. A candidate raised in a
      // range and run months later in a trend is not the same question, and
      // without this the difference is invisible.
      regimeAtQueue: regime || null,
      startedAt: null,
      completedAt: null,
      // Links to the ExperimentStore record once the backtest has run.
      experimentId: null,
      error: null,
    };

    this._write([item, ...entries]);
    return item;
  }

  /** Enqueue many candidates, reporting which were new. */
  enqueueMany(candidates = []) {
    const added = [];
    const deduped = [];
    for (const candidate of candidates) {
      const item = this.enqueue(candidate);
      (item.deduped ? deduped : added).push(item);
    }
    return { added, deduped, total: added.length + deduped.length };
  }

  get(id) {
    const key = String(id || "");
    return this._read().find((entry) => entry.id === key) || null;
  }

  /** Newest-first, optionally filtered by status, strategy, symbol or origin. */
  list({ status, strategy, symbol, timeframe, origin, limit = 100 } = {}) {
    const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    const rows = this._read().filter(
      (entry) =>
        (status === undefined || entry.status === status) &&
        (strategy === undefined || eq(entry.strategy, strategy)) &&
        (symbol === undefined || eq(entry.symbol, symbol)) &&
        (timeframe === undefined || eq(entry.timeframe, timeframe)) &&
        (origin === undefined || entry.origin === origin),
    );
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return { total: rows.length, items: rows.slice(0, capped) };
  }

  /**
   * Move an item through the workflow.
   *
   * Statuses are set here rather than by the caller mutating a record, so a
   * "done" item always carries the experiment it produced and a "failed" one
   * always carries why — the two facts that make a queue auditable afterwards.
   */
  update(id, { status, experimentId = undefined, error = undefined }) {
    const entries = this._read();
    const index = entries.findIndex((entry) => entry.id === String(id || ""));
    if (index === -1) {
      throw Object.assign(new Error(`No research candidate with id ${id}`), { statusCode: 404, expose: true });
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      throw Object.assign(new Error(`Unknown research status "${status}" (expected ${STATUSES.join(", ")})`), {
        statusCode: 400,
        expose: true,
      });
    }

    const current = entries[index];
    const next = {
      ...current,
      ...(status === undefined ? {} : { status }),
      ...(experimentId === undefined ? {} : { experimentId: experimentId ? String(experimentId) : null }),
      ...(error === undefined ? {} : { error: error ? String(error) : null }),
      ...(status === "running" ? { startedAt: new Date().toISOString() } : {}),
      ...(status === "done" || status === "failed" ? { completedAt: new Date().toISOString() } : {}),
    };

    entries[index] = next;
    this._write(entries);
    return next;
  }

  /** Drop finished items, keeping the outstanding work. Returns how many went. */
  clearCompleted() {
    const entries = this._read();
    const keep = entries.filter((entry) => entry.status === "queued" || entry.status === "running");
    this._write(keep);
    return entries.length - keep.length;
  }

  count() {
    return this._read().length;
  }
}

module.exports = { ResearchQueue, ORIGINS, STATUSES, candidateKey };
