"use strict";

// Where completed backtest experiments are kept.
//
// This is the seam. Everything above it (routes, backtester) speaks only
// `record` / `get` / `list` / `count`, so replacing this file with a SQLite or
// Postgres implementation is a swap, not a rewrite. Nothing outside this file
// knows there is a JSON file at all.
//
// Two separations are deliberate:
//
//   From the ledger. Experiments live under `<dataDir>/research/`, never under
//   `<dataDir>/trading-lab/<book>/`. Research history and money-shaped state
//   are different kinds of data with different lifetimes, and a reset of one
//   must never be able to touch the other.
//
//   From the run. Recording is a caller's explicit choice, so replaying bars
//   during development or in a test leaves no trace.
//
// Writes go through write-then-rename, the same way the paper trader persists
// its books: a crash mid-write leaves the previous file intact rather than a
// truncated one.

const fs = require("fs");
const path = require("path");

const { resolveDataDir } = require("../../utils/data-dir");

// Newest-first, and bounded. A research log that grows without limit
// eventually makes every read slower for data nobody looks at; the cap is
// generous enough that it should never bite in practice.
const DEFAULT_CAP = 1000;

class ExperimentStore {
  constructor({ dataDir = resolveDataDir(), cap = DEFAULT_CAP, logger = console } = {}) {
    this.dir = path.join(dataDir, "research");
    this.file = path.join(this.dir, "experiments.json");
    this.cap = Number(cap) > 0 ? Number(cap) : DEFAULT_CAP;
    this._logger = logger;
  }

  // A corrupt or half-written file must not take the dashboard down: the
  // research log is not load-bearing for trading. Read failures degrade to an
  // empty list and are logged once per read, and the next successful write
  // repairs the file.
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8").trim();
    } catch {
      return []; // Nothing recorded yet.
    }
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._logger.warn?.(`[ExperimentStore] ${this.file} is not an array — ignoring its contents`);
        return [];
      }
      // Entries without an id cannot be fetched or de-duplicated, so they are
      // dropped rather than served as half-records.
      return parsed.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
    } catch (err) {
      this._logger.warn?.(`[ExperimentStore] Ignoring unreadable ${this.file}: ${err.message}`);
      return [];
    }
  }

  _write(entries) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries.slice(0, this.cap), null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /** Persist one experiment record. Returns the record as stored. */
  record(experiment) {
    if (!experiment || typeof experiment.id !== "string" || !experiment.id) {
      throw Object.assign(new Error("An experiment needs a string id"), { statusCode: 400, expose: true });
    }
    const entries = this._read();
    // Re-recording an id replaces it rather than creating a second copy —
    // makes a retried write idempotent.
    const next = [experiment, ...entries.filter((e) => e.id !== experiment.id)];
    this._write(next);
    return experiment;
  }

  /** One experiment by id, or null. */
  get(id) {
    const key = String(id || "");
    return this._read().find((entry) => entry.id === key) || null;
  }

  /**
   * Newest-first experiments, optionally filtered.
   *
   * Filters are exact matches on the fields a researcher actually groups by.
   * Symbol and timeframe are compared case-insensitively because "btcusdt"
   * and "BTCUSDT" are the same experiment.
   */
  list({ strategy, version, symbol, timeframe, limit = 100 } = {}) {
    const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    const rows = this._read().filter(
      (entry) =>
        (strategy === undefined || entry.strategy === strategy) &&
        (version === undefined || entry.strategyVersion === version) &&
        (symbol === undefined || eq(entry.symbol, symbol)) &&
        (timeframe === undefined || eq(entry.timeframe, timeframe)),
    );
    const capped = Math.min(Math.max(Number(limit) || 100, 1), this.cap);
    return { total: rows.length, items: rows.slice(0, capped) };
  }

  count() {
    return this._read().length;
  }
}

module.exports = { ExperimentStore, DEFAULT_CAP };
