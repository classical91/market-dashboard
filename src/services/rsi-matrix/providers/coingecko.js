"use strict";

// Market-cap series (TradingView's CRYPTOCAP:USDT, CRYPTOCAP:USDC, …) from
// CoinGecko's /coins/{id}/market_chart.
//
// These are not trading pairs, so they never go near a candle exchange. The
// request goes through MarketDataService.fetchJson() so it carries the same
// CoinGecko key header, retry and backoff as every other CoinGecko call in the
// app.
//
// CoinGecko picks the granularity from the span asked for: 2–90 days comes
// back hourly, anything longer daily (the public tier reaches back 365 days).
// So 1H/4H read 90 days of hourly points and 1D/1W a year of daily ones; a bar
// closes on the last point observed inside it.

const { candlesFromPoints } = require("../candles");
const { providerError } = require("./http");

const DAYS = { "1h": 90, "4h": 90, "1D": 365, "1W": 365 };

class CoinGeckoMarketCapProvider {
  constructor({ marketDataService }) {
    this._marketData = marketDataService;
  }

  async fetchCandles(coinId, tf) {
    const md = this._marketData;
    if (!md || !md.config || md.config.provider !== "coingecko") {
      throw providerError("CoinGecko is not the configured market data provider (MARKET_DATA_PROVIDER)", "venue");
    }
    const url = `${md.config.baseUrl}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${DAYS[tf]}`;
    let body;
    try {
      body = await md.fetchJson(url);
    } catch (err) {
      const status = err.statusCode || err.status || null;
      throw providerError(`CoinGecko: ${err.message}`, status === 404 || status === 400 ? "symbol" : "venue", status);
    }
    const caps = body && Array.isArray(body.market_caps) ? body.market_caps : null;
    if (!caps || !caps.length) throw providerError(`CoinGecko has no market-cap history for "${coinId}"`, "symbol");
    const points = caps
      .map((row) => ({ t: Number(row[0]), value: Number(row[1]) }))
      // A zero market cap is CoinGecko's gap marker, not an observation.
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value) && p.value > 0);
    return candlesFromPoints(points, tf);
  }
}

module.exports = { CoinGeckoMarketCapProvider };
