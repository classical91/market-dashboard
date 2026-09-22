"use strict";

// Open Interest Intelligence.
//
// One server-side contract over several public futures venues, so the page
// makes one request and never talks to an exchange itself. For each asset the
// provider chain is walked in order (Binance → Bybit → OKX → Bitget by
// default) and the first venue that has the symbol serves the whole row.
// Venues are never summed into an invented "aggregate" for one asset: a row
// is one venue's book, and it says which.
//
// Price comes from the dashboard's own spot candle cache (the same
// SignalScreenerService klines every screener reads), and confluence comes
// from the Directional Bias and Local Extremes projections of that same
// engine. This file computes no indicator of its own.
//
// Failure is per row, never per page: a venue that is geo-blocked or down is
// benched for a cooldown and the next one is asked; an asset with no venue at
// all becomes an error row; a refresh that fails after a good one serves the
// last good row marked STALE.

const { TOP_TOKENS } = require("../../config/market-symbols");
const { createServiceError } = require("../../utils/errors");
const { formatAge } = require("../data-freshness");
const {
  HORIZONS,
  HORIZON_KEYS,
  oiChanges,
  priceChanges,
  classifyPriceOi,
  describeState,
  detectSpike,
  summarizeMarket,
  confluenceNotes,
  round,
} = require("./classify");

const MINUTE = 60 * 1000;
const RESOLUTION = "15m";
const RESOLUTION_MS = 15 * MINUTE;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,16}USDT$/;
const PINNED = ["BTCUSDT", "ETHUSDT"];

// Detail-chart timeframes: which OI period and which spot candle interval
// each one reads.
const DETAIL_INTERVALS = Object.freeze({
  "15m": { oiPeriod: "15m", candleInterval: "15m" },
  "1h": { oiPeriod: "1h", candleInterval: "1h" },
  "4h": { oiPeriod: "4h", candleInterval: "4h" },
  "1d": { oiPeriod: "1d", candleInterval: "1D" },
});

const CONFLUENCE_INTERVALS = new Set(["1h", "4h", "1D"]);

// Directional Bias and Local Extremes default to 4 checks; asking with the
// same value lands on the same cache entry those pages already warmed.
const CONFLUENCE_MIN_CHECKS = 4;

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function pinOrder(symbols) {
  const pinned = PINNED.filter((symbol) => symbols.includes(symbol));
  return pinned.concat(symbols.filter((symbol) => !PINNED.includes(symbol)));
}

