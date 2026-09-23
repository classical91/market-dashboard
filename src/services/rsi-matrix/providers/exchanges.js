"use strict";

// Public, keyless spot-candle endpoints for the venues the reference matrix
// quotes outside Binance (MEXC, KuCoin, Coinbase, Kraken, Poloniex). Each
// class is only a URL and a row mapping into the shared candle shape; the
// service handles caching, closed-bar filtering and RSI.
//
// Where a venue has no native bar for a timeframe, real finer bars are rolled
// up on UTC boundaries (see candles.aggregateCandles) — never synthesised.

const { TIMEFRAME_MS, aggregateCandles, makeCandle, normalizeCandles } = require("../candles");
const { fetchJson, providerError } = require("./http");

function closeOf(openTime, tf) {
  return openTime + TIMEFRAME_MS[tf] - 1;
}

class MexcProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://api.mexc.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async fetchCandles(symbol, tf) {
    const interval = { "1h": "60m", "4h": "4h", "1D": "1d", "1W": "1W" }[tf];
    const url = `${this._baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500`;
    const rows = await fetchJson(this._fetch, url, { timeoutMs: this._timeoutMs, label: "MEXC" });
    if (!Array.isArray(rows)) throw providerError("MEXC returned no kline rows", "venue");
    return normalizeCandles(
      rows.map((row) =>
        makeCandle({
          openTime: row[0],
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
          closeTime: Number(row[6]) || closeOf(Number(row[0]), tf),
        }),
      ),
    );
  }
}

class KucoinProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://api.kucoin.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async fetchCandles(symbol, tf) {
    const type = { "1h": "1hour", "4h": "4hour", "1D": "1day", "1W": "1week" }[tf];
    const url = `${this._baseUrl}/api/v1/market/candles?type=${type}&symbol=${encodeURIComponent(symbol)}`;
    const body = await fetchJson(this._fetch, url, { timeoutMs: this._timeoutMs, label: "KuCoin" });
    // KuCoin answers 200 with its own error code for an unknown market.
    if (!body || body.code !== "200000" || !Array.isArray(body.data)) {
      throw providerError(`KuCoin: ${(body && body.msg) || "unknown market"} (${symbol})`, "symbol");
    }
    // Rows: [time(s), open, close, high, low, volume, turnover], newest first.
    return normalizeCandles(
      body.data.map((row) => {
        const openTime = Number(row[0]) * 1000;
        return makeCandle({
          openTime,
          open: row[1],
          close: row[2],
          high: row[3],
          low: row[4],
          volume: row[5],
          closeTime: closeOf(openTime, tf),
        });
      }),
    );
  }
}

class CoinbaseProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://api.exchange.coinbase.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async _raw(symbol, granularity, tf) {
    const url = `${this._baseUrl}/products/${encodeURIComponent(symbol)}/candles?granularity=${granularity}`;
    const rows = await fetchJson(this._fetch, url, {
      timeoutMs: this._timeoutMs,
      label: "Coinbase",
      // Coinbase Exchange rejects requests without a User-Agent.
      headers: { "User-Agent": "market-dashboard-rsi-matrix" },
    });
    if (!Array.isArray(rows)) throw providerError(`Coinbase: ${(rows && rows.message) || "no candles"} (${symbol})`, "symbol");
    // Rows: [time(s), low, high, open, close, volume], newest first.
    return normalizeCandles(
      rows.map((row) => {
        const openTime = Number(row[0]) * 1000;
        return makeCandle({
          openTime,
          low: row[1],
          high: row[2],
          open: row[3],
          close: row[4],
          volume: row[5],
          closeTime: closeOf(openTime, tf),
        });
      }),
    );
  }

  async fetchCandles(symbol, tf) {
    // Coinbase serves 1h and 1d natively (max 300 rows); 4h and 1W are rolled
    // up from them.
    if (tf === "1h") return this._raw(symbol, 3600, "1h");
    if (tf === "1D") return this._raw(symbol, 86400, "1D");
    if (tf === "4h") return aggregateCandles(await this._raw(symbol, 3600, "1h"), "4h");
    return aggregateCandles(await this._raw(symbol, 86400, "1D"), "1W");
  }
}

class KrakenProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://api.kraken.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async _raw(symbol, minutes, tf) {
    const url = `${this._baseUrl}/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=${minutes}`;
    const body = await fetchJson(this._fetch, url, { timeoutMs: this._timeoutMs, label: "Kraken" });
    const errors = (body && body.error) || [];
    if (errors.length) {
      const unknown = errors.some((e) => /Unknown asset pair|Invalid arguments/i.test(e));
      throw providerError(`Kraken: ${errors.join("; ")}`, unknown ? "symbol" : "venue");
    }
    // The result is keyed by Kraken's own pair name, which need not match the
    // one requested (XBTUSD comes back as XXBTZUSD); `last` sits beside it.
    const key = Object.keys((body && body.result) || {}).find((k) => k !== "last");
    const rows = key ? body.result[key] : null;
    if (!Array.isArray(rows)) throw providerError(`Kraken returned no candles for ${symbol}`, "symbol");
    // Rows: [time(s), open, high, low, close, vwap, volume, count].
    return normalizeCandles(
      rows.map((row) => {
        const openTime = Number(row[0]) * 1000;
        return makeCandle({
          openTime,
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[6],
          closeTime: closeOf(openTime, tf),
        });
      }),
    );
  }

  async fetchCandles(symbol, tf) {
    if (tf === "1h") return this._raw(symbol, 60, "1h");
    if (tf === "4h") return this._raw(symbol, 240, "4h");
    if (tf === "1D") return this._raw(symbol, 1440, "1D");
    // Kraken's native weekly bars are not guaranteed to open on Monday; roll
    // Monday-anchored weeks up from its daily bars instead.
    return aggregateCandles(await this._raw(symbol, 1440, "1D"), "1W");
  }
}

class PoloniexProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://api.poloniex.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async fetchCandles(symbol, tf) {
    const interval = { "1h": "HOUR_1", "4h": "HOUR_4", "1D": "DAY_1", "1W": "WEEK_1" }[tf];
    const url = `${this._baseUrl}/markets/${encodeURIComponent(symbol)}/candles?interval=${interval}&limit=500`;
    const rows = await fetchJson(this._fetch, url, { timeoutMs: this._timeoutMs, label: "Poloniex" });
    if (!Array.isArray(rows)) {
      throw providerError(`Poloniex: ${(rows && rows.message) || "no candles"} (${symbol})`, "symbol");
    }
    // Rows: [low, high, open, close, amount, quantity, buyTakerAmount,
    //        buyTakerQuantity, tradeCount, ts, weightedAverage, interval,
    //        startTime, closeTime].
    return normalizeCandles(
      rows.map((row) => {
        const openTime = Number(row[12]);
        return makeCandle({
          openTime,
          low: row[0],
          high: row[1],
          open: row[2],
          close: row[3],
          volume: row[5],
          closeTime: Number(row[13]) || closeOf(openTime, tf),
        });
      }),
    );
  }
}

module.exports = { MexcProvider, KucoinProvider, CoinbaseProvider, KrakenProvider, PoloniexProvider };
