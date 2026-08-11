"use strict";

// Native live paper-trading scanner.
//
// The Signal Bot bridge (signal-bridge.js) already replaced the TradingView
// alert webhooks for the 4h/1D confluence screener. This is the same idea one
// timeframe down: a self-contained loop that pulls its own candles, runs its
// own strategy, and feeds entries through the *same* Trading Lab pipeline
// (checklist -> edge gate -> risk sizing -> paper position). Nothing here can
// place a real order — it only ever calls TradingLabService.execute(), which
// opens paper positions.
//
// Why a separate service rather than another Signal Bot timeframe:
//
//   * Different venue. The screener reads Binance *spot* klines; this reads
//     Bitget USDT-perpetuals, so ".P" symbols like BTCUSDT.P are real here
//     instead of being proxied by their spot pair.
//   * Different cadence. A 15m strategy wants a ~60s poll so a signal is acted
//     on within a minute of the bar closing, not up to 15 minutes later.
//   * Different de-dupe contract. The Signal Bot de-dupes on *state change*
//     (FLAT -> LONG). This de-dupes on symbol + direction + candle close time,
//     which is the stronger property: a restart mid-bar cannot re-enter a
//     candle that was already traded.
//
// Safety properties, all covered by tests:
//
//   1. Disabled unless ENABLE_LIVE_SCANNER=true.
//   2. Paper only. No exchange-order code is reachable from this file.
//   3. Only fully closed candles are ever evaluated.
//   4. At most one open position per symbol.
//   5. At most one entry per symbol + direction + candle close time, persisted
//      across restarts.
//   6. An unreachable exchange degrades to a recorded error, never a crash.

const { ema, rsi, macd, dropUnclosedCandle } = require("../signal-screener");
const { replayOrderForPositions } = require("./replay-order");
const { buildTradeIntent, isExit, ENTRY_SIGNALS } = require("./trade-intent");
const { TradeIntentHandler } = require("./intent-handler");

const BITGET_CANDLES_URL = "https://api.bitget.com/api/v2/mix/market/candles";
const BITGET_OK_CODE = "00000";

// Bitget v2 granularity strings: minutes lowercase, hours/days uppercase.
const TIMEFRAMES = {
  "1m": { granularity: "1m", ms: 60_000 },
  "3m": { granularity: "3m", ms: 180_000 },
  "5m": { granularity: "5m", ms: 300_000 },
  "15m": { granularity: "15m", ms: 900_000 },
  "30m": { granularity: "30m", ms: 1_800_000 },
  "1h": { granularity: "1H", ms: 3_600_000 },
  "4h": { granularity: "4H", ms: 14_400_000 },
  "6h": { granularity: "6H", ms: 21_600_000 },
  "12h": { granularity: "12H", ms: 43_200_000 },
  "1d": { granularity: "1D", ms: 86_400_000 },
};

const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const ENTRY_KEY_CAP = 200;

function resolveTimeframe(timeframe) {
  const key = String(timeframe || "").trim().toLowerCase();
  const found = TIMEFRAMES[key];
  if (!found) {
    throw new Error(`Unsupported timeframe "${timeframe}" (expected one of ${Object.keys(TIMEFRAMES).join(", ")})`);
  }
  return { timeframe: key, ...found };
}

// TradingView-style perpetual notation ("BTCUSDT.P") maps to Bitget's plain
// contract symbol plus a productType. The ".P" is kept as the *display* and
// ledger symbol so paper trades are never confused with the spot pair the
// Signal Bot screener trades.
function resolveSymbol(symbol) {
  const display = String(symbol || "").trim().toUpperCase();
  if (!display) throw new Error("Live scanner symbol is required");
  const perp = display.endsWith(".P");
  return {
    display,
    bitgetSymbol: perp ? display.slice(0, -2) : display,
    productType: "USDT-FUTURES",
  };
}

