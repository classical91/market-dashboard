"use strict";

const { Router } = require("express");
const { createRateLimit } = require("../middleware/rate-limit");
const { isLedgerRequest, isLedgerParamRequest } = require("../middleware/ledger-auth");
const { deriveTitle, firstUrl } = require("../services/broadcast-ingest");
const { SOURCES, KINDS, STATUSES, DEFAULT_SETTINGS, canonicalizeUrl, isPostedStatus } = require("../services/broadcast-ledger");

const MAX_IDS = 200;
const FINANCE_NEWS_TYPES = new Set(["Stock", "Crypto", "Economics"]);
const FINANCE_NEWS_DESTINATIONS = Object.freeze([
  Object.freeze({ chatId: "-1001841650798", threadId: "6297" }),
  Object.freeze({ chatId: "-1001941064823", threadId: "984" }),
]);
// Stop accidental double-taps/retries, not legitimate recurring coverage.
// A canonical URL may stay newsworthy for days, so an old receipt must not
// permanently ban that story from future daily broadcasts.
const BROADCAST_DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;

function duplicateWindowMs(value) {
  if (value === "off") return 0;
  if (value === "24h") return 24 * 60 * 60 * 1000;
  if (value === "same-day") return 24 * 60 * 60 * 1000;
  return BROADCAST_DUPLICATE_WINDOW_MS;
}

function badRequest(res, message) {
  res.status(400).json({ error: message });
}

function destinationsForNewsType(newsType, settings) {
  return settings?.financeTopicRoutingEnabled !== false && FINANCE_NEWS_TYPES.has(newsType)
    ? FINANCE_NEWS_DESTINATIONS.map((target) => ({ ...target }))
    : null;
}

/**
 * Reject obviously malformed payloads before they reach the store. The store
 * clamps and normalizes everything it keeps, so this layer only has to catch
 * the shapes that would be meaningless rather than merely untidy.
 */
