"use strict";

// Traditional-market candles (indices, yields, futures, FX, DXY) for the RSI
// Matrix.
//
// Why not Finnhub, which the Overview's macro board already uses: its free
// tier serves only a current /quote. /stock/candle is a paid endpoint, and a
// quote alone cannot produce an honest 1H or 4H RSI — building one from
// snapshots would take weeks of polling and still miss every bar the app was
// asleep for.
//
// Yahoo Finance's chart endpoint returns real OHLC history at 1h / 1d / 1wk
// with no key. It is an unofficial endpoint, so it is treated like any other
// venue here: every failure is a per-cell "unavailable", never a crash and
// never a substituted market. 4H has no native Yahoo bar and is rolled up from
// 1H bars on UTC 4-hour boundaries, which can differ slightly from a
// session-anchored 4H bar on an exchange-hours chart.

const { DAY_MS, HOUR_MS, TIMEFRAME_MS, aggregateCandles, bucketStart, makeCandle, normalizeCandles } = require("../candles");
const { fetchJson, providerError } = require("./http");

const REQUESTS = {
  "1h": { interval: "1h", range: "60d" },
  "4h": { interval: "1h", range: "180d" },
  "1D": { interval: "1d", range: "2y" },
  "1W": { interval: "1wk", range: "10y" },
};

class YahooChartProvider {
  constructor({ fetchImpl = fetch, timeoutMs, baseUrl = "https://query1.finance.yahoo.com" } = {}) {
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._baseUrl = baseUrl;
  }

  async _raw(symbol, { interval, range }) {
    const url = `${this._baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const body = await fetchJson(this._fetch, url, {
      timeoutMs: this._timeoutMs,
      label: "Yahoo Finance",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; market-dashboard-rsi-matrix)" },
    });
    const chart = body && body.chart;
    if (chart && chart.error) {
      throw providerError(`Yahoo Finance: ${chart.error.description || chart.error.code}`, "symbol");
    }
    const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!result || !Array.isArray(result.timestamp) || !quote) {
      throw providerError(`Yahoo Finance returned no candles for ${symbol}`, "symbol");
    }
    return result.timestamp.map((ts, i) => ({
      t: Number(ts) * 1000,
      open: quote.open && quote.open[i],
      high: quote.high && quote.high[i],
      low: quote.low && quote.low[i],
      close: quote.close && quote.close[i],
      volume: quote.volume && quote.volume[i],
    }));
  }

  async fetchCandles(symbol, tf) {
    const rows = await this._raw(symbol, REQUESTS[tf]);
    const native = tf === "4h" ? "1h" : tf;
    const candles = normalizeCandles(
      rows.map((row) => {
        // Yahoo stamps daily and weekly bars at the session open (13:30 UTC
        // for the S&P, midnight exchange time for futures), not at a UTC
        // boundary. Closing them at the end of their UTC day / Monday-anchored
        // week keeps a live session's bar from being read as closed.
        let closeTime;
        if (native === "1h") closeTime = row.t + HOUR_MS - 1;
        else if (native === "1D") closeTime = bucketStart(row.t, "1D") + DAY_MS - 1;
        else closeTime = bucketStart(row.t, "1W") + TIMEFRAME_MS["1W"] - 1;
        return makeCandle({ ...row, openTime: row.t, closeTime });
      }),
    );
    return tf === "4h" ? aggregateCandles(candles, "4h") : candles;
  }
}

module.exports = { YahooChartProvider };
