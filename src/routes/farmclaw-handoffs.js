"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { isLedgerRequest } = require("../middleware/ledger-auth");

/**
 * FarmClaw handoff queue — see src/services/farmclaw-handoffs.js.
 *
 *   POST /                queue a post (dashboard owner / admin key).
 *   GET  /:id             one handoff, for the button to poll (either side).
 *   GET  /                list, optionally ?status= (either side).
 *   POST /claim           FarmClaw takes pending items (machine key).
 *   POST /:id/receipt     FarmClaw acknowledges with its own receipt id.
 *   POST /:id/fail        FarmClaw reports it could not take the item.
 *
 * The machine side reuses the broadcast ledger key that the OpenClaw agents
 * already carry, so no new secret is needed.
 */

function handoffResponse(store, result) {
  return {
    ok: true,
    id: result.record.id,
    status: result.record.status,
    created: result.created,
    requeued: result.requeued,
    record: result.record,
    agent: store.agentStatus(),
  };
}

function createFarmclawHandoffRouter({ handoffStore, requireAdmin, requireLedgerKey, ledgerKey, adminKey, rateLimitPerMinute = 60 }) {
  const router = Router();
  const limiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });

  // Reads serve both the dashboard (owner session or admin key) and FarmClaw
  // (machine key).
  function requireEither(req, res, next) {
    if (isLedgerRequest(req, { ledgerKey, adminKey })) {
      next();
      return;
    }
    requireAdmin(req, res, next);
  }

  function handle(fn) {
    return (req, res, next) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err.statusCode === 409) {
          res.status(409).json({ error: err.message, currentStatus: err.currentStatus });
          return;
        }
        next(err);
      }
    };
  }

  router.post("/", requireAdmin, limiter, handle((req, res) => {
    const body = req.body || {};
    const result = handoffStore.request({ url: body.url, handle: body.handle, text: body.text });
    res.status(result.created ? 201 : 200).json(handoffResponse(handoffStore, result));
  }));

  router.get("/", requireEither, handle((req, res) => {
    res.json({
      records: handoffStore.list({ status: req.query.status, limit: req.query.limit }),
      agent: handoffStore.agentStatus(),
    });
  }));

  router.post("/claim", requireLedgerKey, limiter, handle((req, res) => {
    const body = req.body || {};
    const records = handoffStore.claim({ agent: body.agent, limit: body.limit });
    res.json({ ok: true, records });
  }));

  router.get("/:id", requireEither, handle((req, res) => {
    const record = handoffStore.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    res.json({ ...record, agent: handoffStore.agentStatus() });
  }));

  router.post("/:id/receipt", requireLedgerKey, limiter, handle((req, res) => {
    const record = handoffStore.receipt(req.params.id, req.body || {});
    if (!record) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    res.json({ ok: true, id: record.id, status: record.status, record });
  }));

  router.post("/:id/fail", requireLedgerKey, limiter, handle((req, res) => {
    const record = handoffStore.fail(req.params.id, req.body || {});
    if (!record) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    res.json({ ok: true, id: record.id, status: record.status, record });
  }));

  return router;
}

module.exports = { createFarmclawHandoffRouter, handoffResponse };