/**
 * Parse a Bitget v2 mix candles payload into the candle shape the rest of the
 * trading code already speaks ({ openTime, open, high, low, close, volume,
 * closeTime }).
 *
 * Bitget rows are [openTimeMs, open, high, low, close, baseVolume,
 * quoteVolume] and carry no close time, so it is derived from the timeframe.
 * `closeTime` is the last millisecond *inside* the bar (openTime + duration
 * - 1), matching the Binance convention that dropUnclosedCandle() assumes.
 */
function parseBitgetCandles(payload, timeframe) {
  const { ms } = resolveTimeframe(timeframe);

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.code !== undefined && String(payload.code) !== BITGET_OK_CODE) {
      throw new Error(`Bitget error ${payload.code}: ${payload.msg || "unknown error"}`);
    }
  }

  const rows = Array.isArray(payload) ? payload : payload && Array.isArray(payload.data) ? payload.data : null;
  if (!rows) throw new Error("Bitget response contained no candle data");

  const candles = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const openTime = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    // A row with a NaN price is unusable for indicators; dropping it is safer
    // than letting it poison an EMA for the next 50 bars.
    if (![openTime, open, high, low, close].every((n) => Number.isFinite(n))) continue;
    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      closeTime: openTime + ms - 1,
    });
  }

  // Bitget documents ascending order, but sorting makes the parser independent
  // of that promise — indicators are order-sensitive and a silent reversal
  // would invert every trend read.
  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}

function sma(values, length, endIndex) {
  if (endIndex < length - 1) return null;
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

// Wilder ATR as a series. Seeded with the SMA of the first `length` true
// ranges, so its last value equals decision-engine.js's atr() over the same
// candles — one ATR definition across the codebase, asserted in the tests.
function atrSeries(candles, length = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < length + 1) return out;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  let value = trs.slice(0, length).reduce((sum, tr) => sum + tr, 0) / length;
  out[length] = value; // trs[i] corresponds to candles[i + 1]
  for (let i = length; i < trs.length; i++) {
    value = (value * (length - 1) + trs[i]) / length;
    out[i + 1] = value;
  }
  return out;
}

const MINDSET_V1_DEFAULTS = {
  fastLen: 20,
  slowLen: 50,
  rsiLen: 14,
  atrLen: 14,
  atrAvgLen: 20,
  volLen: 20,
  // RSI must agree with the EMA trend, but not be so stretched that the entry
  // is a chase. The upper/lower guards are what keep a runaway bar from
  // opening a position at the exact moment the move is exhausted.
  rsiLongMin: 50,
  rsiLongMax: 75,
  rsiShortMax: 50,
  rsiShortMin: 25,
};

/**
 * MVP "mindset_v1" strategy: EMA20/EMA50 trend direction with an RSI filter.
 *
 * Deliberately simple — it is the scaffolding the real Mindset-Aligned Trend
 * Entry rules get ported into. It returns the indicator readings alongside the
 * signal so the caller can hand them to the Trading Lab checklist, which is
 * where the 0-100 confidence score and the size multiplier actually come from.
 *
 * Every candle passed in must already be closed; this function does no
 * filtering of its own.
 */
