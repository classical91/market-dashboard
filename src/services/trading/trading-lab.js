"use strict";

// Trading Lab — the layer that turns "this setup looks good" into "setups like
// this have historically made or lost money, and here is the trade that would
// result".
//
// The pipeline, composed from the ported TraderClaw engines:
//
//   decision engine → market state → checklist → edge gate → risk sizing
//                                                          → paper position
//
// Nothing in here places a real order. Live execution stays behind the
// exchange adapter and TraderClaw's two-gate safety model (TRADING_MODE=live
// *and* ALLOW_LIVE_TRADING=true), which this service deliberately never flips.

const { getTradingConfig } = require("./config");
const { runChecklist, marketState } = require("./checklist");
const { assessEdge } = require("./edge-gate");
const { planTrade } = require("./risk");
const { buildStrategyMetrics } = require("./metrics");
const { classifyRegime } = require("./regime");
const { buildRegimeMatrix } = require("./regime-metrics");
const { routeRegime } = require("./regime-router");
const { PaperTradingService } = require("./paper-trader");

const BOOKS = [
  { id: "main", name: "Main" },
  { id: "shadow", name: "Shadow SMC" },
  { id: "alts", name: "Alts" },
];

// The decision engine speaks in regime labels and scores; the checklist speaks
// in trend regimes and daily bias. This is the only place the two vocabularies
// meet, so a change to either stays a one-file change.
function marketStateFromDecision(decision, extra = {}) {
  const regime = decision && decision.regime;
  const score = regime && Number.isFinite(regime.score) ? regime.score : 50;
  const label = (regime && regime.label) || "";
  const volatile = label === "Volatile" || (regime && regime.modifiers || []).includes("Volatile");
  const choppy = label === "Choppy" || (regime && regime.modifiers || []).includes("Choppy");

  let trendRegime = "RANGE";
  if (volatile) trendRegime = "VOLATILE_EXPANSION";
  else if (choppy) trendRegime = "RANGE";
  else if (score >= 58) trendRegime = "TREND_UP";
  else if (score <= 42) trendRegime = "TREND_DOWN";

  let dailyBias = "NEUTRAL";
  if (score >= 58) dailyBias = "BULLISH";
  else if (score <= 42) dailyBias = "BEARISH";

  return marketState({
    regime: trendRegime,
    dailyBias,
    usdtDominanceSignal: score >= 58 ? "RISK_ON" : score <= 42 ? "RISK_OFF" : "NEUTRAL",
    bearMarket: score <= 35,
    newsBlackout: Boolean(decision && decision.newsRisk && decision.newsRisk.level === "high"),
    ...extra,
  });
}

class TradingLabService {
  constructor({
    dataDir,
    config = getTradingConfig(),
    priceFeed = null,
    decisionEngineService = null,
    // The candle source the regime engine reads. Optional: without it the
    // regime endpoints return 503 rather than the rest of the lab failing to
    // start, which is the same posture the backtester takes.
    signalScreenerService = null,
  } = {}) {
    this.config = config;
    this.decisionEngineService = decisionEngineService;
    this.signalScreenerService = signalScreenerService;
    this.books = new Map(
      BOOKS.map((book) => [
        book.id,
        new PaperTradingService({ dataDir, book: book.id, config, priceFeed }),
      ]),
    );
  }

  listBooks() {
    return BOOKS.map((book) => ({ ...book }));
  }

