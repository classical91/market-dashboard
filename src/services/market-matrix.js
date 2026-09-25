"use strict";

// TradeHunter → Market Matrix: candles for the four-chart workspace.
//
// Every panel asks for one symbol on one timeframe. The answer is either real
// bars from the symbol's configured source, or `available: false` with the
// reason — never a substitute market, never generated values, and never a
// sampled series that has quietly stopped updating.
//
// Sources are the ones the rest of TradeHunter already reads:
// - Binance spot via SignalScreenerService.getCandles(), so BTC here is the
//   same BTCUSDT series Directional Bias and Local Extremes use.
// - Yahoo Finance chart history (the RSI Matrix's macro source), extended
//   here to 5m / 15m / 30m bars.
// - The RSI Matrix's dominance sampler for TOTAL and the .D series.

const { SOURCES, getSymbol, isTimeframe, timeframeLabel } = require("../config/market-matrix");
const { DAY_MS, HOUR_MS, TIMEFRAME_MS, aggregateCandles, bucketStart, candlesFromPoints, makeCandle, normalizeCandles } = require("./rsi-matrix/candles");
const { YahooChartProvider } = require("./rsi-matrix/providers/yahoo");
const { SAMPLE_INTERVAL_MS } = require("./rsi-matrix/providers/dominance");
const { createServiceError } = require("../utils/errors");

// Enough history to scroll back through without shipping megabytes per panel.
const MAX_BARS = 1000;

// How long one fetched series is served to every viewer. Short on fast
// timeframes so the forming bar keeps moving; a chart is not a screener.
const CACHE_TTL_MS = { "5m": 20e3, "15m": 20e3, "30m": 30e3, "1h": 30e3, "4h": 60e3, "1D": 120e3, "1W": 300e3 };
const SAMPLED_TTL_MS = 60e3;
const ERROR_TTL_MS = 30e3;
// Refresh re-reads a series only if the cached copy is at least this old.
const MIN_FORCE_AGE_MS = 10e3;

// A sampled series whose newest sample is older than this has stopped being
// sampled (server asleep, CoinGecko failing). Its last value is not "current".
const SAMPLED_STALE_MS = 3 * SAMPLE_INTERVAL_MS;

// Yahoo interval and range per timeframe. 4H has no native Yahoo bar.
const YAHOO_REQUESTS = {
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "1mo" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "3mo" },
  "4h": { interval: "60m", range: "1y" },
  "1D": { interval: "1d", range: "5y" },
  "1W": { interval: "1wk", range: "10y" },
};

class YahooMatrixProvider extends YahooChartProvider {
  async fetchCandles(symbol, tf) {
    const request = YAHOO_REQUESTS[tf];
    const rows = await this._raw(symbol, request);
    const native = tf === "4h" ? "1h" : tf;
    const candles = normalizeCandles(
      rows.map((row) => {
        // Daily and weekly Yahoo bars are stamped at the session open, not a
        // UTC boundary; intraday bars are stamped at their own open.
        let closeTime;
        if (native === "1D") closeTime = bucketStart(row.t, "1D") + DAY_MS - 1;
        else if (native === "1W") closeTime = bucketStart(row.t, "1W") + TIMEFRAME_MS["1W"] - 1;
        else closeTime = row.t + (native === "1h" ? HOUR_MS : TIMEFRAME_MS[native]) - 1;
        return makeCandle({ ...row, openTime: row.t, closeTime });
      }),
    );
    return tf === "4h" ? aggregateCandles(candles, "4h") : candles;
  }
}

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return round(((to - from) / Math.abs(from)) * 100, 4);
}

/**
 * Last value, change against the previous bar's close (TradingView's legend
 * convention) and, on 1D and faster, change over 24 hours.
 */
function summarize(candles, tf) {
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  let change24h = null;
  if (TIMEFRAME_MS[tf] <= DAY_MS) {
    const cutoff = last.closeTime - DAY_MS;
    let base = null;
    for (let i = candles.length - 2; i >= 0; i -= 1) {
      if (candles[i].closeTime <= cutoff) {
        base = candles[i];
        break;
      }
    }
    // Only a close from roughly 24h ago counts; a gap in the history must not
    // turn "24h" into "since last week".
    if (base && cutoff - base.closeTime <= Math.max(TIMEFRAME_MS[tf], HOUR_MS) * 2) change24h = pctChange(base.close, last.close);
  }
  return {
    value: last.close,
    lastBarTime: new Date(last.openTime).toISOString(),
    previousClose: prev ? prev.close : null,
    changePct: prev ? pctChange(prev.close, last.close) : null,
    change24hPct: change24h,
  };
}

