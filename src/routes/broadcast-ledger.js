"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { isLedgerRequest, isLedgerParamRequest } = require("../middleware/ledger-auth");
const { SOURCES, KINDS, STATUSES, canonicalizeUrl } = require("../services/broadcast-ledger");

const MAX_IDS = 200;

function badRequest(res, message) {
  res.status(400).json({ error: message });
}

/**
 * Reject obviously malformed payloads before they reach the store. The store
 * clamps and normalizes everything it keeps, so this layer only has to catch
 * the shapes that would be meaningless rather than merely untidy.
 */
function validateReceiptPayload(body) {
  if (!body || typeof body !== "object") return "A JSON object body is required.";
  if (body.source && !SOURCES.includes(body.source)) {
    return `source must be one of: ${SOURCES.join(", ")}`;
  }
  if (body.kind && !KINDS.includes(body.kind)) {
    return `kind must be one of: ${KINDS.join(", ")}`;
  }
  if (body.status && !STATUSES.includes(body.status)) {
    return `status must be one of: ${STATUSES.join(", ")}`;
  }
  if (body.destinations && !Array.isArray(body.destinations)) {
    return "destinations must be an array.";
  }
  // A URL that doesn't parse is a caller mistake worth surfacing: stored as-is
  // it yields no canonical URL and no hash, so the receipt would be invisible
  // to every dedupe tier — exactly the silent gap this ledger exists to close.
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (rawUrl && !canonicalizeUrl(rawUrl)) {
    return "url must be a valid http(s) URL.";
  }

  // Identity means something a later lookup can actually match on.
  const hasIdentity =
    [body.title, body.headline, body.text, body.content, body.contentHash].some(
      (value) => typeof value === "string" && value.trim(),
    ) || Boolean(canonicalizeUrl(rawUrl));
  if (!hasIdentity) {
    return "A receipt needs at least one of: title, url, text, or contentHash.";
  }
  return null;
}

/**
 * Escape for HTML text/attribute context in the manual form. The form echoes
 * back what was just submitted, so this is the boundary that keeps a pasted
 * headline from becoming markup.
 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Mobile-first manual entry form. Deliberately a server-rendered page with
 * no build step and no framework — it has to work from a phone, one-handed,
 * at the moment the gateway is down and the story has just gone out by hand.
 */
