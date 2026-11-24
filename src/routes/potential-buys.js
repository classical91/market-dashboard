"use strict";

const express = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { MAX_BYTES } = require("../services/potential-buys");
const { tickerSymbol, withTicker } = require("../../public/assets/js/ticker-label");

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.expose = true;
  return err;
}

function firstText(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return "";
}

/**
 * Potential Buys — screenshots of stocks and tokens worth a closer look.
 *
 *   GET    /summary  counts only (total, #tickers, untagged, added in the
 *                  last 24 hours and 7 days, older than 3 days and
 *                  across how many tickers, newest/oldest times) — never a
 *                  label or image. Main Hub's System Logs reads it with the
 *                  admin key in `x-admin-key` (see site-auth.js).
 *   GET    /       every stored screenshot, newest first, plus `folders`:
 *                  one per #hashtag in the labels ({ tag, count, updatedAt }).
 *   POST   /       one screenshot: the raw image bytes as the body, with an
 *                  image Content-Type. Optional `?label=` (ticker or note).
 *   PATCH  /:id    { label } — rename it.
 *   PUT    /:id/image  the cropped picture (raw image bytes) replaces the
 *                  stored one; id, label and folders stay the same.
 *   DELETE /:id    remove it for good.
 *   POST   /upload the iPhone Shortcut's route (Share Sheet → Potential
 *                  Buys). Ledger key in `x-broadcast-key` (or Authorization:
 *                  Bearer). Body: the image itself (Request Body = File), or
 *                  JSON { imageBase64, ticker, label } for small images.
 *                  The ticker files it in that ticker's stack: an `x-ticker`
 *                  header (what the page's Shortcut steps use, since a "#"
 *                  in a URL would cut it short), `?ticker=` or JSON
 *                  `ticker`. "nvda", "$NVDA" and "NASDAQ:NVDA" all file it
 *                  under $NVDA. A note can ride along as `x-label`, `?label=`
 *                  or JSON `label`. The reply's `message` ("Saved to $NVDA")
 *                  is for the Shortcut's notification.
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
        let ticker = firstText(req.get("x-ticker"), req.query.ticker);
        if (!bytes && body && typeof body === "object" && typeof body.imageBase64 === "string") {
          const raw = body.imageBase64.trim().replace(/^data:[^,]*,/, "").replace(/\s/g, "");
          bytes = Buffer.from(raw, "base64");
          if (typeof body.label === "string") label = body.label;
          if (typeof body.ticker === "string" && body.ticker.trim()) ticker = body.ticker;
        }
        if (typeof label !== "string") label = "";
        if (ticker && tickerSymbol(ticker) === null) {
          throw badRequest(
            `"${ticker.trim().slice(0, 40)}" isn't a ticker. Send one symbol like NVDA, BTC or SOL-USD ` +
              "(put any note in the label instead).",
          );
        }
        const item = potentialBuysStore.add(bytes, { label: ticker ? withTicker(ticker, label) : label });
        const tags = item.tags || [];
        res.status(201).json({
          ok: true,
          id: item.id,
          label: item.label,
          tags,
          message: tags.length
            ? `Saved to ${tags.map((tag) => `$${tag}`).join(", ")}`
            : "Saved without a ticker; add one on the Potential Buys page",
          size: item.size,
          createdAt: item.createdAt,
        });
      } catch (err) {
        next(err);
      }
    });
  }

  router.get("/summary", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(potentialBuysStore.summary());
    } catch (err) {
      next(err);
    }
  });

  router.get("/", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const items = potentialBuysStore.list();
      const { folders, untagged } = potentialBuysStore.folders(items);
      res.json({ items, folders, untagged });
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

  router.put("/:id/image", imageBody, (req, res, next) => {
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      res.json({ item: potentialBuysStore.replaceImage(req.params.id, bytes) });
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
