// Logs every newly-detected pattern/divergence with its entry price, then
// resolves each one after a horizon proportional to its timeframe by
// checking whether price actually moved in the direction the bias implied.
// This is the accuracy feedback loop the scanners otherwise lack — without
// it there's no way to know if "Falling Wedge" or "Regular Bullish
// Divergence" mean anything on this token universe versus noise.
const fs = require("fs");
const path = require("path");

// Bars-based horizons translated to wall-clock time (24 bars is a common
// forward-return window in this kind of backtest).
const RESOLVE_HORIZON_MS = {
  "1h": 24 * 60 * 60 * 1000,
  "4h": 4 * 24 * 60 * 60 * 1000,
  "1D": 10 * 24 * 60 * 60 * 1000,
};
const DEFAULT_HORIZON_MS = RESOLVE_HORIZON_MS["4h"];

// A move smaller than this in either direction is scored "flat" (neither a
// hit nor a miss) rather than forced into one bucket or the other.
const MOVE_THRESHOLD_PCT = 0.02;

class PatternTrackerService {
  constructor({ dataDir, fetchPrice }) {
    this._file = path.join(dataDir, "pattern-track-log.json");
    this._fetchPrice = fetchPrice;
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
      // Capped so the file can't grow unbounded over months of scanning.
      fs.writeFileSync(this._file, JSON.stringify(entries.slice(0, 2000), null, 2), "utf8");
    } catch (err) {
      console.error("[PatternTracker] Failed to write track log:", err.message);
    }
  }

  /**
   * Records a newly-observed pattern or divergence instance. Call this once
   * per instance (e.g. on a null->pattern or pattern-A->pattern-B
   * transition), not on every scan it remains visible.
   */
  log({ symbol, interval, kind, name, bias, entryPrice, detectedAt }) {
    const entries = this._read();
    const entry = {
      id: `${symbol}:${interval}:${kind}:${detectedAt}`,
      symbol,
      interval,
      kind,
      name,
      bias,
      entryPrice,
      detectedAt,
      resolveAt: new Date(new Date(detectedAt).getTime() + (RESOLVE_HORIZON_MS[interval] || DEFAULT_HORIZON_MS)).toISOString(),
      status: "pending",
    };
    entries.unshift(entry);
    this._write(entries);
    return entry;
  }

  /**
   * Resolves every pending entry whose horizon has passed: fetches the
   * current price, compares it against the entry price in the direction the
   * bias implied, and scores it hit/miss/flat. Entries whose price fetch
   * fails are left pending and retried next cycle.
   */
  async resolveDue() {
    const entries = this._read();
    const now = Date.now();
    const due = entries.filter((e) => e.status === "pending" && new Date(e.resolveAt).getTime() <= now);
    if (!due.length) return [];

    const resolved = [];
    for (const entry of due) {
      try {
        const price = await this._fetchPrice(entry.symbol);
        const returnPct = (price - entry.entryPrice) / entry.entryPrice;
        const favorableReturn = entry.bias === "bullish" ? returnPct : -returnPct;
        entry.resolvedAt = new Date().toISOString();
        entry.resolvedPrice = price;
        entry.returnPct = Number((returnPct * 100).toFixed(2));
        entry.outcome = favorableReturn >= MOVE_THRESHOLD_PCT ? "hit" : favorableReturn <= -MOVE_THRESHOLD_PCT ? "miss" : "flat";
        entry.status = "resolved";
        resolved.push(entry);
      } catch (err) {
        console.error(`[PatternTracker] Failed to resolve ${entry.symbol}:`, err.message);
      }
    }
    if (resolved.length) this._write(entries);
    return resolved;
  }

  _summarize(list) {
    const hits = list.filter((e) => e.outcome === "hit").length;
    const misses = list.filter((e) => e.outcome === "miss").length;
    const flats = list.filter((e) => e.outcome === "flat").length;
    const decisive = hits + misses;
    return {
      total: list.length,
      hits,
      misses,
      flats,
      hitRate: decisive ? Number(((hits / decisive) * 100).toFixed(1)) : null,
    };
  }

  stats() {
    const resolved = this._read().filter((e) => e.status === "resolved");
    const byName = {};
    resolved.forEach((e) => {
      if (!byName[e.name]) byName[e.name] = [];
      byName[e.name].push(e);
    });
    const byPattern = {};
    Object.keys(byName).forEach((name) => {
      byPattern[name] = this._summarize(byName[name]);
    });
    return { overall: this._summarize(resolved), pending: this._read().filter((e) => e.status === "pending").length, byPattern };
  }

  recent(limit) {
    return this._read().slice(0, limit || 50);
  }
}

module.exports = { PatternTrackerService, MOVE_THRESHOLD_PCT };
