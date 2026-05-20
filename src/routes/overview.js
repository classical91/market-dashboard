const express = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createOverviewRouter({ overviewService }) {
  const router = express.Router();

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const range = typeof req.query.range === "string" ? req.query.range.toUpperCase() : "1D";
      const payload = await overviewService.getOverview(range);
      res.json(payload);
    }),
  );

  return router;
}

module.exports = { createOverviewRouter };
