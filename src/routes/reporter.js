const { Router } = require("express");

function createReporterRouter({ reporterService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.ttlHours, 10) || 24, 1), 168);
      const report = await reporterService.getReport(hours * 60 * 60 * 1000);
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createReporterRouter };
