"use strict";

const { Router } = require("express");

// Personal notes: both reading and writing take the owner session (or admin
// key), so a deploy without site login can't leak them to anonymous visitors.
function createOverviewNotesRouter({ overviewNotesService, requireAdmin }) {
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", requireAdmin, (req, res, next) => {
    try {
      res.json(overviewNotesService.get());
    } catch (err) {
      next(err);
    }
  });

  router.put("/", requireAdmin, (req, res, next) => {
    const baseRevision = req.body?.baseRevision;
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      res.status(400).json({ error: "baseRevision must be a non-negative integer" });
      return;
    }
    try {
      res.json(overviewNotesService.save({ baseRevision, folders: req.body?.folders }));
    } catch (err) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: err.message, current: err.current });
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createOverviewNotesRouter };
