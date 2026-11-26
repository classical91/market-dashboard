const { Router } = require("express");
const G = require("../../public/assets/js/gann-math");

// Gann Intelligence API. Read-only, GET only: every route either does pure
// arithmetic or reads the shared cached candles through GannService. Nothing
// here places, sizes or modifies a trade.

const SETTING_KEYS = [
  "pivotLeft", "pivotRight", "lookback", "anchorMode", "anchorSide", "anchorTime",
  "scaleMode", "scaleLength", "scaleValue", "sq9Step", "sq9Count", "sq9Normalise",
  "cycleTolerance", "confluenceAtr", "levelRangeAtr", "horizonBars",
];

function settingsFrom(query) {
  const out = {};
  for (const key of SETTING_KEYS) {
    if (typeof query[key] === "string" && query[key] !== "") out[key] = query[key];
  }
  return out;
}

function isForce(query) {
  return query.force === "true" || query.force === "1";
}

function createGannRouter({ gannService }) {
  const router = Router();

  router.get("/meta", (req, res) => {
    res.json({ symbols: gannService.symbols, timeframes: gannService.timeframes, fanAngles: G.FAN_ANGLES.map((a) => a.name) });
  });

  // Pure calculator: no market data, no cache.
  router.get("/square-of-nine", (req, res) => {
    const price = Number(req.query.price);
    if (!Number.isFinite(price) || price <= 0) {
      res.status(400).json({ error: "price must be a positive number" });
      return;
    }
    const step = Number(req.query.step) || 45;
    const count = Number.parseInt(req.query.count, 10) || 8;
    res.json(G.squareOfNine(price, { step, count, normalise: req.query.normalise !== "false" }));
  });

  router.get("/analysis", async (req, res, next) => {
    try {
      const result = await gannService.analyze({
        symbol: req.query.symbol || "BTCUSDT",
        timeframe: req.query.timeframe || "4h",
        settings: settingsFrom(req.query),
        force: isForce(req.query),
        includeCandles: req.query.candles !== "false",
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/mtf", async (req, res, next) => {
    try {
      res.json(await gannService.multiTimeframe({ symbol: req.query.symbol || "BTCUSDT", settings: settingsFrom(req.query) }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/screener", async (req, res, next) => {
    try {
      res.json(await gannService.screener({ timeframe: req.query.timeframe || "4h", settings: settingsFrom(req.query) }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/backtest", async (req, res, next) => {
    try {
      const options = {};
      if (["baseline", "stress", "frictionless"].includes(req.query.costScenario)) options.costScenario = req.query.costScenario;
      res.json(await gannService.backtest({
        symbol: req.query.symbol || "BTCUSDT",
        timeframe: req.query.timeframe || "4h",
        settings: settingsFrom(req.query),
        options,
      }));
    } catch (err) {
      next(err);
    }
  });

  // TraderClaw's read-only feed. Default settings only, so every consumer
  // sees the same numbers as the page's default view.
  router.get("/observations", async (req, res, next) => {
    try {
      res.json(await gannService.observations({ symbol: req.query.symbol || "BTCUSDT", timeframe: req.query.timeframe || "4h" }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createGannRouter, settingsFrom };
