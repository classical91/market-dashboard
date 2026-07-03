const { Router } = require("express");

function createTelegramRouter({ telegramService, requireAdmin }) {
  const router = Router();

  router.get("/status", (req, res) => {
    res.json({
      configured: telegramService.configured,
      channelCount: telegramService._chatIds.length,
    });
  });

  // Read-only config check: validates the token (getMe) and each chat id
  // (getChat) against the live Telegram API without sending any message.
  // Admin-guarded: it can reveal bot-id / token-length and target chat detail.
  router.get("/diagnose", requireAdmin, async (req, res, next) => {
    try {
      res.json(await telegramService.diagnose());
    } catch (err) {
      next(err);
    }
  });

  router.post("/test", requireAdmin, async (req, res, next) => {
    try {
      if (!telegramService.configured) {
        return res.status(400).json({ error: "Telegram not configured" });
      }
      await telegramService.testAll();
      res.json({ ok: true, channelCount: telegramService._chatIds.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createTelegramRouter };
