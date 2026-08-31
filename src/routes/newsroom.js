"use strict";

/**
 * Newsroom operations API.
 *
 * Reads are safe: they expose cycle status, counts, identifiers and the
 * provider's own error text — never a credential, a prompt body or a token.
 * Writes (running a cycle, retrying a delivery) are admin-guarded because they
 * spend provider credits and push messages to real channels.
 */

const { Router } = require("express");

function createNewsroomRouter({ newsroomService, cycleStore, broadcastLedgerStore, requireAdmin }) {
  const router = Router();

  function resolveTtlMs(req) {
    const hours = Math.min(Math.max(parseInt(req.query.ttlHours, 10) || 24, 1), 168);
    return hours * 60 * 60 * 1000;
  }

  // Read-only operational status for the ShareBot status panel and for a
  // human asking "did the newsroom run?".
  router.get("/health", (req, res, next) => {
    try {
      res.json(newsroomService.health());
    } catch (err) {
      next(err);
    }
  });

  // Configuration check only — no generation, no delivery, nothing sent.
  router.get("/preflight", requireAdmin, async (req, res, next) => {
    try {
      res.json(await newsroomService.preflight());
    } catch (err) {
      next(err);
    }
  });

  router.get("/cycles", (req, res, next) => {
    try {
      res.json({
        cycles: cycleStore.list({
          limit: req.query.limit,
          status: req.query.status ? String(req.query.status) : undefined,
          trigger: req.query.trigger ? String(req.query.trigger) : undefined,
          since: req.query.since ? String(req.query.since) : undefined,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // One cycle with everything it links to: the sections it generated (with the
  // stored report text and whatever source evidence the generation returned)
  // and the receipts its delivery wrote.
  router.get("/cycles/:id", (req, res, next) => {
    try {
      const cycle = cycleStore.getCycle(req.params.id);
      if (!cycle) {
        res.status(404).json({ error: "Cycle not found" });
        return;
      }
      // Resolved through each section's own generation reference rather than
      // by listing generations logged under this cycle's id. A same-day reused
      // section writes no new log entry, so a by-cycle query silently misses
      // it; the reference finds it under the cycle that first wrote it and
      // reports that link. Prompt bodies stay out: a prompt is
      // operator-authored and may carry things that do not belong in an
      // operational read.
      const generations = newsroomService.resolveCycleGenerations(cycle);
      const receipts = broadcastLedgerStore
        ? broadcastLedgerStore.list({ cycleId: cycle.id, limit: 50 }).map((receipt) => ({
            id: receipt.id,
            newsType: receipt.newsType,
            status: receipt.status,
            createdAt: receipt.createdAt,
            updatedAt: receipt.updatedAt,
            destinations: receipt.destinations,
            attempts: receipt.attempts,
          }))
        : [];
      res.json({ cycle, generations, receipts });
    } catch (err) {
      next(err);
    }
  });

  // Start or resume the cycle for a scheduled slot. Safe to call twice: the
  // slot's deterministic key means the second call joins the first cycle
  // instead of forking a parallel run.
  router.post("/cycles/run", requireAdmin, async (req, res, next) => {
    try {
      const result = await newsroomService.runCycle({
        scheduledAt: req.body?.scheduledAt,
        trigger: req.body?.trigger || "api",
        cycleKey: req.body?.cycleKey,
        deliver: req.body?.deliver !== false,
        ttlMs: resolveTtlMs(req),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Retry delivery for a cycle whose report already exists. Never regenerates.
  router.post("/cycles/:id/deliver", requireAdmin, async (req, res, next) => {
    try {
      const result = await newsroomService.deliverCycle(req.params.id);
      if (!result) {
        res.status(404).json({ error: "Cycle not found" });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createNewsroomRouter };
