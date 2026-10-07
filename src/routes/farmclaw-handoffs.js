"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { isLedgerRequest } = require("../middleware/ledger-auth");
const { pushWithin } = require("../services/farmclaw-pusher");

/**
 * FarmClaw handoff queue — see src/services/farmclaw-handoffs.js.
 *
 *   POST /                queue a post (dashboard owner / admin key).
 *   GET  /:id             one handoff, for the button to poll (either side).
 *   GET  /lookup?url=     restore a button's status without requeueing it.
 *   GET  /                list, optionally ?status= (either side).
 *   POST /claim           FarmClaw takes pending items (machine key).
 *   POST /:id/receipt     FarmClaw acknowledges with its own receipt id.
 *   POST /:id/fail        FarmClaw reports it could not take the item.
 *
 * The machine side reuses the broadcast ledger key that the OpenClaw agents
 * already carry, so no new secret is needed.
 */

function handoffResponse(store, result, pusher = null) {
  return {
    ok: true,
    id: result.record.id,
    status: result.record.status,
    created: result.created,
    requeued: result.requeued,
    record: result.record,
    agent: store.agentStatus(),
    push: { enabled: Boolean(pusher?.enabled) },
  };
}

/**
 * Queue a post, then, when the OpenClaw hook is configured, send it to the
 * FarmClaw agent right away and answer with the outcome (✓ or the gateway's
 * error). Shared by POST /api/farmclaw/handoffs and its /api/x/farmclaw alias.
 */
async function requestAndPush(store, pusher, body) {
  const result = store.request({ url: body.url, handle: body.handle, text: body.text });
  if (pusher?.enabled && result.record.status === "pending") {
    await pushWithin(pusher, result.record.id);
    return { ...result, record: store.get(result.record.id) || result.record };
  }
  return result;
}

function createFarmclawHandoffRouter({ handoffStore, pusher = null, requireAdmin, requireLedgerKey, ledgerKey, adminKey, rateLimitPerMinute = 60 }) {
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
    return async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err.statusCode === 409) {
          res.status(409).json({ error: err.message, currentStatus: err.currentStatus });
          return;
        }
        next(err);
      }
    };
  }

  router.post("/", requireAdmin, limiter, handle(async (req, res) => {
    const result = await requestAndPush(handoffStore, pusher, req.body || {});
    res.status(result.created ? 201 : 200).json(handoffResponse(handoffStore, result, pusher));
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

  // Unlike POST, a page reload must never retry a failed handoff or push it
  // again. Lookup uses the same canonical URL as request(), without writes.
  router.get("/lookup", requireEither, handle((req, res) => {
    const record = handoffStore.findByUrl(req.query.url);
    if (!record) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    res.json({ ...record, agent: handoffStore.agentStatus(), push: { enabled: Boolean(pusher?.enabled) } });
  }));

  router.get("/:id", requireEither, handle((req, res) => {
    const record = handoffStore.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    res.json({ ...record, agent: handoffStore.agentStatus(), push: { enabled: Boolean(pusher?.enabled) } });
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

module.exports = { createFarmclawHandoffRouter, handoffResponse, requestAndPush };
