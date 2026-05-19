const { Router } = require("express");

function createReporterRouter({ reporterService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const report = await reporterService.getReport();
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createReporterRouter };
