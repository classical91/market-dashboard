const fs = require("fs");
const path = require("path");

function itemKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

// Small persisted list of "tokens I'm trading" — a simple flat JSON file
// rather than PersistentReporterCache, since a watchlist entry has no TTL:
// it stays until the user removes it, not until it expires.
class WatchlistService {
  constructor({ dataDir }) {
    this._file = path.join(dataDir, "watchlist.json");
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _write(items) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(items, null, 2), "utf8");
    } catch (err) {
      console.error("[Watchlist] Failed to write watchlist file:", err.message);
    }
  }

  list() {
    return this._read();
  }

  add(symbol, interval, label) {
    const items = this._read();
    const key = itemKey(symbol, interval);
    if (items.some((i) => itemKey(i.symbol, i.interval) === key)) return items;
    items.unshift({ symbol, interval, label: label || symbol, addedAt: new Date().toISOString() });
    this._write(items);
    return items;
  }

  remove(symbol, interval) {
    const items = this._read().filter((i) => itemKey(i.symbol, i.interval) !== itemKey(symbol, interval));
    this._write(items);
    return items;
  }
}

module.exports = { WatchlistService };
