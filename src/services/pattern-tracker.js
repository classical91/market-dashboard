// Logs every newly-detected pattern/divergence with its entry price, then
// resolves each one after a horizon proportional to its timeframe by
// checking whether price actually moved in the direction the bias implied.
// This is the accuracy feedback loop the scanners otherwise lack — without
// it there's no way to know if "Falling Wedge" or "Regular Bullish
// Divergence" mean anything on this token universe versus noise.
//
// Resolution reads the price AT the horizon from timestamped 1h candles, not
// whatever the price happens to be when the resolver next runs: a bot that
// was down for a day must not score a 24h call on a 48h move. The same
// candles give the maximum favourable / adverse excursion inside the window.
const fs = require("fs");
const path = require("path");

const HOUR_MS = 60 * 60 * 1000;

// Bars-based horizons translated to wall-clock time (24 bars is a common
// forward-return window in this kind of backtest).
const RESOLVE_HORIZON_MS = {
  "1h": 24 * HOUR_MS,
  "4h": 4 * 24 * HOUR_MS,
  "1D": 10 * 24 * HOUR_MS,
};
const DEFAULT_HORIZON_MS = RESOLVE_HORIZON_MS["4h"];

// A move smaller than this in either direction is scored "flat" (neither a
// hit nor a miss) rather than forced into one bucket or the other.
const MOVE_THRESHOLD_PCT = 0.02;

// Entries kept in the live file. Overflow is moved — resolved entries only,
// oldest first — to an append-only archive that stats() still counts.
// Pending entries are never dropped.
const MAX_ACTIVE_ENTRIES = 2000;

function round2(value) {
  return Number(value.toFixed(2));
}

class PatternTrackerService {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {(q: {symbol: string, interval: string, startTime: number, endTime: number, limit: number}) => Promise<Array>} [opts.fetchCandles]
   *   Binance-shaped klines ([openTime, open, high, low, close, volume, closeTime, ...]).
   *   Preferred: resolves at the exact horizon.
   * @param {(symbol: string) => Promise<number>} [opts.fetchPrice]
   *   Live price, used only when fetchCandles is not supplied. Entries resolved
   *   this way are tagged priceSource "live" with their resolution lag.
   * @param {() => number} [opts.now]
   */
  constructor({ dataDir, fetchCandles, fetchPrice, now }) {
    this._file = path.join(dataDir, "pattern-track-log.json");
    this._backupFile = `${this._file}.bak`;
    this._archiveFile = path.join(dataDir, "pattern-track-archive.jsonl");
    this._fetchCandles = fetchCandles || null;
    this._fetchPrice = fetchPrice || null;
    this._now = now || Date.now;
    this._integrity = null;
  }

  _parseFile(file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("track log is not an array");
    return parsed;
  }

  // A missing file is an empty history. An unreadable one is NOT: it is moved
  // aside (so the next write cannot overwrite the evidence) and the last good
  // backup is used instead.
  _read() {
    if (!fs.existsSync(this._file)) return this._readBackup(null);
    try {
      return this._parseFile(this._file);
    } catch (err) {
      const quarantined = this._file.replace(/\.json$/, `.corrupt-${this._now()}.json`);
      try {
        fs.renameSync(this._file, quarantined);
      } catch (renameErr) {
        console.error("[PatternTracker] Could not quarantine corrupt track log:", renameErr.message);
      }
      console.error(`[PatternTracker] Track log unreadable (${err.message}); moved to ${path.basename(quarantined)}`);
      return this._readBackup({ error: err.message, quarantined: path.basename(quarantined), at: new Date(this._now()).toISOString() });
    }
  }

  _readBackup(incident) {
    if (!fs.existsSync(this._backupFile)) {
      if (incident) this._integrity = { ...incident, recoveredFromBackup: false };
      return [];
    }
    try {
      const entries = this._parseFile(this._backupFile);
      if (incident) {
        this._integrity = { ...incident, recoveredFromBackup: true, recoveredEntries: entries.length };
        console.error(`[PatternTracker] Recovered ${entries.length} entries from backup`);
      }
      return entries;
    } catch (err) {
      if (incident) this._integrity = { ...incident, recoveredFromBackup: false, backupError: err.message };
      return [];
    }
  }