class MarketMatrixService {
  constructor({ signalScreenerService, dominanceProvider, yahooProvider, cache, now = () => Date.now() } = {}) {
    this._screener = signalScreenerService;
    this._dominance = dominanceProvider;
    this._yahoo = yahooProvider || new YahooMatrixProvider({ timeoutMs: 8000 });
    this._cache = cache;
    this._now = now;
  }

  async _fetchCandles(sym, tf) {
    if (sym.source === "binance") {
      if (!this._screener) throw new Error("Binance candles are not wired up");
      // force: the screener's own cache holds klines for minutes, which is
      // right for a scan but too slow for a live chart. This service's cache
      // decides how often the venue is asked.
      const rows = await this._screener.getCandles(sym.providerSymbol, tf, { force: true });
      return normalizeCandles(rows.map((row) => makeCandle(row)));
    }
    if (sym.source === "yahoo") return this._yahoo.fetchCandles(sym.providerSymbol, tf);
    if (sym.source === "sampled") {
      if (!this._dominance || typeof this._dominance.points !== "function") throw new Error("The dominance sampler is not running");
      const points = this._dominance.points(sym.providerSymbol);
      if (!points.length) {
        throw new Error(`No ${sym.label} samples recorded yet — the server samples CoinGecko /global every 15 minutes`);
      }
      const newest = points[points.length - 1].t;
      const age = this._now() - newest;
      if (age > SAMPLED_STALE_MS) {
        throw new Error(
          `Last ${sym.label} sample was ${Math.round(age / 60000)} min ago — sampling has stopped, so there is no current value`,
        );
      }
      return candlesFromPoints(points, tf);
    }
    throw new Error(`Unknown source "${sym.source}"`);
  }

  async _load(sym, tf) {
    const fetchedAt = this._now();
    try {
      const candles = await this._fetchCandles(sym, tf);
      if (!candles.length) throw new Error(`${SOURCES[sym.source].label} returned no ${timeframeLabel(tf)} bars`);
      return { candles: candles.slice(-MAX_BARS), fetchedAt, error: null };
    } catch (err) {
      return { candles: [], fetchedAt, error: err.message || "Request failed" };
    }
  }

  async _series(sym, tf, { force = false } = {}) {
    const key = `market-matrix:${sym.source}:${sym.providerSymbol}:${tf}`;
    const load = async () => {
      const value = await this._load(sym, tf);
      const ttl = value.error ? ERROR_TTL_MS : sym.source === "sampled" ? SAMPLED_TTL_MS : CACHE_TTL_MS[tf];
      this._cache.set(key, value, ttl);
      return value;
    };
    if (force) {
      const cached = this._cache.get(key);
      if (!cached || this._now() - cached.fetchedAt >= MIN_FORCE_AGE_MS) return this._cache.getOrLoad(`${key}:forced`, 0, load);
    }
    return this._cache.getOrLoad(key, 0, load);
  }

  async getChart({ symbol, timeframe, force = false } = {}) {
    const sym = getSymbol(symbol);
    if (!sym) throw createServiceError(`Unknown Market Matrix symbol "${symbol}"`, 400);
    if (!isTimeframe(timeframe)) throw createServiceError(`Unknown timeframe "${timeframe}"`, 400);
    const source = SOURCES[sym.source];
    const base = {
      symbol: {
        id: sym.id,
        label: sym.label,
        name: sym.name,
        format: sym.format,
        tvSymbol: sym.tvSymbol || null,
      },
      timeframe,
      timeframeLabel: timeframeLabel(timeframe),
      source: {
        id: sym.source,
        label: source.label,
        detail: source.detail,
        providerSymbol: sym.providerSymbol,
        note: sym.note || null,
        sampled: source.sampled,
      },
      chartType: source.sampled ? "line" : "candles",
      intervalMs: TIMEFRAME_MS[timeframe],
    };

    if (!source.timeframes.includes(timeframe)) {
      return {
        ...base,
        available: false,
        error: `${sym.label} is sampled every 15 minutes, so it has no ${timeframeLabel(timeframe)} bars`,
        candles: [],
        fetchedAt: new Date(this._now()).toISOString(),
      };
    }

    const series = await this._series(sym, timeframe, { force });
    if (series.error) {
      return { ...base, available: false, error: series.error, candles: [], fetchedAt: new Date(series.fetchedAt).toISOString() };
    }
    const candles = series.candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    return {
      ...base,
      available: true,
      error: null,
      candles,
      firstBarTime: new Date(series.candles[0].openTime).toISOString(),
      ...summarize(series.candles, timeframe),
      fetchedAt: new Date(series.fetchedAt).toISOString(),
    };
  }
}

module.exports = { MarketMatrixService, YahooMatrixProvider, summarize, YAHOO_REQUESTS, SAMPLED_STALE_MS, MAX_BARS };
