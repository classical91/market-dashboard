"use strict";

const { Router } = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function createTradingLabRouter({ tradingLabService, backtestService, requireAdmin }) {
  const router = Router();

  // ── Reads ─────────────────────────────────────────────────────────────────
  // Public like the other scanner reads: paper P&L on a personal dashboard is
  // not a secret, and no external credits are spent serving it.

  router.get("/", asyncRoute(async (req, res) => {
    res.json(await tradingLabService.overview());
  }));

  router.get("/books", (req, res) => {
    res.json({ books: tradingLabService.listBooks() });
  });

  router.get("/positions", (req, res) => {
    const trader = tradingLabService.book(req.query.book);
    res.json({ book: trader.book, positions: trader.getPositions() });
  });

  router.get("/history", (req, res) => {
    const trader = tradingLabService.book(req.query.book);
    const limit = Math.min(Math.max(numberOr(req.query.limit, 100), 1), 1000);
    const history = trader.getHistory();
    res.json({ book: trader.book, total: history.length, items: history.slice(-limit).reverse() });
  });

  router.get("/metrics", (req, res) => {
    res.json(
      tradingLabService.strategyMetrics({
        book: req.query.book,
        minTrades: Math.max(numberOr(req.query.min_trades, 1), 1),
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
    requireFields(body, ["symbol", "direction", "entryPrice"]);
    const result = await tradingLabService.execute({
      book: body.book,
      symbol: String(body.symbol),
      direction: String(body.direction).toUpperCase(),
      entryPrice: Number(body.entryPrice),
      atr: body.atr === undefined ? null : Number(body.atr),
      state: body.state || {},
      strategy: body.strategy || null,
      signalSource: body.signalSource || "manual",
    });
    res.status(result.opened ? 201 : 200).json(result);
  }));

  router.post("/positions/:id/close", requireAdmin, asyncRoute(async (req, res) => {
    const trader = tradingLabService.book((req.body || {}).book || req.query.book);
    const closed = await trader.closePosition(req.params.id, {
      reason: (req.body || {}).reason || "MANUAL",
      exitPrice: (req.body || {}).exitPrice ? Number(req.body.exitPrice) : null,
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
    const trader = tradingLabService.book((req.body || {}).book || req.query.book);
    const events = await trader.updatePositions((req.body || {}).prices || null);
    res.json({ book: trader.book, events, stats: await trader.getStats() });
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
      await backtestService.backtestSymbol({
        symbol: String(body.symbol).toUpperCase(),
        interval: typeof body.interval === "string" ? body.interval : "4h",
        options: body.options || {},
      }),
    );
  }));

  router.post("/reset", requireAdmin, (req, res) => {
    const trader = tradingLabService.book((req.body || {}).book || req.query.book);
    res.json({ book: trader.book, account: trader.reset() });
  });

  return router;
}

module.exports = { createTradingLabRouter };
