const { Router } = require("express");

function createLayoutAnalysisRouter({ layoutAnalysisService, telegramService, requireAdmin }) {
  const router = Router();

  function resolveTtlMs(req) {
    const minutes = Math.min(Math.max(parseInt(req.query.ttlMinutes, 10) || 30, 1), 1440);
    return minutes * 60 * 1000;
  }

  // The Telegram bot and OpenAI vision both fetch the captured screenshot
  // server-to-server, so the chart URL handed to them must be a fully
  // qualified public URL — derive it from the request that triggered the
  // capture rather than requiring a separate PUBLIC_BASE_URL config value.
  function publicBaseUrl(req) {
    return `${req.protocol}://${req.get("host")}`;
  }

  router.get("/", (req, res) => {
    res.json({
      configured: layoutAnalysisService.isConfigured(),
      layouts: layoutAnalysisService.peekAll(),
    });
  });

  router.get("/log", (req, res) => {
    res.json({ entries: layoutAnalysisService.getLog(100) });
  });

  router.post("/generate", requireAdmin, async (req, res, next) => {
    try {
      const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      const result = await layoutAnalysisService.generate(id, resolveTtlMs(req), publicBaseUrl(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/broadcast", requireAdmin, async (req, res, next) => {
    try {
      const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      if (!telegramService.configured) {
        res.status(400).json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)" });
        return;
      }
      const cached = layoutAnalysisService.getCached(id);
      if (!cached || !cached.analysis) {
        res.status(400).json({ error: "No analysis to broadcast yet — click Analyze first" });
        return;
      }
      if (cached.broadcastAt && cached.generatedAt && cached.broadcastAt >= cached.generatedAt) {
        res.status(409).json({
          error: "Already broadcast — generate a new analysis first",
          alreadyBroadcast: true,
          broadcastAt: cached.broadcastAt,
        });
        return;
      }
      await telegramService.postAIAnalysis(cached);
      const updated = layoutAnalysisService.markBroadcasted(id);
      res.json({
        ok: true,
        channelCount: telegramService._chatIds.length,
        broadcastAt: updated ? updated.broadcastAt : new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLayoutAnalysisRouter };
