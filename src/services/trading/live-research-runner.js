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
const { EXECUTION_OWNERS, ownedBy } = require("./execution-owner");

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
      // Where this experiment started. Every trade in the ledger must come from
      // a candle that closed after this one; the baseline itself is never
      // evaluated for an entry.
      baselineCandle: null,
      baselineAt: null,
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

  // Drop persisted state entirely, so the next cycle re-baselines. Used by an
  // experiment reset; never called on a normal cycle.
  clearState() {
    if (this._stateCache) this._stateCache.set(this.stateKey, this._initialState(), STATE_TTL_MS);
  }

  async runOnce() {
    if (this._running) return { status: "busy", state: this.status() };
    this._running = true;
    const state = this._read();
    state.lastAttemptedAt = nowIso();
    state.retryStatus = state.lastError ? "RETRYING" : "IDLE";
    try {
      // Raw Binance klines include the still-forming bar. A cached snapshot of
      // that bar is not authoritative after its close timestamp passes, so a
      // runner cycle always requests a coalesced forced refresh before deciding
      // that a new close is final.
      const candles = await this._candles.getCandles(this.symbol, this.timeframe, { force: true });
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

      // ── First start: establish a baseline, do not trade it ────────────────
      //
      // The latest already-closed candle closed BEFORE this experiment existed.
      // Evaluating it for an entry would open a position from information the
      // experiment was not running to receive — a one-bar backtest booked into
      // a live demo ledger, indistinguishable afterwards from a real result.
      //
      // App starts 12:47, latest finalized 1h candle closed 12:00:
      //   12:00  baseline only, never evaluated for entry
      //   13:00  the first candle this experiment can act on
      //
      // Position management is the exception and runs below: if a live-research
      // position already exists while runner state is missing or corrupt, its
      // stop and target must still be honoured. That path can only CLOSE what
      // is already open; it can never invent a retroactive entry.
      if (!prior) {
        return { status: "baseline", state: this._write(await this._establishBaseline(closed, state)) };
      }

      const pending = closed.filter((bar) => closeTime(bar) > prior);
      if (!pending.length) {
        state.healthStatus = "RUNNING";
        state.runnerStatus = "WAITING_FOR_NEXT_CANDLE";
        state.retryStatus = "IDLE";
        return { status: "waiting", state: this._write(state) };
      }

      for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
        const candle = pending[pendingIndex];
        const index = closed.indexOf(candle);
        // Missed bars are replayed only for an already-open position's SL/TP.
        // Present-time decision context cannot be used to invent historical
        // entries. Entry evaluation resumes on the newest freshly fetched
        // confirmed close.
        await this._processCandle(closed, index, candle, state, {
          allowEntry: pendingIndex === pending.length - 1,
        });
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

  /**
   * Mark where this experiment starts, without trading the candle that marks it.
   *
   * Called on the first cycle that has no `lastProcessedCandle` — a genuine
   * first start, or a restart after the runner's state was lost. Both are
   * handled the same way for entries: the baseline candle is recorded and never
   * evaluated, so the first tradeable candle is one that closes afterwards.
   *
   * The two cases differ in one respect. If a live-research position is already
   * open, state loss must not orphan it: its stop and target are honoured
   * against the baseline candle before the baseline is written. That is
   * position MANAGEMENT — it can close an existing position and cannot open
   * one — so it preserves the safety property without inventing history.
   */
  async _establishBaseline(closed, state) {
    const candle = closed[closed.length - 1];
    const candleAt = isoAt(closeTime(candle) + 1);
    const trader = this._lab.strategyLedger(this.strategyId);
    const events = [];

    const orphaned = trader
      .getOpenPositions()
      .filter((p) => p.symbol === this.symbol && ownedBy(p, EXECUTION_OWNERS.LIVE_RESEARCH));

    if (orphaned.length) {
      // Same pessimistic intrabar ordering the runner and the backtester use:
      // when a bar could have hit both the stop and the target, the stop wins.
      const ordering = replayOrderForPositions(orphaned, candle);
      for (const price of ordering.prices) {
        events.push(...(await trader.updatePositions(
          { [this.symbol]: price },
          { only: [this.symbol], positionIds: orphaned.map((position) => position.id), at: closeTime(candle) },
        )));
      }
    }

    const stillOpen = trader
      .getOpenPositions()
      .find((p) => p.symbol === this.symbol && ownedBy(p, EXECUTION_OWNERS.LIVE_RESEARCH)) || null;

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
    // Recorded so the dashboard can say when the experiment started and prove
    // that every result came from a candle after it.
    state.baselineCandle = { ...state.lastProcessedCandle };
    state.baselineAt = nowIso();
    state.healthStatus = "RUNNING";
    state.runnerStatus = stillOpen ? "POSITION_OPEN" : "WAITING_FOR_NEXT_CANDLE";
    state.retryStatus = "IDLE";
    state.lastError = null;
    state.currentSignal = "FLAT";
    state.setupState = "NOT_EVALUATED";
    state.currentIntent = {
      code: "BASELINE_ESTABLISHED",
      title: "WAITING FOR NEXT CANDLE",
      summary: `Experiment baseline set at the ${this.timeframe} candle closing ${candleAt}.`,
      reason:
        "The latest candle closed before this experiment started, so it is a baseline only and is never traded.",
      nextAction: `Evaluate the next ${this.timeframe} candle to close`,
      signal: "FLAT",
      currentPrice: Number(candle.close) || null,
      intendedTrade: false,
    };

    addActivities(state, [
      activity(
        "baseline",
        `Experiment baseline established at the ${this.timeframe} candle closing ${candleAt}; it is not evaluated for entry`,
        candleAt,
      ),
      ...(orphaned.length
        ? [activity(
            "recovery",
            `Runner state was missing with ${orphaned.length} open position(s); stops and targets were honoured without creating any entry`,
            candleAt,
          )]
        : []),
      ...events.map((event) => activity("position-event", `${event.type} on ${this.symbol}`, candleAt, event)),
    ]);

    return state;
  }

  async _processCandle(closed, index, candle, state, { allowEntry = true } = {}) {
    const candleAt = isoAt(closeTime(candle) + 1);
    const trader = this._lab.strategyLedger(this.strategyId);
    const events = [];

    // Existing positions are managed before a new entry is considered, using
    // the same pessimistic intrabar ordering as backtests and the live scanner.
    const before = trader
      .getOpenPositions()
      .filter((p) => p.symbol === this.symbol && ownedBy(p, EXECUTION_OWNERS.LIVE_RESEARCH));
    if (before.length) {
      const ordering = replayOrderForPositions(before, candle);
      for (const price of ordering.prices) {
        events.push(...(await trader.updatePositions(
          { [this.symbol]: price },
          {
            only: [this.symbol],
            positionIds: before.map((position) => position.id),
            at: closeTime(candle),
          },
        )));
      }
    }

    if (!allowEntry) {
      const position = trader
        .getOpenPositions()
        .find((p) => p.symbol === this.symbol && ownedBy(p, EXECUTION_OWNERS.LIVE_RESEARCH)) || null;
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
      state.runnerStatus = position ? "POSITION_OPEN" : "CATCHING_UP";
      addActivities(state, [
        activity("catch-up", `Missed ${this.timeframe} candle replayed for position management; entry skipped`, candleAt),
        ...events.map((event) => activity("position-event", `${event.type} on ${this.symbol}`, candleAt, event)),
      ]);
      this._write(state);
      return;
    }

    const evaluation = this.definition.evaluate(closed, index, {});
    let execution = null;
    let assessment = null;

    // Deliberately no generic opposite-signal/trend close here. Historical
    // backtests manage these strategy positions through their configured
    // SL/TP contract only, so live research must test that exact same exit
    // behavior instead of quietly adding a more active live-only rule.

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
            openedAt: closeTime(candle),
          });
          execution = assessment.opened
            ? { status: "opened", reason: `Opened ${assessment.opened.id}` }
            : { status: "blocked", reason: assessment.trade.reason };
        } catch (err) {
          execution = { status: "blocked", reason: err.message };
        }
      }
    }

    const open = trader
      .getOpenPositions()
      .filter((p) => p.symbol === this.symbol && ownedBy(p, EXECUTION_OWNERS.LIVE_RESEARCH));
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
    reservedStrategyIds = [],
    logger = console,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.symbol = String(symbol).toUpperCase();
    this.timeframe = String(timeframe);
    this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    this._logger = logger;
    this._timer = null;
    this._running = false;
    const reserved = new Set((reservedStrategyIds || []).map(String));
    const eligible = listStrategies({ supportsBacktest: true }).filter((meta) => meta.liveResearchEligible);

    /**
     * A strategy the Live Scanner is already writing gets no Live Research
     * runner. One experiment, one execution owner — the same rule the manual
     * routes enforce, applied at startup.
     *
     * This USED TO THROW, which took the entire dashboard down: mindset_v1 is
     * both scanner eligible and live-research eligible, so every deployment
     * with ENABLE_LIVE_SCANNER=true failed to boot, health check included, and
     * restarted forever. A resolvable conflict in one subsystem must not stop
     * the regime engine, the backtester and every unrelated panel from loading.
     *
     * Resolving it in the scanner's favour is what `reservedStrategyIds` was
     * always for — the name says the scanner has reserved that ledger. The
     * other eligible strategies still collect live research, and the exclusion
     * is reported in status() rather than being silent, because "mindset is not
     * collecting live evidence" is a fact a reader has to be able to see.
     */
    this.reservedByScanner = this.enabled
      ? eligible.filter((meta) => reserved.has(meta.id)).map((meta) => meta.id)
      : [];
    if (this.reservedByScanner.length) {
      this._logger.warn?.(
        `[LiveResearch] ${this.reservedByScanner.join(", ")} is written by the Live Scanner, so it collects no live research here. ` +
          "One ledger has one execution owner.",
      );
    }

    this._runners = new Map(
      eligible
        .filter((meta) => !this.reservedByScanner.includes(meta.id))
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

  // Does this service actually run the given strategy? Distinct from
  // eligibility: a strategy can be eligible while the loop is disabled, and a
  // disabled loop owns no experiment.
  ownsStrategy(strategyId) {
    return this.enabled && this._runners.has(String(strategyId));
  }

  /**
   * Restart one experiment: clear the runner's state so the next cycle
   * establishes a fresh baseline from the latest finalized candle.
   *
   * Paired with a ledger reset by TradingLabService so the two cannot disagree.
   * Clearing state — rather than writing a new baseline here — is what makes the
   * restart safe: the next cycle takes the baseline path, which by construction
   * records a candle without evaluating it, so a reset can never be followed by
   * an immediate trade on a candle that closed before the reset.
   */
  resetExperiment(strategyId) {
    const runner = this._runners.get(String(strategyId));
    if (!runner) return false;
    runner.clearState();
    return true;
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
    // Reserved by the Live Scanner, which owns that ledger. Reported on its own
    // terms: falling through to the event-replay branch below would tell a
    // reader mindset_v1 "cannot be evaluated from OHLCV candles", which is
    // false — it is evaluated, by the other loop.
    if (this.reservedByScanner.includes(String(strategyId))) {
      return {
        enabled: false,
        loopRunning: Boolean(this._timer),
        strategyId: String(strategyId),
        symbol: this.symbol,
        timeframe: this.timeframe,
        healthStatus: "OWNED_BY_LIVE_SCANNER",
        runnerStatus: "OWNED_BY_LIVE_SCANNER",
        currentSignal: "FLAT",
        currentIntent: {
          code: "OWNED_BY_LIVE_SCANNER",
          title: "MANAGED BY LIVE SCANNER",
          summary: "The Live Scanner writes this strategy's account, so Live Research does not.",
          reason: "One experiment ledger has one execution owner.",
          nextAction: "Watch this account through the Live Scanner",
          signal: "FLAT",
          currentPrice: null,
          intendedTrade: false,
        },
        setupState: "NOT_EVALUATED",
        blockers: ["The Live Scanner already owns this strategy account"],
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
      // Visible rather than silent: "mindset is not collecting live research"
      // is a fact a reader has to be able to see.
      reservedByScanner: this.reservedByScanner.slice(),
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
