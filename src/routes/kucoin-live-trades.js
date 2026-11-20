"use strict";

const { Router } = require("express");
const { SUPPORTED_ASSETS } = require("../services/kucoin-live-trades/instruments");

// KuCoin Live Trades Terminal. Read-only, keyless public market data:
//
//   GET /api/kucoin-live-trades/status    upstream sockets, feeds, viewers
//   GET /api/kucoin-live-trades/symbols   BTC/ETH/SOL resolved to listed KuCoin
//                                         spot pairs and USDT perpetuals, with
//                                         the futures contract multiplier
//   GET /api/kucoin-live-trades/snapshot  ?market=spot|futures&asset=BTC
//   GET /api/kucoin-live-trades/stream    same params; Server-Sent Events
//
// `symbol=` (e.g. XBTUSDTM) is accepted in place of `asset=`.

async function feedParams(service, query) {
  const market = typeof query.market === "string" && query.market ? query.market : "spot";
  let asset = typeof query.asset === "string" && query.asset ? query.asset : null;
  if (!asset && typeof query.symbol === "string" && query.symbol) {
    const resolved = await service.instruments.load();
    const marketKey = String(market).toLowerCase();
    const match = Object.values(resolved[marketKey] || {}).find((item) => item.symbol === query.symbol.toUpperCase());
    if (!match) {
      const err = new Error(`${query.symbol} is not a supported KuCoin ${marketKey} symbol`);
      err.statusCode = 400;
      throw err;
    }
    asset = match.asset;
  }
  return service.validateFeed(market, asset || "BTC");
}

function createKucoinLiveTradesRouter({ kucoinLiveTradesService: service }) {
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/status", (req, res) => {
    res.json(service.status());
  });

  router.get("/symbols", async (req, res, next) => {
    try {
      const resolved = await service.instruments.load();
      res.json({
        exchange: "kucoin",
        assets: SUPPORTED_ASSETS,
        defaults: { market: "spot", asset: "BTC" },
        spot: resolved.spot,
        futures: resolved.futures,
        missing: resolved.missing,
        fetchedAt: resolved.fetchedAt,
        source: "GET https://api.kucoin.com/api/ua/v2/market/instrument (tradeType=SPOT, FUTURES)",
        registry: service.instruments.status(),
      });
    } catch (err) {
      err.statusCode = err.statusCode || 502;
      err.expose = true;
      err.message = `KuCoin instrument metadata unavailable: ${err.message}`;
      next(err);
    }
  });

  router.get("/snapshot", async (req, res, next) => {
    try {
      const { marketType, asset } = await feedParams(service, req.query);
      res.json(await service.snapshot(marketType, asset));
    } catch (err) {
      next(err);
    }
  });

  router.get("/stream", async (req, res, next) => {
    try {
      const { marketType, asset } = await feedParams(service, req.query);
      await service.openStream(req, res, { marketType, asset });
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createKucoinLiveTradesRouter };
