// USDT dominance as market context for the Signal Screener.
//
// CRYPTOCAP:USDT.D is a synthetic TradingView index: there is no OHLCV for it
// on Binance or anywhere else this app can reach, and no volume for it even in
// principle. The screener's engines are candle maths — RSI, MACD, VWAP,
// Bollinger excursion, volume climax — so none of them can run on it, and a
// dominance row can never carry a bias score or an extreme state.
//
// What is reachable is the *level*: CoinGecko's /global endpoint reports
// market_cap_percentage.usdt as a single current number with no history
// attached. So the level is published immediately, and the history is
// something this service accumulates itself — every read appends a snapshot,
// and direction appears once those snapshots span the comparison window.
// Until then the direction is explicitly null rather than a guess, because a
// made-up "FLAT" on the first day would read exactly like a real one.
const fs = require("fs");
const path = require("path");

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Dominance is a percentage of total market cap, so it moves in small
// increments: USDT.D lives around 4-8% and a real day's move is measured in
// hundredths of a point. Anything under this is noise, not a direction.
const FLAT_BAND_PP = 0.05;

// A snapshot is only worth keeping if it is meaningfully newer than the last
// one; without this, every page load would append a near-duplicate row and a
// busy hour would bury the day's actual shape.
const MIN_SNAPSHOT_GAP_MS = 5 * 60 * 1000;

// Roughly a month of 5-minute snapshots. The file is a rolling window, not an
// archive: only the last 24h is ever read for direction.
const MAX_SNAPSHOTS = 8000;

// How far from the requested age a snapshot may sit and still answer for it.
// A gap in coverage (the app was down, CoinGecko was failing) should read as
// "no comparison available" rather than silently comparing against whatever
// happens to be nearest.
const WINDOW_TOLERANCE = 0.35;

function roundPercent(value) {
  return Number(Number(value).toFixed(4));
}

class UsdtDominanceService {
  constructor({ marketDataService, dataDir, now = () => Date.now() } = {}) {
    this._marketData = marketDataService;
    this._file = path.join(dataDir || ".", "usdt-dominance-history.json");
    this._now = now;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((row) => row && Number.isFinite(row.t) && Number.isFinite(row.percent)) : [];
    } catch {
      return [];
    }
  }

  _write(snapshots) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(snapshots.slice(-MAX_SNAPSHOTS)), "utf8");
    } catch (err) {
      console.error("[UsdtDominance] Failed to write history:", err.message);
    }
  }

  /**
   * Appends a snapshot unless one was taken recently. Returns the full series
   * including the new point, so callers read what they just wrote.
   */
  _record(percent, at) {
    const snapshots = this._read();
    const last = snapshots[snapshots.length - 1];
    if (last && at - last.t < MIN_SNAPSHOT_GAP_MS) return snapshots;
    // A clock that jumped backwards (or a restored backup) would otherwise
    // leave the series unsorted, and every window lookup reads it in order.
    const next = last && at <= last.t ? snapshots : snapshots.concat([{ t: at, percent: roundPercent(percent) }]);
    if (next !== snapshots) this._write(next);
    return next;
  }

  /**
   * The snapshot closest to `windowMs` ago, or null when coverage does not
   * reach back that far.
   */
  _snapshotAt(snapshots, now, windowMs) {
    const target = now - windowMs;
    const tolerance = windowMs * WINDOW_TOLERANCE;
    let best = null;
    for (const row of snapshots) {
      const distance = Math.abs(row.t - target);
      if (distance > tolerance) continue;
      if (!best || distance < Math.abs(best.t - target)) best = row;
    }
    return best;
  }

  _change(snapshots, now, percent, windowMs) {
    const from = this._snapshotAt(snapshots, now, windowMs);
    if (!from) return null;
    const delta = roundPercent(percent - from.percent);
    return {
      delta,
      direction: Math.abs(delta) < FLAT_BAND_PP ? "FLAT" : delta > 0 ? "RISING" : "FALLING",
      fromPercent: from.percent,
      fromAt: new Date(from.t).toISOString(),
    };
  }

  /**
   * Current USDT dominance plus whatever direction the accumulated history
   * supports. `direction` is null until there is enough coverage — the caller
   * is expected to say "building history" rather than invent a reading.
   */
  async read() {
    const global = await this._marketData.getGlobalDominance();
    const row = (global.dominance || []).find((entry) => entry.symbol === "USDT");
    const percent = row && Number.isFinite(row.percent) ? roundPercent(row.percent) : null;
    const now = this._now();
    if (percent == null) {
      return {
        symbol: "USDT.D",
        percent: null,
        live: false,
        source: global.source || "unavailable",
        error: "USDT dominance not reported by the market data provider",
      };
    }

    // Only live readings are recorded: persisting the hardcoded fallback would
    // manufacture a flat line that later reads as a real observation.
    const snapshots = global.live ? this._record(percent, now) : this._read();
    const h4 = this._change(snapshots, now, percent, FOUR_HOURS_MS);
    const h24 = this._change(snapshots, now, percent, TWENTY_FOUR_HOURS_MS);
    const first = snapshots[0];

    return {
      symbol: "USDT.D",
      percent,
      live: Boolean(global.live),
      source: global.source || "unknown",
      capturedAt: new Date(now).toISOString(),
      // 24h is the headline read; 4h stands in while the series is still young.
      direction: (h24 || h4 || {}).direction ?? null,
      changes: { h4, h24 },
      history: {
        points: snapshots.length,
        coverageMs: first ? now - first.t : 0,
        since: first ? new Date(first.t).toISOString() : null,
      },
    };
  }
}

module.exports = {
  UsdtDominanceService,
  FLAT_BAND_PP,
  MIN_SNAPSHOT_GAP_MS,
  MAX_SNAPSHOTS,
};
