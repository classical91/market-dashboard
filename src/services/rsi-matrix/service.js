"use strict";

// Multi-Timeframe RSI Matrix.
//
// Behavioural spec: the reference Pine indicator — RSI 14 on close, requested
// separately for every instrument × timeframe (default 1W / 1D / 4H / 1H),
// with an AVG row that is the plain mean of those readings. This ports the
// logic, not the Pine structure: instead of forty hand-numbered
// request.security() calls, it loops the configured registry × enabled
// timeframes, and every one of those cells fails on its own.
//
// Rules that keep the page honest:
// - RSI comes from signal-screener.js's rsi(), the same Wilder formula every
//   other screener here uses, on closed bars only (dropUnclosedCandle, the
//   screener's bar-close semantics).
// - A cell with no data is null with a reason — never 0, never a substitute
//   market.
// - AVG needs every enabled timeframe. A missing weekly would otherwise shift
//   the "multi-timeframe" mean without saying so; the row reports 3/4 instead.
// - Nothing here says BUY or SELL. States describe RSI momentum; the AVG
//   extremes are labelled MTF overbought / oversold.

const { rsi, dropUnclosedCandle } = require("../signal-screener");
const { TIMEFRAMES, TIMEFRAME_LABELS, TIMEFRAME_MS, bucketStart, ttlUntilNextClose } = require("./candles");
const { PROVIDER_DEFINITIONS } = require("./providers");

const RSI_LENGTH = 14;

// Individual cells: momentum bands from the reference indicator.
const CELL_THRESHOLDS = [
  { min: 75, state: "strong-bullish", label: "Strong bullish momentum" },
  { min: 65, state: "bullish", label: "Bullish momentum" },
  { min: 55, state: "weak-bullish", label: "Weak bullish momentum" },
  { min: 45, state: "neutral", label: "Neutral" },
  { min: 35, state: "weak-bearish", label: "Weak bearish momentum" },
  { min: 25, state: "bearish", label: "Bearish momentum", exclusiveMin: true },
  { min: -Infinity, state: "strong-bearish", label: "Strong bearish momentum" },
];

// The AVG row reads differently: a very high multi-timeframe average is a
// stretched market (potential top), a very low one a washed-out market
// (potential bottom).
const AVG_OVERBOUGHT = 70;
const AVG_OVERSOLD = 30;

// A failed series is retried after this long rather than on every page load,
// so one dead venue can't turn each refresh into a request storm.
const ERROR_TTL_MS = 3 * 60 * 1000;
// Manual Refresh: at most one forced pass per window across all viewers, and
// within it only series older than MIN_FORCE_AGE_MS are re-read.
const FORCE_COOLDOWN_MS = 60 * 1000;
const MIN_FORCE_AGE_MS = 60 * 1000;

// Concurrent upstream requests per provider on a cold refresh.
const PROVIDER_CONCURRENCY = { "coingecko-mcap": 1, yahoo: 3, default: 4 };

function classifyRsi(value) {
  if (value == null || !Number.isFinite(value)) return null;
  for (const band of CELL_THRESHOLDS) {
    if (band.exclusiveMin ? value > band.min : value >= band.min) return band.state;
  }
  return "strong-bearish";
}

function stateLabel(state) {
  const band = CELL_THRESHOLDS.find((b) => b.state === state);
  return band ? band.label : null;
}

