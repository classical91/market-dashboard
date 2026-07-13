const { Router } = require("express");

// No admin gate on any of these, unlike Watchlist/Journal — this is a
// personal reference list (Telegram bot command snippets), not an action
// that spends credits or posts anywhere, and the point is to let it sync
// freely between a phone and a desktop without re-entering a key on each.
function createBotCommandsRouter({ botCommandsService }) {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({ items: botCommandsService.list() });
  });

  router.post("/", (req, res, next) => {
    try {
      const item = botCommandsService.upsert(req.body || {});
      res.json({ item, items: botCommandsService.list() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", (req, res) => {
    res.json({ items: botCommandsService.remove(req.params.id) });
  });

  return router;
}

module.exports = { createBotCommandsRouter };
