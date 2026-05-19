const { Router } = require("express");

function createTelegramRouter({ telegramService }) {
  const router = Router();

  router.get("/status", (req, res) => {
    res.json({
      configured: telegramService.configured,
      channelCount: telegramService._chatIds.length,
    });
  });

  router.post("/test", async (req, res, next) => {
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
