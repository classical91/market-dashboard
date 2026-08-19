"use strict";

const crypto = require("crypto");

/**
 * Auth for the broadcast ledger's machine callers.
 *
 * Deliberately a *separate* secret from ADMIN_API_KEY. The iOS Shortcut and
 * ShareBot67 both have to carry this key in places that are easy to leak (a
 * phone, an agent config), and a key that can only write broadcast receipts
 * is a far smaller blast radius than one that can also spend OpenAI credits
 * and fire Telegram broadcasts. When BROADCAST_LEDGER_API_KEY is unset it
 * falls back to ADMIN_API_KEY so the feature still works on a deploy that
 * hasn't added the new variable yet.
 */

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function presentedKeys(req) {
  return [
    req.get("x-broadcast-key") || "",
    req.get("x-admin-key") || "",
    // Authorization: Bearer <key>. iOS Shortcuts sets this more naturally
    // than a custom header when the request is built from a template.
    (String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i) || [])[1] || "",
  ].filter(Boolean);
}

/**
 * True when the request carries a secret that authorizes ledger access.
 * Exported separately from the guard because site-auth needs to ask the
 * same question without terminating the request.
 */
function isLedgerRequest(req, { ledgerKey, adminKey } = {}) {
  const accepted = [ledgerKey, adminKey].filter((key) => typeof key === "string" && key.length > 0);
  if (!accepted.length) return false;
  const provided = presentedKeys(req);
  if (!provided.length) return false;
  return provided.some((candidate) => accepted.some((key) => safeEqual(candidate, key)));
}

/**
 * True when the request carries the key as a `key` query or body parameter.
 *
 * Kept deliberately separate from isLedgerRequest, and honored only on the
 * manual form path: a phone browser cannot set a custom header, but a key in
 * a URL lands in browser history and access logs, so the machine endpoints
 * must never accept one this way.
 */
function isLedgerParamRequest(req, { ledgerKey, adminKey } = {}) {
  const accepted = [ledgerKey, adminKey].filter((key) => typeof key === "string" && key.length > 0);
  if (!accepted.length) return false;
  const provided = String((req.query && req.query.key) || (req.body && req.body.key) || "");
  if (!provided) return false;
  return accepted.some((key) => safeEqual(provided, key));
}

function createRequireLedgerKey({ ledgerKey, adminKey } = {}) {
  const configured = Boolean(
    (typeof ledgerKey === "string" && ledgerKey.length) || (typeof adminKey === "string" && adminKey.length),
  );

  return function requireLedgerKey(req, res, next) {
    if (!configured) {
      // Same posture as the admin guard: an unconfigured deploy disables the
      // endpoints rather than leaving a writable ledger open to the world.
      res.status(503).json({
        error:
          "Broadcast ledger endpoints are disabled. Set BROADCAST_LEDGER_API_KEY (or ADMIN_API_KEY) on the server to enable them.",
      });
      return;
    }
    if (!isLedgerRequest(req, { ledgerKey, adminKey })) {
      res.status(401).json({ error: "Unauthorized: a valid x-broadcast-key header is required." });
      return;
    }
    next();
  };
}

module.exports = { createRequireLedgerKey, isLedgerRequest, isLedgerParamRequest };
