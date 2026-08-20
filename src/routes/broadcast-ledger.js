"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { isLedgerRequest, isLedgerParamRequest } = require("../middleware/ledger-auth");
const { deriveTitle, firstUrl } = require("../services/broadcast-ingest");
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
const SOURCE_LABELS = {
  shortcut: "Shortcut",
  sharebot67: "ShareBot67",
  dashboard: "Dashboard",
  manual: "Manual",
};

// What a receipt's status means for the only question this page exists to
// answer: did the story actually go out?
const STATUS_LABELS = {
  posted: "Sent",
  partial: "Sent (some channels)",
  reconciled: "Sent (by another path)",
  pending: "Not sent yet",
  failed: "Failed",
};

function renderManualForm({
  notice = "",
  error = "",
  recent = [],
  watching = false,
  diagnostics = null,
  total = 0,
  bySource = {},
} = {}) {
  const hiddenCount = bySource["telegram-ingest"] || 0;
  const visibleTotal = Math.max(0, total - hiddenCount);
  const rows = recent
    .filter((receipt) => receipt.source !== "telegram-ingest")
    .map((receipt) => {
      const when = receipt.createdAt ? new Date(receipt.createdAt).toISOString().replace("T", " ").slice(0, 16) : "";
      const source = SOURCE_LABELS[receipt.source] || "";
      const statusLabel = STATUS_LABELS[receipt.status] || receipt.status;
      const meta = [source, when].filter(Boolean).join(" · ");
      return `<li>
        <span class="status status-${escapeHtml(receipt.status)}">${escapeHtml(statusLabel)}</span>
        <strong>${escapeHtml(receipt.title || receipt.canonicalUrl || receipt.id)}</strong>
        <span class="meta">${escapeHtml(meta)}</span>
      </li>`;
    })
    .join("");

  const breakdown = Object.keys(SOURCE_LABELS)
    .filter((key) => bySource[key])
    .map((key) => `${bySource[key]} ${SOURCE_LABELS[key]}`)
    .join(" · ");

  // The page led with a form, so an empty ledger looked identical to a broken
  // one. State first: whether anything is watching, and how much it has seen.
  // A watch that is on but recording nothing has several possible causes and
  // they are indistinguishable from the ledger alone. Say which one it is.
  const d = diagnostics || {};
  const diagLines = [];
  if (watching) {
    if (d.conflict) {
      diagLines.push(
        `<strong class="bad">Telegram is refusing the poll (409 Conflict).</strong> Another process is reading this bot's
         updates \u2014 most likely ShareBot67 on the same bot token, or a webhook. Give the dashboard its own bot.`,
      );
    }
    if (d.lastError && !d.conflict) {
      diagLines.push(`<strong class="bad">Last poll failed:</strong> ${escapeHtml(d.lastError)}`);
    }
    if (Array.isArray(d.watchedChatIds) && d.watchedChatIds.length) {
      diagLines.push(`Watching chat ${d.watchedChatIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}`);
    } else {
      diagLines.push(
        `<strong class="bad">No chats configured.</strong> <code>TELEGRAM_CHAT_IDS</code> is empty, so there is nothing to watch.`,
      );
    }
    if (Array.isArray(d.unwatchedChatIdsSeen) && d.unwatchedChatIdsSeen.length) {
      diagLines.push(
        `<strong class="bad">Posts are arriving from a chat you are not watching:</strong>
         ${d.unwatchedChatIdsSeen.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}.
         Add it to <code>TELEGRAM_CHAT_IDS</code>.`,
      );
    }
    if (d.lastPollAt) {
      const seen = d.lastSummary ? d.lastSummary.polled : 0;
      diagLines.push(
        `Last checked ${escapeHtml(new Date(d.lastPollAt).toISOString().replace("T", " ").slice(0, 16))} \u2014
         ${seen} update${seen === 1 ? "" : "s"} from Telegram`,
      );
    } else {
      diagLines.push("Has not completed a poll yet.");
    }
    if (!total && d.lastPollAt && d.lastSummary && !d.lastSummary.polled && !d.conflict) {
      diagLines.push(
        `<strong>If you sent it through this bot, the watch cannot see it.</strong> Telegram does not return a
         bot's own outgoing messages, so a Shortcut or agent posting with this bot token is invisible here.
         Send via <code>POST /api/broadcast-ledger/broadcast</code> instead and the receipt is written from the
         send itself.`,
      );
      diagLines.push(
        `Otherwise: the watch only sees posts made <em>after</em> it started
         (${escapeHtml(String(d.startedAt || "this deploy"))}), and in a group the bot must be an admin to read
         other senders' messages \u2014 in a channel it already is.`,
      );
    }
  }
  const diagBlock = diagLines.length
    ? `<details class="diag"><summary>Why is nothing appearing?</summary><ul>${diagLines
        .map((line) => `<li>${line}</li>`)
        .join("")}</ul></details>`
    : "";

  const watchBanner = watching
    ? `<div class="watch on"><strong>\u25cf Watching your Telegram channels</strong>
         <span>Posts from other senders are recorded automatically. Telegram never reports this bot's own
         messages back, so anything sent through this bot must broadcast via
         <code>POST /api/broadcast-ledger/broadcast</code> to be recorded.</span></div>`
    : `<div class="watch off"><strong>\u25cb Channel watch is off</strong>
         <span>Broadcasts are only recorded when a path reports itself, or when you file one below.
         Set <code>BROADCAST_LEDGER_INGEST_ENABLED=true</code> in Railway to record posts automatically.</span></div>`;

  const tally = visibleTotal
    ? `<p class="tally"><strong>${visibleTotal}</strong> broadcast${visibleTotal === 1 ? "" : "s"} recorded${
        breakdown ? ` \u2014 ${escapeHtml(breakdown)}` : ""
      }</p>`
    : `<p class="tally empty">No broadcasts recorded yet.${
        watching
          ? " The watch is running, so the next post to your channels will appear here on its own."
          : " Nothing is watching your channels, so nothing will appear here until a path reports itself or you file one below."
      }</p>`;

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

  /* ── State first: what has actually been recorded ── */
  .watch { border-radius:12px; padding:12px 14px; margin-bottom:12px; font-size:13px; line-height:1.5;
    border:1px solid var(--line); background:var(--panel); }
  .watch strong { display:block; font-size:13px; margin-bottom:3px; }
  .watch span { color:var(--muted); }
  .watch.on { border-color:rgba(34,197,94,.45); background:rgba(34,197,94,.08); }
  .watch.on strong { color:var(--green); }
  .watch.off { border-color:rgba(245,158,11,.45); background:rgba(245,158,11,.08); }
  .watch.off strong { color:var(--amber); }
  .watch code { background:rgba(255,255,255,.08); padding:1px 5px; border-radius:5px; font-size:12px; }
  .tally { font-size:14px; margin:0 0 18px; }
  .tally strong { font-size:17px; }
  .tally.empty { color:var(--muted); font-size:13px; line-height:1.5; }
  .diag { margin:-8px 0 18px; font-size:13px; }
  .diag summary { cursor:pointer; color:var(--accent); padding:6px 0; }
  .diag ul { margin:8px 0 0; padding:0; }
  .diag li { background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:9px 12px; margin-bottom:7px; color:var(--muted); line-height:1.5; overflow-wrap:anywhere; }
  .diag strong { color:var(--text); }
  .diag strong.bad { color:var(--red); }
  .diag code { background:rgba(255,255,255,.08); padding:1px 5px; border-radius:5px; font-size:12px; color:var(--text); }
</style>
</head>
<body>
<main>
  <h1>Broadcast receipts</h1>
  <p class="sub">The shared record that stops ShareBot67 repeating a story or reporting one as failed.</p>
  ${notice ? `<div class="msg ok">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ""}
  ${watchBanner}
  ${tally}
  ${diagBlock}
  ${rows ? `<h2>Last 10 broadcasts</h2><ul>${rows}</ul>` : ""}
</main>
</body>
</html>`;
}

function createBroadcastLedgerRouter({
  broadcastLedgerStore,
  broadcastIngestService,
  telegramService,
  requireAdmin,
  requireLedgerKey,
  ledgerKey,
  adminKey,
  rateLimitPerMinute = 60,
}) {
  const router = Router();
  const requireWatchlistAdmin = requireAdmin || requireLedgerKey;

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
  // Every render of the manual page needs the same state block, so build it
  // once rather than letting the GET and the POST error path drift apart.
  function pageState() {
    return {
      recent: broadcastLedgerStore.list({ limit: 10 }),
      total: broadcastLedgerStore.count(),
      bySource: broadcastLedgerStore.sourceBreakdown().bySource,
      watching: Boolean(broadcastIngestService && broadcastIngestService.enabled),
      diagnostics: broadcastIngestService ? broadcastIngestService.describe() : null,
    };
  }

  router.get("/status", requireManualAccess, (req, res, next) => {
    try {
      const [latest] = broadcastLedgerStore.list({ limit: 1 });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        configured: true,
        // Whether posts are being recorded on their own, which is what decides
        // if anything still has to be entered by hand.
        watching: Boolean(broadcastIngestService && broadcastIngestService.enabled),
        watch: broadcastIngestService ? broadcastIngestService.describe() : null,
        count: broadcastLedgerStore.count(),
        // Which path did what. "telegram-ingest" is the residual: posts the
        // watch recorded that no path claimed.
        bySource: broadcastLedgerStore.sourceBreakdown().bySource,
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

  // Changing what is observed must never change where broadcasts are sent.
  // Admin auth is deliberately stronger than the receipt-only ledger key.
  router.put("/watchlist", requireWatchlistAdmin, (req, res, next) => {
    try {
      if (!broadcastIngestService) return res.status(503).json({ error: "Telegram ingest is unavailable." });
      res.json({ watch: broadcastIngestService.setWatchTargets(req.body && req.body.targets) });
    } catch (err) {
      if (err.statusCode === 400) return badRequest(res, err.message);
      next(err);
    }
  });

  router.get("/manual", requireManualAccess, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // noindex is already in the markup; no-store keeps the recent-receipt
    // list (and any key in the URL) out of the browser cache.
    res.send(
      renderManualForm({
        ...pageState(),
        notice: req.query.saved ? "Receipt saved." : "",
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
            ...pageState(),
            error: invalid,
            values: body,
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

  /**
   * Send a broadcast AND record it, in one call.
   *
   * The channel watch cannot cover this: Telegram never returns a bot's own
   * outgoing messages through getUpdates, so anything sent with this bot token
   * is invisible to the watcher no matter how well it is configured. A sender
   * using this bot must therefore record its own receipt, and doing it here —
   * from the real sendMessage response — is the only way the receipt can carry
   * true message ids rather than the caller's word.
   *
   * Point the iOS Shortcut at this instead of api.telegram.org: one call
   * replaces the direct send, the ledger is written from the actual result,
   * and the bot token stops living on the phone.
   */
  router.post("/broadcast", (req, res, next) => {
    (async () => {
      const body = req.body || {};
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return badRequest(res, "text is required — it is the message to broadcast.");
      if (body.source && !SOURCES.includes(body.source)) {
        return badRequest(res, `source must be one of: ${SOURCES.join(", ")}`);
      }
      const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
      if (rawUrl && !canonicalizeUrl(rawUrl)) return badRequest(res, "url must be a valid http(s) URL.");

      const source = SOURCES.includes(body.source) ? body.source : "shortcut";
      const title = typeof body.title === "string" && body.title.trim() ? body.title : deriveTitle(text);
      // The Shortcut sends one blob of text with the link inside it. Pulling
      // the link out is what gives the receipt a canonical URL, and the URL
      // tier is the only authoritative half of dedupe — without it a resend
      // check would fall back to hashing the exact wording.
      const url = rawUrl || firstUrl(text);

      // Refuse to broadcast a story the ledger already shows as sent. This is
      // the dedupe actually doing its job at the moment it matters, rather
      // than after the fact. `force: true` overrides for a deliberate resend.
      if (body.force !== true) {
        const existing = broadcastLedgerStore.lookup({ url, text, headline: title });
        if (existing.posted && existing.receipt) {
          return res.status(409).json({
            error: "Already broadcast — pass force:true to send it again.",
            alreadyBroadcast: true,
            match: existing.match,
            receipt: existing.receipt,
          });
        }
      }

      // Checked here rather than first: a malformed payload and an
      // already-broadcast story are both true answers regardless of whether
      // this deploy can send, and "already sent" is the more useful reply.
      if (!telegramService || !telegramService.configured) {
        return res
          .status(400)
          .json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)" });
      }

      // Pending first, so a crash mid-send leaves a trace to reconcile rather
      // than a silent gap.
      const { receipt } = broadcastLedgerStore.createReceipt({
        source,
        kind: SOURCES.includes(body.kind) ? body.kind : body.kind === "digest" ? "digest" : "story",
        title,
        url,
        text,
        status: "pending",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      });

      let result;
      try {
        result = await telegramService.postText(text, {
          parseMode: body.parseMode === "none" ? null : "HTML",
        });
      } catch (err) {
        const updated = broadcastLedgerStore.updateReceipt(
          receipt.id,
          { status: "failed", error: err, destinations: err.destinations || [], action: "broadcast" },
          { actor: source },
        );
        return res.status(err.statusCode || 502).json({
          error: err.message,
          receipt: updated || receipt,
        });
      }

      const final = broadcastLedgerStore.updateReceipt(
        receipt.id,
        { destinations: result.destinations, action: "broadcast" },
        { actor: source },
      );
      res.status(201).json({
        ok: true,
        sent: result.posted,
        failed: result.failed,
        receipt: final || receipt,
      });
    })().catch(next);
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
