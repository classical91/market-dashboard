"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");

/**
 * Reporter news log — the canonical, deduplicated record of every news
 * candidate ShareBot/FarmClaw verifies, and of what later happened to it.
 *
 *   POST  /intake      log a discovered/verified item (ledger key). Returns a
 *                      durable receipt: { id, created, deduplicated, record }.
 *   PATCH /:id         advance workflow / link FarmBot receipts (ledger key).
 *   GET   /daily       one reporter day with counts and filters.
 *   GET   /days        recent days with totals.
 *   GET   /lookup      find by url or source+sourceId, never creates.
 *   GET   /:id         one record with its history.
 *
 * Writes reuse the broadcast ledger's machine key: ShareBot already holds it
 * and it can only write receipts, not spend credits or broadcast.
 *
 * History attribution: the key is shared, so the only identity the server can
 * vouch for is "a holder of the shared key" (TRUSTED_ACTOR). A caller's own
 * `actor` / `capturedBy` is stored separately as `claimedBy`, never as the
 * trusted actor.
 */
const TRUSTED_ACTOR = "shared-key";

function createReporterNewsLogRouter({ newsLogStore, requireLedgerKey, rateLimitPerMinute = 60 }) {
  const router = Router();
  const limiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });

  function receipt(result) {
    return {
      ok: true,
      id: result.record.id,
      created: result.created,
      deduplicated: result.deduplicated,
      status: result.record.status,
      reporterDate: result.record.reporterDate,
      record: result.record,
    };
  }

  router.post("/intake", requireLedgerKey, limiter, (req, res, next) => {
    try {
      const result = newsLogStore.intake(req.body || {}, { actor: TRUSTED_ACTOR });
      res.status(result.created ? 201 : 200).json(receipt(result));
    } catch (err) {
      next(err);
    }
  });

  router.get("/daily", (req, res, next) => {
    try {
      res.json(newsLogStore.daily({
        date: req.query.date,
        market: req.query.market,
        source: req.query.source,
        symbol: req.query.symbol,
        status: req.query.status,
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/days", (req, res, next) => {
    try {
      res.json({ timeZone: newsLogStore.timeZone, days: newsLogStore.days({ limit: req.query.limit }) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/lookup", (req, res, next) => {
    try {
      const record = newsLogStore.find({ url: req.query.url, source: req.query.source, sourceId: req.query.sourceId });
      res.json({ found: Boolean(record), record });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", (req, res, next) => {
    try {
      const record = newsLogStore.get(req.params.id);
      if (!record) {
        res.status(404).json({ error: "Record not found" });
        return;
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireLedgerKey, limiter, (req, res, next) => {
    try {
      const body = req.body || {};
      const record = newsLogStore.update(req.params.id, body, {
        actor: TRUSTED_ACTOR,
        claimedBy: typeof body.actor === "string" ? body.actor : null,
      });
      if (!record) {
        res.status(404).json({ error: "Record not found" });
        return;
      }
      res.json({ ok: true, id: record.id, status: record.status, record });
    } catch (err) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: err.message, currentStatus: err.currentStatus });
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createReporterNewsLogRouter };