function evaluateMindsetV1(candles, overrides = {}) {
  const options = { ...MINDSET_V1_DEFAULTS, ...overrides };
  const needed = Math.max(options.slowLen, options.rsiLen + 1, options.atrLen + options.atrAvgLen, options.volLen);
  if (!Array.isArray(candles) || candles.length < needed) {
    return {
      signal: "FLAT",
      error: `Need at least ${needed} closed candles, have ${Array.isArray(candles) ? candles.length : 0}`,
      indicators: null,
      reasons: [],
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles.length - 1;

  const fast = ema(closes, options.fastLen)[last];
  const slow = ema(closes, options.slowLen)[last];
  const rsiValue = rsi(closes, options.rsiLen)[last];
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);
  const atrs = atrSeries(candles, options.atrLen);
  const atrValue = atrs[last];

  if ([fast, slow, rsiValue, atrValue].some((v) => v == null || !Number.isFinite(v))) {
    return { signal: "FLAT", error: "Indicators not warmed up yet", indicators: null, reasons: [] };
  }

  // Volatility and volume relative to their own recent averages — the units
  // the checklist's kill switches and scoring expect.
  const recentAtrs = atrs.slice(Math.max(0, last - options.atrAvgLen + 1), last + 1).filter((v) => v != null);
  const atrAvg = recentAtrs.length ? recentAtrs.reduce((s, v) => s + v, 0) / recentAtrs.length : atrValue;
  const volAvg = sma(volumes, options.volLen, last);

  const trend = fast > slow ? "UP" : fast < slow ? "DOWN" : "FLAT";
  const reasons = [
    `EMA${options.fastLen} ${fast.toFixed(2)} vs EMA${options.slowLen} ${slow.toFixed(2)} — trend ${trend}`,
    `RSI${options.rsiLen} ${rsiValue.toFixed(1)}`,
  ];

  let signal = "FLAT";
  if (trend === "UP") {
    if (rsiValue > options.rsiLongMin && rsiValue < options.rsiLongMax) signal = "LONG";
    else reasons.push(`RSI outside long band (${options.rsiLongMin}-${options.rsiLongMax}) — no entry`);
  } else if (trend === "DOWN") {
    if (rsiValue < options.rsiShortMax && rsiValue > options.rsiShortMin) signal = "SHORT";
    else reasons.push(`RSI outside short band (${options.rsiShortMin}-${options.rsiShortMax}) — no entry`);
  } else {
    reasons.push("EMAs equal — no trend");
  }

  return {
    signal,
    strategy: "mindset_v1",
    error: null,
    reasons,
    indicators: {
      ema20: fast,
      ema50: slow,
      rsi: rsiValue,
      atr: atrValue,
      atrRatio: atrAvg > 0 ? atrValue / atrAvg : 1,
      volumeRatio: volAvg > 0 ? volumes[last] / volAvg : 1,
      macdBullish: macdLine[last] != null && signalLine[last] != null ? macdLine[last] > signalLine[last] : null,
      trend,
    },
  };
}

const STRATEGIES = { mindset_v1: evaluateMindsetV1 };

function entryKey(symbol, direction, candleTs) {
  return `${symbol}:${direction}:${candleTs}`;
}

// One bar can produce several intents (close the long, then consider the
// short). The cycle reports the most consequential outcome rather than
// whichever happened to be processed last — otherwise an executed exit would
// be masked by the "already-evaluated" of the entry that followed it.
const STATUS_PRIORITY = [
  "exited",
  "opened",
  "blocked",
  "dry-run",
  "skipped",
  "already-evaluated",
  "ignored",
  "flat",
];

function summarizeStatuses(statuses) {
  for (const candidate of STATUS_PRIORITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "flat";
}

class LiveScannerService {
  constructor({
    tradingLabService,
    stateCache = null,
    signalActionStore = null,
    enabled = false,
    paperTradeEnabled = true,
    symbol = "BTCUSDT.P",
    timeframe = "15m",
    strategy = "mindset_v1",
    intervalMs = 60_000,
    contextInterval = "4h",
    book = "main",
    candleLimit = 300,
    requestTimeoutMs = 10_000,
    fetchImpl = null,
    logger = console,
  } = {}) {
    this._lab = tradingLabService;
    this._stateCache = stateCache;
    this._actionStore = signalActionStore;
    this._logger = logger;
    this._fetch = fetchImpl || ((...args) => fetch(...args));

    this.enabled = Boolean(enabled);
    this.paperTradeEnabled = Boolean(paperTradeEnabled);
    this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    this.book = String(book || "main").toLowerCase();
    this.candleLimit = Math.min(Math.max(Number(candleLimit) || 300, 100), 1000);
    this.requestTimeoutMs = Number(requestTimeoutMs) > 0 ? Number(requestTimeoutMs) : 10_000;
    // Regime/daily-bias context deliberately comes from a higher timeframe than
    // the scan interval: a 15m bar has no opinion on the daily trend.
    this.contextInterval = String(contextInterval || "4h");

    // Config errors surface at construction, not on the first scan, so a bad
    // LIVE_SCANNER_TIMEFRAME fails the deploy loudly instead of silently never
    // trading.
    const resolvedSymbol = resolveSymbol(symbol);
    const resolvedTimeframe = resolveTimeframe(timeframe);
    this.symbol = resolvedSymbol.display;
    this._bitgetSymbol = resolvedSymbol.bitgetSymbol;
    this._productType = resolvedSymbol.productType;
    this.timeframe = resolvedTimeframe.timeframe;
    this._granularity = resolvedTimeframe.granularity;
    this._timeframeMs = resolvedTimeframe.ms;

    const strategyName = String(strategy || "mindset_v1");
    const strategyFn = STRATEGIES[strategyName];
    if (!strategyFn) {
      throw new Error(`Unknown strategy "${strategyName}" (expected one of ${Object.keys(STRATEGIES).join(", ")})`);
    }
    this.strategy = strategyName;
    this._strategyFn = strategyFn;

    // The single boundary an intent crosses to become an action. Entries go
    // through every gate; exits deliberately bypass them — see intent-handler.
    this._handler = new TradeIntentHandler({
      tradingLabService,
      book: this.book,
      contextInterval: this.contextInterval,
      paperTradeEnabled: this.paperTradeEnabled,
      signalSource: this._signalSource(),
      logger,
    });

    this._timer = null;
    this._running = false;
    this._status = {
      lastScanAt: null,
      lastCandle: null,
      lastSignal: null,
      lastAction: null,
      lastError: null,
      lastErrorAt: null,
      scanCount: 0,
      errorCount: 0,
      signalSource: this._signalSource(),
    };
  }

  _signalSource() {
    return `live-scanner:${this.timeframe}`;
  }

  get _stateKey() {
    return `live-scanner:${this.symbol}:${this.timeframe}`;
  }

  _readState() {
    const stored = this._stateCache ? this._stateCache.get(this._stateKey) : null;
    return {
      lastCandleCloseTime: 0,
      entryKeys: [],
      ...(stored && typeof stored === "object" ? stored : {}),
    };
  }

  _writeState(state) {
    if (!this._stateCache) return;
    try {
      this._stateCache.set(this._stateKey, state, STATE_TTL_MS);
    } catch (err) {
      this._logger.error?.(`[LiveScanner] Failed to persist state: ${err.message}`);
    }
  }

  start() {
    if (!this.enabled) {
      this._logger.log("[LiveScanner] Disabled — set ENABLE_LIVE_SCANNER=true to enable");
      return false;
    }
    if (this._timer) return true;
    this._logger.log(
      `[LiveScanner] Watching ${this.symbol} ${this.timeframe} (${this.strategy}) every ${Math.round(this.intervalMs / 1000)}s — ` +
        `${this.paperTradeEnabled ? `paper trading into book "${this.book}"` : "dry run, opening nothing"}`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => this._logger.error(`[LiveScanner] Scan failed: ${err.message}`));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.runOnce().catch((err) => this._logger.error(`[LiveScanner] Initial scan failed: ${err.message}`));
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async fetchCandles() {
    const url =
      `${BITGET_CANDLES_URL}?symbol=${encodeURIComponent(this._bitgetSymbol)}` +
      `&productType=${encodeURIComponent(this._productType)}` +
      `&granularity=${encodeURIComponent(this._granularity)}` +
      `&limit=${this.candleLimit}`;

    // A hung exchange must not wedge the loop until the next interval stacks
    // on top of it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this._fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Bitget candles HTTP ${res.status} for ${this._bitgetSymbol} ${this._granularity}`);
      return parseBitgetCandles(await res.json(), this.timeframe);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One scan cycle. Returns a result object describing what happened, so the
   * tests and the status endpoint can see the decision rather than inferring
   * it. Never throws for an exchange failure — that is recorded and reported.
   */
  async runOnce() {
    // A slow cycle must not have another stacked on top of it: two concurrent
    // passes could both see the same candle as un-traded and open twice.
    if (this._running) return { status: "busy" };
    this._running = true;
    try {
      return await this._scan();
    } finally {
      this._running = false;
    }
  }

  async _scan() {
    this._status.lastScanAt = new Date().toISOString();
    this._status.scanCount += 1;

    let candles;
    try {
      candles = await this.fetchCandles();
    } catch (err) {
      // Graceful degradation: the exchange being down is a recorded condition,
      // not a crash, and the next tick retries.
      this._status.errorCount += 1;
      this._status.lastError = err.message;
      this._status.lastErrorAt = new Date().toISOString();
      this._logger.error(`[LiveScanner] Candle fetch failed: ${err.message}`);
      return { status: "error", reason: err.message };
    }
    this._status.lastError = null;

    const closed = dropUnclosedCandle(candles);
    if (!closed.length) return { status: "no-candles" };

    const candle = closed[closed.length - 1];
    this._status.lastCandle = {
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      closedAt: new Date(candle.closeTime + 1).toISOString(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };

    const state = this._readState();
    const isNewCandle = candle.closeTime > state.lastCandleCloseTime;

    // Mark open positions against every bar that closed since the last pass, so
    // stops and targets fill on this scanner's own timeframe rather than
    // waiting for someone to load the dashboard.
    const markEvents = await this._markPositions(closed, state.lastCandleCloseTime);

    const evaluation = this._strategyFn(closed);
    this._status.lastSignal = {
      signal: evaluation.signal,
      strategy: this.strategy,
      candleCloseTime: candle.closeTime,
      price: candle.close,
      error: evaluation.error || null,
      indicators: evaluation.indicators,
      reasons: evaluation.reasons,
    };

    state.lastCandleCloseTime = Math.max(state.lastCandleCloseTime, candle.closeTime);
    this._writeState(state);

    if (evaluation.error) return { status: "not-ready", reason: evaluation.error, markEvents };

    const intents = this.intentsFor(evaluation, candle);
    const actions = [];
    const statuses = [];

    for (const intent of intents) {
      // Exits are not rate-limited by the candle claim and are not de-duped
      // against it: a broken thesis should be actionable on the bar it breaks,
      // and re-emitting an exit for an already-closed position is a harmless
      // no-op the handler absorbs.
      if (isExit(intent)) {
        const outcome = await this._handler.handle(intent);
        if (outcome.status === "noop") continue;
        actions.push(this._record(intent, outcome, evaluation));
        statuses.push(outcome.status);
        continue;
      }

      // Entries confirm once per bar. Re-evaluating the same closed candle on
      // the next 60s tick must not produce a second entry.
      if (!isNewCandle) {
        statuses.push("already-evaluated");
        continue;
      }
      // De-dupe on symbol + direction + candle, persisted, so a restart
      // mid-bar cannot re-enter a candle already acted on.
      const key = entryKey(intent.symbol, intent.signal, intent.candleTs);
      if (state.entryKeys.includes(key)) {
        actions.push(this._record(intent, { status: "skipped", reason: "Already traded this candle" }, evaluation));
        statuses.push("skipped");
        continue;
      }

      // Claim the candle before handing it over. If the gates refuse, the
      // candle stays claimed — a refusal is a decision about this bar, and
      // retrying it 60 seconds later would re-run the same rejected setup.
      if (this.paperTradeEnabled) {
        state.entryKeys = [key, ...state.entryKeys].slice(0, ENTRY_KEY_CAP);
        this._writeState(state);
      }

      const outcome = await this._handler.handle(intent);
      actions.push(this._record(intent, outcome, evaluation));
      statuses.push(outcome.status);
    }

    return { status: summarizeStatuses(statuses), actions, action: actions[actions.length - 1] || null, markEvents };
  }

  /**
   * The scanner's entire decision surface: raw trade intent from candle data.
   *
   * A pure function of the strategy reading — it does not look at the book, and
   * it never computes a level, a size or a score. An exit intent is emitted
   * whenever the trend opposes a thesis, whether or not such a position is
   * actually open; resolving that against the ledger is the handler's job.
   *
   * A single bar can produce both an exit and an entry (the trend flipped
   * down: close the long, then consider the short). They are returned in that
   * order so the position slot is freed before the entry is judged.
   */
  intentsFor(evaluation, candle) {
    const common = {
      symbol: this.symbol,
      price: candle.close,
      tf: this.timeframe,
      source: "live_scanner",
      strategy: this.strategy,
      candleTs: new Date(candle.closeTime + 1).toISOString(),
      indicators: evaluation.indicators,
    };

    const intents = [];
    const trend = evaluation.indicators.trend;
    if (trend === "DOWN") intents.push(buildTradeIntent({ ...common, signal: "EXIT_LONG" }));
    if (trend === "UP") intents.push(buildTradeIntent({ ...common, signal: "EXIT_SHORT" }));
    if (ENTRY_SIGNALS.has(evaluation.signal)) {
      intents.push(buildTradeIntent({ ...common, signal: evaluation.signal }));
    }
    return intents;
  }

  async _markPositions(closed, since) {
    if (!this._lab) return [];
    let trader;
    try {
      trader = this._lab.book(this.book);
    } catch {
      return [];
    }
    const open = trader.getOpenPositions().filter((p) => p.symbol === this.symbol);
    if (!open.length) return [];

    const bars = closed.filter((c) => c.closeTime > since);
    if (!bars.length) return [];

    const events = [];
    for (const bar of bars) {
      const positions = trader.getOpenPositions().filter((p) => p.symbol === this.symbol);
      if (!positions.length) break;
      // Same intrabar ordering the backtester and the signal bridge use, so a
      // forward paper run and a replay agree on which of SL/TP fired first.
      const { prices } = replayOrderForPositions(positions, bar);
      for (const price of prices) {
        events.push(...(await trader.updatePositions({ [this.symbol]: price }, { only: [this.symbol] })));
      }
    }
    for (const event of events) {
      this._logger.log(`[LiveScanner] ${event.type} on ${event.symbol} (${event.realized})`);
    }
    return events;
  }

  // Every accepted *and* rejected intent is logged and persisted, so the
  // decision trail exists even for the bars that never became trades. The
  // scanner records what the handler decided; it does not decide anything here.
  _record(intent, outcome, evaluation = null) {
    const assessment = outcome.assessment || null;
    const action = {
      timestamp: new Date().toISOString(),
      source: "live-scanner",
      symbol: intent.symbol,
      interval: intent.tf,
      strategy: intent.strategy,
      direction: intent.signal,
      book: this.book,
      status: outcome.status,
      reason: outcome.reason,
      entryPrice: intent.price,
      candleTs: intent.candleTs,
      indicators: intent.indicators || (evaluation ? evaluation.indicators : null),
      // Read back off the assessment for the audit trail. These are the
      // Trading Lab's outputs, never the scanner's inputs.
      decision: assessment ? assessment.decision : null,
      confidenceScore: assessment ? assessment.checklist.confidenceScore : null,
      sizeMultiplier: assessment ? assessment.sizeMultiplier : null,
      opened: outcome.opened || null,
      closed: outcome.closed ? outcome.closed.map((p) => p.id) : null,
    };

    let stored = action;
    if (this._actionStore && typeof this._actionStore.record === "function") {
      try {
        stored = this._actionStore.record(action) || action;
      } catch (err) {
        this._logger.error?.(`[LiveScanner] Failed to persist action: ${err.message}`);
      }
    }
    this._status.lastAction = stored;
    this._logger.log(
      `[LiveScanner] ${outcome.status.toUpperCase()} ${intent.symbol} ${intent.signal} ${intent.tf}: ${outcome.reason}`,
    );
    return stored;
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this._timer),
      scanning: this._running,
      paperTradeEnabled: this.paperTradeEnabled,
      mode: "paper",
      symbol: this.symbol,
      exchange: "bitget",
      productType: this._productType,
      timeframe: this.timeframe,
      strategy: this.strategy,
      book: this.book,
      intervalMs: this.intervalMs,
      contextInterval: this.contextInterval,
      ...this._status,
    };
  }
}

module.exports = {
  LiveScannerService,
  TradeIntentHandler,
  buildTradeIntent,
  parseBitgetCandles,
  evaluateMindsetV1,
  atrSeries,
  resolveTimeframe,
  resolveSymbol,
  entryKey,
  TIMEFRAMES,
  MINDSET_V1_DEFAULTS,
};