function validateReceiptPayload(body, settings = null) {
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
  const suppliedCategory = String(body.newsType || body.category || "").trim();
  if (
    suppliedCategory &&
    settings?.requireExactCategory &&
    !settings.allowedCategories.includes(suppliedCategory)
  ) {
    return `newsType must be one of: ${settings.allowedCategories.join(", ")}`;
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
const STATUS_LABELS = {
  posted: "Broadcasted",
  partial: "Broadcasted (partial)",
  reconciled: "Broadcasted (reconciled)",
  pending: "Pending",
  failed: "Failed",
  blocked: "Blocked",
};

function newsTypeLabel(receipt) {
  return receipt.newsType || "Unclassified";
}

// Channel Watch is an audit fallback, not a reliable news classifier. Keep
// its raw receipts in storage for reconciliation, but never let ordinary
// watched-room comments with no exact category leak into the operator ledger.
function isVisibleReceipt(receipt) {
  return !(
    receipt?.source === "telegram-ingest"
    && newsTypeLabel(receipt) === "Unclassified"
  );
}

function visibleDailySummary(store, settings) {
  const base = store.dailySummary();
  const summary = { ...base, total: 0, byCategory: {}, byStatus: {} };
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  store.list({ limit: 500 }).filter(isVisibleReceipt).forEach((receipt) => {
    if (!receipt.createdAt || formatter.format(new Date(receipt.createdAt)) !== base.date) return;
    const category = newsTypeLabel(receipt);
    const status = isPostedStatus(receipt.status) ? "broadcasted" : receipt.status;
    summary.total += 1;
    summary.byCategory[category] = summary.byCategory[category] || {};
    summary.byCategory[category][status] = (summary.byCategory[category][status] || 0) + 1;
    summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
  });
  return summary;
}

const SOURCE_LABELS = {
  shortcut: "Shortcut",
  dashboard: "Market Dashboard",
  sharebot67: "News Reporter",
  manual: "Manual",
  "telegram-ingest": "Channel Watch",
};

function destinationName(destination, settings) {
  if (destination.label) return destination.label;
  const key = `${destination.channel}:${destination.chatId || ""}:${destination.threadId || ""}`;
  if (settings.destinationLabels?.[key]) return settings.destinationLabels[key];
  if (destination.threadId) return `Chat ${destination.chatId} · topic ${destination.threadId}`;
  if (destination.chatId) return `Chat ${destination.chatId}`;
  return destination.channel || "Unknown destination";
}

function selected(value, expected) {
  return String(value || "") === String(expected) ? " selected" : "";
}

function summaryText(summary) {
  if (!summary || !summary.total) return "No broadcast attempts today.";
  const parts = [];
  Object.entries(summary.byCategory || {}).forEach(([category, statuses]) => {
    Object.entries(statuses).forEach(([status, count]) => {
      parts.push(`${count} ${category} ${status}${status === "blocked" ? " attempt" + (count === 1 ? "" : "s") : ""}`);
    });
  });
  return parts.join(", ");
}

function renderManualForm({
  notice = "",
  error = "",
  recent = [],
  formKey = "",
  watching = false,
  total = 0,
  bySource = {},
  filters = {},
  settings = DEFAULT_SETTINGS,
  summary = null,
} = {}) {
  const visibleSources = new Set(settings.visibleSources || SOURCES);
  const visibleReceipts = recent.filter(isVisibleReceipt).filter((receipt) => visibleSources.has(receipt.source));
  const visibleTotal = visibleReceipts.length;
  const categoryOptions = ["", ...(settings.allowedCategories || []), "Unclassified"]
    .map((category) => `<option value="${escapeHtml(category)}"${selected(filters.newsType, category)}>${escapeHtml(category || "All categories")}</option>`)
    .join("");
  const rows = visibleReceipts
    .map((receipt) => {
      const when = receipt.createdAt
        ? new Date(receipt.createdAt).toLocaleString("en-CA", {
            timeZone: settings.timezone || "America/Vancouver",
            year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })
        : "";
      const newsType = newsTypeLabel(receipt);
      const dateLabel = receipt.createdAt
        ? new Date(receipt.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: settings.timezone || "America/Vancouver" })
        : "";
      const rawTitle = receipt.title || receipt.canonicalUrl || receipt.id;
      const title = /^Broadcasted today\b/i.test(rawTitle) ? `${newsType} News — ${dateLabel}` : rawTitle;
      const statusLabel = STATUS_LABELS[receipt.status] || receipt.status;
      const keyField = formKey ? `<input type="hidden" name="key" value="${escapeHtml(formKey)}">` : "";
      const destinations = (receipt.destinations || []).map((destination) =>
        `<li><strong>${escapeHtml(destinationName(destination, settings))}</strong><span class="destination-state status-${escapeHtml(destination.status)}">${escapeHtml(destination.status)}</span>${destination.error ? `<span>${escapeHtml(destination.error)}</span>` : ""}</li>`,
      ).join("");
      const attempts = (receipt.attempts || []).slice().reverse().map((attempt) =>
        `<li><time>${escapeHtml(attempt.at ? new Date(attempt.at).toLocaleString("en-CA", { timeZone: settings.timezone || "America/Vancouver" }) : "")}</time><strong>${escapeHtml(SOURCE_LABELS[attempt.actor] || attempt.actor || "Unknown")}</strong><span>${escapeHtml(attempt.action || "attempt")} · ${escapeHtml(attempt.detail || (attempt.ok ? "Completed" : "Not completed"))}</span></li>`,
      ).join("");
      const copyPayload = escapeHtml(JSON.stringify({
        id: receipt.id, headline: receipt.title, category: newsType, source: SOURCE_LABELS[receipt.source] || receipt.source,
        status: statusLabel, createdAt: receipt.createdAt, destinations: receipt.destinations || [], attempts: receipt.attempts || [],
      }));
      const categorySelect = (settings.allowedCategories || []).map((category) =>
        `<option value="${escapeHtml(category)}"${selected(newsType, category)}>${escapeHtml(category)}</option>`,
      ).concat(`<option value="Unclassified"${selected(newsType, "Unclassified")}>Unclassified</option>`).join("");
      return `<li class="receipt-card" data-status="${escapeHtml(receipt.status)}">
        <div class="receipt-head"><span class="status status-${escapeHtml(receipt.status)}">${escapeHtml(statusLabel)}</span><span class="category">${escapeHtml(newsType)}</span><time>${escapeHtml(when)}</time></div>
        <strong class="headline">${escapeHtml(title)}</strong>
        <div class="receipt-meta"><span>${escapeHtml(SOURCE_LABELS[receipt.source] || receipt.source)}</span><code>${escapeHtml(receipt.id)}</code></div>
        ${destinations ? `<ul class="destinations">${destinations}</ul>` : `<p class="missing-destination">Destination not reported</p>`}
        <div class="receipt-actions">
          <button type="button" class="copy-receipt" data-receipt="${copyPayload}">Copy details</button>
          ${receipt.status === "failed" ? `<button type="button" class="retry-receipt" data-id="${escapeHtml(receipt.id)}">Retry</button>` : ""}
        </div>
        <details class="attempt-history"><summary>Attempt history <span>${(receipt.attempts || []).length}</span></summary><ul>${attempts || "<li>No attempt details recorded.</li>"}</ul></details>
        ${settings.editDeleteEnabled !== false ? `<details class="receipt-edit"><summary>Edit or delete</summary>
          <form method="POST" action="/api/broadcast-ledger/manual/${encodeURIComponent(receipt.id)}/edit">
            ${keyField}
            <label>Headline<input name="title" value="${escapeHtml(receipt.title || "")}" required></label>
            <label>Exact category<select name="newsType" required>${categorySelect}</select></label>
            <button type="submit">Save changes</button>
          </form>
          <form method="POST" action="/api/broadcast-ledger/manual/${encodeURIComponent(receipt.id)}/delete"
            onsubmit="return confirm('Delete this broadcast receipt? This cannot be undone.');">
            ${keyField}
            <button class="delete-button" type="submit">Delete receipt</button>
          </form>
        </details>` : ""}
      </li>`;
    })
    .join("");

  const watchBanner = watching
    ? `<details class="watch on" open><summary>\u25cf Channel status</summary><strong>Watching your Telegram channels</strong>
         <span>Posts from other senders are recorded automatically. Telegram never reports this bot's own
         messages back, so anything sent through this bot must broadcast via
         <code>POST /api/broadcast-ledger/broadcast</code> to be recorded.</span></details>`
    : `<details class="watch off" open><summary>\u25cb Channel status</summary><strong>Channel watch is off</strong>
         <span>Broadcasts are only recorded when a sending path reports itself.
         Set <code>BROADCAST_LEDGER_INGEST_ENABLED=true</code> in Railway to record posts automatically.</span></details>`;

  const tally = visibleTotal
    ? `<p class="tally"><strong>${visibleTotal}</strong> ledger ${visibleTotal === 1 ? "entry" : "entries"} recorded</p>`
    : `<p class="tally empty">No broadcasts recorded yet.${
        watching
          ? " The watch is running, so the next post to your channels will appear here on its own."
          : " Nothing is watching your channels, so nothing will appear here until a sending path reports itself."
      }</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>Broadcast Ledger</title>
<link rel="stylesheet" href="/assets/styles/broadcast-ledger.css">
<script defer src="/assets/js/broadcast-ledger.js"></script>
</head>
<body>
<main>
  <h1>Broadcast receipts</h1>
  <p class="sub">The shared record that stops ShareBot67 repeating a story or reporting one as failed.</p>
  ${notice ? `<div class="msg ok">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ""}
  ${watchBanner}
  ${tally}
  <section class="daily-summary" aria-label="Daily summary"><span>Today · ${escapeHtml(summary?.timeZone || settings.timezone || "America/Vancouver")}</span><strong>${escapeHtml(summaryText(summary))}</strong></section>
  <details class="filter-panel" open>
    <summary>Search &amp; filters</summary>
  <form class="ledger-filters" method="GET" action="/api/broadcast-ledger/manual">
    ${formKey ? `<input type="hidden" name="key" value="${escapeHtml(formKey)}">` : ""}
    <label class="search-field">Search<input name="q" value="${escapeHtml(filters.query || "")}" placeholder="Headline or receipt ID"></label>
    <label>Range<select name="range"><option value="today"${selected(filters.range, "today")}>Today</option><option value="7"${selected(filters.range, "7")}>7 days</option><option value="30"${selected(filters.range, "30")}>30 days</option><option value="all"${selected(filters.range, "all")}>All time</option></select></label>
    <label>Category<select name="newsType">${categoryOptions}</select></label>
    <label>Status<select name="status"><option value="">All statuses</option><option value="broadcasted"${selected(filters.status, "broadcasted")}>Broadcasted</option><option value="blocked"${selected(filters.status, "blocked")}>Blocked</option><option value="failed"${selected(filters.status, "failed")}>Failed</option><option value="pending"${selected(filters.status, "pending")}>Pending</option></select></label>
    <button type="submit">Apply filters</button><a href="/api/broadcast-ledger/manual${formKey ? `?key=${encodeURIComponent(formKey)}` : ""}">Clear</a>
  </form>
  </details>
  ${rows ? `<div class="ledger-heading"><h2>Broadcast log</h2><span>${visibleReceipts.length} shown</span></div><ul class="receipt-list">${rows}</ul>` : `<p class="empty filtered-empty">No receipts match these filters.</p>`}
</main>
</body>
</html>`;
}

function createBroadcastLedgerRouter({
  broadcastLedgerStore,
  broadcastIngestService,
  telegramService,
  notificationService,
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

  async function notify(type, receipt, detail = "") {
    const settings = broadcastLedgerStore.getSettings();
    if (!notificationService || settings.notifications?.[type] === false) return;
    await notificationService.notify(type, receipt, detail);
  }

  async function notifyReceiptChange(receipt, previous = null) {
    if (!receipt) return;
    if (receipt.newsType === "Unclassified" && previous?.newsType !== "Unclassified") {
      await notify("missingCategory", receipt, receipt.error?.message || "No exact allowed category was supplied.");
    } else if (receipt.status === "blocked" && previous?.status !== "blocked") {
      await notify("blocked", receipt, receipt.error?.message || "Broadcast attempt was blocked.");
    }
    if (receipt.status === "failed" && previous?.status !== "failed") {
      await notify("failed", receipt, receipt.error?.message || "Broadcast delivery failed.");
    }
  }

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
  function pageState(query = {}) {
    const settings = broadcastLedgerStore.getSettings();
    const range = ["today", "7", "30", "all"].includes(String(query.range)) ? String(query.range) : "today";
    const filters = {
      range,
      status: String(query.status || ""),
      newsType: String(query.newsType || ""),
      query: String(query.q || ""),
    };
    const since = range === "7" || range === "30"
      ? new Date(Date.now() - Number(range) * 24 * 60 * 60 * 1000).toISOString()
      : null;
    let recent = broadcastLedgerStore.list({
      limit: 500,
      status: filters.status,
      newsType: filters.newsType,
      query: filters.query,
      since,
    }).filter(isVisibleReceipt);
    if (range === "today") {
      const today = broadcastLedgerStore.dailySummary().date;
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: settings.timezone,
        year: "numeric", month: "2-digit", day: "2-digit",
      });
      recent = recent.filter((receipt) => formatter.format(new Date(receipt.createdAt)) === today);
    }
    return {
      recent,
      total: recent.length,
      bySource: broadcastLedgerStore.sourceBreakdown().bySource,
      watching: Boolean(broadcastIngestService && broadcastIngestService.enabled),
      diagnostics: broadcastIngestService ? broadcastIngestService.describe() : null,
      filters,
      settings,
      summary: visibleDailySummary(broadcastLedgerStore, settings),
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
        summary: broadcastLedgerStore.dailySummary(),
        settings: broadcastLedgerStore.getSettings(),
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

  router.get("/settings", requireManualAccess, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ settings: broadcastLedgerStore.getSettings() });
  });

  router.put("/settings", requireWatchlistAdmin, (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== "object") return badRequest(res, "A JSON object body is required.");
      res.json({ settings: broadcastLedgerStore.updateSettings(req.body) });
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
        ...pageState(req.query),
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

      const invalid = validateReceiptPayload({ ...body, source: "manual" }, broadcastLedgerStore.getSettings());
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

  router.post("/manual/:id/edit", requireManualAccess, (req, res, next) => {
    try {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      const newsType = String(body.newsType || "").trim();
      if (!title || !newsType) return badRequest(res, "Headline and news type are required.");
      const settings = broadcastLedgerStore.getSettings();
      if (settings.requireExactCategory && !settings.allowedCategories.includes(newsType) && newsType !== "Unclassified") {
        return badRequest(res, `newsType must be one of: ${settings.allowedCategories.join(", ")}`);
      }
      const receipt = broadcastLedgerStore.updateReceipt(
        req.params.id,
        { title, newsType, action: "manual-edit" },
        { actor: "owner" },
      );
      if (!receipt) return res.status(404).json({ error: "Receipt not found." });
      const keyParam = body.key ? `&key=${encodeURIComponent(body.key)}` : "";
      res.redirect(303, `/api/broadcast-ledger/manual?saved=1${keyParam}`);
    } catch (err) {
      next(err);
    }
  });

  router.post("/manual/:id/delete", requireManualAccess, (req, res, next) => {
    try {
      if (!broadcastLedgerStore.getSettings().editDeleteEnabled) {
        return res.status(403).json({ error: "Receipt deletion is disabled in Ledger Settings." });
      }
      const deleted = broadcastLedgerStore.deleteReceipt(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Receipt not found." });
      const keyParam = req.body && req.body.key ? `&key=${encodeURIComponent(req.body.key)}` : "";
      res.redirect(303, `/api/broadcast-ledger/manual?saved=1${keyParam}`);
    } catch (err) {
      next(err);
    }
  });

  router.post("/receipts/:id/retry", requireManualAccess, (req, res, next) => {
    (async () => {
      const receipt = broadcastLedgerStore.getReceipt(req.params.id);
      if (!receipt) return res.status(404).json({ error: "Receipt not found." });
      if (receipt.status !== "failed") return res.status(409).json({ error: "Only failed broadcasts can be retried." });
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) return badRequest(res, "text is required because private broadcast bodies are not stored.");
      if (!telegramService || !telegramService.configured) {
        return res.status(400).json({ error: "Telegram is not configured." });
      }
      try {
        const targets = destinationsForNewsType(receipt.newsType, broadcastLedgerStore.getSettings());
        const result = await telegramService.postText(text, { parseMode: "HTML", ...(targets ? { targets } : {}) });
        const updated = broadcastLedgerStore.updateReceipt(
          receipt.id,
          { destinations: result.destinations, error: null, action: "retry", detail: "Operator retried failed broadcast" },
          { actor: "owner" },
        );
        res.json({ ok: true, receipt: updated, sent: result.posted, failed: result.failed });
      } catch (err) {
        const updated = broadcastLedgerStore.updateReceipt(
          receipt.id,
          { status: "failed", destinations: err.destinations || [], error: err, action: "retry", detail: err.message },
          { actor: "owner" },
        );
        await notify("failed", updated || receipt, err.message);
        res.status(err.statusCode || 502).json({ error: err.message, receipt: updated });
      }
    })().catch(next);
  });

  // Every remaining endpoint is machine-facing and key-only.
  router.use(requireLedgerKey);

  router.post("/broadcast/guard", (req, res, next) => {
    (async () => {
      const body = req.body || {};
      const invalid = validateReceiptPayload(body, broadcastLedgerStore.getSettings());
      if (invalid) return badRequest(res, invalid);
      if (!String(body.idempotencyKey || body.attemptId || "").trim()) {
        return badRequest(res, "A stable idempotencyKey or attemptId is required.");
      }
      const result = broadcastLedgerStore.guard(body);
      if (!result.allowed) await notifyReceiptChange(result.receipt);
      res.status(result.allowed ? 200 : 409).json(result);
    })().catch(next);
  });

  // Create or upsert a receipt. Idempotent on idempotencyKey — the property
  // that lets a phone on a bad connection retry safely.
  router.post("/receipts", (req, res, next) => {
    (async () => {
      const invalid = validateReceiptPayload(req.body, broadcastLedgerStore.getSettings());
      if (invalid) return badRequest(res, invalid);
      const { receipt, created } = broadcastLedgerStore.createReceipt(req.body);
      if (created) await notifyReceiptChange(receipt);
      res.status(created ? 201 : 200).json({ receipt, created });
    })().catch(next);
  });

  // Record destination results / final status against an existing receipt.
  router.patch("/receipts/:id", (req, res, next) => {
    (async () => {
      if (!req.body || typeof req.body !== "object") return badRequest(res, "A JSON object body is required.");
      if (req.body.status && !STATUSES.includes(req.body.status)) {
        return badRequest(res, `status must be one of: ${STATUSES.join(", ")}`);
      }
      if (req.body.destinations && !Array.isArray(req.body.destinations)) {
        return badRequest(res, "destinations must be an array.");
      }
      const actor = SOURCES.includes(req.body.source) ? req.body.source : "unknown";
      const previous = broadcastLedgerStore.getReceipt(req.params.id);
      const receipt = broadcastLedgerStore.updateReceipt(req.params.id, req.body, { actor });
      if (!receipt) return res.status(404).json({ error: "Receipt not found." });
      await notifyReceiptChange(receipt, previous);
      res.json({ receipt });
    })().catch(next);
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
          newsType: req.query.newsType,
          since: req.query.since,
          query: req.query.q,
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
      const settings = broadcastLedgerStore.getSettings();
      const suppliedCategory = String(body.newsType || body.category || "").trim();
      if (suppliedCategory && settings.requireExactCategory && !settings.allowedCategories.includes(suppliedCategory)) {
        return badRequest(res, `newsType must be one of: ${settings.allowedCategories.join(", ")}`);
      }
      const exactNewsType = settings.allowedCategories.includes(suppliedCategory) ? suppliedCategory : "Unclassified";

      const source = SOURCES.includes(body.source) ? body.source : "shortcut";
      const title = typeof body.title === "string" && body.title.trim() ? body.title : deriveTitle(text);
      // The Shortcut sends one blob of text with the link inside it. Pulling
      // the link out is what gives the receipt a canonical URL, and the URL
      // tier is the only authoritative half of dedupe — without it a resend
      // check would fall back to hashing the exact wording.
      const url = rawUrl || firstUrl(text);

      // A configured daily cap is enforced at the actual send boundary too;
      // callers should still preflight through /broadcast/guard so blocked
      // attempts are visible before Telegram is contacted.
      if (settings.categoryLimits[suppliedCategory]) {
        if (!String(body.idempotencyKey || "").trim()) {
          return badRequest(res, `idempotencyKey is required for limited category ${suppliedCategory}.`);
        }
        const guarded = broadcastLedgerStore.guard({ ...body, source, title, url, text });
        if (!guarded.allowed) {
          await notifyReceiptChange(guarded.receipt);
          return res.status(409).json(guarded);
        }
      }

      // Refuse to broadcast a story the ledger already shows as sent. This is
      // the dedupe actually doing its job at the moment it matters, rather
      // than after the fact. `force: true` overrides for a deliberate resend.
      if (body.force !== true) {
        const existing = broadcastLedgerStore.lookup({ url, text, headline: title });
        const existingAgeMs = existing.receipt && existing.receipt.createdAt
          ? Date.now() - new Date(existing.receipt.createdAt).getTime()
          : Infinity;
        const category = suppliedCategory || "Unclassified";
        const configuredWindow = settings.duplicateWindows[category] || "6h";
        const windowMs = duplicateWindowMs(configuredWindow);
        const sameConfiguredDay = configuredWindow === "same-day" && existing.receipt
          ? new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(new Date(existing.receipt.createdAt)) ===
            new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(new Date())
          : false;
        const withinWindow = configuredWindow === "same-day" ? sameConfiguredDay : windowMs && existingAgeMs <= windowMs;
        if (existing.posted && existing.receipt && withinWindow) {
          await notify("blocked", existing.receipt, "Already broadcast inside the configured duplicate window.");
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
        kind: KINDS.includes(body.kind) ? body.kind : "story",
        newsType: exactNewsType,
        title,
        url,
        text,
        status: "pending",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      });
      await notifyReceiptChange(receipt);

      let result;
      try {
        const targets = destinationsForNewsType(exactNewsType, settings);
        result = await telegramService.postText(text, {
          parseMode: body.parseMode === "none" ? null : "HTML",
          ...(targets ? { targets } : {}),
        });
      } catch (err) {
        const updated = broadcastLedgerStore.updateReceipt(
          receipt.id,
          { status: "failed", error: err, destinations: err.destinations || [], action: "broadcast" },
          { actor: source },
        );
        await notify("failed", updated || receipt, err.message);
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
