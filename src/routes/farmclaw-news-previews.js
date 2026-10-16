"use strict";
const express = require("express");

// A read-only bridge to the one authoritative store. It never receives an
// approver, preparer, reporter, ledger or queue credential from the browser.
function createFarmclawNewsPreviewsRouter({ env = process.env, fetcher = fetch } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("cache-control", "no-store"); next(); });
  router.get("/", async (_req, res) => {
    const base = env.FARMBOT_NEWS_API_URL;
    const token = env.FARMBOT_NEWS_READER_TOKEN;
    const approval = env.FARMBOT_NEWS_APPROVAL_BASE_URL;
    if (!base || !token || token.length < 32 || !approval) return res.status(503).json({ error: "FarmClaw preview view is not configured" });
    try {
      const api = new URL(base), web = new URL(approval);
      if (api.protocol !== "https:" || web.protocol !== "https:" || api.username || api.password || web.username || web.password) throw new Error();
      const response = await fetcher(`${api.origin}/news/v1/batches`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return res.status(503).json({ error: "Authoritative preview store unavailable" });
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.some(b => !/^fnb_[a-f0-9-]{36}$/.test(b.batchId) || b.persisted !== true || b.validated !== true || !/^sha256:[a-f0-9]{64}$/.test(b.payloadHash))) throw new Error();
      return res.json({ batches: rows.map(b => ({ batchId: b.batchId, clientBatchId: b.clientBatchId, revision: b.revision,
        payloadHash: b.payloadHash, status: b.status, expiresAt: b.expiresAt, approvalEligible: b.approvalEligible,
        approvalUrl: new URL(`/news-batches/${b.batchId}`, web.origin).toString() })) });
    } catch { return res.status(503).json({ error: "Could not verify saved previews; approval unavailable here" }); }
  });
  router.use((_req, res) => res.status(405).json({ error: "Read-only view. Review and approve in the authenticated FarmBot dashboard." }));
  return router;
}
module.exports = { createFarmclawNewsPreviewsRouter };
