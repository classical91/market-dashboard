"use strict";

// Dominance and total-market-cap indices (USDT.D, USDC.D, BTC.D, TOTAL3, …)
// for the RSI Matrix.
//
// These are synthetic TradingView series. No venue this app can reach serves
// their OHLC history — CoinGecko's /global reports only the *current*
// percentages and total cap, and its historical global chart is a paid
// endpoint. So, like UsdtDominanceService before it, this provider builds the
// history itself: a sampler records one /global observation every
// SAMPLE_INTERVAL_MS, and bars are cut from those observations.
//
// Nothing older than the first sample is ever invented. RSI 14 needs 15
// consecutive closed bars, so a fresh deployment shows USDT.D 1H within about
// a day, 4H within three, 1D after ~15 days and 1W after ~15 weeks. Until then
// the cell says how far along the history is. USDT.D also reads the snapshots
// UsdtDominanceService has been accumulating, so it starts ahead.

const fs = require("fs");
const path = require("path");

const { candlesFromPoints, contiguousTail } = require("../candles");
const { providerError } = require("./http");

const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
// A point is kept only if it is meaningfully newer than the last one, so a
// burst of reads can't pile up near-duplicates.
const MIN_SAMPLE_GAP_MS = 10 * 60 * 1000;
// ~125 days of 15-minute samples: enough for 15+ weekly bars and no more.
const MAX_SAMPLES = 12000;

const TOTAL_SERIES = {
  TOTAL: (row) => row.total,
  // TradingView's TOTAL2 excludes BTC; TOTAL3 excludes BTC and ETH.
  TOTAL2: (row) => (row.d.BTC != null ? row.total * (1 - row.d.BTC / 100) : null),
  TOTAL3: (row) => (row.d.BTC != null && row.d.ETH != null ? row.total * (1 - (row.d.BTC + row.d.ETH) / 100) : null),
};

function round(value, digits) {
  return Number(Number(value).toFixed(digits));
}

class DominanceHistoryProvider {
  constructor({ marketDataService, dataDir, now = () => Date.now(), logger = console } = {}) {
    this._marketData = marketDataService;
    this._file = path.join(dataDir || ".", "rsi-matrix-dominance-history.json");
    // UsdtDominanceService's history. Read-only here: that service owns it.
    this._usdtFile = path.join(dataDir || ".", "usdt-dominance-history.json");
    this._now = now;
    this._logger = logger;
    this._timer = null;
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed)
        ? parsed.filter((row) => row && Number.isFinite(row.t) && row.d && typeof row.d === "object")
        : [];
    } catch {
      return [];
    }
  }

  _readUsdtHistory() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._usdtFile, "utf8"));
      return Array.isArray(parsed)
        ? parsed.filter((row) => row && Number.isFinite(row.t) && Number.isFinite(row.percent))
        : [];
    } catch {
      return [];
    }
  }

  _write(rows) {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = `${this._file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows.slice(-MAX_SAMPLES)), "utf8");
      fs.renameSync(tmp, this._file);
    } catch (err) {
      this._logger.error?.(`[RsiMatrix] Failed to write dominance history: ${err.message}`);
    }
  }

  /**
   * Records one /global observation. Only live readings are kept: the
   * hardcoded fallback (or a stale replay of the last good response) would
   * otherwise become a flat line that later reads as real history.
   */
  async sample() {
    if (!this._marketData) return false;
    const global = await this._marketData.getGlobalDominance();
    if (!global || !global.live) return false;
    const total = Number(global.totalMcap);
    const d = {};
    for (const entry of global.dominance || []) {
      if (entry && entry.symbol && Number.isFinite(entry.percent)) d[String(entry.symbol).toUpperCase()] = round(entry.percent, 5);
    }
    if (!Object.keys(d).length || !(total > 0)) return false;
    const now = this._now();
    const rows = this._read();
    const last = rows[rows.length - 1];
    if (last && now - last.t < MIN_SAMPLE_GAP_MS) return false;
    rows.push({ t: now, total: Math.round(total), d });
    this._write(rows);
    return true;
  }

  /** Starts the background sampler. Called from server.js, never createApp(). */
  start() {
    if (this._timer) return;
    const tick = () => this.sample().catch((err) => this._logger.warn?.(`[RsiMatrix] Dominance sample failed: ${err.message}`));
    tick();
    this._timer = setInterval(tick, SAMPLE_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Point series { t, value } for one synthetic symbol. */
  points(symbol) {
    const rows = this._read();
    if (TOTAL_SERIES[symbol]) {
      const pick = TOTAL_SERIES[symbol];
      return rows
        .map((row) => ({ t: row.t, value: Number.isFinite(row.total) && row.total > 0 ? pick(row) : null }))
        .filter((p) => Number.isFinite(p.value));
    }
    const coin = symbol.replace(/\.D$/, "");
    const points = rows
      .filter((row) => Number.isFinite(row.d[coin]))
      .map((row) => ({ t: row.t, value: row.d[coin] }));
    if (coin === "USDT") {
      for (const row of this._readUsdtHistory()) points.push({ t: row.t, value: row.percent });
    }
    return points.sort((a, b) => a.t - b.t);
  }

  async fetchCandles(symbol, tf) {
    const points = this.points(symbol);
    if (!points.length) {
      throw providerError(
        `No ${symbol} history recorded yet. It is sampled from CoinGecko /global every 15 minutes while the server runs.`,
        "venue",
      );
    }
    // Only an unbroken run of bars: a period nobody sampled is not a flat one.
    const candles = contiguousTail(candlesFromPoints(points, tf), tf);
    return candles;
  }

  /** Which dominance keys the latest sample carried — used to validate new rows. */
  knownCoins() {
    const rows = this._read();
    const last = rows[rows.length - 1];
    return last ? Object.keys(last.d) : [];
  }
}

module.exports = { DominanceHistoryProvider, SAMPLE_INTERVAL_MS, MIN_SAMPLE_GAP_MS, MAX_SAMPLES };
