"use strict";

const { Router } = require("express");

function queryOptions(query) {
  return {
    trendEmaLen: query.trendEmaLen,
    entryEmaLen: query.entryEmaLen,
    rsiLen: query.rsiLen,
    atrLen: query.atrLen,
    atrMultSL: query.atrMultSL,
    rr: query.rr,
    useVwap: query.useVwap,
    allowLong: query.allowLong,
    allowShort: query.allowShort,
    feePct: query.feePct,
  };
}

function createStrategyEngineRouter({ strategyEngineService }) {
  const router = Router();

  // Public read-only strategy analysis. It uses Binance public klines already
  // cached by the signal screener, so it has no private trading permissions.
  router.get("/", async (req, res, next) => {
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "BTCUSDT";
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const result = await strategyEngineService.analyze({
        symbol,
        interval,
        options: queryOptions(req.query),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/scan", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const symbols = typeof req.query.symbols === "string"
        ? req.query.symbols.split(",").map((symbol) => symbol.trim()).filter(Boolean)
        : null;
      const result = await strategyEngineService.scan({
        symbols,
        interval,
        options: queryOptions(req.query),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createStrategyEngineRouter };
