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
 *                  image Content-Type. Optional `?label=` (ticker or note)
 *                  and `?batch=` (screenshots sent together share one).
 *   PATCH  /:id    { label } — rename it.
 *   PUT    /:id/image  the cropped picture (raw image bytes) replaces the
 *                  stored one; id, label and folders stay the same.
 *   DELETE /:id    remove it for good.
 *   POST   /upload the iPhone Shortcut's route (Share Sheet → Potential
 *                  Buys). Ledger key in `x-broadcast-key` (or Authorization:
 *                  Bearer). Body: the image itself (Request Body = File), or
 *                  JSON { imageBase64, ticker, label } (up to 15 MB of image).
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
/**
 * The phone upload's JSON body ({ imageBase64 }) is parsed here, after the
 * ledger key is checked, not by the app-wide 2 MB JSON parser: base64 makes
 * an image a third bigger, so a 1.5 MB JPEG screenshot already came to over
 * 2 MB and was refused before it got here. And Shortcuts' Get Contents of URL
 * doesn't stop on an HTTP error, so the Shortcut looked like it had worked.
 * This fits a MAX_BYTES image as base64 with Shortcuts' line breaks (CRLF
 * every 76 characters, written \r\n in JSON).
 */
const UPLOAD_JSON_LIMIT = Math.ceil((MAX_BYTES * 4) / 3 * (80 / 76)) + 64 * 1024;
const UPLOAD_PATH_RE = /^\/api\/potential-buys\/upload\/?$/;

/** The app-wide JSON parser skips this one request; see UPLOAD_JSON_LIMIT. */
function isPotentialBuysUpload(req) {
  return req.method === "POST" && UPLOAD_PATH_RE.test(req.path);
}

/** A JSON body that's too big gets an answer the Shortcut can show. */
function uploadTooLarge(err, req, res, next) {
  if (err && err.type === "entity.too.large") {
    next(Object.assign(new Error("Screenshot is larger than 15 MB."), { statusCode: 413, expose: true }));
    return;
  }
  next(err);
}

function createPotentialBuysRouter({ potentialBuysStore, requireLedgerKey, rateLimitPerMinute = 60 }) {
  const router = express.Router();
  // Raw bytes rather than base64-in-JSON: the app-wide JSON parser is capped
  // at 2 MB, and a full-screen phone screenshot is often bigger than that.
  const imageBody = express.raw({ type: "image/*", limit: MAX_BYTES });

  // Shortcuts sends a File body with the image's own type, but can fall back
  // to application/octet-stream, so take any non-JSON body as raw bytes and
  // let the store decide from the bytes what it is.
  const anyRawBody = express.raw({ type: (req) => !req.is("application/json"), limit: MAX_BYTES });
  const uploadJson = express.json({ limit: UPLOAD_JSON_LIMIT });
  const uploadLimiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });

  if (requireLedgerKey) {
    router.post("/upload", requireLedgerKey, uploadLimiter, uploadJson, anyRawBody, uploadTooLarge, (req, res, next) => {
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
      const item = potentialBuysStore.add(bytes, { label: req.query.label, batch: req.query.batch });
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

module.exports = { createPotentialBuysRouter, isPotentialBuysUpload, UPLOAD_JSON_LIMIT };
