"use strict";

const crypto = require("crypto");

/**
 * Auth for human approval of reporter news.
 *
 * REPORTER_NEWS_APPROVER_KEY is held by the human approval path only — never
 * by FarmClaw, ShareBot67 or any agent that prepares drafts — so an agent can
 * log and advance its own work but cannot authorize its own publication.
 *
 * Unlike the ledger key it has no fallback: when it is unset approval is
 * disabled (503), and a key equal to the ledger or admin key is refused as a
 * misconfiguration, because it would hand approval back to every holder of
 * that shared secret. Only the dedicated `x-approver-key` header is read.
 */

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function approverKeyProblem({ approverKey, ledgerKey, adminKey } = {}) {
  if (typeof approverKey !== "string" || !approverKey.length) {
    return "Reporter news approval is disabled. Set REPORTER_NEWS_APPROVER_KEY on the server to enable it.";
  }
  if (safeEqual(approverKey, ledgerKey) || safeEqual(approverKey, adminKey)) {
    return "Reporter news approval is disabled: REPORTER_NEWS_APPROVER_KEY must differ from BROADCAST_LEDGER_API_KEY and ADMIN_API_KEY.";
  }
  return null;
}

/** True when the request carries a valid approver key on a usable configuration. */
function isApproverRequest(req, keys = {}) {
  if (approverKeyProblem(keys)) return false;
  return safeEqual(req.get("x-approver-key") || "", keys.approverKey);
}

function createRequireApproverKey(keys = {}) {
  const problem = approverKeyProblem(keys);
  return function requireApproverKey(req, res, next) {
    if (problem) {
      res.status(503).json({ error: problem });
      return;
    }
    if (!isApproverRequest(req, keys)) {
      res.status(401).json({ error: "Unauthorized: a valid x-approver-key header is required." });
      return;
    }
    next();
  };
}

module.exports = { createRequireApproverKey, isApproverRequest };
