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
const { planTrade, calculatePositionSize } = require("./risk");
const { buildStrategyMetrics } = require("./metrics");
const { classifyRegime } = require("./regime");
const { buildRegimeMatrix } = require("./regime-metrics");
const { routeRegime } = require("./regime-router");
const {
  listStrategyAccounts,
  describeStrategyAccount,
  acceptsForwardTrades,
  acceptsLiveResearchTrades,
} = require("./strategy-accounts");
const { PaperTradingService, MemoryStorage } = require("./paper-trader");
const { EXECUTION_OWNERS, ownerFromSignalSource, positionOwner } = require("./execution-owner");

const LEGACY_BOOKS = [
  { id: "main", name: "Main", archived: true },
  { id: "shadow", name: "Shadow SMC", archived: true },
  { id: "alts", name: "Alts", archived: true },
];
const BOOKS = LEGACY_BOOKS;

function archivedMutation(book) {
  return () => {
    throw Object.assign(new Error(`Legacy ledger "${book}" is archived and read-only`), {
      statusCode: 409,
      expose: true,
    });
  };
}

function archivedLedgerView(trader) {
  return Object.freeze({
    book: trader.book,
    archived: true,
    getAccount: (...args) => trader.getAccount(...args),
    readAccount: (...args) => trader.readAccount(...args),
    getPositions: (...args) => trader.getPositions(...args),
    getOpenPositions: (...args) => trader.getOpenPositions(...args),
    getHistory: (...args) => trader.getHistory(...args),
    getStats: (...args) => trader.getStats(...args),
    readStats: (...args) => trader.readStats(...args),
    getRiskState: (...args) => trader.getRiskState(...args),
    openPosition: archivedMutation(trader.book),
    closePosition: archivedMutation(trader.book),
    updatePositions: archivedMutation(trader.book),
    addToHistory: archivedMutation(trader.book),
    reset: archivedMutation(trader.book),
    savePositions: archivedMutation(trader.book),
    saveAccount: archivedMutation(trader.book),
  });
}

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
    this.liveResearchService = null;
    this._legacyLedgers = new Map(
      LEGACY_BOOKS.map((book) => [
        book.id,
        new PaperTradingService({ dataDir, book: book.id, config, priceFeed }),
      ]),
    );
    this.books = new Map(
      [...this._legacyLedgers].map(([id, ledger]) => [id, archivedLedgerView(ledger)]),
    );
    // One isolated ledger per registered strategy, derived from the registry so
    // a sixth strategy needs no second list updating. Every strategy gets one,
    // including strategies that may collect live demo evidence without being
    // promoted into the scanner lifecycle. See ./strategy-accounts.
    this.strategyLedgers = new Map(
      listStrategyAccounts().map((account) => [
        account.id,
        new PaperTradingService({ dataDir, book: account.ledgerKey, config, priceFeed }),
      ]),
    );
    // Unattributed/manual/Decision Engine/Signal Bot evaluation remains useful,
    // but it must not create a sixth persistent account or fall back to Main.
    // This ledger is process-local and can only be used by evaluate().
    this.unattributedEvaluationLedger = new PaperTradingService({
      book: "unattributed-evaluation",
      config,
      priceFeed,
      storage: new MemoryStorage(),
    });
  }

  attachLiveResearchService(service) {
    this.liveResearchService = service || null;
    return this;
  }

  // ── Experiment ownership ──────────────────────────────────────────────────

  /**
   * The autonomous loop that owns this strategy account, or null.
   *
   * A live demo account is a claim: "$10,000 became $10,x, and every trade came
   * from this strategy's own runner reacting to candles that closed after the
   * experiment started". That claim survives only if exactly one writer touches
   * the ledger, so this is the question every manual mutation has to ask first.
   *
   * Read from the attached service rather than from lifecycle metadata: a
   * strategy can be live-research ELIGIBLE while the loop is disabled, and a
   * disabled loop owns nothing. Eligibility is permission; ownership is fact.
   */
  autonomousOwnerOf(strategyId) {
    const service = this.liveResearchService;
    if (!service || !service.enabled || typeof service.ownsStrategy !== "function") return null;
    return service.ownsStrategy(strategyId) ? EXECUTION_OWNERS.LIVE_RESEARCH : null;
  }

  /**
   * Positions in this account that an autonomous loop is managing.
   *
   * Ownership is read off the POSITION, not off the account: an account can
   * hold a runner-owned position and a manual one at once — a manual trade
   * opened before the runner was enabled, say — and only the first is
   * protected. Refusing to mark the whole account because of one runner-owned
   * position would be as wrong as marking the runner's position because the
   * account also holds a manual one.
   */
  autonomousPositionsIn(strategyId) {
    return this.strategyLedger(strategyId)
      .getOpenPositions()
      .filter((position) => {
        const owner = positionOwner(position);
        return owner === EXECUTION_OWNERS.LIVE_RESEARCH || owner === EXECUTION_OWNERS.LIVE_SCANNER;
      });
  }

  /**
   * Restart one demo experiment: ledger and runner together, or not at all.
   *
   * Resetting only the ledger is the failure this replaces. It leaves a fresh
   * $10,000 account whose runner still holds `lastProcessedCandle` from the old
   * experiment, so the two disagree about what has happened — and the runner
   * resumes mid-stream rather than starting a new experiment.
   *
   * The runner's state is cleared rather than re-baselined here, which is what
   * makes the ordering safe: the next cycle takes the baseline path, records the
   * latest finalized candle WITHOUT evaluating it, and only trades a candle
   * closing after the reset. A reset can therefore never be followed by a trade
   * on a candle that closed before it.
   */
  async resetExperiment(strategyId) {
    const account = describeStrategyAccount(strategyId);
    if (!account) {
      throw Object.assign(new Error(`Unknown strategy account: ${strategyId}`), { statusCode: 404, expose: true });
    }
    const ledger = this.strategyLedger(account.id);
    const service = this.liveResearchService;
    const autonomous = Boolean(this.autonomousOwnerOf(account.id));

    // Refused rather than half-done when the runner cannot be restarted with
    // the ledger: a reset that clears the balance and leaves the runner
    // mid-experiment produces exactly the disagreement this method exists to
    // prevent.
    if (autonomous && (!service || typeof service.resetExperiment !== "function")) {
      throw Object.assign(
        new Error(
          `${account.id} is running an autonomous live demo experiment and its runner state cannot be restarted, so a reset would leave the ledger and the runner disagreeing. Stop Live Research before resetting.`,
        ),
        { statusCode: 409, expose: true },
      );
    }

    const reset = ledger.reset();
    const runnerReset = autonomous ? service.resetExperiment(account.id) : false;

    return {
      strategyId: account.id,
      book: ledger.book,
      account: reset,
      // Stated so a caller can tell a full experiment restart from a plain
      // ledger reset of an idle account.
      runnerReset,
      autonomous,
      baseline: runnerReset
        ? "Runner state cleared; the next finalized candle becomes the new baseline and is not traded."
        : "No autonomous runner owns this account.",
    };
  }

  // ── Ledger resolution ─────────────────────────────────────────────────────

  /**
   * Which ledger a trade belongs to.
   *
   * There is exactly one of these because the gauntlet must READ and WRITE the
   * same ledger. evaluate() reads risk state and closed-trade history to run
   * kill switches and the edge gate; execute() opens the position. If those
   * resolved differently — scoring against Main's loss limits while writing to
   * a strategy account — the kill switches would be guarding the wrong book,
   * which is a safety failure rather than a reporting one.
   *
   * Registered strategies always resolve to their own account. They never fall
   * back to a legacy ledger. Unattributed evaluation may use the process-local
   * analysis ledger; persistent execution may not.
   */
  ledgerFor({
    strategyId = null,
    allowUnattributed = false,
    requireForward = false,
    requireLiveResearch = false,
  } = {}) {
    if (strategyId) {
      const account = describeStrategyAccount(strategyId);
      if (!account || !this.strategyLedgers.has(account.id)) {
        throw Object.assign(new Error(`Unknown registered strategy: ${strategyId}`), {
          statusCode: 400,
          expose: true,
        });
      }
      if (requireForward && !acceptsForwardTrades(account.id)) {
        throw Object.assign(
          new Error(`Strategy "${account.id}" is ${account.label.toLowerCase()} and cannot forward-paper trade`),
          { statusCode: 409, expose: true },
        );
      }
      if (requireLiveResearch && !acceptsLiveResearchTrades(account.id)) {
        throw Object.assign(
          new Error(`Strategy "${account.id}" is not compatible with candle live research`),
          { statusCode: 409, expose: true },
        );
      }
      return this.strategyLedgers.get(account.id);
    }
    if (allowUnattributed) return this.unattributedEvaluationLedger;
    throw Object.assign(new Error("Forward-paper execution requires a registered strategy identity"), {
      statusCode: 400,
      expose: true,
    });
  }

  // The ledger for one strategy account, whether or not it may trade forward.
  strategyLedger(id) {
    const ledger = this.strategyLedgers.get(String(id || ""));
    if (!ledger) {
      throw Object.assign(new Error(`Unknown strategy account: ${id}`), { statusCode: 404, expose: true });
    }
    return ledger;
  }

  listBooks() {
    return LEGACY_BOOKS.map((book) => ({ ...book }));
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
  evaluate({
    book = "main",
    symbol,
    direction,
    entryPrice,
    atr = null,
    state = {},
    strategy = null,
    strategyId = null,
    allowCounterTrend = false,
    at = null,
  }) {
    // Resolved, not assumed: a scanner-eligible strategy is scored against its
    // OWN account's risk state and closed-trade history, which is the ledger
    // execute() will write to. Kill switches and the edge gate must read the
    // book they are protecting.
    const trader = this.ledgerFor({ strategyId, allowUnattributed: true });
    const signal = { symbol, direction, price: entryPrice, atr, allowCounterTrend };

    // Live account risk (open positions, loss streaks, daily/weekly drawdown)
    // always overrides whatever the caller passed — kill switches must read
    // the real ledger, not a hopeful payload.
    const fullState = marketState({ ...state, ...trader.getRiskState({ at }) });

    const checklist = runChecklist(signal, fullState, this.config);
    const account = trader.getAccount({ at });
    const edge = assessEdge({
      history: trader.getHistory(),
      startingBalance: account.startingBalance,
      strategy: strategy || `${strategyId || "UNATTRIBUTED"}:${direction}`,
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
  /**
   * Evaluate, then open the paper position when every gate agrees.
   *
   * `strategyId` and friends are ATTRIBUTION, not inputs to any decision. They
   * are recorded on the trade and read by nothing in the gauntlet — the same
   * property the backtester's regime tag has, and for the same reason: a
   * strategy × regime table is only evidence about a strategy if the tag played
   * no part in selecting the trades it summarises.
   *
   * They are separate from `strategy`, which is the edge gate's grouping key
   * and is a display string ("live:mindset_v1:15m"). Conflating the two is how
   * the persistent ledger ended up with no strategy identity at all: the caller
   * knew it, spent it on the edge gate, and dropped it before the write.
   */
  async execute(input) {
    return this._executePersistent({ ...input, executionScope: "forward-paper" });
  }

  // The live demo research boundary. It is deliberately not the scanner
  // boundary above: lifecycle status is evidence/promotion, while this method
  // is allowed only for candle-compatible isolated demo accounts. Nothing
  // outside the in-process runner calls it and no HTTP route exposes it.
  async executeLiveResearch(input) {
    return this._executePersistent({ ...input, executionScope: "live-research" });
  }

  async _executePersistent({
    book = "main",
    signalSource = "manual",
    strategyId = null,
    strategyVersion = null,
    timeframe = null,
    regime = null,
    regimeConfidence = null,
    strategySignal = null,
    executionOwner = null,
    openedAt = null,
    executionScope = "forward-paper",
    ...input
  }) {
    // Resolve permission before doing any scoring. A registered but ineligible
    // strategy is refused; a missing identity is refused; neither can fall back
    // to Main/Shadow/Alts.
    const liveResearch = executionScope === "live-research";
    const trader = this.ledgerFor({
      strategyId,
      requireForward: !liveResearch,
      requireLiveResearch: liveResearch,
    });
    const assessment = this.evaluate({ book, strategyId, at: openedAt, ...input });
    if (!assessment.trade.ok) {
      return { ...assessment, opened: null };
    }

    // The same resolution evaluate() just used, so the position opens in the
    // ledger whose limits were checked.
    let trade = { ...assessment.trade };
    let appliedExecution = "shared";

    // Candle strategies may publish structural stop/target hints. Live
    // research uses them when they are geometrically valid and recomputes size
    // so dollar risk stays identical; otherwise the shared ATR plan remains in
    // force and the fallback is explicit in the decision trail.
    if (liveResearch && strategySignal) {
      const stop = Number(strategySignal.stopHint);
      const target = Number(strategySignal.targetHint);
      const long = trade.direction === "LONG";
      const validStop = Number.isFinite(stop) && (long ? stop < trade.entryPrice : stop > trade.entryPrice);
      const validTarget = Number.isFinite(target) && (long ? target > trade.entryPrice : target < trade.entryPrice);
      if (validStop && validTarget) {
        const size = calculatePositionSize({
          entryPrice: trade.entryPrice,
          stopLoss: stop,
          accountSize: this.config.accountSize,
          riskPct: this.config.maxRiskPerTrade,
          sizeMultiplier: trade.sizeMultiplier,
        });
        if (size > 0) {
          trade = { ...trade, size, stopLoss: stop, tp1: target, tp2: target };
          appliedExecution = "native";
        }
      }
    }
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
      executionOwner: liveResearch
        ? EXECUTION_OWNERS.LIVE_RESEARCH
        : executionOwner || ownerFromSignalSource(signalSource) || EXECUTION_OWNERS.TRADING_LAB,
      meta: {
        edgeDecision: assessment.edge.decision,
        sizeMultiplier: trade.sizeMultiplier,
        executionScope,
        executionMode: appliedExecution,
        strategyConfidence: strategySignal ? strategySignal.confidence ?? null : null,
        stopHint: strategySignal ? strategySignal.stopHint ?? null : null,
        targetHint: strategySignal ? strategySignal.targetHint ?? null : null,
        // Null rather than a guess when the caller did not supply one. A trade
        // with no strategy identity is UNATTRIBUTED and must report as such —
        // the signal bot bridge has no registry strategy at all, and inventing
        // one for it would put fabricated rows in the strategy leaderboard.
        strategy: strategyId ? String(strategyId) : null,
        strategyVersion: strategyVersion ? String(strategyVersion) : null,
        timeframe: timeframe ? String(timeframe) : null,
        regime: regime ? String(regime) : null,
        // Unmeasured stays null: `Number(null)` is 0 and finite, so coercing
        // first would record "no regime read" as "measured, zero confidence".
        regimeConfidence:
          regimeConfidence === null || regimeConfidence === undefined || !Number.isFinite(Number(regimeConfidence))
            ? null
            : Number(regimeConfidence),
      },
      openedAt,
    });

    return { ...assessment, opened, ledger: trader.book };
  }

  // ── Strategy accounts ─────────────────────────────────────────────────────

  // Every registered strategy's account, with lifecycle and independent live
  // demo runner state side by side.
  async strategyAccounts() {
    const accounts = await Promise.all(
      listStrategyAccounts().map(async (account) => {
        const ledger = this.strategyLedgers.get(account.id);
        return {
          ...account,
          stats: ledger.readStats(),
          openPositions: ledger.getOpenPositions(),
          liveResearch: this.liveResearchService ? this.liveResearchService.statusFor(account.id) : null,
        };
      }),
    );

    return {
      updatedAt: new Date().toISOString(),
      mode: this.config.liveEnabled ? "live" : "paper",
      accounts,
    };
  }

  // One strategy account in full: metrics, regime breakdown and history, all
  // computed from that account's own isolated ledger.
  async strategyAccount(id, { minTrades = 1, limit = 100 } = {}) {
    const account = describeStrategyAccount(id);
    if (!account) {
      throw Object.assign(new Error(`Unknown strategy account: ${id}`), { statusCode: 404, expose: true });
    }
    const ledger = this.strategyLedger(account.id);
    const history = ledger.getHistory();
    const startingBalance = ledger.readAccount().startingBalance;

    return {
      ...account,
      updatedAt: new Date().toISOString(),
      stats: ledger.readStats(),
      openPositions: ledger.getOpenPositions(),
      metrics: buildStrategyMetrics(history, startingBalance, minTrades),
      regimeMetrics: buildRegimeMatrix(history, startingBalance, { minTrades }),
      history: history.slice(-limit).reverse(),
      totalTrades: history.length,
      liveResearch: this.liveResearchService ? this.liveResearchService.statusFor(account.id) : null,
    };
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
    const strategy = await this.strategyAccounts();
    const legacyBooks = await Promise.all(
      LEGACY_BOOKS.map(async ({ id, name, archived }) => {
        const trader = this.book(id);
        return {
          id,
          name,
          archived,
          stats: trader.readStats(),
          totalTrades: trader.getHistory().length,
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
      accounts: strategy.accounts,
      legacyBooks,
      // Compatibility alias for older read-only clients. Every item is marked
      // archived and mutation routes no longer accept a legacy book.
      books: legacyBooks,
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
  async regime({ symbol, interval = "1h", strategyId = null, book = "main", minTrades = 20 } = {}) {
    if (!this.signalScreenerService) {
      throw Object.assign(new Error("No candle source configured for regime detection"), {
        statusCode: 503,
        expose: true,
      });
    }

    const candles = await this.signalScreenerService.getCandles(symbol, interval);
    const read = classifyRegime(candles || []);
    // Routing answers a portfolio-wide research question: which registered
    // strategy has evidence in THIS regime? The selected account is display
    // context only. Feeding its isolated matrix to the router would make every
    // other strategy look unproven and change the recommendation on card click.
    const routingMatrix = this.aggregateRegimeMatrix({ minTrades });
    const routing = routeRegime({ read, matrix: routingMatrix });

    return {
      symbol,
      interval,
      strategyId: strategyId || null,
      updatedAt: new Date().toISOString(),
      candles: (candles || []).length,
      regime: read,
      routing,
    };
  }

  // The strategy × regime evidence table for one selected account. This powers
  // account-specific analysis and intentionally does not compare accounts.
  regimeMatrix({ strategyId = null, book = "main", minTrades = 20 } = {}) {
    const trader = strategyId ? this.strategyLedger(strategyId) : this.book(book);
    const account = trader.readAccount();
    return {
      strategyId: strategyId || null,
      book: strategyId ? trader.book : book,
      ...buildRegimeMatrix(trader.getHistory(), account.startingBalance, { minTrades }),
    };
  }

  // Advisory routing evidence across every registered strategy account. Each
  // trade keeps its explicit strategy identity; histories are combined only
  // for the comparison table and no account balance or risk state is shared.
  aggregateRegimeMatrix({ minTrades = 20 } = {}) {
    const history = [];

    for (const account of listStrategyAccounts()) {
      const ledger = this.strategyLedger(account.id);
      history.push(...ledger.getHistory());
    }

    return {
      scope: "all-strategy-accounts",
      strategyId: null,
      book: null,
      ...buildRegimeMatrix(history, this.config.accountSize, { minTrades }),
    };
  }

  strategyMetrics({ strategyId = null, book = "main", minTrades = 1 } = {}) {
    const trader = strategyId ? this.strategyLedger(strategyId) : this.book(book);
    const account = trader.readAccount();
    return {
      strategyId: strategyId || null,
      book: strategyId ? trader.book : book,
      ...buildStrategyMetrics(trader.getHistory(), account.startingBalance, minTrades),
    };
  }
}

module.exports = { TradingLabService, marketStateFromDecision, BOOKS, LEGACY_BOOKS };