class OpenInterestService {
  constructor({
    providers,
    signalScreenerService,
    screenerSettingsService = null,
    cache,
    cacheTtlMs = 2 * MINUTE,
    staleAfterMs = 45 * MINUTE,
    venueCooldownMs = 5 * MINUTE,
    unsupportedTtlMs = 60 * MINUTE,
    concurrency = 6,
    defaultSymbols = TOP_TOKENS,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    if (!providers || !providers.length) throw new Error("OpenInterestService needs at least one provider");
    this._providers = providers;
    this._screener = signalScreenerService;
    this._settings = screenerSettingsService;
    this._cache = cache;
    this._cacheTtlMs = cacheTtlMs;
    this._staleAfterMs = staleAfterMs;
    this._venueCooldownMs = venueCooldownMs;
    this._unsupportedTtlMs = unsupportedTtlMs;
    this._concurrency = concurrency;
    this._defaultSymbols = defaultSymbols;
    this._now = now;
    this._logger = logger;
    // venue id → { until, error }: benched after a venue-level failure.
    this._venueDown = new Map();
    // "venue:SYMBOL" → until: the venue does not list this symbol.
    this._unsupported = new Map();
    // SYMBOL → last row that loaded cleanly, served STALE if a refresh fails.
    this._lastGood = new Map();
  }

  get providers() {
    return this._providers.map((p) => ({ id: p.id, label: p.label, supportsHistory: p.supportsHistory }));
  }

  /** The configured OI universe, BTC then ETH first. */
  universe() {
    let symbols = null;
    if (this._settings) {
      try {
        symbols = this._settings.getUniverse("openInterest");
      } catch (err) {
        this._logger.warn?.(`[OpenInterest] Could not read the openInterest universe: ${err.message}`);
      }
    }
    if (!Array.isArray(symbols)) symbols = this._defaultSymbols.slice();
    return pinOrder(symbols);
  }

  _knownSymbol(symbol) {
    if (this.universe().includes(symbol)) return true;
    if (this._settings && typeof this._settings.catalog === "function") {
      try {
        return this._settings.catalog().includes(symbol);
      } catch {
        return false;
      }
    }
    return this._defaultSymbols.includes(symbol);
  }

  _venueAvailable(provider) {
    const down = this._venueDown.get(provider.id);
    if (!down) return true;
    if (down.until <= this._now()) {
      this._venueDown.delete(provider.id);
      return true;
    }
    return false;
  }

  _recordFailure(provider, symbol, err) {
    if (err && err.scope === "venue") {
      this._venueDown.set(provider.id, { until: this._now() + this._venueCooldownMs, error: err.message });
      this._logger.warn?.(`[OpenInterest] ${provider.id} benched for ${formatAge(this._venueCooldownMs)}: ${err.message}`);
    } else {
      this._unsupported.set(`${provider.id}:${symbol}`, this._now() + this._unsupportedTtlMs);
    }
  }

  _supports(provider, symbol) {
    const key = `${provider.id}:${symbol}`;
    const until = this._unsupported.get(key);
    if (until == null) return true;
    if (until <= this._now()) {
      this._unsupported.delete(key);
      return true;
    }
    return false;
  }

  _orderedProviders(preferredId) {
    if (!preferredId) return this._providers;
    const preferred = this._providers.filter((p) => p.id === preferredId);
    return preferred.concat(this._providers.filter((p) => p.id !== preferredId));
  }

  /**
   * First venue in the chain that returns OI history for `symbol`. History
   * venues are always preferred; a current-only venue answers only when none
   * of them could.
   */
  async _loadHistory(symbol, { period = RESOLUTION, limit = 500, preferredId = null, requireHistory = false } = {}) {
    const attempts = [];
    const ordered = this._orderedProviders(preferredId);
    const chain = ordered.filter((p) => p.supportsHistory).concat(requireHistory ? [] : ordered.filter((p) => !p.supportsHistory));
    for (const provider of chain) {
      if (!this._venueAvailable(provider)) {
        attempts.push({ provider: provider.id, error: `benched: ${this._venueDown.get(provider.id).error}` });
        continue;
      }
      if (!this._supports(provider, symbol)) {
        attempts.push({ provider: provider.id, error: "symbol not listed" });
        continue;
      }
      try {
        const result = await provider.history(symbol, { period, limit });
        if (!result || !Array.isArray(result.points) || !result.points.length) {
          throw Object.assign(new Error("empty history"), { scope: "symbol" });
        }
        return { provider, ...result, attempts };
      } catch (err) {
        this._recordFailure(provider, symbol, err);
        attempts.push({ provider: provider.id, error: err.message });
      }
    }
    const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join("; ");
    const error = new Error(summary ? `No venue returned open interest (${summary})` : "No open-interest venue configured");
    error.attempts = attempts;
    throw error;
  }

  async _spotCandles(symbol, interval) {
    if (!this._screener || typeof this._screener.getCandles !== "function") {
      throw new Error("spot candle source unavailable");
    }
    const candles = await this._screener.getCandles(symbol, interval);
    if (!Array.isArray(candles) || !candles.length) throw new Error("no spot candles");
    return candles;
  }

  _freshness(asOf, { servedStale = false, staleReason = null } = {}) {
    const now = this._now();
    if (asOf == null) {
      return { state: "UNKNOWN", ageMs: null, reason: "Venue reported no OI timestamp" };
    }
    const ageMs = now - asOf;
    if (servedStale) {
      return { state: "STALE", ageMs, reason: staleReason || "Refresh failed; showing the last good reading" };
    }
    if (ageMs > this._staleAfterMs) {
      return { state: "STALE", ageMs, reason: `Latest OI point is ${formatAge(ageMs)} old` };
    }
    return { state: "FRESH", ageMs, reason: null };
  }

  async _buildRow(symbol) {
    const history = await this._loadHistory(symbol);
    const { provider, points, multiplier, venueSymbol, attempts } = history;
    const last = points[points.length - 1];

    let candles = null;
    let priceError = null;
    try {
      candles = await this._spotCandles(symbol, RESOLUTION);
    } catch (err) {
      priceError = err.message;
    }

    const now = this._now();
    const price = candles ? candles[candles.length - 1].close : null;
    const oiChange = provider.supportsHistory ? oiChanges(points, RESOLUTION_MS) : Object.fromEntries(HORIZON_KEYS.map((k) => [k, null]));
    const priceChange = candles ? priceChanges(candles, now) : Object.fromEntries(HORIZON_KEYS.map((k) => [k, null]));
    const states = {};
    for (const h of HORIZONS) {
      states[h.key] = describeState(classifyPriceOi(priceChange[h.key], oiChange[h.key], h.key));
    }
    const spike = provider.supportsHistory ? detectSpike(points, RESOLUTION_MS) : null;

    // The venue's own USD valuation when it publishes one; otherwise coins x
    // contract unit x spot price, flagged as an estimate. Never a zero.
    let oiUsd = last.oiUsd != null && last.oiUsd > 0 ? last.oiUsd : null;
    let oiUsdBasis = oiUsd != null ? "venue" : null;
    if (oiUsd == null && price != null) {
      oiUsd = last.oi * multiplier * price;
      oiUsdBasis = "estimated";
    }

    const notes = [];
    if (!provider.supportsHistory) notes.push(`${provider.label} publishes current OI only — changes unavailable`);
    if (priceError) notes.push(`Spot price unavailable: ${priceError}`);

    return {
      symbol,
      asset: symbol.replace(/USDT$/, ""),
      source: { id: provider.id, label: provider.label, venueSymbol, supportsHistory: provider.supportsHistory },
      price,
      priceChange: roundMap(priceChange, 3),
      oiCoins: last.oi * multiplier,
      oiUsd,
      oiUsdBasis,
      oiChange: roundMap(oiChange, 3),
      states,
      spike,
      asOf: last.t,
      computedAt: new Date(now).toISOString(),
      fallbacks: attempts,
      notes,
      error: null,
    };
  }

  async row(symbol, { force = false } = {}) {
    const key = `open-interest:row:${symbol}`;
    if (force) this._cache.delete(key);
    try {
      const row = await this._cache.getOrLoad(key, this._cacheTtlMs, () => this._buildRow(symbol));
      this._lastGood.set(symbol, row);
      return { ...row, freshness: this._freshness(row.asOf) };
    } catch (err) {
      const lastGood = this._lastGood.get(symbol);
      if (lastGood) {
        return {
          ...lastGood,
          freshness: this._freshness(lastGood.asOf, { servedStale: true, staleReason: `Refresh failed — ${err.message}` }),
        };
      }
      return {
        symbol,
        asset: symbol.replace(/USDT$/, ""),
        source: null,
        price: null,
        priceChange: Object.fromEntries(HORIZON_KEYS.map((k) => [k, null])),
        oiCoins: null,
        oiUsd: null,
        oiUsdBasis: null,
        oiChange: Object.fromEntries(HORIZON_KEYS.map((k) => [k, null])),
        states: Object.fromEntries(HORIZON_KEYS.map((k) => [k, describeState("UNKNOWN")])),
        spike: null,
        asOf: null,
        computedAt: new Date(this._now()).toISOString(),
        fallbacks: err.attempts || [],
        notes: [],
        freshness: { state: "UNKNOWN", ageMs: null, reason: "No venue returned open interest" },
        error: err.message,
      };
    }
  }

  /**
   * Directional Bias and Local Extremes for the same symbols, read from the
   * existing screener projections. Their failure degrades the confluence
   * column, never the OI table.
   */
  async _confluence(symbols, interval) {
    if (!this._screener || typeof this._screener.scanDirectionalBias !== "function") {
      return { available: false, interval, error: "Screener engine unavailable", bias: new Map(), extremes: new Map() };
    }
    try {
      const [biasRows, extremeRows] = await Promise.all([
        this._screener.scanDirectionalBias(interval, CONFLUENCE_MIN_CHECKS, { symbols }),
        this._screener.scanLocalExtremes(interval, CONFLUENCE_MIN_CHECKS, { symbols }),
      ]);
      const bias = new Map((biasRows || []).filter((r) => r && r.symbol).map((r) => [r.symbol, r]));
      const extremes = new Map((extremeRows || []).filter((r) => r && r.symbol).map((r) => [r.symbol, r]));
      return { available: true, interval, error: null, bias, extremes };
    } catch (err) {
      return { available: false, interval, error: err.message, bias: new Map(), extremes: new Map() };
    }
  }

  _attachConfluence(row, confluence) {
    const biasRow = confluence.bias.get(row.symbol) || null;
    const extremeRow = confluence.extremes.get(row.symbol) || null;
    const bias = biasRow && !biasRow.error ? biasRow.bias : null;
    const extreme = extremeRow && !extremeRow.error
      ? {
        dominant: extremeRow.dominant || null,
        state: extremeRow.state || "NONE",
        topScore: extremeRow.topScore ?? null,
        bottomScore: extremeRow.bottomScore ?? null,
        setupType: extremeRow.setupType || null,
      }
      : null;
    const notes = {};
    for (const key of HORIZON_KEYS) {
      notes[key] = row.error ? [] : confluenceNotes({ oiState: row.states[key].state, bias, extreme, spike: row.spike });
    }
    return {
      ...row,
      confluence: {
        interval: confluence.interval,
        bias,
        biasScore: biasRow && !biasRow.error ? biasRow.score ?? null : null,
        biasFreshness: biasRow ? biasRow.freshness || null : null,
        extreme,
        notes,
      },
    };
  }

  _sourceStatus(rows) {
    return this._providers.map((provider) => {
      const down = this._venueDown.get(provider.id);
      const serving = rows.filter((row) => row.source && row.source.id === provider.id).length;
      const benched = down && down.until > this._now();
      return {
        id: provider.id,
        label: provider.label,
        supportsHistory: provider.supportsHistory,
        assets: serving,
        status: benched ? "down" : serving ? "ok" : "idle",
        error: benched ? down.error : null,
        retryAt: benched ? new Date(down.until).toISOString() : null,
      };
    });
  }

  async snapshot({ force = false, confluenceInterval = "4h" } = {}) {
    const symbols = this.universe();
    const interval = CONFLUENCE_INTERVALS.has(confluenceInterval) ? confluenceInterval : null;
    const [rows, confluence] = await Promise.all([
      mapLimit(symbols, this._concurrency, (symbol) => this.row(symbol, { force })),
      interval
        ? this._confluence(symbols, interval)
        : Promise.resolve({ available: false, interval: null, error: "Confluence off", bias: new Map(), extremes: new Map() }),
    ]);
    const enriched = rows.map((row) => this._attachConfluence(row, confluence));
    const usable = enriched.filter((row) => !row.error);
    const summary = summarizeMarket(usable);
    const pick = (symbol) => {
      const row = enriched.find((r) => r.symbol === symbol);
      return row && !row.error
        ? { symbol, oiUsd: row.oiUsd, oiChange: row.oiChange, priceChange: row.priceChange, states: row.states, source: row.source }
        : null;
    };
    const staleRows = enriched.filter((row) => row.freshness && row.freshness.state === "STALE").length;

    return {
      updatedAt: new Date(this._now()).toISOString(),
      resolution: RESOLUTION,
      horizons: HORIZONS.map((h) => ({ key: h.key, label: h.label, oiFlatPct: h.oiFlatPct, priceFlatPct: h.priceFlatPct })),
      universe: { source: this._settings ? "screener-settings:openInterest" : "default", symbols },
      summary: {
        ...summary,
        btc: pick("BTCUSDT"),
        eth: pick("ETHUSDT"),
        staleRows,
        errorRows: enriched.length - usable.length,
      },
      confluence: { available: confluence.available, interval: confluence.interval, error: confluence.error },
      sources: this._sourceStatus(enriched),
      priceSource: "Binance spot (shared screener candle cache)",
      rows: enriched,
    };
  }

  async detail(rawSymbol, { interval = "1h", force = false } = {}) {
    const symbol = String(rawSymbol || "").trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) throw createServiceError(`"${symbol}" is not a USDT pair`, 400);
    if (!this._knownSymbol(symbol)) throw createServiceError(`${symbol} is not in the dashboard's token catalog`, 404);
    const spec = DETAIL_INTERVALS[interval];
    if (!spec) throw createServiceError(`Unsupported interval "${interval}". Use one of: ${Object.keys(DETAIL_INTERVALS).join(", ")}`, 400);

    const row = await this.row(symbol, { force });
    const preferredId = row.source ? row.source.id : null;
    const errors = [];

    const seriesKey = `open-interest:series:${symbol}:${spec.oiPeriod}`;
    if (force) this._cache.delete(seriesKey);
    let oiSeries = null;
    try {
      const history = await this._cache.getOrLoad(seriesKey, this._cacheTtlMs, async () => {
        const h = await this._loadHistory(symbol, { period: spec.oiPeriod, limit: 200, preferredId, requireHistory: true });
        return {
          source: { id: h.provider.id, label: h.provider.label, venueSymbol: h.venueSymbol },
          points: h.points.slice(-200).map((p) => ({ t: p.t, oi: p.oi * h.multiplier, oiUsd: p.oiUsd })),
        };
      });
      oiSeries = history;
    } catch (err) {
      errors.push(`OI history: ${err.message}`);
    }

    let priceSeries = null;
    try {
      const candles = await this._spotCandles(symbol, spec.candleInterval);
      priceSeries = {
        source: "Binance spot",
        candles: candles.slice(-200).map((c) => ({ t: c.closeTime, o: c.open, h: c.high, l: c.low, c: c.close })),
      };
    } catch (err) {
      errors.push(`Price: ${err.message}`);
    }

    const [funding, longShort] = await Promise.all([
      this._firstAnswer(symbol, preferredId, "funding", errors),
      this._firstAnswer(symbol, preferredId, "longShort", errors),
    ]);

    return {
      symbol,
      interval,
      row,
      series: { oi: oiSeries, price: priceSeries },
      funding,
      longShort,
      // No keyless REST venue still publishes liquidation prints — Binance's
      // forceOrders now needs a signed key — so this is reported as missing
      // rather than approximated.
      liquidations: {
        available: false,
        reason: "No free, keyless liquidation feed is wired up",
        links: [
          { label: "CoinGlass liquidation heatmap", href: "https://www.coinglass.com/pro/futures/LiquidationHeatMap" },
          { label: "CoinGlass liquidations", href: "https://www.coinglass.com/LiquidationData" },
        ],
      },
      errors,
      updatedAt: new Date(this._now()).toISOString(),
    };
  }

  /** Funding / long-short from the row's venue first, then any other. */
  async _firstAnswer(symbol, preferredId, method, errors) {
    const key = `open-interest:${method}:${symbol}`;
    try {
      return await this._cache.getOrLoad(key, this._cacheTtlMs, async () => {
        const failures = [];
        for (const provider of this._orderedProviders(preferredId)) {
          if (!this._venueAvailable(provider) || typeof provider[method] !== "function") continue;
          try {
            const value = await provider[method](symbol);
            return { ...value, source: { id: provider.id, label: provider.label } };
          } catch (err) {
            if (err && err.scope === "venue") this._recordFailure(provider, symbol, err);
            failures.push(`${provider.id}: ${err.message}`);
          }
        }
        throw new Error(failures.length ? failures.join("; ") : "no venue available");
      });
    } catch (err) {
      errors.push(`${method === "funding" ? "Funding" : "Long/short"}: ${err.message}`);
      return null;
    }
  }
}

function roundMap(map, digits) {
  const out = {};
  for (const [key, value] of Object.entries(map)) out[key] = round(value, digits);
  return out;
}

module.exports = { OpenInterestService, DETAIL_INTERVALS, RESOLUTION, pinOrder, mapLimit };
