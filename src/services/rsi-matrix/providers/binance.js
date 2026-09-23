"use strict";

// Binance candles for the RSI Matrix.
//
// Spot deliberately goes through SignalScreenerService.getCandles() rather
// than a second copy of its kline code: same mirror domain, same row mapping,
// same cache key — so a pair Directional Bias already pulled on 4h costs the
// matrix nothing extra.
//
// USDT-margined perpetuals (TradingView's ".P" suffix) are a different API
// (fapi.binance.com) that the screener never needed, so that one venue call
// lives here.

const { makeCandle, normalizeCandles } = require("../candles");
const { fetchJson, providerError } = require("./http");

const FUTURES_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
const FUTURES_INTERVALS = { "1h": "1h", "4h": "4h", "1D": "1d", "1W": "1w" };

class BinanceSpotProvider {
  constructor({ signalScreenerService }) {
    this._screener = signalScreenerService;
  }

  async fetchCandles(symbol, tf) {
    if (!this._screener) throw providerError("Binance spot candles are not wired up", "venue");
    let candles;
    try {
      candles = await this._screener.getCandles(symbol, tf);
    } catch (err) {
      // getCandles() reports Binance's 400 ("Invalid symbol") as a plain
      // Error; recover the scope from the message it builds.
      const status = Number((/HTTP (\d{3})/.exec(err.message) || [])[1]) || null;
      throw providerError(err.message, status === 400 || status === 404 ? "symbol" : "venue", status);
    }
    return normalizeCandles(candles.map((c) => makeCandle(c)));
  }
}

class BinanceFuturesProvider {
  constructor({ fetchImpl = fetch, timeoutMs } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
  }

  async fetchCandles(symbol, tf) {
    const interval = FUTURES_INTERVALS[tf];
    const url = `${FUTURES_KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500`;
    const rows = await fetchJson(this._fetch, url, { timeoutMs: this._timeoutMs, label: "Binance Futures" });
    if (!Array.isArray(rows)) throw providerError("Binance Futures returned no kline rows", "venue");
    return normalizeCandles(
      rows.map((row) =>
        makeCandle({
          openTime: row[0],
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
          closeTime: row[6],
        }),
      ),
    );
  }
}

module.exports = { BinanceSpotProvider, BinanceFuturesProvider };