  _archive(entries) {
    if (!entries.length) return;
    fs.appendFileSync(this._archiveFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  _readArchive() {
    if (!fs.existsSync(this._archiveFile)) return [];
    const out = [];
    for (const line of fs.readFileSync(this._archiveFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line from an interrupted append costs one entry, not the archive.
      }
    }
    return out;
  }

  // Newest first. Keeps every pending entry; moves the oldest resolved
  // overflow to the archive; then replaces the file atomically (temp file +
  // rename) after keeping the previous version as the backup.
  _write(entries) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let keep = entries;
      if (entries.length > MAX_ACTIVE_ENTRIES) {
        let resolvedBudget = Math.max(MAX_ACTIVE_ENTRIES - entries.filter((e) => e.status === "pending").length, 0);
        keep = [];
        const overflow = [];
        for (const entry of entries) {
          if (entry.status === "pending") keep.push(entry);
          else if (resolvedBudget > 0) { keep.push(entry); resolvedBudget -= 1; }
          else overflow.push(entry);
        }
        // Archive oldest-first so the JSONL reads chronologically.
        this._archive(overflow.reverse());
      }

      const tmp = `${this._file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), "utf8");
      if (fs.existsSync(this._file)) fs.copyFileSync(this._file, this._backupFile);
      fs.renameSync(tmp, this._file);
    } catch (err) {
      console.error("[PatternTracker] Failed to write track log:", err.message);
    }
  }

  /**
   * Records a newly-observed pattern or divergence instance. Call this once
   * per instance (e.g. on a null->pattern or pattern-A->pattern-B
   * transition), not on every scan it remains visible.
   *
   * entryPrice is the close of the candle that closed at candleCloseTime, so
   * the horizon is measured from that close — not from when the bot happened
   * to notice it (detectedAt). The gap between the two is kept as
   * detectionLatencyMs.
   */
  log({ symbol, interval, kind, name, bias, entryPrice, detectedAt, candleCloseTime }) {
    const entries = this._read();
    const detectedMs = new Date(detectedAt).getTime();
    const closeMs = Number.isFinite(candleCloseTime) ? candleCloseTime : null;
    // Binance closeTime is the last millisecond of the bar (…59.999).
    const anchorMs = closeMs != null ? closeMs + 1 : detectedMs;
    const entry = {
      id: `${symbol}:${interval}:${kind}:${name}:${detectedAt}`,
      symbol,
      interval,
      kind,
      name,
      bias,
      entryPrice,
      detectedAt,
      entryAt: new Date(anchorMs).toISOString(),
      detectionLatencyMs: closeMs != null ? Math.max(detectedMs - anchorMs, 0) : null,
      resolveAt: new Date(anchorMs + (RESOLVE_HORIZON_MS[interval] || DEFAULT_HORIZON_MS)).toISOString(),
      status: "pending",
    };
    entries.unshift(entry);
    this._write(entries);
    return entry;
  }

  // Price at resolveAt plus favourable/adverse excursion over the window,
  // from 1h candles. Returns null while the window's last candle hasn't closed.
  async _historicalOutcome(entry) {
    const startMs = new Date(entry.entryAt || entry.detectedAt).getTime();
    const endMs = new Date(entry.resolveAt).getTime();
    const firstOpen = Math.floor(startMs / HOUR_MS) * HOUR_MS;
    const bars = Math.ceil((endMs - firstOpen) / HOUR_MS);
    const candles = await this._fetchCandles({
      symbol: entry.symbol, interval: "1h", startTime: firstOpen, endTime: endMs - 1, limit: Math.min(Math.max(bars, 1), 1000),
    });
    const window = (Array.isArray(candles) ? candles : [])
      .filter((c) => Number(c[0]) >= firstOpen && Number(c[6]) < endMs);
    const last = window.at(-1);
    // The candle containing the horizon must exist and be closed.
    if (!last || Number(last[6]) < endMs - HOUR_MS || Number(last[6]) >= this._now()) return null;
    const highs = window.map((c) => Number(c[2]));
    const lows = window.map((c) => Number(c[3]));
    return {
      price: Number(last[4]),
      priceAt: new Date(Number(last[6]) + 1).toISOString(),
      high: Math.max(...highs),
      low: Math.min(...lows),
      bars: window.length,
    };
  }

  _score(entry, outcome, priceSource) {
    const returnPct = (outcome.price - entry.entryPrice) / entry.entryPrice;
    const favorableReturn = entry.bias === "bullish" ? returnPct : -returnPct;
    const resolved = {
      ...entry,
      resolvedAt: new Date(this._now()).toISOString(),
      resolvedPrice: outcome.price,
      priceSource,
      returnPct: round2(returnPct * 100),
      outcome: favorableReturn >= MOVE_THRESHOLD_PCT ? "hit" : favorableReturn <= -MOVE_THRESHOLD_PCT ? "miss" : "flat",
      status: "resolved",
    };
    if (outcome.priceAt) resolved.priceAt = outcome.priceAt;
    if (outcome.high != null && outcome.low != null) {
      const up = (outcome.high - entry.entryPrice) / entry.entryPrice;
      const down = (outcome.low - entry.entryPrice) / entry.entryPrice;
      // Favourable/adverse in the direction of the call, as positive / negative percentages.
      resolved.mfePct = round2(Math.max(entry.bias === "bullish" ? up : -down, 0) * 100);
      resolved.maePct = round2(Math.min(entry.bias === "bullish" ? down : -up, 0) * 100);
    }
    if (priceSource === "live") resolved.resolutionLagMs = Math.max(this._now() - new Date(entry.resolveAt).getTime(), 0);
    return resolved;
  }

  /**
   * Resolves every pending entry whose horizon has passed. Entries whose
   * price lookup fails (or whose horizon candle hasn't closed) stay pending
   * and are retried next cycle.
   */
  async resolveDue() {
    const now = this._now();
    const due = this._read().filter((e) => e.status === "pending" && new Date(e.resolveAt).getTime() <= now);
    if (!due.length) return [];

    const updates = new Map();
    for (const entry of due) {
      try {
        if (this._fetchCandles) {
          const outcome = await this._historicalOutcome(entry);
          if (outcome) updates.set(entry.id, this._score(entry, outcome, "historical"));
        } else if (this._fetchPrice) {
          const price = await this._fetchPrice(entry.symbol);
          updates.set(entry.id, this._score(entry, { price }, "live"));
        }
      } catch (err) {
        console.error(`[PatternTracker] Failed to resolve ${entry.symbol}:`, err.message);
      }
    }
    if (!updates.size) return [];

    // Re-read after the network calls so an entry logged meanwhile isn't lost.
    const latest = this._read();
    const resolved = [];
    const merged = latest.map((e) => {
      const update = e.status === "pending" ? updates.get(e.id) : null;
      if (!update) return e;
      resolved.push(update);
      return update;
    });
    if (resolved.length) this._write(merged);
    return resolved;
  }

  _summarize(list) {
    const hits = list.filter((e) => e.outcome === "hit").length;
    const misses = list.filter((e) => e.outcome === "miss").length;
    const flats = list.filter((e) => e.outcome === "flat").length;
    const decisive = hits + misses;
    const avg = (key) => {
      const values = list.map((e) => e[key]).filter(Number.isFinite);
      return values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    return {
      total: list.length,
      hits,
      misses,
      flats,
      hitRate: decisive ? Number(((hits / decisive) * 100).toFixed(1)) : null,
      avgFavorableReturnPct: list.length
        ? round2(list.reduce((sum, e) => sum + (e.bias === "bullish" ? e.returnPct : -e.returnPct), 0) / list.length)
        : null,
      avgMfePct: avg("mfePct"),
      avgMaePct: avg("maePct"),
    };
  }

  _groupBy(list, key) {
    const groups = {};
    list.forEach((e) => {
      const k = e[key];
      if (!groups[k]) groups[k] = [];
      groups[k].push(e);
    });
    const out = {};
    Object.keys(groups).forEach((k) => { out[k] = this._summarize(groups[k]); });
    return out;
  }

  stats() {
    const active = this._read();
    const resolved = [...active.filter((e) => e.status === "resolved"), ...this._readArchive()];
    return {
      overall: this._summarize(resolved),
      pending: active.filter((e) => e.status === "pending").length,
      byPattern: this._groupBy(resolved, "name"),
      byInterval: this._groupBy(resolved, "interval"),
      bySymbol: this._groupBy(resolved, "symbol"),
      // Live-resolved entries predate horizon-exact resolution (or ran
      // without candle access); their returns include resolver lag.
      priceSources: {
        historical: resolved.filter((e) => e.priceSource === "historical").length,
        live: resolved.filter((e) => e.priceSource !== "historical").length,
      },
      integrity: this._integrity,
    };
  }

  recent(limit) {
    return this._read().slice(0, limit || 50);
  }
}

module.exports = { PatternTrackerService, MOVE_THRESHOLD_PCT, RESOLVE_HORIZON_MS, MAX_ACTIVE_ENTRIES };
