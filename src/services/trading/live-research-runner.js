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
const { TOP_TOKENS } = require("../../config/market-symbols");

// The market universe a demo account watches by default. Twenty liquid pairs:
// enough that a selective strategy meets its setup somewhere, without turning
// one cycle into a hundred candle fetches.
const DEFAULT_DEMO_SYMBOLS = TOP_TOKENS.slice(0, 20);

function runnerKey(strategyId, symbol, timeframe) {
  return `${strategyId}|${String(symbol).toUpperCase()}|${timeframe}`;
}
const { contextAtBar } = require("./backtest");
const { getTradingConfig } = require("./config");

const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const ACTIVITY_CAP = 120;
// Kept in step with signal-screener's INTERVAL_MAP: a timeframe the screener
// can fetch but this map does not know would silently fall back to the 1h
// default below, and the runner would then compute the wrong nextExpectedCandle
// — telling a reader the next decision is an hour away when it is minutes away.
const TIMEFRAME_MS = Object.freeze({
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
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

// The six numbers every demo account reports. Kept as one shape so a runner, a
// strategy account and the whole subsystem all sum the same fields.
const EMPTY_COUNTERS = Object.freeze({
  candlesProcessed: 0,
  signalsGenerated: 0,
  tradesExecuted: 0,
  signalsBlockedByRisk: 0,
  executionErrors: 0,
});

function addCounters(into, from) {
  const out = { ...into };
  for (const key of Object.keys(EMPTY_COUNTERS)) out[key] = (out[key] || 0) + (Number(from?.[key]) || 0);
  return out;
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
    // Indicator periods for the shared candle context. The lab's config, so a
    // demo account and a backtest measure volatility and momentum the same way.
    this._config = getTradingConfig();
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
      // The most recent valid strategy signal the account could not take.
      lastRefusedSignal: null,
      // Lifetime counters for this runner. Their whole purpose is to make "zero
      // trades" readable: an account showing candles processed but no signals is
      // a strategy that has not met its conditions, while an account showing no
      // candles at all is a dead runner, and those two are indistinguishable
      // from the trade count alone.
      counters: { ...EMPTY_COUNTERS },
      activity: [],
    };
  }

  _read() {
    const stored = this._stateCache ? this._stateCache.get(this.stateKey) : null;
    const state = { ...this._initialState(), ...(stored && typeof stored === "object" ? stored : {}) };
    // State persisted before counters existed has none; a missing counter must
    // read as zero rather than undefined, or the status panel prints NaN.
    state.counters = { ...EMPTY_COUNTERS, ...(state.counters || {}) };
    return state;
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
      state.counters = addCounters(state.counters, { executionErrors: 1 });
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
      state.counters = addCounters(state.counters, { candlesProcessed: 1 });
      addActivities(state, [
        activity("catch-up", `Missed ${this.timeframe} candle replayed for position management; entry skipped`, candleAt),
        ...events.map((event) => activity("position-event", `${event.type} on ${this.symbol}`, candleAt, event)),
      ]);
      this._write(state);
      return;
    }

    const evaluation = this.definition.evaluate(closed, index, {});

    // The generic market context every strategy's trade is scored against,
    // computed once from the bars this runner already holds.
    //
    // contextAtBar is the backtester's own function, so a demo account and a
    // backtest of the same strategy are scored against volatility, volume and
    // momentum measured identically — which is the whole reason the two are
    // comparable. It reads bars 0..index only, so it cannot see past the candle
    // being decided.
    const context = contextAtBar(closed, this._config, { index });
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
            // Volatility, volume and momentum come from the CANDLES, not from
            // whatever generic fields a strategy happens to emit.
            //
            // Reading them off `evaluation.indicators` only worked for
            // mindset_v1. SMC reports structure (BOS, FVG, retest), Donchian
            // reports its channel, VWAP reports stretch and ADX — none of them
            // publish atrRatio/volumeRatio/macdBullish, so all three passed
            // `undefined` into market state and the checklist threw on
            // `state.volumeRatio.toFixed(1)` the moment they produced a real
            // signal. Requiring every strategy to also compute generic Trading
            // Lab indicators would be asking each one to duplicate work the
            // runner can do once from the bars it already holds.
            //
            // A strategy's OWN reading still wins when it has one — mindset_v1
            // computes these as part of its rules, and its own numbers are what
            // its signal was based on.
            state: {
              ...(await this._lab.stateForInterval(this.timeframe)),
              atrRatio: evaluation.indicators?.atrRatio ?? context.atrRatio,
              volumeRatio: evaluation.indicators?.volumeRatio ?? context.volumeRatio,
              macdBullish: evaluation.indicators?.macdBullish ?? context.macdBullish,
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
            : {
                status: "blocked",
                // A valid strategy signal the ACCOUNT could not take is a
                // different fact from a setup that was never good enough, and
                // the safety code says which of the account's own limits bit.
                reason: assessment.accountSafety?.reason || assessment.trade.reason,
                code: assessment.accountSafety?.code || null,
                refusedValidSignal: assessment.refusedValidSignal === true,
              };
        } catch (err) {
          // A thrown error is a FAULT, not a risk decision. Reporting it as
          // "blocked" told the dashboard the strategy had been refused on its
          // merits while the truth was that execution crashed — the account
          // read BLOCKED_BY_RISK with health "RUNNING", which is the most
          // misleading pair of words this system could produce.
          execution = { status: "error", reason: err.message };
          this._logger.error?.(`[LiveResearch] ${this.strategyId} execution failed: ${err.message}`);
        }
      }
    }

    const signalled = !evaluation.error && (evaluation.signal === "LONG" || evaluation.signal === "SHORT");
    state.counters = addCounters(state.counters, {
      candlesProcessed: 1,
      signalsGenerated: signalled ? 1 : 0,
      tradesExecuted: execution?.status === "opened" ? 1 : 0,
      signalsBlockedByRisk: execution?.status === "blocked" ? 1 : 0,
      executionErrors: execution?.status === "error" ? 1 : 0,
    });

    // A signal the strategy genuinely produced and the account refused is kept
    // in full — direction, price and the safety code — because a flat equity
    // curve made of refusals and a flat curve made of silence are different
    // research outcomes and must never render the same.
    if (signalled && execution?.status === "blocked") {
      state.lastRefusedSignal = {
        at: candleAt,
        symbol: this.symbol,
        timeframe: this.timeframe,
        direction: evaluation.signal,
        price: evaluation.price ?? candle.close,
        code: execution.code || null,
        reason: execution.reason,
      };
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

class DemoTradingService {
  /**
   * One Demo Trading subsystem, and every candle strategy is a first-class
   * member of it.
   *
   * Mindset used to be special: it was the scanner's strategy, so the scanner
   * owned its ledger and Live Research skipped it, while SMC, Donchian and
   * VWAP were "live research". That split is the thing that kept recreating
   * confusion, because it made one strategy the real trader and the rest
   * secondary. All four now get the identical contract:
   *
   *   live closed candles -> the account's own strategy -> strategy signal
   *   -> hard account safety -> paper execution -> that strategy's ledger
   *
   * They will trade at different frequencies, because the strategies differ.
   * That is the only thing that should differ.
   *
   * Internally a runner is strategy x symbol x timeframe, so one account can
   * watch a whole market universe — but every runner for a strategy writes to
   * that strategy's single $10,000 ledger. One demo account, one strategy, many
   * markets.
   */
  constructor({
    tradingLabService,
    candleSource,
    stateCache = null,
    enabled = true,
    // The market universe every demo account watches. One list, so no strategy
    // gets a wider or narrower view than another.
    symbols = null,
    timeframes = null,
    // Back-compat with the single-market configuration.
    symbol = null,
    timeframe = null,
    intervalMs = 60_000,
    reservedStrategyIds = [],
    logger = console,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.symbols = (symbols && symbols.length ? symbols : symbol ? [symbol] : DEFAULT_DEMO_SYMBOLS)
      .map((value) => String(value).toUpperCase());
    this.timeframes = (timeframes && timeframes.length ? timeframes : timeframe ? [timeframe] : ["1h"])
      .map((value) => String(value));
    // Kept for status payloads and tests that still speak in one market.
    this.symbol = this.symbols[0];
    this.timeframe = this.timeframes[0];
    this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    this._logger = logger;
    this._timer = null;
    this._running = false;

    const eligible = listStrategies({ supportsBacktest: true }).filter((meta) => meta.liveResearchEligible);
    this.strategyIds = eligible.map((meta) => meta.id);

    // The Live Scanner is a signal DIAGNOSTIC, not a demo trader. If it is also
    // configured to paper-trade a strategy this subsystem owns, Demo Trading
    // wins and the conflict is logged — the opposite of the old arrangement,
    // where the scanner's reservation left mindset_v1 as the only account
    // without a demo runner. Never a throw: a writer conflict is resolvable and
    // must not take the deployment down.
    const reserved = new Set((reservedStrategyIds || []).map(String));
    this.contestedByScanner = this.enabled ? this.strategyIds.filter((id) => reserved.has(id)) : [];
    if (this.contestedByScanner.length) {
      this._logger.warn?.(
        `[DemoTrading] ${this.contestedByScanner.join(", ")} is also configured for Live Scanner paper trading. ` +
          "Demo Trading owns the strategy ledgers; disable LIVE_SCANNER_PAPER_TRADE_ENABLED to silence this.",
      );
    }

    // strategy x symbol x timeframe. Every runner for a strategy writes to that
    // strategy's one ledger, so this multiplies MARKETS WATCHED, never accounts.
    this._runners = new Map();
    for (const meta of eligible) {
      const definition = getLiveResearchStrategy(meta.id);
      for (const marketSymbol of this.symbols) {
        for (const marketTimeframe of this.timeframes) {
          this._runners.set(runnerKey(meta.id, marketSymbol, marketTimeframe), new CandleLiveResearchRunner({
            definition,
            tradingLabService,
            candleSource,
            stateCache,
            symbol: marketSymbol,
            timeframe: marketTimeframe,
            logger,
          }));
        }
      }
    }
  }

  // Every runner belonging to one demo account.
  runnersFor(strategyId) {
    const id = String(strategyId);
    return [...this._runners.entries()]
      .filter(([key]) => key.startsWith(`${id}|`))
      .map(([, runner]) => runner);
  }

  start() {
    if (!this.enabled) {
      this._logger.log("[DemoTrading] Disabled via LIVE_RESEARCH_ENABLED=false");
      return false;
    }
    if (this._timer) return true;
    this._logger.log(
      `[DemoTrading] ${this.strategyIds.length} demo accounts watching ${this.symbols.length} markets on ` +
        `${this.timeframes.join(", ")} (${this._runners.size} runners) every ${Math.round(this.intervalMs / 1000)}s`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => this._logger.error?.(`[DemoTrading] Cycle failed: ${err.message}`));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.runOnce().catch((err) => this._logger.error?.(`[DemoTrading] Initial cycle failed: ${err.message}`));
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
      const entries = [...this._runners.entries()];
      const settled = await Promise.allSettled(entries.map(([, runner]) => runner.runOnce()));
      return {
        status: "complete",
        results: settled.map((result, index) => {
          const [, runner] = entries[index];
          return {
            strategyId: runner.strategyId,
            symbol: runner.symbol,
            timeframe: runner.timeframe,
            ...(result.status === "fulfilled"
              ? result.value
              : { status: "error", reason: result.reason?.message || String(result.reason) }),
          };
        }),
      };
    } finally {
      this._running = false;
    }
  }

  // Does this service actually run the given strategy? Distinct from
  // eligibility: a strategy can be eligible while the loop is disabled, and a
  // disabled loop owns no experiment.
  ownsStrategy(strategyId) {
    return this.enabled && this.strategyIds.includes(String(strategyId));
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
    // Every market this account watches, not just one: an account resets as a
    // whole, or its ledger starts from zero while nineteen runners keep their
    // pre-reset baselines and trade the account on stale history.
    const runners = this.runnersFor(strategyId);
    if (!runners.length) return false;
    for (const runner of runners) runner.clearState();
    return true;
  }

  /**
   * One demo account's whole state, aggregated across every market it watches.
   *
   * The shape stays the one-runner shape the dashboard already reads —
   * healthStatus, runnerStatus, currentIntent, indicators, activity — because a
   * reader still wants a single answer to "what is this account doing right
   * now". What changed is where that answer comes from: a HEADLINE runner is
   * chosen (the one holding a position, else the most recently evaluated), and
   * the rest are summarised in `markets` and folded into `counters`.
   */
  statusFor(strategyId) {
    const runners = this.runnersFor(strategyId);
    if (runners.length) {
      const states = runners.map((runner) => runner.status());
      const counters = states.reduce((total, one) => addCounters(total, one.counters), { ...EMPTY_COUNTERS });
      const headline =
        states.find((one) => one.runnerStatus === "POSITION_OPEN") ||
        states.find((one) => one.runnerStatus === "SIGNAL_DETECTED" || one.currentSignal !== "FLAT") ||
        states.find((one) => one.healthStatus === "ERROR") ||
        [...states].sort((a, b) => String(b.lastEvaluationAt || "").localeCompare(String(a.lastEvaluationAt || "")))[0];

      // Health is the worst case, not the headline's case: one market erroring
      // while nineteen run is still an account with a broken runner in it.
      const errored = states.filter((one) => one.healthStatus === "ERROR");
      const openMarkets = states.filter((one) => one.runnerStatus === "POSITION_OPEN");
      const refusals = states
        .map((one) => one.lastRefusedSignal)
        .filter(Boolean)
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

      // Every market's activity on one timeline, so an account that traded ETH
      // does not look idle because BTC is the headline.
      const activity = states
        .flatMap((one) =>
          (one.activity || []).map((entry) => ({ ...entry, symbol: one.symbol, timeframe: one.timeframe })),
        )
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
        .slice(0, ACTIVITY_CAP);

      const panel = {
        strategyId: String(strategyId),
        // The status panel proper. Six numbers that make a flat account
        // legible: candles processed proves the runner is alive, signals
        // generated separates "the strategy saw nothing" from "the account
        // refused", and blocked/errors separate a risk decision from a fault.
        counters,
        marketsWatched: new Set(states.map((one) => one.symbol)).size,
        timeframesWatched: [...new Set(states.map((one) => one.timeframe))],
        runnerCount: states.length,
        runnersErrored: errored.length,
        openMarkets: openMarkets.map((one) => one.symbol),
        lastRefusedSignal: refusals[0] || null,
        markets: states.map((one) => ({
          symbol: one.symbol,
          timeframe: one.timeframe,
          healthStatus: one.healthStatus,
          runnerStatus: one.runnerStatus,
          currentSignal: one.currentSignal,
          lastProcessedCandle: one.lastProcessedCandle,
          nextExpectedCandle: one.nextExpectedCandle,
          lastError: one.lastError,
          counters: one.counters,
        })),
      };

      if (!this.enabled) {
        return {
          ...headline,
          ...panel,
          enabled: false,
          loopRunning: false,
          healthStatus: "PAUSED",
          runnerStatus: "PAUSED",
          demoTradingStatus: "PAUSED",
          currentIntent: {
            code: "LIVE_RESEARCH_PAUSED",
            title: "LIVE DEMO PAUSED",
            summary: "This isolated research account is not evaluating new candles.",
            reason: "LIVE_RESEARCH_ENABLED=false",
            nextAction: "Enable live research to resume closed-candle evaluation",
            signal: headline.currentSignal || "FLAT",
            currentPrice: headline.currentIntent?.currentPrice ?? null,
            intendedTrade: false,
          },
          retryStatus: "PAUSED",
        };
      }

      const healthStatus = errored.length === states.length ? "ERROR" : errored.length ? "DEGRADED" : "RUNNING";
      return {
        enabled: true,
        loopRunning: Boolean(this._timer),
        ...headline,
        ...panel,
        activity,
        healthStatus,
        // Demo trading state is its own field, deliberately not derived from
        // research maturity: whether this account is trading and how far its
        // research has matured are separate questions, and collapsing them is
        // what previously made a backtest-status strategy look untradeable.
        demoTradingStatus: openMarkets.length ? "IN_POSITION" : healthStatus === "ERROR" ? "ERROR" : "TRADING",
        lastError: errored.length ? errored[0].lastError : null,
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
      demoTradingStatus: "NO_LIVE_RUNNER",
      counters: { ...EMPTY_COUNTERS },
      marketsWatched: 0,
      timeframesWatched: [],
      runnerCount: 0,
      runnersErrored: 0,
      openMarkets: [],
      lastRefusedSignal: null,
      markets: [],
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
    const accounts = listStrategies().map((meta) => this.statusFor(meta.id));
    return {
      enabled: this.enabled,
      running: Boolean(this._timer),
      scanning: this._running,
      symbol: this.symbol,
      timeframe: this.timeframe,
      symbols: this.symbols.slice(),
      timeframes: this.timeframes.slice(),
      runnerCount: this._runners.size,
      intervalMs: this.intervalMs,
      // Visible rather than silent: a second writer configured against a demo
      // account's ledger is a fact a reader has to be able to see, even though
      // Demo Trading is the one that wins.
      contestedByScanner: this.contestedByScanner.slice(),
      counters: accounts.reduce((total, one) => addCounters(total, one.counters), { ...EMPTY_COUNTERS }),
      runners: accounts,
    };
  }
}

module.exports = {
  DemoTradingService,
  // The subsystem was named Live Research while it was the thing that ran the
  // three strategies the scanner did not. Kept as an alias so existing wiring
  // and tests keep resolving while the name settles.
  LiveResearchService: DemoTradingService,
  DEFAULT_DEMO_SYMBOLS,
  EMPTY_COUNTERS,
  CandleLiveResearchRunner,
  strategySpecificRead,
  currentIntent,
  decisionTrail,
  displayStatus,
  TIMEFRAME_MS,
};
