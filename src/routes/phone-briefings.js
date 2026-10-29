"use strict";

const express = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { CATEGORIES, normalizeCategory } = require("../services/phone-briefings");

/**
 * Phone briefings — what the iOS Shortcut generated with ChatGPT, kept for
 * reading on a computer.
 *
 *   POST /:category   one briefing (ledger key). Body: JSON { text, title? },
 *                     a form with a `text` field, or the raw text itself as
 *                     text/plain.
 *   POST /            several at once (ledger key). JSON keyed by category:
 *                     { geopolitics, economics, stocks, crypto }.
 *   GET  /            every desk with its newest briefing.
 *   GET  /:category   one desk's runs, newest first (no text).
 *   GET  /:category/:id
 *                     one run with its text.
 *
 * Writes take the broadcast ledger's machine key: the Shortcut on the phone
 * already carries it, and it can only write receipts and these briefings,
 * never spend credits or post to Telegram. Reads sit behind the site login.
 */
function createPhoneBriefingsRouter({ briefingStore, requireLedgerKey, rateLimitPerMinute = 60 }) {
  const router = express.Router();
  const limiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });
  const plainText = express.text({ type: ["text/plain", "text/markdown"], limit: "1mb" });

  function receipt({ entry, created }) {
    return {
      ok: true,
      created,
      deduplicated: !created,
      id: entry.id,
      category: entry.category,
      receivedAt: entry.receivedAt,
      chars: entry.text.length,
    };
  }

  router.post("/", requireLedgerKey, limiter, (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const pushes = Object.keys(body)
        .map((name) => ({ name, category: normalizeCategory(name), text: body[name] }))
        .filter((push) => push.category && typeof push.text === "string" && push.text.trim());
      if (!pushes.length) {
        res.status(400).json({
          error: `Send at least one briefing keyed by category: ${CATEGORIES.map((c) => c.key).join(", ")}.`,
        });
        return;
      }
      const results = pushes.map((push) => receipt(briefingStore.receive(push.category, { text: push.text })));
      res.status(results.some((r) => r.created) ? 201 : 200).json({ ok: true, results });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:category", requireLedgerKey, limiter, plainText, (req, res, next) => {
    try {
      const body = req.body;
      const text = typeof body === "string" ? body : body && typeof body === "object" ? body.text : "";
      const title = body && typeof body === "object" ? body.title : undefined;
      const result = briefingStore.receive(req.params.category, { text, title });
      res.status(result.created ? 201 : 200).json(receipt(result));
    } catch (err) {
      next(err);
    }
  });

  router.get("/", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ categories: briefingStore.summary() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:category", (req, res, next) => {
    try {
      const runs = briefingStore.history(req.params.category);
      if (!runs) {
        res.status(404).json({ error: "Unknown category." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ category: normalizeCategory(req.params.category), runs });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:category/:id", (req, res, next) => {
    try {
      const entry = briefingStore.get(req.params.category, req.params.id);
      if (!entry) {
        res.status(404).json({ error: "Briefing not found." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(entry);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPhoneBriefingsRouter };
