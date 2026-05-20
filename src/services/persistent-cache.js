/**
 * PersistentReporterCache
 *
 * Stores the latest generated report as a JSON file on disk so it survives
 * server restarts. Falls back to in-memory silently if file I/O fails.
 *
 * Structure of cache file:
 *   { "key": { "value": <report>, "expiresAt": <ms timestamp> } }
 */

const fs = require("fs");
const path = require("path");

class PersistentReporterCache {
  /**
   * @param {string} filePath  Absolute path to the JSON cache file.
   *                           Defaults to <project-root>/data/reporter-cache.json
   */
  constructor(filePath) {
    this._file = filePath || path.join(process.cwd(), "data", "reporter-cache.json");
    this._map = new Map();
    this._inflight = new Map();
    this._load();
  }

  /* ── private: hydrate from disk ── */
  _load() {
    try {
      const raw = fs.readFileSync(this._file, "utf8");
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for (const [k, entry] of Object.entries(parsed)) {
        if (entry.expiresAt > now) {
          this._map.set(k, entry);
        }
      }
      console.log(`[PersistentCache] Loaded ${this._map.size} valid entries from ${this._file}`);
    } catch {
      /* file doesn't exist yet or parse error — start fresh */
    }
  }

  /* ── private: flush to disk ── */
  _save() {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this._map);
      fs.writeFileSync(this._file, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      console.error("[PersistentCache] Failed to write cache file:", err.message);
    }
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    this._map.set(key, { value, expiresAt });
    this._save();
    return value;
  }

  async getOrLoad(key, ttlMs, loader) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    if (this._inflight.has(key)) return this._inflight.get(key);

    const pending = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (ttlMs > 0) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this._inflight.delete(key);
      });

    this._inflight.set(key, pending);
    return pending;
  }
}

module.exports = { PersistentReporterCache };
