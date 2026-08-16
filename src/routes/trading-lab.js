"use strict";

const { Router } = require("express");

const { listStrategies, DEFAULT_STRATEGY_ID } = require("../services/trading/strategies");
const { positionOwner } = require("../services/trading/execution-owner");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function latestExperimentFor(experimentStore, strategyId) {
  if (!experimentStore) return null;
  const result = experimentStore.list({ strategy: strategyId, limit: 1 });
  return result.items[0] || null;
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) {
    throw Object.assign(new Error(`Missing required fields: ${missing.join(", ")}`), {
      statusCode: 400,
      expose: true,
    });
  }
}

function readLedger(tradingLabService, values = {}) {
  const strategyId = values.strategyId || values.strategy;
  return strategyId ? tradingLabService.strategyLedger(strategyId) : tradingLabService.book(values.book);
}

// An autonomous demo account is an experiment, and an experiment with two
// writers is not an experiment. These helpers are the single place a manual
// route asks "may I touch this?", so a new admin route cannot quietly acquire
// the ability to alter a running result.
function refuseAutonomous(res, { owner, what, detail }) {
  const managedBy = owner === "live-research" ? "Live Research" : "Live Scanner";
  res.status(409).json({
    error: `Position is managed by ${managedBy}. ${what} is disabled to preserve demo-account experiment integrity.`,
    owner,
    managedBy,
    // Said out loud rather than silently ignored: a caller that believes it
    // marked the book and did not would misread every number afterwards.
    refused: true,
    ...(detail ? { detail } : {}),
  });
}

