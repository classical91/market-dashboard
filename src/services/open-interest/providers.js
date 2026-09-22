"use strict";

// Public, keyless futures endpoints that serve open interest.
//
// Every provider answers the same three questions in the same shape, so the
// service never branches on which venue it is talking to:
//
//   history(symbol, { period, limit })
//     → { venueSymbol, multiplier, points: [{ t, oi, oiUsd }] }  oldest first
//       `oi` is in coin (or 1000-coin contract) units; `oiUsd` is the venue's
//       own USD valuation when it publishes one, otherwise null.
//   funding(symbol)    → { rate, nextFundingTime } | throws
//   longShort(symbol)  → { ratio, longPct, shortPct, t } | throws
//
// Symbols in are the dashboard's Binance spot pairs (BTCUSDT, PEPEUSDT). Each
// venue lists some small-priced coins as 1000-unit contracts, which the alias
// tables translate; `multiplier` carries the unit so a USD value is never off
// by a factor of a thousand.
//
// No API keys are used or accepted: these are the venues' public market-data
// endpoints, called only from the server.

const { createServiceError } = require("../../utils/errors");

// Errors carry a scope so the service knows whether to try the next symbol on
// this venue ("symbol": the venue does not list it) or to stop asking this
// venue for a while ("venue": blocked, rate-limited, down, timing out).
function providerError(message, scope, status = null) {
  const err = new Error(message);
  err.scope = scope;
  err.status = status;
  return err;
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err.message;
    throw providerError(`request failed: ${reason}`, "venue");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // 400/404 is the venue saying it does not know the symbol; anything else
    // (403/451 geo-block, 429 rate limit, 5xx) is the venue being unusable.
    const scope = res.status === 400 || res.status === 404 ? "symbol" : "venue";
    const detail = body && (body.msg || body.retMsg || body.message);
    throw providerError(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, scope, res.status);
  }
  return body;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function baseAsset(symbol) {
  return symbol.replace(/USDT$/, "");
}

function thousandAliases(entries) {
  const out = {};
  for (const [spot, venueSymbol] of Object.entries(entries)) out[spot] = { venueSymbol, multiplier: 1000 };
  return out;
}

class BinanceFuturesProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, baseUrl = "https://fapi.binance.com" } = {}) {
    this.id = "binance";
    this.label = "Binance USDⓈ-M";
    this.supportsHistory = true;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._base = baseUrl.replace(/\/+$/, "");
    this._aliases = thousandAliases({
      PEPEUSDT: "1000PEPEUSDT",
      SHIBUSDT: "1000SHIBUSDT",
      BONKUSDT: "1000BONKUSDT",
      FLOKIUSDT: "1000FLOKIUSDT",
      LUNCUSDT: "1000LUNCUSDT",
      XECUSDT: "1000XECUSDT",
      SATSUSDT: "1000SATSUSDT",
    });
    this.periods = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  }

  resolve(symbol) {
    return this._aliases[symbol] || { venueSymbol: symbol, multiplier: 1 };
  }

  async history(symbol, { period = "15m", limit = 500 } = {}) {
    const { venueSymbol, multiplier } = this.resolve(symbol);
    const venuePeriod = this.periods[period];
    if (!venuePeriod) throw providerError(`unsupported period ${period}`, "symbol");
    const url = `${this._base}/futures/data/openInterestHist?symbol=${encodeURIComponent(venueSymbol)}` +
      `&period=${venuePeriod}&limit=${Math.min(limit, 500)}`;
    const rows = await fetchJson(this._fetch, url, this._timeoutMs);
    if (!Array.isArray(rows)) throw providerError("unexpected response shape", "venue");
    if (!rows.length) throw providerError(`no OI history for ${venueSymbol}`, "symbol");
    const points = rows
      .map((row) => ({ t: num(row.timestamp), oi: num(row.sumOpenInterest), oiUsd: num(row.sumOpenInterestValue) }))
      .filter((p) => p.t != null && p.oi != null)
      .sort((a, b) => a.t - b.t);
    return { venueSymbol, multiplier, points };
  }

  async funding(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const body = await fetchJson(this._fetch, `${this._base}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(venueSymbol)}`, this._timeoutMs);
    const rate = num(body && body.lastFundingRate);
    if (rate == null) throw providerError("no funding rate in response", "symbol");
    return { rate, nextFundingTime: num(body.nextFundingTime) };
  }

  async longShort(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const url = `${this._base}/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(venueSymbol)}&period=1h&limit=1`;
    const rows = await fetchJson(this._fetch, url, this._timeoutMs);
    const row = Array.isArray(rows) ? rows[rows.length - 1] : null;
    if (!row) throw providerError("no long/short ratio in response", "symbol");
    return {
      ratio: num(row.longShortRatio),
      longPct: num(row.longAccount) == null ? null : num(row.longAccount) * 100,
      shortPct: num(row.shortAccount) == null ? null : num(row.shortAccount) * 100,
      t: num(row.timestamp),
      basis: "accounts",
    };
  }
}

class BybitProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, baseUrl = "https://api.bybit.com" } = {}) {
    this.id = "bybit";
    this.label = "Bybit Linear";
    this.supportsHistory = true;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._base = baseUrl.replace(/\/+$/, "");
    this._aliases = thousandAliases({
      PEPEUSDT: "1000PEPEUSDT",
      SHIBUSDT: "SHIB1000USDT",
      BONKUSDT: "1000BONKUSDT",
      FLOKIUSDT: "1000FLOKIUSDT",
      LUNCUSDT: "1000LUNCUSDT",
      XECUSDT: "1000XECUSDT",
    });
    this.periods = { "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1d" };
  }

  resolve(symbol) {
    return this._aliases[symbol] || { venueSymbol: symbol, multiplier: 1 };
  }

  async _get(pathAndQuery) {
    const body = await fetchJson(this._fetch, `${this._base}${pathAndQuery}`, this._timeoutMs);
    if (!body || body.retCode !== 0) {
      // Bybit answers 200 with a non-zero retCode for an unknown symbol.
      throw providerError(`retCode ${body ? body.retCode : "?"}${body && body.retMsg ? ` — ${body.retMsg}` : ""}`, "symbol");
    }
    return body.result || {};
  }

  async history(symbol, { period = "15m", limit = 200 } = {}) {
    const { venueSymbol, multiplier } = this.resolve(symbol);
    const venuePeriod = this.periods[period];
    if (!venuePeriod) throw providerError(`unsupported period ${period}`, "symbol");
    const result = await this._get(
      `/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(venueSymbol)}` +
      `&intervalTime=${venuePeriod}&limit=${Math.min(limit, 200)}`,
    );
    const list = Array.isArray(result.list) ? result.list : [];
    if (!list.length) throw providerError(`no OI history for ${venueSymbol}`, "symbol");
    const points = list
      .map((row) => ({ t: num(row.timestamp), oi: num(row.openInterest), oiUsd: null }))
      .filter((p) => p.t != null && p.oi != null)
      .sort((a, b) => a.t - b.t);
    return { venueSymbol, multiplier, points };
  }

  async funding(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const result = await this._get(`/v5/market/tickers?category=linear&symbol=${encodeURIComponent(venueSymbol)}`);
    const row = Array.isArray(result.list) ? result.list[0] : null;
    const rate = num(row && row.fundingRate);
    if (rate == null) throw providerError("no funding rate in response", "symbol");
    return { rate, nextFundingTime: num(row.nextFundingTime) };
  }

  async longShort(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const result = await this._get(`/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(venueSymbol)}&period=1h&limit=1`);
    const row = Array.isArray(result.list) ? result.list[0] : null;
    if (!row) throw providerError("no long/short ratio in response", "symbol");
    const longShare = num(row.buyRatio);
    const shortShare = num(row.sellRatio);
    return {
      ratio: longShare != null && shortShare ? longShare / shortShare : null,
      longPct: longShare == null ? null : longShare * 100,
      shortPct: shortShare == null ? null : shortShare * 100,
      t: num(row.timestamp),
      basis: "accounts",
    };
  }
}

class OkxProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, baseUrl = "https://www.okx.com" } = {}) {
    this.id = "okx";
    this.label = "OKX Swap";
    this.supportsHistory = true;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._base = baseUrl.replace(/\/+$/, "");
    this.periods = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
  }

  resolve(symbol) {
    // oiCcy is quoted in the coin itself, so no 1000-unit alias is needed.
    return { venueSymbol: `${baseAsset(symbol)}-USDT-SWAP`, multiplier: 1 };
  }

  async _get(pathAndQuery) {
    const body = await fetchJson(this._fetch, `${this._base}${pathAndQuery}`, this._timeoutMs);
    if (!body || String(body.code) !== "0") {
      throw providerError(`code ${body ? body.code : "?"}${body && body.msg ? ` — ${body.msg}` : ""}`, "symbol");
    }
    return Array.isArray(body.data) ? body.data : [];
  }

  async history(symbol, { period = "15m", limit = 100 } = {}) {
    const { venueSymbol, multiplier } = this.resolve(symbol);
    const venuePeriod = this.periods[period];
    if (!venuePeriod) throw providerError(`unsupported period ${period}`, "symbol");
    const rows = await this._get(
      `/api/v5/rubik/stat/contracts/open-interest-history?instId=${encodeURIComponent(venueSymbol)}` +
      `&period=${venuePeriod}&limit=${Math.min(limit, 100)}`,
    );
    if (!rows.length) throw providerError(`no OI history for ${venueSymbol}`, "symbol");
    // [ts, oi (contracts), oiCcy (coin), oiUsd]
    const points = rows
      .map((row) => ({ t: num(row[0]), oi: num(row[2]), oiUsd: num(row[3]) }))
      .filter((p) => p.t != null && p.oi != null)
      .sort((a, b) => a.t - b.t);
    return { venueSymbol, multiplier, points };
  }

  async funding(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const rows = await this._get(`/api/v5/public/funding-rate?instId=${encodeURIComponent(venueSymbol)}`);
    const rate = num(rows[0] && rows[0].fundingRate);
    if (rate == null) throw providerError("no funding rate in response", "symbol");
    return { rate, nextFundingTime: num(rows[0].nextFundingTime) };
  }

  async longShort(symbol) {
    const { venueSymbol } = this.resolve(symbol);
    const rows = await this._get(
      `/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=${encodeURIComponent(venueSymbol)}&period=1H&limit=1`,
    );
    const row = rows[0];
    const ratio = num(row && row[1]);
    if (ratio == null) throw providerError("no long/short ratio in response", "symbol");
    const longPct = (ratio / (1 + ratio)) * 100;
    return { ratio, longPct, shortPct: 100 - longPct, t: num(row[0]), basis: "accounts" };
  }
}

// Bitget publishes current OI only. It is last in the default chain: it keeps
// the OI level on screen when every history venue is unreachable, and the
// page shows the missing changes as unavailable rather than as zero.
class BitgetProvider {
  constructor({ fetchImpl = fetch, timeoutMs = 8000, baseUrl = "https://api.bitget.com" } = {}) {
    this.id = "bitget";
    this.label = "Bitget USDT-M";
    this.supportsHistory = false;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._base = baseUrl.replace(/\/+$/, "");
  }

  resolve(symbol) {
    return { venueSymbol: symbol, multiplier: 1 };
  }

  async _get(pathAndQuery) {
    const body = await fetchJson(this._fetch, `${this._base}${pathAndQuery}`, this._timeoutMs);
    if (!body || String(body.code) !== "00000") {
      throw providerError(`code ${body ? body.code : "?"}${body && body.msg ? ` — ${body.msg}` : ""}`, "symbol");
    }
    return body.data;
  }

  async history(symbol) {
    const { venueSymbol, multiplier } = this.resolve(symbol);
    const data = await this._get(`/api/v2/mix/market/open-interest?symbol=${encodeURIComponent(venueSymbol)}&productType=usdt-futures`);
    const entry = data && Array.isArray(data.openInterestList) ? data.openInterestList[0] : null;
    const oi = num(entry && entry.size);
    if (oi == null) throw providerError(`no OI for ${venueSymbol}`, "symbol");
    return { venueSymbol, multiplier, points: [{ t: num(data.ts) || Date.now(), oi, oiUsd: null }] };
  }

  async funding(symbol) {
    const data = await this._get(`/api/v2/mix/market/current-fund-rate?symbol=${encodeURIComponent(symbol)}&productType=usdt-futures`);
    const row = Array.isArray(data) ? data[0] : data;
    const rate = num(row && row.fundingRate);
    if (rate == null) throw providerError("no funding rate in response", "symbol");
    return { rate, nextFundingTime: num(row.nextUpdate) };
  }

  async longShort() {
    throw providerError("Bitget long/short ratio is not wired up", "symbol");
  }
}

const PROVIDER_CLASSES = {
  binance: BinanceFuturesProvider,
  bybit: BybitProvider,
  okx: OkxProvider,
  bitget: BitgetProvider,
};

const DEFAULT_PROVIDER_ORDER = ["binance", "bybit", "okx", "bitget"];

/** Builds the provider chain from an ordered list of ids. */
function createProviders(ids = DEFAULT_PROVIDER_ORDER, options = {}) {
  const seen = new Set();
  const providers = [];
  for (const raw of ids) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    const Provider = PROVIDER_CLASSES[id];
    if (!Provider) throw createServiceError(`Unknown open-interest provider "${id}"`, 500);
    seen.add(id);
    providers.push(new Provider(options));
  }
  return providers;
}

module.exports = {
  BinanceFuturesProvider,
  BybitProvider,
  OkxProvider,
  BitgetProvider,
  DEFAULT_PROVIDER_ORDER,
  createProviders,
  providerError,
  fetchJson,
};