function renderManualForm({ notice = "", error = "", values = {}, recent = [], formKey = "" } = {}) {
  const rows = recent
    .map((receipt) => {
      const when = receipt.createdAt ? new Date(receipt.createdAt).toISOString().replace("T", " ").slice(0, 16) : "";
      return `<li>
        <span class="status status-${escapeHtml(receipt.status)}">${escapeHtml(receipt.status)}</span>
        <strong>${escapeHtml(receipt.title || receipt.canonicalUrl || receipt.id)}</strong>
        <span class="meta">${escapeHtml(receipt.source)} · ${escapeHtml(when)}</span>
      </li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Record Broadcast</title>
<style>
  :root { color-scheme: dark; --bg:#0b0e13; --panel:#141920; --line:#232b36; --text:#e6edf5; --muted:#8b98a8; --accent:#3b82f6; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--text); font:16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width:560px; margin:0 auto; }
  h1 { font-size:19px; margin:4px 0 4px; }
  p.sub { color:var(--muted); font-size:13px; margin:0 0 18px; }
  form { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  label { display:block; margin:0 0 14px; font-size:13px; color:var(--muted); }
  input, select, textarea { width:100%; margin-top:6px; padding:12px; font-size:16px; color:var(--text);
    background:#0e131a; border:1px solid var(--line); border-radius:8px; font-family:inherit; }
  textarea { min-height:96px; resize:vertical; }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
  button { width:100%; padding:14px; font-size:16px; font-weight:600; color:#fff; background:var(--accent);
    border:0; border-radius:8px; margin-top:4px; }
  button:active { opacity:.85; }
  .msg { padding:12px; border-radius:8px; margin-bottom:14px; font-size:14px; }
  .msg.ok { background:rgba(34,197,94,.12); border:1px solid var(--green); color:var(--green); }
  .msg.err { background:rgba(239,68,68,.12); border:1px solid var(--red); color:var(--red); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:26px 0 8px; }
  ul { list-style:none; margin:0; padding:0; }
  li { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; font-size:14px; }
  li strong { display:block; font-weight:600; margin:3px 0; overflow-wrap:anywhere; }
  .meta { color:var(--muted); font-size:12px; }
  .status { font-size:11px; text-transform:uppercase; letter-spacing:.05em; font-weight:700; }
  .status-posted, .status-reconciled { color:var(--green); }
  .status-partial, .status-pending { color:var(--amber); }
  .status-failed { color:var(--red); }
  .empty { color:var(--muted); font-size:14px; }
</style>
</head>
<body>
<main>
  <h1>Record a broadcast</h1>
  <p class="sub">Log a story you posted by hand so ShareBot67 doesn't repeat it or report it as failed.</p>
  ${notice ? `<div class="msg ok">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/api/broadcast-ledger/manual">
    ${formKey ? `<input type="hidden" name="key" value="${escapeHtml(formKey)}">` : ""}
    <label>Headline
      <input name="title" autocapitalize="sentences" autocomplete="off" value="${escapeHtml(values.title)}" required>
    </label>
    <label>Source URL <span class="meta">(optional)</span>
      <input name="url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="https://" value="${escapeHtml(values.url)}">
    </label>
    <label>What you posted <span class="meta">(optional — hashed, never stored as text)</span>
      <textarea name="text" autocapitalize="sentences">${escapeHtml(values.text)}</textarea>
    </label>
    <label>Channels <span class="meta">(comma-separated)</span>
      <input name="channels" autocapitalize="off" autocorrect="off" value="${escapeHtml(values.channels || "telegram")}">
    </label>
    <label>Status
      <select name="status">
        <option value="posted"${values.status === "partial" || values.status === "failed" ? "" : " selected"}>Posted</option>
        <option value="partial"${values.status === "partial" ? " selected" : ""}>Partial — some channels only</option>
        <option value="failed"${values.status === "failed" ? " selected" : ""}>Failed</option>
      </select>
    </label>
    <button type="submit">Save receipt</button>
  </form>
  <h2>Last 10 receipts</h2>
  ${rows ? `<ul>${rows}</ul>` : '<p class="empty">Nothing recorded yet.</p>'}
</main>
</body>
</html>`;
}

function createBroadcastLedgerRouter({
  broadcastLedgerStore,
  requireLedgerKey,
  ledgerKey,
  adminKey,
  rateLimitPerMinute = 60,
}) {
  const router = Router();

  // The key guard already stops anonymous writes; the limiter is there so a
  // stuck shortcut or a retry loop can't spin the ledger's whole-file writes.
  const limiter = createRateLimit({ limit: rateLimitPerMinute, windowMs: 60 * 1000 });

  router.use(limiter);

  /**
   * The manual form is the one surface a human opens in a phone browser,
   * which cannot set a custom auth header. So it accepts, in order: a header
   * or Bearer key like every other route; a `key` query/body parameter (the
   * form carries it forward in a hidden field); or an authenticated owner
   * site session, which is the cleanest route when the dashboard login is on.
   *
   * A key in a URL is visible in browser history and access logs, so prefer
   * the owner session or a home-screen bookmark you keep private.
   */
  function requireManualAccess(req, res, next) {
    if (isLedgerRequest(req, { ledgerKey, adminKey })) return next();

    if (isLedgerParamRequest(req, { ledgerKey, adminKey })) return next();

    if (req.siteSession && req.siteSession.role === "owner") return next();

    const accepted = [ledgerKey, adminKey].filter((key) => typeof key === "string" && key.length > 0);
    if (!accepted.length) {
      res.status(503).json({
        error:
          "Broadcast ledger endpoints are disabled. Set BROADCAST_LEDGER_API_KEY (or ADMIN_API_KEY) on the server to enable them.",
      });
      return;
    }
    res.status(401).json({ error: "Unauthorized: sign in as owner or supply a valid broadcast key." });
  }

  // Lightweight probe for the Settings page. Shares the manual form's access
  // rules on purpose: whatever credential opens the form is exactly what the
  // Settings card needs to confirm before it offers a link to it. The 401 and
  // 503 responses are as informative as the 200 — they tell the card whether
  // to ask for a key or say the ledger isn't configured at all.
  router.get("/status", requireManualAccess, (req, res, next) => {
    try {
      const [latest] = broadcastLedgerStore.list({ limit: 1 });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        configured: true,
        count: broadcastLedgerStore.count(),
        latest: latest
          ? {
              id: latest.id,
              title: latest.title,
              source: latest.source,
              status: latest.status,
              createdAt: latest.createdAt,
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/manual", requireManualAccess, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // noindex is already in the markup; no-store keeps the recent-receipt
    // list (and any key in the URL) out of the browser cache.
    res.send(
      renderManualForm({
        notice: req.query.saved ? "Receipt saved." : "",
        recent: broadcastLedgerStore.list({ limit: 10 }),
        formKey: String(req.query.key || ""),
      }),
    );
  });

  // Accepts both a browser form post and a JSON body, so the same endpoint
  // serves the mobile form and a shortcut that would rather not build the
  // full /receipts payload.
  router.post("/manual", requireManualAccess, (req, res, next) => {
    try {
      const body = req.body || {};
      const wantsJson = String(req.get("content-type") || "").includes("application/json");
      const channels = String(body.channels || "telegram")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 20);
      const status = STATUSES.includes(body.status) ? body.status : "posted";

      const invalid = validateReceiptPayload({ ...body, source: "manual" });
      if (invalid) {
        if (wantsJson) return badRequest(res, invalid);
        res.status(400).setHeader("Cache-Control", "no-store");
        return res.send(
          renderManualForm({
            error: invalid,
            values: body,
            recent: broadcastLedgerStore.list({ limit: 10 }),
            formKey: String(body.key || ""),
          }),
        );
      }

      // `key` is an auth parameter, never receipt content.
      const { key, ...fields } = body;
      const { receipt, created } = broadcastLedgerStore.createReceipt({
        ...fields,
        source: "manual",
        kind: body.kind || "story",
        status,
        destinations: channels.map((channel) => ({
          channel,
          status: status === "failed" ? "failed" : "posted",
        })),
      });

      if (wantsJson) return res.status(created ? 201 : 200).json({ receipt, created });
      const keyParam = key ? `&key=${encodeURIComponent(key)}` : "";
      res.redirect(303, `/api/broadcast-ledger/manual?saved=1${keyParam}`);
    } catch (err) {
      next(err);
    }
  });

  // Every remaining endpoint is machine-facing and key-only.
  router.use(requireLedgerKey);

  // Create or upsert a receipt. Idempotent on idempotencyKey — the property
  // that lets a phone on a bad connection retry safely.
  router.post("/receipts", (req, res, next) => {
    try {
      const invalid = validateReceiptPayload(req.body);
      if (invalid) return badRequest(res, invalid);
      const { receipt, created } = broadcastLedgerStore.createReceipt(req.body);
      res.status(created ? 201 : 200).json({ receipt, created });
    } catch (err) {
      next(err);
    }
  });

  // Record destination results / final status against an existing receipt.
  router.patch("/receipts/:id", (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== "object") return badRequest(res, "A JSON object body is required.");
      if (req.body.status && !STATUSES.includes(req.body.status)) {
        return badRequest(res, `status must be one of: ${STATUSES.join(", ")}`);
      }
      if (req.body.destinations && !Array.isArray(req.body.destinations)) {
        return badRequest(res, "destinations must be an array.");
      }
      const actor = SOURCES.includes(req.body.source) ? req.body.source : "unknown";
      const receipt = broadcastLedgerStore.updateReceipt(req.params.id, req.body, { actor });
      if (!receipt) return res.status(404).json({ error: "Receipt not found." });
      res.json({ receipt });
    } catch (err) {
      next(err);
    }
  });

  router.get("/receipts/:id", (req, res, next) => {
    try {
      const receipt = broadcastLedgerStore.getReceipt(req.params.id);
      if (!receipt) return res.status(404).json({ error: "Receipt not found." });
      res.json({ receipt });
    } catch (err) {
      next(err);
    }
  });

  router.get("/receipts", (req, res, next) => {
    try {
      res.json({
        receipts: broadcastLedgerStore.list({
          limit: req.query.limit,
          status: req.query.status,
          source: req.query.source,
          since: req.query.since,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // Preflight. GET and POST both work: Shortcuts builds a query string more
  // easily, agents send a body with the full text.
  function handleLookup(req, res, next) {
    try {
      const input = req.method === "GET" ? req.query : req.body || {};
      const result = broadcastLedgerStore.lookup({
        url: input.url,
        headline: input.headline || input.title,
        text: input.text || input.content,
        hash: input.hash || input.contentHash,
        windowMs: input.windowMs,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  router.get("/lookup", handleLookup);
  router.post("/lookup", handleLookup);

  // Recovery: resolve unfinished work against what other paths already sent.
  router.post("/reconcile", (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, MAX_IDS).map(String) : null;
      res.json(broadcastLedgerStore.reconcile({ ids, windowMs: req.body?.windowMs }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createBroadcastLedgerRouter, renderManualForm, validateReceiptPayload };
