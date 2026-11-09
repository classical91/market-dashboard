"use strict";

const express = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { MAX_BYTES } = require("../services/potential-buys");

/**
 * Potential Buys — screenshots of stocks and tokens worth a closer look.
 *
 *   GET    /       every stored screenshot, newest first.
 *   POST   /       one screenshot: the raw image bytes as the body, with an
 *                  image Content-Type. Optional `?label=` (ticker or note).
 *   PATCH  /:id    { label } — rename it.
 *   DELETE /:id    remove it for good.
 *   POST   /upload the iPhone Shortcut's route (Share Sheet → Potential
 *                  Buys). Ledger key in `x-broadcast-key` (or Authorization:
 *                  Bearer). Body: the image itself (Request Body = File), or
 *                  JSON { imageBase64, label } for small images. Optional
 *                  `?label=` or an `x-label` header.
 *
 * The images themselves are served from /potential-buys-images/<file>. All
 * but /upload sit behind the site login like every other owner page; /upload
 * takes the same machine key the phone-briefings Shortcut already carries,
 * which can only add screenshots here, never list or delete them.
 */
function createPotentialBuysRouter({ potentialBuysStore, requireLedgerKey, rateLimitPerMinute = 60 }) {
  const router = express.Router();
  // Raw bytes rather than base64-in-JSON: the app-wide JSON parser is capped
  // at 2 MB, and a full-screen phone screenshot is often bigger than that.
  const imageBody = express.raw({ type: "image/*", limit: MAX_BYTES });

  // Shortcuts sends a File body with the image's own type, but can fall back
  // to application/octet-stream, so take any non-JSON body as raw bytes and
  // let the store decide from the bytes what it is.
  const anyRawBody = express.raw({ type: (req) => !req.is("application/json"), limit: MAX_BYTES });
  const uploadLimiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });

  if (requireLedgerKey) {
    router.post("/upload", requireLedgerKey, uploadLimiter, anyRawBody, (req, res, next) => {
      try {
        const body = req.body;
        let bytes = Buffer.isBuffer(body) ? body : null;
        let label = req.query.label || req.get("x-label");
        if (!bytes && body && typeof body === "object" && typeof body.imageBase64 === "string") {
          const raw = body.imageBase64.trim().replace(/^data:[^,]*,/, "").replace(/\s/g, "");
          bytes = Buffer.from(raw, "base64");
          if (typeof body.label === "string") label = body.label;
        }
        const item = potentialBuysStore.add(bytes, { label });
        res.status(201).json({ ok: true, id: item.id, label: item.label, size: item.size, createdAt: item.createdAt });
      } catch (err) {
        next(err);
      }
    });
  }

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
