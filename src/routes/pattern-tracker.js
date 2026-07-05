const { Router } = require("express");

function createPatternTrackerRouter({ patternTrackerService }) {
  const router = Router();

  // Read-only, unauthenticated — same as the scanners themselves.
  router.get("/stats", (req, res) => {
    res.json(patternTrackerService.stats());
  });

  router.get("/log", (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    res.json({ entries: patternTrackerService.recent(limit) });
  });

  return router;
}

module.exports = { createPatternTrackerRouter };
