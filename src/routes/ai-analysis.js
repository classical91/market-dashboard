const { Router } = require("express");

function createAIAnalysisRouter({ aiAnalysisService, telegramService, requireAdmin }) {
  const router = Router();

  function resolveTtlMs(req) {
    const minutes = Math.min(Math.max(parseInt(req.query.ttlMinutes, 10) || 30, 1), 1440);
    return minutes * 60 * 1000;
  }

  // Read-only: returns cached analyses for every configured symbol, never generates.
  router.get("/", (req, res) => {
    res.json({
      configured: aiAnalysisService.isConfigured(),
      presets: aiAnalysisService.peekAll(),
    });
  });

  // Explicit generation — triggered only by a user action. Admin-guarded
  // because it spends Chart-img + OpenAI credits.
  router.post("/generate", requireAdmin, async (req, res, next) => {
    try {
      const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
      const interval = typeof req.body?.interval === "string" ? req.body.interval.trim() : "";
      if (!symbol || !interval) {
        res.status(400).json({ error: "symbol and interval are required" });
        return;
      }
      const result = await aiAnalysisService.generate(symbol, interval, resolveTtlMs(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Manually broadcast the last generated analysis for one symbol/interval to
  // Telegram. Never generates a fresh analysis itself — run /generate first.
  // Admin-guarded because it pushes messages to every configured channel.
  router.post("/broadcast", requireAdmin, async (req, res, next) => {
    try {
      const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
      const interval = typeof req.body?.interval === "string" ? req.body.interval.trim() : "";
      if (!symbol || !interval) {
        res.status(400).json({ error: "symbol and interval are required" });
        return;
      }
      if (!telegramService.configured) {
        res.status(400).json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)" });
        return;
      }
      const cached = aiAnalysisService.getCached(symbol, interval);
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
      const updated = aiAnalysisService.markBroadcasted(symbol, interval);
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

module.exports = { createAIAnalysisRouter };
