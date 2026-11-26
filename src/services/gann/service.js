"use strict";

// Gann Intelligence service: fetches nothing of its own. Candles come from
// SignalScreenerService.getCandles — the same cached Binance spot klines the
// screeners already pull — and only CLOSED candles are analysed.
//
// Cache keys carry the last closed candle's open time, so a result is
// recomputed exactly when a new candle closes and never in between, and
// two viewers with the same settings share one computation regardless of
// how either has zoomed their chart.

const { dropUnclosedCandle } = require("../signal-screener");
const { TOP_TOKENS } = require("../../config/market-symbols");
const { assessFreshness } = require("../data-freshness");
const { createServiceError, describeNetworkError } = require("../../utils/errors");
const { TIMEFRAMES, BAR_MS, buildAnalysis, normaliseSettings, settingsKey } = require("./analysis");
const { runBacktest } = require("./backtest");

// Results are immutable for a given closed candle, so the TTL only bounds
// memory; correctness comes from the key.
const RESULT_TTL_MS = 6 * 60 * 60 * 1000;
const SCREENER_CONCURRENCY = 5;

const EXPERIMENTAL_NOTICE =
  "Experimental. Gann levels and cycle windows are geometric projections, not predictions, and have not been validated by paper trading. Read-only context — never an order instruction.";