function classifyAverage(value) {
  if (value == null) return null;
  if (value <= AVG_OVERSOLD) return "mtf-oversold";
  if (value >= AVG_OVERBOUGHT) return "mtf-overbought";
  return "normal";
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * AVG of the enabled timeframes: the arithmetic mean when every one of them
 * has a value, otherwise null plus how many were available.
 */
function averageOf(values, timeframes) {
  const present = timeframes.map((tf) => values[tf]).filter((v) => v != null && Number.isFinite(v));
  const complete = timeframes.length > 0 && present.length === timeframes.length;
  return {
    average: complete ? round2(present.reduce((a, b) => a + b, 0) / present.length) : null,
    available: present.length,
    required: timeframes.length,
  };
}

/** Latest RSI on closed bars, or a reason there isn't one. */
function rsiFromCandles(candles, { length = RSI_LENGTH, now = Date.now(), tf } = {}) {
  const closed = dropUnclosedCandle(candles || [], now).filter((c) => c.closeTime <= now);
  const need = length + 1;
  if (closed.length < need) {
    return {
      value: null,
      bars: closed.length,
      error: `Only ${closed.length} closed ${TIMEFRAME_LABELS[tf] || tf} bar${closed.length === 1 ? "" : "s"} — RSI ${length} needs ${need}`,
    };
  }
  const series = rsi(
    closed.map((c) => c.close),
    length,
  );
  const value = series[series.length - 1];
  if (value == null || !Number.isFinite(value)) return { value: null, bars: closed.length, error: "RSI could not be computed" };
  return { value: round2(value), bars: closed.length, lastBarClose: closed[closed.length - 1].closeTime, error: null };
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

function extreme(cells, pick) {
  let best = null;
  for (const cell of cells) {
    if (cell.value == null) continue;
    if (!best || pick(cell.value, best.value)) best = cell;
  }
  return best;
}

function summarize(rows, timeframes) {
  const cells = [];
  for (const row of rows) {
    for (const tf of timeframes) {
      if (row.values[tf] != null) cells.push({ id: row.id, label: row.label, timeframe: tf, value: row.values[tf] });
    }
  }
  const averages = rows.filter((r) => r.average != null).map((r) => ({ id: r.id, label: r.label, value: r.average }));
  return {
    mostOverbought: extreme(cells, (a, b) => a > b),
    mostOversold: extreme(cells, (a, b) => a < b),
    strongestAverage: extreme(averages, (a, b) => a > b),
    weakestAverage: extreme(averages, (a, b) => a < b),
    mtfOverbought: averages.filter((a) => a.value >= AVG_OVERBOUGHT),
    mtfOversold: averages.filter((a) => a.value <= AVG_OVERSOLD),
  };
}

class RsiMatrixService {
  constructor({ settingsService, providers, cache, now = () => Date.now(), forceCooldownMs = FORCE_COOLDOWN_MS } = {}) {
    this._settings = settingsService;
    this._providers = providers || {};
    this._cache = cache;
    this._now = now;
    this._forceCooldownMs = forceCooldownMs;
    this._lastForceAt = 0;
    this._limiters = new Map();
  }

  _limiter(provider) {
    if (!this._limiters.has(provider)) {
      this._limiters.set(provider, createLimiter(PROVIDER_CONCURRENCY[provider] || PROVIDER_CONCURRENCY.default));
    }
    return this._limiters.get(provider);
  }

  /** Starts background history collection for the sampled dominance series. */
  startSampler() {
    if (this._providers.dominance && this._providers.dominance.start) this._providers.dominance.start();
  }

  /**
   * One upstream series, cached by provider + symbol + timeframe. Concurrent
   * callers share one in-flight request; failures are cached briefly too.
   */
  async _series(provider, symbol, tf, { forced } = {}) {
    const key = `rsi-matrix:candles:${provider}:${symbol}:${tf}`;
    const load = async () => {
      const fetchedAt = this._now();
      let value;
      try {
        const source = this._providers[provider];
        if (!source || typeof source.fetchCandles !== "function") {
          throw Object.assign(new Error(`Provider "${provider}" is not available`), { scope: "venue" });
        }
        const candles = await this._limiter(provider)(() => source.fetchCandles(symbol, tf));
        value = { candles: Array.isArray(candles) ? candles : [], fetchedAt, error: null };
        this._cache.set(key, value, ttlUntilNextClose(tf, fetchedAt));
      } catch (err) {
        value = { candles: [], fetchedAt, error: err.message || "Request failed" };
        this._cache.set(key, value, ERROR_TTL_MS);
      }
      return value;
    };
    if (forced) {
      const cached = this._cache.get(key);
      if (!cached || this._now() - cached.fetchedAt >= MIN_FORCE_AGE_MS) {
        // A separate zero-TTL key shares one forced refresh between
        // concurrent callers; the loader writes the ordinary key.
        return this._cache.getOrLoad(`${key}:forced`, 0, load);
      }
    }
    return this._cache.getOrLoad(key, 0, load);
  }

  async _cell(instrument, tf, opts) {
    const series = await this._series(instrument.provider, instrument.providerSymbol, tf, opts);
    const now = this._now();
    const freshness = { fetchedAt: new Date(series.fetchedAt).toISOString(), lastBarClose: null, barsBehind: null };
    if (series.error) return { value: null, state: null, bars: 0, error: series.error, freshness };
    const result = rsiFromCandles(series.candles, { tf, now });
    if (result.lastBarClose != null) {
      freshness.lastBarClose = new Date(result.lastBarClose).toISOString();
      // How many bars behind the most recently closed one the data is — a
      // weekend for an index, or a stalled feed. Informational, not an error.
      const expected = bucketStart(now, tf) - 1;
      freshness.barsBehind = Math.max(0, Math.round((expected - result.lastBarClose) / TIMEFRAME_MS[tf]));
    }
    let error = result.error;
    if (error && instrument.provider === "dominance") {
      error = `Building history: ${result.bars}/${RSI_LENGTH + 1} consecutive ${TIMEFRAME_LABELS[tf]} bars sampled`;
    }
    return { value: result.value, state: classifyRsi(result.value), bars: result.bars, error, freshness };
  }

  async _row(instrument, timeframes, opts) {
    const cells = {};
    await Promise.all(
      timeframes.map(async (tf) => {
        try {
          cells[tf] = await this._cell(instrument, tf, opts);
        } catch (err) {
          cells[tf] = { value: null, state: null, bars: 0, error: err.message, freshness: null };
        }
      }),
    );
    const values = {};
    const states = {};
    const errors = {};
    const freshness = {};
    for (const tf of timeframes) {
      values[tf] = cells[tf].value;
      states[tf] = cells[tf].state;
      errors[tf] = cells[tf].error;
      freshness[tf] = cells[tf].freshness;
    }
    const avg = averageOf(values, timeframes);
    const failed = timeframes.filter((tf) => values[tf] == null);
    const definition = PROVIDER_DEFINITIONS[instrument.provider];
    return {
      id: instrument.id,
      symbol: instrument.label,
      label: instrument.label,
      group: instrument.group,
      source: instrument.provider,
      sourceLabel: definition ? definition.label : instrument.provider,
      providerSymbol: instrument.providerSymbol,
      note: instrument.note || null,
      values,
      states,
      errors,
      average: avg.average,
      averageState: classifyAverage(avg.average),
      averageTone: classifyRsi(avg.average),
      averageAvailable: avg.available,
      averageRequired: avg.required,
      freshness,
      error: timeframes.length && failed.length === timeframes.length ? `Data unavailable: ${errors[failed[0]]}` : null,
    };
  }

  async getMatrix({ force = false } = {}) {
    const snapshot = this._settings.snapshot();
    const timeframes = TIMEFRAMES.filter((tf) => snapshot.timeframes.some((t) => t.key === tf && t.enabled));
    const instruments = snapshot.instruments.filter((row) => row.enabled);

    const now = this._now();
    const forced = Boolean(force) && now - this._lastForceAt >= this._forceCooldownMs;
    if (forced) this._lastForceAt = now;

    const rows = await Promise.all(instruments.map((instrument) => this._row(instrument, timeframes, { forced })));
    const groups = snapshot.groups.map((group) => {
      const members = rows.filter((row) => row.group === group.id);
      return { id: group.id, label: group.label, rows: members.map((row) => row.id), summary: summarize(members, timeframes) };
    });

    return {
      updatedAt: new Date(this._now()).toISOString(),
      rsiLength: RSI_LENGTH,
      source: "close",
      timeframes,
      timeframeLabels: timeframes.reduce((acc, tf) => ({ ...acc, [tf]: TIMEFRAME_LABELS[tf] }), {}),
      thresholds: {
        cells: CELL_THRESHOLDS.filter((b) => Number.isFinite(b.min)).map(({ min, state, label }) => ({ min, state, label })),
        average: { overbought: AVG_OVERBOUGHT, oversold: AVG_OVERSOLD },
      },
      groups,
      instruments: rows,
      refresh: {
        requested: Boolean(force),
        forced,
        nextForceAt: new Date(this._lastForceAt + this._forceCooldownMs).toISOString(),
      },
    };
  }
}

module.exports = {
  RsiMatrixService,
  RSI_LENGTH,
  CELL_THRESHOLDS,
  AVG_OVERBOUGHT,
  AVG_OVERSOLD,
  ERROR_TTL_MS,
  classifyRsi,
  classifyAverage,
  stateLabel,
  averageOf,
  rsiFromCandles,
  summarize,
  createLimiter,
};
