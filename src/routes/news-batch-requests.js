"use strict";
const express = require("express");

function createNewsBatchRequestsRouter({ service, requireOwner }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(requireOwner);
  router.use(express.json({ limit: "8kb" }));
  const handle = fn => async (req, res, next) => {
    try { await fn(req, res); } catch (err) {
      if (err.expose) res.status(err.statusCode || 500).json({ error: err.message });
      else next(err);
    }
  };
  router.get("/", handle(async (_req, res) => {
    res.json({ configured: service.configured(), requests: service.store.list().slice(0, 30).map(row => service.public(row)) });
  }));
  router.post("/", handle(async (req, res) => {
    const result = service.store.create(req.body, req.get("Idempotency-Key"), req.siteSession?.role === "owner" ? "owner" : "admin");
    const row = await service.sync(result.request.id);
    res.status(result.created ? 201 : 200).json({ request: service.public(row), deduplicated: !result.created });
  }));
  router.post("/:id/check", handle(async (req, res) => {
    if (!service.store.get(req.params.id)) return res.status(404).json({ error: "News request not found." });
    const row = await service.sync(req.params.id);
    return res.json({ request: service.public(row) });
  }));
  return router;
}
module.exports = { createNewsBatchRequestsRouter };
