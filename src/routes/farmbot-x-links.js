"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { createFarmbotXQueue } = require("../services/farmbot-x-queue");

/**
 * Direct X post → FarmBot Queue (no FarmClaw agent). Admin only.
 *
 *   GET  /status         { configured, missing } for the page.
 *   GET  /lookup?url=    what FarmBot holds for this post (404 if nothing).
 *   POST /               { url, text, sourceText, handle, publishedAt, category, image? }
 */
function createFarmbotXLinksRouter({ requireAdmin, env = process.env, fetcher = fetch, queue = null }) {
  const router = Router();
  const service = queue || createFarmbotXQueue({ env, fetcher });
  const limiter = createRateLimit({ limit: 30, windowMs: 60 * 1000 });
  router.use((_req, res, next) => { res.set("cache-control", "no-store"); next(); });

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "FarmBot queue request failed" });
    }
  };

  router.get("/status", requireAdmin, (_req, res) => {
    const missing = service.missingConfig();
    res.json({ configured: missing.length === 0, missing });
  });

  router.get("/lookup", requireAdmin, handle(async (req, res) => {
    const found = await service.lookup(req.query.url);
    if (!found) {
      res.status(404).json({ error: "Not in FarmBot Queue" });
      return;
    }
    res.json(found);
  }));

  router.post("/", requireAdmin, limiter, handle(async (req, res) => {
    const result = await service.enqueue(req.body || {});
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  return router;
}

module.exports = { createFarmbotXLinksRouter };