  book(id) {
    const trader = this.books.get(String(id || "main").toLowerCase());
    if (!trader) {
      throw Object.assign(new Error(`Unknown book: ${id}`), { statusCode: 404, expose: true });
    }
    return trader;
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  // Run a candidate trade through the full gauntlet without opening anything.
  // Every stage's reasoning is returned so the UI can show *why* a setup was
  // sized down or refused, not just the verdict.
  evaluate({ book = "main", symbol, direction, entryPrice, atr = null, state = {}, strategy = null }) {
    const trader = this.book(book);
    const signal = { symbol, direction, price: entryPrice, atr };

    // Live account risk (open positions, loss streaks, daily/weekly drawdown)
    // always overrides whatever the caller passed — kill switches must read
    // the real ledger, not a hopeful payload.
    const fullState = marketState({ ...state, ...trader.getRiskState() });

    const checklist = runChecklist(signal, fullState, this.config);
    const account = trader.getAccount();
    const edge = assessEdge({
      history: trader.getHistory(),
      startingBalance: account.startingBalance,
      strategy: strategy || `${book}:${direction}`,
      symbol,
      score: checklist.confidenceScore,
      config: this.config,
    });

    // The two gates multiply: the checklist says how good the setup looks
    // right now, the edge gate says how setups like it have actually paid.
    const sizeMultiplier = checklist.sizeMultiplier * edge.sizeMultiplier;
    const blocked = checklist.decision === "SKIP" || edge.decision === "BLOCK" || sizeMultiplier <= 0;

    const trade = blocked
      ? { ok: false, reason: checklist.decision === "SKIP" ? "Checklist skipped the setup" : "Edge gate blocked the setup" }
      : planTrade({ symbol, direction, entryPrice, atr, sizeMultiplier, config: this.config });

    return {
      book,
      symbol,
      direction,
      decision: blocked ? "SKIP" : checklist.decision,
      sizeMultiplier,
      checklist,
      edge,
      state: fullState,
      trade,
      reasons: [...checklist.reasons, ...edge.reasons, ...(trade.ok === false ? [trade.reason] : [])],
    };
  }

  // Evaluate, then open the paper position when every gate agrees.
  async execute({ book = "main", signalSource = "manual", ...input }) {
    const assessment = this.evaluate({ book, ...input });
    if (!assessment.trade.ok) {
      return { ...assessment, opened: null };
    }

    const trader = this.book(book);
    const { trade } = assessment;
    const opened = trader.openPosition({
      symbol: trade.symbol,
      direction: trade.direction,
      size: trade.size,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      tp1: trade.tp1,
      tp2: trade.tp2,
      riskUsd: trade.riskUsd,
      confidenceScore: assessment.checklist.confidenceScore,
      signalSource,
      meta: { edgeDecision: assessment.edge.decision, sizeMultiplier: trade.sizeMultiplier },
    });

    return { ...assessment, opened };
  }

  // ── Decision engine bridge ────────────────────────────────────────────────

  // Take the decision engine's execution plans and score each one through the
  // Trading Lab, so the dashboard can show historical edge next to every plan
  // it already renders. Read-only: nothing is opened here.
  async evaluateDecisionPlans({ interval = "4h", book = "main" } = {}) {
    if (!this.decisionEngineService) {
      throw Object.assign(new Error("Decision engine is not configured"), { statusCode: 503, expose: true });
    }

    const decision = await this.decisionEngineService.getDecision(interval);
    const plans = (decision.execution || []).filter((plan) => plan && !plan.error && plan.trigger);
    const state = marketStateFromDecision(decision);

    const candidates = plans.map((plan) => {
      const assessment = this.evaluate({
        book,
        symbol: plan.symbol,
        direction: plan.signal,
        // Enter at the plan's trigger, not at spot — the plan is a resting
        // order, and sizing it off the current price would misstate the risk.
        entryPrice: plan.trigger,
        atr: plan.atr,
        state,
        strategy: `decision:${interval}`,
      });

      return {
        symbol: plan.symbol,
        signal: plan.signal,
        setupScore: plan.setupScore ?? null,
        plan,
        decision: assessment.decision,
        sizeMultiplier: assessment.sizeMultiplier,
        edgeDecision: assessment.edge.decision,
        confidenceScore: assessment.checklist.confidenceScore,
        trade: assessment.trade,
        reasons: assessment.reasons,
      };
    });

    return {
      interval,
      book,
      updatedAt: new Date().toISOString(),
      regime: decision.regime,
      newsRisk: decision.newsRisk,
      state,
      candidates,
    };
  }

  // Market state for callers that have a timeframe but no decision payload —
  // the signal bridge, mainly. Falls back to the neutral state rather than
  // failing the caller: an unreachable decision engine should cost a setup its
  // trend/macro points, not stop the evaluation from happening at all.
  async stateForInterval(interval = "4h") {
    if (!this.decisionEngineService) return marketState({});
    try {
      return marketStateFromDecision(await this.decisionEngineService.getDecision(interval));
    } catch (err) {
      console.warn(`[TradingLab] Decision state unavailable for ${interval}: ${err.message}`);
      return marketState({});
    }
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  async overview() {
    const books = await Promise.all(
      BOOKS.map(async ({ id, name }) => {
        const trader = this.book(id);
        return {
          id,
          name,
          stats: await trader.getStats(),
          openPositions: trader.getOpenPositions(),
        };
      }),
    );

    return {
      updatedAt: new Date().toISOString(),
      mode: this.config.liveEnabled ? "live" : "paper",
      config: {
        accountSize: this.config.accountSize,
        maxRiskPerTrade: this.config.maxRiskPerTrade,
        maxOpenPositions: this.config.maxOpenPositions,
        tp1CloseFraction: this.config.tp1CloseFraction,
        tp1RMultiple: this.config.tp1RMultiple,
        tp2RMultiple: this.config.tp2RMultiple,
      },
      books,
    };
  }

  // ── Regime ────────────────────────────────────────────────────────────────

  /**
   * What environment is this symbol in, and — separately — what does the
   * recorded evidence say belongs in it?
   *
   * The two halves are deliberately computed independently and returned side by
   * side. The regime read is a measurement of the market; the routing is a
   * reading of our own trade history. Collapsing them into one verdict would
   * hide which of the two a surprising answer came from.
   */
  async regime({ symbol, interval = "1h", book = "main", minTrades = 20 } = {}) {
    if (!this.signalScreenerService) {
      throw Object.assign(new Error("No candle source configured for regime detection"), {
        statusCode: 503,
        expose: true,
      });
    }

    const candles = await this.signalScreenerService.getCandles(symbol, interval);
    const read = classifyRegime(candles || []);
    const matrix = this.regimeMatrix({ book, minTrades });
    const routing = routeRegime({ read, matrix });

    return {
      symbol,
      interval,
      book,
      updatedAt: new Date().toISOString(),
      candles: (candles || []).length,
      regime: read,
      routing,
    };
  }

  // The strategy × regime evidence table for one book's recorded history.
  regimeMatrix({ book = "main", minTrades = 20 } = {}) {
    const trader = this.book(book);
    const account = trader.getAccount();
    return {
      book,
      ...buildRegimeMatrix(trader.getHistory(), account.startingBalance, { minTrades }),
    };
  }

  strategyMetrics({ book = "main", minTrades = 1 } = {}) {
    const trader = this.book(book);
    const account = trader.getAccount();
    return {
      book,
      ...buildStrategyMetrics(trader.getHistory(), account.startingBalance, minTrades),
    };
  }
}

module.exports = { TradingLabService, marketStateFromDecision, BOOKS };