function bad(message) {
  return createServiceError(message, 400);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

class GannService {
  constructor({ signalScreenerService, cache, symbols, now } = {}) {
    if (!signalScreenerService) throw new Error("GannService requires signalScreenerService");
    this._screener = signalScreenerService;
    this._cache = cache;
    this._symbols = symbols && symbols.length ? symbols : TOP_TOKENS;
    this._now = now || (() => Date.now());
  }

  get symbols() {
    return this._symbols.slice();
  }

  get timeframes() {
    return TIMEFRAMES.slice();
  }

  validate(symbol, timeframe) {
    const sym = String(symbol || "").toUpperCase();
    // Restricted to the shared universe so this page never widens what the
    // app fetches from Binance.
    if (!this._symbols.includes(sym)) throw bad(`Unsupported symbol "${symbol}"`);
    if (!TIMEFRAMES.includes(timeframe)) throw bad(`Unsupported timeframe "${timeframe}" (use ${TIMEFRAMES.join(", ")})`);
    return sym;
  }

  async _closedCandles(symbol, timeframe, { force = false } = {}) {
    let raw;
    try {
      raw = await this._screener.getCandles(symbol, timeframe, { force });
    } catch (err) {
      // Upstream outage: say so (502) instead of a generic 500, and never
      // substitute candles of our own.
      throw createServiceError(`Market data unavailable for ${symbol} ${timeframe}: ${describeNetworkError(err)}`, 502);
    }
    const closed = dropUnclosedCandle(raw, this._now());
    const live = raw.length ? raw[raw.length - 1] : null;
    return { closed, livePrice: live ? live.close : null };
  }

  _freshness(timeframe, analysis, computedAt, error) {
    return assessFreshness({
      interval: timeframe,
      sources: [{
        key: "gann",
        label: "Gann analysis",
        candleCloseTime: analysis && analysis.lastClosed ? analysis.lastClosed.closeTime : null,
        computedAt,
        error: Boolean(error),
      }],
    }, this._now());
  }

  async _cached(key, loader) {
    if (!this._cache) return loader();
    return this._cache.getOrLoad(key, RESULT_TTL_MS, loader);
  }

  async analyze({ symbol, timeframe, settings, force = false, includeCandles = true } = {}) {
    const sym = this.validate(symbol, timeframe);
    const normalised = normaliseSettings(settings);
    const { closed, livePrice } = await this._closedCandles(sym, timeframe, { force });
    if (!closed.length) throw new Error(`No closed ${timeframe} candles for ${sym}`);
    const lastOpen = closed[closed.length - 1].openTime;
    const key = `gann:analysis:${sym}:${timeframe}:${lastOpen}:${settingsKey(normalised)}`;
    const result = await this._cached(key, async () => ({
      ...buildAnalysis(closed, { timeframe, settings: normalised }),
      computedAt: new Date(this._now()).toISOString(),
    }));
    return {
      symbol: sym,
      ...result,
      livePrice,
      freshness: this._freshness(timeframe, result, result.computedAt, !result.ok),
      candles: includeCandles ? closed : undefined,
      notice: EXPERIMENTAL_NOTICE,
    };
  }

  /** One compact row per timeframe — the higher-timeframe structure view. */
  async multiTimeframe({ symbol, settings } = {}) {
    const sym = this.validate(symbol, "1D");
    const rows = await mapLimit(TIMEFRAMES, TIMEFRAMES.length, async (tf) => {
      try {
        const a = await this.analyze({ symbol: sym, timeframe: tf, settings, includeCandles: false });
        return summarise(a);
      } catch (err) {
        return { timeframe: tf, error: err.message };
      }
    });
    return { symbol: sym, rows, notice: EXPERIMENTAL_NOTICE };
  }

  async screener({ timeframe = "4h", settings, symbols } = {}) {
    if (!TIMEFRAMES.includes(timeframe)) throw bad(`Unsupported timeframe "${timeframe}"`);
    const list = (symbols && symbols.length ? symbols : this._symbols).filter((s) => this._symbols.includes(s));
    const rows = await mapLimit(list, SCREENER_CONCURRENCY, async (sym) => {
      try {
        const a = await this.analyze({ symbol: sym, timeframe, settings, includeCandles: false });
        return { symbol: sym, ...summarise(a) };
      } catch (err) {
        return { symbol: sym, timeframe, error: err.message };
      }
    });
    return { timeframe, rows, updatedAt: new Date(this._now()).toISOString(), notice: EXPERIMENTAL_NOTICE };
  }

  async backtest({ symbol, timeframe, settings, options } = {}) {
    const sym = this.validate(symbol, timeframe);
    const normalised = normaliseSettings(settings);
    const { closed } = await this._closedCandles(sym, timeframe);
    if (!closed.length) throw new Error(`No closed ${timeframe} candles for ${sym}`);
    const lastOpen = closed[closed.length - 1].openTime;
    const key = `gann:backtest:${sym}:${timeframe}:${lastOpen}:${settingsKey(normalised)}:${JSON.stringify(options || {})}`;
    const result = await this._cached(key, async () => ({
      ...runBacktest(closed, { timeframe, barMs: BAR_MS[timeframe], settings: normalised, options }),
      computedAt: new Date(this._now()).toISOString(),
    }));
    return { symbol: sym, ...result, notice: EXPERIMENTAL_NOTICE };
  }

  /**
   * Structured, read-only observations for TraderClaw. Always marked
   * experimental and unvalidated; carries no action, side or size field.
   */
  async observations({ symbol, timeframe = "4h" } = {}) {
    const sym = this.validate(symbol, timeframe);
    const primary = await this.analyze({ symbol: sym, timeframe, includeCandles: false });
    const mtf = await this.multiTimeframe({ symbol: sym });
    const higher = mtf.rows.filter((r) => TIMEFRAMES.indexOf(r.timeframe) > TIMEFRAMES.indexOf(timeframe));
    return {
      schema: "gann-observations/v1",
      symbol: sym,
      timeframe,
      experimental: true,
      validated: false,
      readOnly: true,
      status: "EXPERIMENTAL_UNVALIDATED",
      notice: EXPERIMENTAL_NOTICE,
      asOf: primary.ok ? primary.lastClosed : null,
      freshness: { state: primary.freshness.state, summary: primary.freshness.summary },
      price: primary.ok ? primary.lastClosed.close : null,
      nearbyLevels: primary.ok ? {
        supports: primary.confluence.supports.slice(0, 3).map(levelObservation),
        resistances: primary.confluence.resistances.slice(0, 3).map(levelObservation),
      } : null,
      upcomingCycleWindows: primary.ok ? primary.calendar.slice(0, 6).map((c) => ({
        fromTime: new Date(c.fromTime).toISOString(),
        toTime: new Date(c.toTime).toISOString(),
        barsAway: c.barsAway,
        sources: c.sources,
        sourceCount: c.sourceCount,
      })) : [],
      anchor: primary.ok ? { type: primary.anchor.type, price: primary.anchor.price, time: new Date(primary.anchor.time).toISOString(), source: primary.anchor.source } : null,
      higherTimeframeStructure: higher.map((r) => ({ timeframe: r.timeframe, structure: r.structure || null, aboveOneByOne: r.aboveOneByOne ?? null, error: r.error || undefined })),
      reason: primary.ok ? undefined : primary.reason,
    };
  }
}

function levelObservation(c) {
  return { price: c.price, distancePct: c.distancePct, sources: c.sources, sourceCount: c.sourceCount };
}

function summarise(a) {
  if (!a.ok) return { timeframe: a.timeframe, error: a.reason, freshness: a.freshness };
  const s = a.confluence.supports[0] || null;
  const r = a.confluence.resistances[0] || null;
  const next = a.calendar[0] || null;
  const strongestNext = a.calendar.slice().sort((x, y) => y.sourceCount - x.sourceCount || x.fromIndex - y.fromIndex)[0] || null;
  return {
    timeframe: a.timeframe,
    close: a.lastClosed.close,
    lastClosedTime: a.lastClosed.closeTime,
    structure: a.structure.state,
    anchor: { type: a.anchor.type, price: a.anchor.price, time: a.anchor.time, source: a.anchor.source },
    aboveOneByOne: a.fanPosition.aboveOneByOne,
    fanBetween: a.fanPosition.between,
    nearestSupport: s && { price: s.price, distancePct: s.distancePct, sourceCount: s.sourceCount, sources: s.sources },
    nearestResistance: r && { price: r.price, distancePct: r.distancePct, sourceCount: r.sourceCount, sources: r.sources },
    nextCycle: next && { fromTime: next.fromTime, toTime: next.toTime, barsAway: next.barsAway, sourceCount: next.sourceCount, sources: next.sources },
    strongestCycle: strongestNext && { fromTime: strongestNext.fromTime, barsAway: strongestNext.barsAway, sourceCount: strongestNext.sourceCount },
    rsi14: a.indicators.rsi14,
    freshness: a.freshness,
  };
}

module.exports = { GannService, EXPERIMENTAL_NOTICE, summarise };
