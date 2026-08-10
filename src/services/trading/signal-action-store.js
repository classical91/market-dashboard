"use strict";

const fs = require("fs");
const path = require("path");

class SignalActionStore {
  constructor({ dataDir, logger = console, cap = 2000 } = {}) {
    this._file = path.join(dataDir, "signal-bridge-log.json");
    this._logger = logger;
    this._cap = cap;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
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
    const entries = this._read();
    const entry = {
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
    return this._read().length;
  }
}

module.exports = { SignalActionStore };
