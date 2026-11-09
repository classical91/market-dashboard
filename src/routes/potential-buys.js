"use strict";

const express = require("express");
const { MAX_BYTES } = require("../services/potential-buys");

/**
 * Potential Buys — screenshots of stocks and tokens worth a closer look.
 *
 *   GET    /       every stored screenshot, newest first.
 *   POST   /       one screenshot: the raw image bytes as the body, with an
 *                  image Content-Type. Optional `?label=` (ticker or note).
 *   PATCH  /:id    { label } — rename it.
 *   DELETE /:id    remove it for good.
 *
 * The images themselves are served from /potential-buys-images/<file>. Both
 * sit behind the site login like every other owner page.
 */
function createPotentialBuysRouter({ potentialBuysStore }) {
  const router = express.Router();
  // Raw bytes rather than base64-in-JSON: the app-wide JSON parser is capped
  // at 2 MB, and a full-screen phone screenshot is often bigger than that.
  const imageBody = express.raw({ type: "image/*", limit: MAX_BYTES });

  router.get("/", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: potentialBuysStore.list() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", imageBody, (req, res, next) => {
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      const item = potentialBuysStore.add(bytes, { label: req.query.label });
      res.status(201).json({ item });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", (req, res, next) => {
    try {
      const item = potentialBuysStore.update(req.params.id, { label: req.body ? req.body.label : undefined });
      res.json({ item });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", (req, res, next) => {
    try {
      res.json({ deleted: potentialBuysStore.remove(req.params.id).id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPotentialBuysRouter };
