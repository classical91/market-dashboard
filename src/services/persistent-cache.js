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
const { resolveDataDir } = require("../utils/data-dir");

class PersistentReporterCache {
  /**
   * @param {string} filePath  Absolute path to the JSON cache file.
   *                           Defaults to <project-root>/data/reporter-cache.json
   */
  constructor(filePath) {
    this._file = filePath || path.join(resolveDataDir(), "reporter-cache.json");
    this._map = new Map();
    this._inflight = new Map();
    this._load();
  }

  /* ── private: hydrate from disk ── */
  _load() {
    this._loadedAt = new Date().toISOString();
    this._loadState = "empty";
    this._loadError = null;
    this._expiredOnLoad = 0;
    try {
      const raw = fs.readFileSync(this._file, "utf8");
      const parsed = JSON.parse(raw);
      const now = Date.now();
      let expired = 0;
      for (const [k, entry] of Object.entries(parsed)) {
        if (entry.expiresAt > now) this._map.set(k, entry);
        else expired += 1;
      }
      this._loadState = "loaded";
      this._expiredOnLoad = expired;
      console.log(`[PersistentCache] Loaded ${this._map.size} valid entries from ${this._file}`);
    } catch (err) {
      // A missing file on first boot is normal. A corrupt one is not, and
      // starting fresh silently makes a persistence fault look exactly like
      // a legitimate expiry — so say which one this was.
      if (err.code === "ENOENT") {
        this._loadState = "absent";
        return;
      }
      this._loadState = err instanceof SyntaxError ? "corrupt" : "unreadable";
      this._loadError = err.message;
      console.error(`[PersistentCache] Could not read ${this._file} (${this._loadState}): ${err.message}`);
    }
  }

  /**
   * Where this cache actually lives and whether it survived the last boot.
   *
   * `storageSource` reports which setting chose the directory — it does NOT
   * prove a Railway volume is really mounted there, only that the app was
   * told to use it. Confirming the mount is still an operational check.
   * `default` is the one that matters: the file is then on container-local
   * disk and disappears on every deploy.
   */
  describe() {
    const railwayVolume = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
    const dataDir = String(process.env.DATA_DIR || "").trim();
    return {
      file: this._file,
      storageSource: dataDir ? "data-dir" : railwayVolume ? "railway-volume" : "default",
      explicitDataDirConfigured: Boolean(dataDir || railwayVolume),
      loadState: this._loadState,
      loadError: this._loadError,
      loadedAt: this._loadedAt,
      entriesLoaded: this._loadState === "loaded" ? this._map.size : 0,
      expiredOnLoad: this._expiredOnLoad || 0,
      entries: this._map.size,
    };
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

  /** Removes an entry and flushes, so the deletion survives a restart too. */
  delete(key) {
    this._inflight.delete(key);
    const existed = this._map.delete(key);
    if (existed) this._save();
    return existed;
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