function createTradingLabRouter({
  tradingLabService,
  backtestService,
  signalActionStore = null,
  experimentStore = null,
  requireAdmin,
}) {
  const router = Router();

  // ── Reads ─────────────────────────────────────────────────────────────────
  // Public like the other scanner reads: paper P&L on a personal dashboard is
  // not a secret, and no external credits are spent serving it.

  router.get("/", asyncRoute(async (req, res) => {
    res.json(await tradingLabService.overview());
  }));

  // The strategies the backtester can run. Public: it is a static catalogue,
  // and the UI needs it to populate the selector before any admin key exists.
  router.get("/strategies", (req, res) => {
    res.json({ default: DEFAULT_STRATEGY_ID, strategies: listStrategies() });
  });

  // ── Research history ──────────────────────────────────────────────────────
  // Public like the other reads: an experiment is a record of a replay over
  // public candles, spends nothing to serve, and reveals no position or key.
  // Read-only by design — promotion decisions are not made over HTTP.

  router.get("/experiments", (req, res) => {
    if (!experimentStore) {
      res.json({ total: 0, items: [], recording: false });
      return;
    }
    const filters = {};
    for (const key of ["strategy", "version", "symbol", "timeframe"]) {
      const value = req.query[key];
      if (typeof value === "string" && value !== "") filters[key] = value;
    }
    res.json({
      ...experimentStore.list({ ...filters, limit: numberOr(req.query.limit, 100) }),
      filters,
      recording: true,
    });
  });

  router.get("/experiments/:id", (req, res) => {
    const experiment = experimentStore ? experimentStore.get(req.params.id) : null;
    if (!experiment) {
      res.status(404).json({ error: `No experiment with id ${req.params.id}` });
      return;
    }
    res.json({ experiment });
  });

  router.get("/books", (req, res) => {
    res.json({ books: tradingLabService.listBooks() });
  });

  router.get("/positions", (req, res) => {
    const trader = readLedger(tradingLabService, req.query);
    res.json({ book: trader.book, strategyId: req.query.strategyId || null, positions: trader.getPositions() });
  });

  router.get("/history", (req, res) => {
    const trader = readLedger(tradingLabService, req.query);
    const limit = Math.min(Math.max(numberOr(req.query.limit, 100), 1), 1000);
    const history = trader.getHistory();
    const window = history.slice(-limit);
    const before = history.slice(0, Math.max(0, history.length - window.length));

    // The account balance as it stood BEFORE the returned window.
    //
    // Without this a client drawing an equity curve from `items` has to start
    // somewhere, and the only figure it has is the account's original starting
    // balance — which is only correct while the whole history fits in the
    // window. Past that, the curve silently redraws every trade as if the
    // earlier ones never happened. Returning the real opening balance makes a
    // truncated window a WINDOW rather than a wrong picture of the whole run.
    const openingBalance = before.reduce(
      (balance, trade) => balance + (Number(trade.pnl != null ? trade.pnl : trade.realizedPnl) || 0),
      Number((typeof trader.readAccount === "function" ? trader.readAccount() : trader.getAccount()).startingBalance) || 0,
    );

    res.json({
      book: trader.book,
      strategyId: req.query.strategyId || null,
      total: history.length,
      returned: window.length,
      truncated: before.length > 0,
      openingBalance: Math.round(openingBalance * 100) / 100,
      items: window.reverse(),
    });
  });

  router.get("/signal-actions", (req, res) => {
    const limit = Math.min(Math.max(numberOr(req.query.limit, 50), 1), 2000);
    const items = signalActionStore && typeof signalActionStore.recent === "function"
      ? signalActionStore.recent(limit)
      : [];
    const total = signalActionStore && typeof signalActionStore.count === "function"
      ? signalActionStore.count()
      : items.length;
    res.json({ total, items });
  });

  router.get("/metrics", (req, res) => {
    res.json(
      tradingLabService.strategyMetrics({
        strategyId: req.query.strategyId || null,
        book: req.query.book,
        minTrades: Math.max(numberOr(req.query.min_trades, 1), 1),
      }),
    );
  });

  // ── Strategy accounts ─────────────────────────────────────────────────────
  //
  // One isolated ledger per registered strategy: "does THIS strategy make
  // money?". The legacy book endpoints above remain read-only compatibility
  // views. An account existing confers nothing — four of the five may not trade
  // forward and say so.

  router.get("/strategy-accounts", asyncRoute(async (req, res) => {
    const result = await tradingLabService.strategyAccounts();
    res.json({
      ...result,
      accounts: result.accounts.map((account) => ({
        ...account,
        latestBacktest: latestExperimentFor(experimentStore, account.id),
      })),
    });
  }));

  router.get("/strategy-accounts/:id", asyncRoute(async (req, res) => {
    const account = await tradingLabService.strategyAccount(req.params.id, {
        minTrades: Math.max(numberOr(req.query.min_trades, 1), 1),
        limit: Math.min(Math.max(numberOr(req.query.limit, 100), 1), 1000),
      });
    res.json({
      ...account,
      latestBacktest: latestExperimentFor(experimentStore, account.id),
    });
  }));

  router.get("/live-research", (req, res) => {
    const service = tradingLabService.liveResearchService;
    res.json(service ? service.status() : { enabled: false, running: false, runners: [] });
  });

  // ── Regime ────────────────────────────────────────────────────────────────

  // "What environment are we in, and what does our own history say belongs in
  // it?" Public like the other reads: it replays no ledger and spends nothing
  // beyond the screener's already-cached candles.
  //
  // The routing half of the response is ADVISORY. Nothing in the scanner reads
  // it — see services/trading/regime-router.js.
  router.get("/regime", asyncRoute(async (req, res) => {
    res.json(
      await tradingLabService.regime({
        symbol: String(req.query.symbol || "BTCUSDT").toUpperCase(),
        interval: typeof req.query.interval === "string" && req.query.interval ? req.query.interval : "1h",
        strategyId: req.query.strategyId || null,
        book: req.query.book,
        minTrades: Math.max(numberOr(req.query.min_trades, 20), 1),
      }),
    );
  }));

  // The strategy × regime table on its own, for the Trading Lab's research
  // view. No candles are fetched — this is a read of recorded history.
  router.get("/regime-matrix", (req, res) => {
    res.json(
      tradingLabService.regimeMatrix({
        strategyId: req.query.strategyId || null,
        book: req.query.book,
        minTrades: Math.max(numberOr(req.query.min_trades, 20), 1),
      }),
    );
  });

  // The bridge that makes the Decision Engine's plans answer "did setups like
  // this actually pay?" — evaluation only, nothing is opened.
  router.get("/decision-candidates", asyncRoute(async (req, res) => {
    res.json(
      await tradingLabService.evaluateDecisionPlans({
        interval: typeof req.query.interval === "string" ? req.query.interval : "4h",
        book: req.query.book,
      }),
    );
  }));

  // ── Evaluation ────────────────────────────────────────────────────────────

  // A dry run: score a hypothetical trade without touching the ledger. Safe to
  // leave public — it only reads history that the routes above already expose.
  router.post("/evaluate", (req, res, next) => {
    try {
      const body = req.body || {};
      requireFields(body, ["symbol", "direction", "entryPrice"]);
      res.json(
        tradingLabService.evaluate({
          book: body.book,
          symbol: String(body.symbol),
          direction: String(body.direction).toUpperCase(),
          entryPrice: Number(body.entryPrice),
          atr: body.atr === undefined ? null : Number(body.atr),
          state: body.state || {},
          strategy: body.strategy || null,
          strategyId: body.strategyId || null,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  // Admin-gated like every other state-changing route: a public deploy must
  // not let anonymous visitors write to the trading ledger.

  router.post("/positions", requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ["strategyId", "symbol", "direction", "entryPrice"]);

    // ONE DEMO ACCOUNT -> ONE EXPERIMENT -> ONE EXECUTION OWNER.
    // A hand-placed trade in a running experiment's ledger is indistinguishable
    // from a strategy result once it closes, so it is refused rather than
    // written somewhere else — silently redirecting it would just move the
    // contamination to another account.
    const autonomousOwner = tradingLabService.autonomousOwnerOf(body.strategyId);
    if (autonomousOwner) {
      refuseAutonomous(res, {
        owner: autonomousOwner,
        what: "Manual trade entry",
        detail:
          `${body.strategyId} is running an autonomous live demo experiment. A manual trade would be recorded in the same $10,000 ledger and become indistinguishable from a strategy result.`,
      });
      return;
    }

    const result = await tradingLabService.execute({
      strategyId: String(body.strategyId),
      symbol: String(body.symbol),
      direction: String(body.direction).toUpperCase(),
      entryPrice: Number(body.entryPrice),
      atr: body.atr === undefined ? null : Number(body.atr),
      state: body.state || {},
      strategy: body.strategy || null,
      signalSource: body.signalSource || "manual",
      strategyVersion: body.strategyVersion || null,
      timeframe: body.timeframe || null,
      regime: body.regime || null,
      regimeConfidence: body.regimeConfidence ?? null,
    });
    res.status(result.opened ? 201 : 200).json(result);
  }));

  router.post("/positions/:id/close", requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ["strategyId"]);
    const trader = tradingLabService.strategyLedger(body.strategyId);

    // A manual close writes an exit the strategy never chose, and the resulting
    // R-multiple is then attributed to the strategy. There is deliberately no
    // override: discretionary intervention should be a separate, explicit
    // feature that permanently records the experiment as having been altered.
    const target = trader.getOpenPositions().find((p) => p.id === req.params.id);
    const owner = target ? positionOwner(target) : null;
    if (owner === "live-research" || owner === "live-scanner") {
      refuseAutonomous(res, {
        owner,
        what: "Manual closing",
        detail: "Its own loop manages this position's stop, target and strategy exit.",
      });
      return;
    }

    const closed = await trader.closePosition(req.params.id, {
      reason: body.reason || "MANUAL",
      exitPrice: body.exitPrice ? Number(body.exitPrice) : null,
    });
    if (!closed) {
      res.status(404).json({ error: "Open position not found, or no price available to close it" });
      return;
    }
    res.json({ position: closed });
  }));

  // Mark open positions to market and fire any stop/target the new price
  // reaches. Called by the UI on refresh and by the interval loop.
  router.post("/mark", requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ["strategyId"]);
    const trader = tradingLabService.strategyLedger(body.strategyId);

    // Marking fires stops and targets. Doing that on a runner-owned position
    // means a human page load decides an exit price, and the account stops
    // being a record of what the strategy did. The runner marks its own
    // positions on every closed candle, so nothing is lost by refusing.
    const autonomous = tradingLabService.autonomousPositionsIn(body.strategyId);
    if (autonomous.length) {
      refuseAutonomous(res, {
        owner: positionOwner(autonomous[0]),
        what: "Manual marking",
        detail: `${autonomous.length} open position(s) are managed by their own loop and are marked on each closed candle.`,
      });
      return;
    }

    const events = await trader.updatePositions(body.prices || null);
    res.json({ strategyId: body.strategyId, book: trader.book, events, stats: await trader.getStats() });
  }));

  // Admin-gated despite being read-only: unlike the other reads it replays
  // hundreds of bars per call and pulls candles from Binance, so it is not
  // something an anonymous visitor should be able to spin in a loop. It writes
  // only to a temp ledger that is deleted when the run ends — the live books
  // are never touched.
  router.post("/backtest", requireAdmin, asyncRoute(async (req, res) => {
    if (!backtestService) {
      res.status(503).json({ error: "Backtesting is not configured" });
      return;
    }
    const body = req.body || {};
    requireFields(body, ["symbol"]);
    res.json(
      // An unknown strategy id throws a 400 from the registry rather than
      // quietly falling back to the default.
      await backtestService.backtestSymbol({
        symbol: String(body.symbol).toUpperCase(),
        interval: typeof body.interval === "string" ? body.interval : "4h",
        strategy: body.strategy === undefined || body.strategy === null || body.strategy === ""
          ? DEFAULT_STRATEGY_ID
          : String(body.strategy),
        options: body.options || {},
        // "shared" (default) compares entry signals on one execution model;
        // "native" runs each strategy's own stop and target. An unknown value
        // is a 400 from the service rather than a silent fallback.
        executionMode:
          typeof body.executionMode === "string" && body.executionMode ? body.executionMode : "shared",
        // Opt-in: an unrecorded run is the default so that exploring does not
        // fill the research log with noise.
        record: body.record === true || body.record === "true",
        notes: typeof body.notes === "string" && body.notes ? body.notes.slice(0, 500) : null,
      }),
    );
  }));

  // Same replay, several strategies, one candle set — the side-by-side that
  // decides whether a new strategy is worth promoting. Admin-gated for the
  // same reason as /backtest, and more so: it is N runs per call.
  router.post("/backtest/compare", requireAdmin, asyncRoute(async (req, res) => {
    if (!backtestService) {
      res.status(503).json({ error: "Backtesting is not configured" });
      return;
    }
    const body = req.body || {};
    requireFields(body, ["symbol"]);
    const strategies = Array.isArray(body.strategies) && body.strategies.length
      ? body.strategies.map((id) => String(id))
      : listStrategies().map((s) => s.id);
    res.json(
      await backtestService.compare({
        symbol: String(body.symbol).toUpperCase(),
        interval: typeof body.interval === "string" ? body.interval : "4h",
        strategies,
        options: body.options || {},
        executionMode:
          typeof body.executionMode === "string" && body.executionMode ? body.executionMode : "shared",
        ...(body.minRankedTrades === undefined ? {} : { minRankedTrades: Number(body.minRankedTrades) }),
      }),
    );
  }));

  // An atomic restart of the whole experiment, not just of the ledger.
  //
  // Resetting the balance while the runner keeps its lastProcessedCandle would
  // leave the two disagreeing: a fresh $10,000 account whose runner believes it
  // is mid-experiment. Clearing runner state too means the next cycle takes the
  // baseline path, so the first tradeable candle is one closing AFTER the
  // reset — a reset can never be followed by a trade on an old candle.
  router.post("/reset", requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body || {};
    requireFields(body, ["strategyId"]);
    res.json(await tradingLabService.resetExperiment(body.strategyId));
  }));

  return router;
}

module.exports = { createTradingLabRouter };
