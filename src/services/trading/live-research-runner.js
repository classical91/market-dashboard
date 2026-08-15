"use strict";

// Continuous, paper-only evidence collection for candle-compatible strategy
// accounts. This is deliberately separate from LiveScannerService:
//
//   lifecycle/scanner eligibility  -> promotion and production-scanner safety
//   live research eligibility      -> isolated simulated demo-account evidence
//
// A backtest-status strategy can therefore run here without being promoted.
// The only persistent mutation is its own PaperTradingService ledger plus its
// own runner state. No exchange-order adapter is imported or reachable.

const { dropUnclosedCandle } = require("../signal-screener");
const { classifyRegime } = require("./regime");
const { replayOrderForPositions } = require("./replay-order");
const { listStrategies, getLiveResearchStrategy } = require("./strategies");

const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const ACTIVITY_CAP = 120;
const TIMEFRAME_MS = Object.freeze({
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
});

function nowIso() {
  return new Date().toISOString();
}

function closeTime(candle) {
  const n = Number(candle && (candle.closeTime ?? candle.openTime ?? candle.time));
  return Number.isFinite(n) ? n : 0;
}

function isoAt(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function displayStatus(value) {
  return String(value || "").replaceAll("_", " ");
}

function timeframeMs(timeframe) {
  return TIMEFRAME_MS[String(timeframe || "").toLowerCase()] || 3_600_000;
}

function activity(type, message, at = nowIso(), data = null) {
  return { at, type, message, ...(data ? { data } : {}) };
}

function addActivities(state, entries) {
  state.activity = [...entries, ...(state.activity || [])].slice(0, ACTIVITY_CAP);
}

function strategySpecificRead(strategyId, evaluation) {
  const indicators = evaluation.indicators || {};
  if (strategyId === "donchian_breakout_v1") {
    return {
      longTrigger: indicators.channelHigh ?? null,
      shortTrigger: indicators.channelLow ?? null,
      channelLength: indicators.channelLength ?? null,
      trendSma: indicators.trendSma ?? null,
      brokeOut: indicators.brokeOut ?? null,
      fresh: indicators.fresh ?? null,
    };
  }
  if (strategyId === "smc_v1") {
    return {
      trend: indicators.trend ?? null,
      trendSource: indicators.trendSource ?? null,
      bosLevel: indicators.bosLevel ?? null,
      bosAge: indicators.bosAge ?? null,
      fvgTop: indicators.fvgTop ?? null,
      fvgBottom: indicators.fvgBottom ?? null,
      fvgAge: indicators.fvgAge ?? null,
      retested: indicators.retested ?? null,
    };
  }
  if (strategyId === "vwap_reversion_v1") {
    return {
      vwap: indicators.vwap ?? null,
      stretchAtr: indicators.stretchAtr ?? null,
      adx: indicators.adx ?? null,
      rangeState: indicators.regime ?? null,
      stalled: indicators.stalled ?? null,
      rewardR: indicators.rewardR ?? null,
    };
  }
  return {
    trend: indicators.trend ?? null,
    ema20: indicators.ema20 ?? null,
    ema50: indicators.ema50 ?? null,
    rsi: indicators.rsi ?? null,
    atr: indicators.atr ?? null,
    atrRatio: indicators.atrRatio ?? null,
    volumeRatio: indicators.volumeRatio ?? null,
  };
}

function waitingTitle(strategyId, evaluation) {
  const indicators = evaluation.indicators || {};
  if (strategyId === "donchian_breakout_v1") return "WAITING FOR CONFIRMED BREAKOUT";
  if (strategyId === "smc_v1") {
    const side = indicators.trend === "DOWN" ? "BEARISH" : indicators.trend === "UP" ? "BULLISH" : "FRESH";
    return `WATCHING FOR ${side} STRUCTURE RETEST`;
  }
  if (strategyId === "vwap_reversion_v1") {
    const side = Number(indicators.stretchAtr) < 0 ? "DOWNSIDE" : "UPSIDE";
    return `WAITING FOR ${side} STRETCH TO STALL`;
  }
  return "WAITING FOR MOMENTUM ALIGNMENT";
}

function decisionTrail(evaluation, assessment, execution) {
  const rows = [{ step: "Strategy", status: evaluation.signal, detail: (evaluation.reasons || [])[0] || null }];
  if (!assessment) {
    rows.push({ step: "Execution", status: "NO TRADE", detail: evaluation.error || "No entry signal" });
    return rows;
  }
  rows.push({
    step: "Checklist",
    status: assessment.checklist.decision,
    detail: `${assessment.checklist.confidenceScore}/${assessment.checklist.availablePoints ?? 100}`,
    failed: assessment.checklist.decision === "SKIP",
  });
  rows.push({
    step: "Edge Gate",
    status: assessment.edge.decision,
    detail: (assessment.edge.reasons || [])[0] || null,
    failed: assessment.edge.decision === "BLOCK",
  });
  rows.push({
    step: "Risk",
    status: assessment.trade.ok ? "SIZED" : "BLOCKED",
    detail: assessment.trade.ok ? `$${assessment.trade.riskUsd}` : assessment.trade.reason,
    failed: !assessment.trade.ok,
  });
  rows.push({
    step: "Execution",
    status: execution.status === "opened" ? "OPENED" : "NO TRADE",
    detail: execution.reason,
    failed: execution.status !== "opened",
  });
  return rows;
}

function currentIntent({ strategyId, evaluation, assessment = null, execution = null, position = null }) {
  const signal = evaluation.signal || "FLAT";
  const reason = (evaluation.reasons || []).slice(-1)[0] || evaluation.error || "Waiting for the next confirmed candle";
  if (position && !(execution && execution.status === "opened")) {
    return {
      code: "HOLD_POSITION",
      title: `HOLD ${position.direction}`,
      summary: `Paper position ${position.id} remains open on ${position.symbol}.`,
      reason: "Waiting for a strategy exit, stop, or target.",
      nextAction: "Manage the open position on each newly closed candle",
      signal,
      currentPrice: evaluation.price ?? position.currentPrice ?? null,
      intendedTrade: false,
    };
  }
  if (execution && execution.status === "opened") {
    return {
      code: "POSITION_OPENED",
      title: `${signal} SETUP DETECTED`,
      summary: `The structured decision pipeline accepted the ${signal} setup and opened a paper position.`,
      reason,
      nextAction: "Manage stop, target, and strategy exit conditions",
      signal,
      currentPrice: evaluation.price ?? null,
      intendedTrade: true,
    };
  }
  if (signal === "LONG" || signal === "SHORT") {
    return {
      code: "TRADE_REFUSED",
      title: "SIGNAL DETECTED — TRADE REFUSED",
      summary: `${strategyId} produced ${signal}, but a downstream gate did not permit execution.`,
      reason: execution ? execution.reason : reason,
      nextAction: "Continue watching; do not retry this closed candle",
      signal,
      currentPrice: evaluation.price ?? null,
      intendedTrade: false,
    };
  }
  return {
    code: "WAITING",
    title: waitingTitle(strategyId, evaluation),
    summary: reason,
    reason,
    nextAction: "Wait for the next confirmed candle close",
    signal: "FLAT",
    currentPrice: evaluation.price ?? null,
    intendedTrade: false,
  };
}

class CandleLiveResearchRunner {
  constructor({
    definition,
    tradingLabService,
    candleSource,
    stateCache = null,
    symbol = "BTCUSDT",
    timeframe = "1h",
    logger = console,
  }) {
    this.definition = definition;
    this.strategyId = definition.id;
    this._lab = tradingLabService;
    this._candles = candleSource;
    this._stateCache = stateCache;
    this.symbol = String(symbol).toUpperCase();
    this.timeframe = String(timeframe);
    this._logger = logger;
    this._running = false;
  }

  get stateKey() {
    return `live-research:${this.strategyId}:${this.symbol}:${this.timeframe}`;
  }

  _initialState() {
    return {
      strategyId: this.strategyId,
      strategyVersion: this.definition.version,
      symbol: this.symbol,
      timeframe: this.timeframe,
      healthStatus: "RUNNING",
      runnerStatus: "WAITING_FOR_NEXT_CANDLE",
      lastAttemptedAt: null,
      lastSuccessfulEvaluationAt: null,
      lastEvaluationAt: null,
      lastProcessedCandle: null,
      nextExpectedCandle: null,
      currentSignal: "FLAT",
      currentIntent: {
        code: "WAITING",
        title: "WAITING FOR FIRST CLOSED CANDLE",
        summary: "No live-research candle has been evaluated yet.",
        reason: "The runner is waiting for market data.",
        nextAction: "Evaluate the latest fully closed candle",
        signal: "FLAT",
        currentPrice: null,
        intendedTrade: false,
      },
      setupState: "NOT_EVALUATED",
      blockers: [],
      indicators: {},
      marketRead: null,
      decisionTrail: [],
      lastError: null,
      lastErrorAt: null,
      retryStatus: "IDLE",
      activity: [],
    };
  }

  _read() {
    const stored = this._stateCache ? this._stateCache.get(this.stateKey) : null;
    return { ...this._initialState(), ...(stored && typeof stored === "object" ? stored : {}) };
  }

  _write(state) {
    if (this._stateCache) this._stateCache.set(this.stateKey, state, STATE_TTL_MS);
    return state;
  }

  status() {
    return { ...this._read(), scanning: this._running };
  }

  async runOnce() {
    if (this._running) return { status: "busy", state: this.status() };
    this._running = true;
    const state = this._read();
    state.lastAttemptedAt = nowIso();
    state.retryStatus = state.lastError ? "RETRYING" : "IDLE";
    try {
      const candles = await this._candles.getCandles(this.symbol, this.timeframe);
      const closed = dropUnclosedCandle(Array.isArray(candles) ? candles : []).sort(
        (a, b) => closeTime(a) - closeTime(b),
      );
      if (!closed.length) {
        state.runnerStatus = "WAITING_FOR_NEXT_CANDLE";
        state.currentIntent = {
          ...state.currentIntent,
          summary: "The candle feed returned no fully closed candles.",
          reason: "Unclosed candles are never evaluated.",
        };
        return { status: "waiting", state: this._write(state) };
      }

      const prior = Number(state.lastProcessedCandle && state.lastProcessedCandle.closeTime) || 0;
      // First boot establishes the experiment at the latest confirmed close;
      // it does not silently turn the current 500-bar fetch into a backtest.
      const pending = prior ? closed.filter((bar) => closeTime(bar) > prior) : [closed[closed.length - 1]];
      if (!pending.length) {
        state.healthStatus = "RUNNING";
        state.runnerStatus = "WAITING_FOR_NEXT_CANDLE";
        state.retryStatus = "IDLE";
        return { status: "waiting", state: this._write(state) };
      }

      for (const candle of pending) {
        const index = closed.indexOf(candle);
        await this._processCandle(closed, index, candle, state);
      }
      state.healthStatus = "RUNNING";
      state.lastError = null;
      state.retryStatus = "IDLE";
      return { status: "processed", state: this._write(state) };
    } catch (err) {
      state.healthStatus = "ERROR";
      state.runnerStatus = "ERROR";
      state.lastError = err.message;
      state.lastErrorAt = nowIso();
      state.retryStatus = "WAITING_TO_RETRY";
      addActivities(state, [activity("error", `Runner error: ${err.message}`)]);
      this._logger.error?.(`[LiveResearch] ${this.strategyId} failed: ${err.message}`);
      return { status: "error", reason: err.message, state: this._write(state) };
    } finally {
      this._running = false;
    }
  }

  async _processCandle(closed, index, candle, state) {
    const candleAt = isoAt(closeTime(candle) + 1);
    const trader = this._lab.strategyLedger(this.strategyId);
    const events = [];

    // Existing positions are managed before a new entry is considered, using
    // the same pessimistic intrabar ordering as backtests and the live scanner.
    const before = trader.getOpenPositions().filter((p) => p.symbol === this.symbol);
    if (before.length) {
      const ordering = replayOrderForPositions(before, candle);
      for (const price of ordering.prices) {
        events.push(...(await trader.updatePositions({ [this.symbol]: price }, { only: [this.symbol], at: closeTime(candle) })));
      }
    }

    const evaluation = this.definition.evaluate(closed, index, {});
    let execution = null;
    let assessment = null;

    // A strategy changing sides invalidates the opposing thesis. Mindset also
    // publishes its underlying trend while its stretch filter can keep the
    // entry signal FLAT, so that trend remains protective for exits.
    const exitDirection = evaluation.signal === "LONG" || evaluation.indicators?.trend === "UP"
      ? "SHORT"
      : evaluation.signal === "SHORT" || evaluation.indicators?.trend === "DOWN"
        ? "LONG"
        : null;
    if (exitDirection) {
      const invalidated = trader
        .getOpenPositions()
        .filter((p) => p.symbol === this.symbol && p.direction === exitDirection);
      for (const position of invalidated) {
        const closedPosition = await trader.closePosition(position.id, {
          reason: "STRATEGY_EXIT",
          exitPrice: candle.close,
        });
        if (closedPosition) events.push({ type: "STRATEGY_EXIT", positionId: position.id, realized: closedPosition.realizedPnl });
      }
    }

    if (!evaluation.error && (evaluation.signal === "LONG" || evaluation.signal === "SHORT")) {
      const openOnSymbol = trader.getOpenPositions().some((p) => p.symbol === this.symbol);
      if (openOnSymbol) {
        execution = { status: "blocked", reason: `Position already open on ${this.symbol}` };
      } else {
        const regime = classifyRegime(closed.slice(0, index + 1));
        try {
          assessment = await this._lab.executeLiveResearch({
            symbol: this.symbol,
            direction: evaluation.signal,
            entryPrice: evaluation.price ?? candle.close,
            atr: evaluation.indicators?.atr ?? null,
            state: {
              ...(await this._lab.stateForInterval(this.timeframe)),
              atrRatio: evaluation.indicators?.atrRatio,
              volumeRatio: evaluation.indicators?.volumeRatio,
              macdBullish: evaluation.indicators?.macdBullish,
              allowCounterTrend: this.definition.tradesCounterTrend === true,
            },
            allowCounterTrend: this.definition.tradesCounterTrend === true,
            strategy: `live-research:${this.strategyId}:${this.timeframe}`,
            strategyId: this.strategyId,
            strategyVersion: this.definition.version,
            timeframe: this.timeframe,
            regime: regime.regime,
            regimeConfidence: regime.confidence,
            strategySignal: evaluation,
            signalSource: `live-research:${this.timeframe}`,
          });
          execution = assessment.opened
            ? { status: "opened", reason: `Opened ${assessment.opened.id}` }
            : { status: "blocked", reason: assessment.trade.reason };
        } catch (err) {
          execution = { status: "blocked", reason: err.message };
        }
      }
    }

    const open = trader.getOpenPositions().filter((p) => p.symbol === this.symbol);
    const position = open[0] || null;
    const intent = currentIntent({ strategyId: this.strategyId, evaluation, assessment, execution, position });
    const read = strategySpecificRead(this.strategyId, evaluation);
    const regimeRead = classifyRegime(closed.slice(0, index + 1));
    const newActivity = [
      activity("candle", `New ${this.timeframe} candle processed`, candleAt, {
        closeTime: closeTime(candle),
        close: candle.close,
      }),
      activity("market-read", `Regime: ${regimeRead.regime}`, candleAt),
      activity(
        execution?.status === "opened" ? "position-opened" : evaluation.signal === "FLAT" ? "waiting" : "decision",
        execution ? `${evaluation.signal}: ${execution.reason}` : intent.summary,
        candleAt,
      ),
      ...events.map((event) => activity("position-event", `${event.type} on ${this.symbol}`, candleAt, event)),
    ];

    state.lastEvaluationAt = nowIso();
    state.lastSuccessfulEvaluationAt = state.lastEvaluationAt;
    state.lastProcessedCandle = {
      openTime: Number(candle.openTime) || null,
      closeTime: closeTime(candle),
      closedAt: candleAt,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };
    state.nextExpectedCandle = isoAt(closeTime(candle) + 1 + timeframeMs(this.timeframe));
    state.currentSignal = evaluation.signal;
    state.currentIntent = intent;
    state.setupState = evaluation.error ? "NOT_READY" : evaluation.signal === "FLAT" ? "WATCHING" : "SIGNAL_DETECTED";
    state.blockers = evaluation.error
      ? [evaluation.error]
      : execution?.status === "blocked"
        ? [execution.reason]
        : evaluation.signal === "FLAT"
          ? evaluation.reasons || []
          : [];
    state.indicators = evaluation.indicators || {};
    state.strategyRead = read;
    state.marketRead = {
      regime: regimeRead.regime,
      regimeConfidence: regimeRead.confidence,
      signal: evaluation.signal,
      price: evaluation.price ?? candle.close,
    };
    state.decisionTrail = decisionTrail(evaluation, assessment, execution || { status: "flat", reason: "No entry signal" });
    state.runnerStatus = position
      ? "POSITION_OPEN"
      : execution?.status === "blocked"
        ? "BLOCKED_BY_RISK"
        : evaluation.signal === "FLAT"
          ? "WATCHING_FOR_ENTRY"
          : "WAITING_FOR_NEXT_CANDLE";
    addActivities(state, newActivity);
    this._write(state);
  }
}

class LiveResearchService {
  constructor({
    tradingLabService,
    candleSource,
    stateCache = null,
    enabled = true,
    symbol = "BTCUSDT",
    timeframe = "1h",
    intervalMs = 60_000,
    logger = console,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.symbol = String(symbol).toUpperCase();
    this.timeframe = String(timeframe);
    this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    this._logger = logger;
    this._timer = null;
    this._running = false;
    this._runners = new Map(
      listStrategies({ supportsBacktest: true })
        .filter((meta) => meta.liveResearchEligible)
        .map((meta) => {
          const definition = getLiveResearchStrategy(meta.id);
          return [
            meta.id,
            new CandleLiveResearchRunner({
              definition,
              tradingLabService,
              candleSource,
              stateCache,
              symbol: this.symbol,
              timeframe: this.timeframe,
              logger,
            }),
          ];
        }),
    );
  }

  start() {
    if (!this.enabled) {
      this._logger.log("[LiveResearch] Disabled via LIVE_RESEARCH_ENABLED=false");
      return false;
    }
    if (this._timer) return true;
    this._logger.log(
      `[LiveResearch] Watching ${this.symbol} ${this.timeframe} for ${this._runners.size} isolated strategy accounts every ${Math.round(this.intervalMs / 1000)}s`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => this._logger.error?.(`[LiveResearch] Cycle failed: ${err.message}`));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.runOnce().catch((err) => this._logger.error?.(`[LiveResearch] Initial cycle failed: ${err.message}`));
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async runOnce() {
    if (this._running) return { status: "busy", results: [] };
    this._running = true;
    try {
      // Each runner catches and persists its own failure. allSettled is the
      // outer isolation belt: one unexpected rejection still cannot stop the
      // other accounts from processing their candle.
      const settled = await Promise.allSettled([...this._runners.values()].map((runner) => runner.runOnce()));
      return {
        status: "complete",
        results: settled.map((result, index) => ({
          strategyId: [...this._runners.keys()][index],
          ...(result.status === "fulfilled" ? result.value : { status: "error", reason: result.reason?.message || String(result.reason) }),
        })),
      };
    } finally {
      this._running = false;
    }
  }

  statusFor(strategyId) {
    const runner = this._runners.get(String(strategyId));
    if (runner) {
      const runnerStatus = runner.status();
      if (!this.enabled) {
        return {
          ...runnerStatus,
          enabled: false,
          loopRunning: false,
          healthStatus: "PAUSED",
          runnerStatus: "PAUSED",
          currentIntent: {
            code: "LIVE_RESEARCH_PAUSED",
            title: "LIVE DEMO PAUSED",
            summary: "This isolated research account is not evaluating new candles.",
            reason: "LIVE_RESEARCH_ENABLED=false",
            nextAction: "Enable live research to resume closed-candle evaluation",
            signal: runnerStatus.currentSignal || "FLAT",
            currentPrice: runnerStatus.currentIntent?.currentPrice ?? null,
            intendedTrade: false,
          },
          retryStatus: "PAUSED",
        };
      }
      return {
        enabled: true,
        loopRunning: Boolean(this._timer),
        ...runnerStatus,
      };
    }
    return {
      enabled: false,
      loopRunning: Boolean(this._timer),
      strategyId: String(strategyId),
      symbol: null,
      timeframe: null,
      healthStatus: "EVENT_REPLAY_ONLY",
      runnerStatus: "WAITING_FOR_LIVE_EVENT_DATA",
      currentSignal: "FLAT",
      currentIntent: {
        code: "MISSING_EVENT_DATA",
        title: "WAITING FOR LIVE EVENT DATA",
        summary: "This strategy cannot be evaluated from OHLCV candles.",
        reason: "Live candidate, on-chain safety, liquidity, gas, slippage and MEV snapshots are required.",
        nextAction: "Connect the point-in-time event feed before enabling a live runner",
        signal: "FLAT",
        currentPrice: null,
        intendedTrade: false,
      },
      setupState: "EVENT_DATA_REQUIRED",
      blockers: ["Candle execution is unavailable for this strategy"],
      indicators: {},
      decisionTrail: [],
      activity: [],
      lastProcessedCandle: null,
      nextExpectedCandle: null,
      lastAttemptedAt: null,
      lastSuccessfulEvaluationAt: null,
      lastError: null,
      retryStatus: "NOT_APPLICABLE",
    };
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this._timer),
      scanning: this._running,
      symbol: this.symbol,
      timeframe: this.timeframe,
      intervalMs: this.intervalMs,
      runners: listStrategies().map((meta) => this.statusFor(meta.id)),
    };
  }
}

module.exports = {
  LiveResearchService,
  CandleLiveResearchRunner,
  strategySpecificRead,
  currentIntent,
  decisionTrail,
  displayStatus,
  TIMEFRAME_MS,
};
