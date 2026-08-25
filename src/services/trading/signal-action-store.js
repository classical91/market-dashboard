"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function legacyActionId(entry) {
  const identity = JSON.stringify([
    entry.timestamp || null,
    entry.symbol || null,
    entry.interval || null,
    entry.direction || null,
    entry.status || null,
    entry.reason || null,
  ]);
  return `legacy-signal-action-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entry = { ...value };
  const legacy = !entry.id;
  if (legacy) entry.id = legacyActionId(entry);

  // signal-bridge-log.json predates explicit source/strategy attribution. Its
  // old rows can be recovered without guessing: this store was written only by
  // the Signal Bot bridge until live-scanner rows began carrying their own
  // source and strategy. Preserve that derivation in the payload so audits can
  // distinguish recovered history from fields persisted at event time.
  if (legacy && !entry.source && !entry.strategy && entry.symbol && entry.direction && entry.interval) {
    entry.source = "signal-bot";
    entry.strategy = `signal-bot:${entry.interval}`;
    entry.attributionRecovered = true;
  }
  return entry;
}

class SignalActionStore {
  constructor({ dataDir, logger = console, cap = 2000 } = {}) {
    this._file = path.join(dataDir, "signal-bridge-log.json");
    this._logger = logger;
    this._cap = cap;
  }

  _read({ normalize = true } = {}) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return normalize ? parsed.map(normalizeEntry) : parsed;
    } catch {
      return [];
    }
  }

  _write(entries) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(entries.slice(0, this._cap), null, 2), "utf8");
    } catch (err) {
      this._logger.error?.("[SignalActionStore] Failed to write action log:", err.message);
    }
  }

  record(action) {
    // Keep historical bytes historical. Normalization is a read view; writing
    // one new event must not silently backfill older production rows.
    const entries = this._read({ normalize: false });
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...action,
    };
    entries.unshift(entry);
    this._write(entries);
    return entry;
  }

  recent(limit = 50) {
    return this._read().slice(0, limit);
  }

  count() {
    return this._read({ normalize: false }).length;
  }
}

module.exports = { SignalActionStore, legacyActionId, normalizeEntry };
