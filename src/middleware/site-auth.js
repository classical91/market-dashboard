"use strict";

const crypto = require("crypto");
const { isLedgerRequest, isLedgerParamRequest } = require("./ledger-auth");
const { isAdminRequest } = require("./admin-auth");

const COOKIE_NAME = "market_dashboard_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALPHA_PAGES = new Set([
  "/signal-screener.html",
  "/pattern-scanner.html",
  "/alpha-team.html",
]);
const ALPHA_READ_APIS = [
  "/api/alpha-team/access",
  "/api/health",
  "/api/pattern-scanner",
  "/api/signal-screener",
  "/api/watchlist",
];

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index === -1) return cookies;
      const name = part.slice(0, index).trim();
      cookies[name] = decodeURIComponent(part.slice(index + 1));
      return cookies;
    }, {});
}

function signingSecret(config) {
  return [
    config.sitePassword,
    config.alphaAccessCode,
    config.adminKey,
    "market-dashboard-site-auth-v1",
  ].filter(Boolean).join(":");
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeSession(role, config, now = Date.now()) {
  const secret = signingSecret(config);
  if (!secret) return "";
  const expires = now + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `${role}.${expires}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

function decodeSession(value, config, now = Date.now()) {
  const secret = signingSecret(config);
  if (!value || !secret) return null;
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  const [role, expires, nonce, provided] = parts;
  if (!["owner", "alpha"].includes(role)) return null;
  if (!nonce || Number(expires) <= now) return null;
  const payload = `${role}.${expires}.${nonce}`;
  if (!safeEqual(provided, sign(payload, secret))) return null;
  return { role, expires: Number(expires) };
}

function sessionFromRequest(req, config) {
  return decodeSession(parseCookies(req.headers.cookie)[COOKIE_NAME], config);
}

function cookieOptions(req) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? "Secure" : null,
  ].filter(Boolean).join("; ");
}

function setSessionCookie(res, req, role, config) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(encodeSession(role, config))}; ${cookieOptions(req)}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function wantsJson(req) {
  return req.path.startsWith("/api/") || String(req.get("accept") || "").includes("application/json");
}

function isAlphaPage(req) {
  return req.method === "GET"
    && req.query
    && req.query.view === "alpha"
    && ALPHA_PAGES.has(req.path);
}

function isAlphaAsset(req) {
  return req.method === "GET" && req.path.startsWith("/assets/");
}

function isAlphaReadApi(req) {
  return req.method === "GET" && ALPHA_READ_APIS.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
}

// The broadcast ledger is called by machines — the iOS/GPT shortcut and the
// ShareBot67 agent — which authenticate with an API key and have no session
// cookie to present. Without this bypass the site login would reject every
// one of those requests before the ledger's own key guard ever ran, which is
// exactly the silent failure the ledger exists to prevent. The routes still
// enforce their own key; this only stops site auth from short-circuiting
// them first.
function isLedgerApiPath(req) {
  return req.path === "/api/broadcast-ledger" || req.path.startsWith("/api/broadcast-ledger/");
}

// The manual receipt form is opened in a phone browser, which can't set a
// header — so it alone may authenticate with a `key` parameter. Narrowed to
// this one path on purpose: keys in URLs end up in history and access logs.
function isLedgerFormPath(req) {
  return req.path === "/api/broadcast-ledger/manual" || req.path === "/api/broadcast-ledger/status";
}

function isPublicAuthPath(req) {
  return req.path === "/login"
    || req.path === "/auth/login"
    || req.path === "/auth/logout"
    || req.path === "/api/alpha-team/access"
    || req.path === "/api/health";
}

// GET /api/decision is documented in src/routes/decision.js as read-only
// public market data, and the TraderClaw agent polls it with no browser
// session to present. Site auth runs before every API router, so it answered
// `401 Login required` before that route was ever reached. Scoped to the exact
// path and read methods on purpose: /api/decision/journal and every mutating
// journal route stay behind the session cookie and ADMIN_API_KEY.
function isPublicDecisionRequest(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return req.path === "/api/decision" || req.path === "/api/decision/";
}

// The TraderClaw learning-journal sync reads Trading Lab evidence with an API
// client, not a browser, so it has no session cookie to present — the same
// shape of caller /api/decision above had to be opened for. Site auth runs
// before every API router, so it answered `401 Login required` before the
// Trading Lab router was ever reached, leaving the sync unable to read the
// source records it exists to journal.
//
// Deliberately narrow, the same way the decision bypass is. Only GET/HEAD, only
// with a valid x-admin-key, and only the four surfaces the sync actually reads.
// /positions and /history are absent on purpose: the strategy-account routes
// already carry open positions, closed-trade history, trade counts and metrics,
// so there is no sync need for the generic ones. /metrics, /experiments,
// /research, and every mutating route stay behind the owner session cookie.
const TRADING_LAB_MACHINE_READ_PATHS = new Set([
  "/api/trading-lab/pipeline",
  "/api/trading-lab/strategy-accounts",
  "/api/trading-lab/signal-actions",
]);

// One path segment only, so this can never widen into a deeper sub-resource.
const STRATEGY_ACCOUNT_DETAIL_PATH = /^\/api\/trading-lab\/strategy-accounts\/[^/]+$/;

function isTradingLabMachineReadRequest(req, adminKey) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
  if (!TRADING_LAB_MACHINE_READ_PATHS.has(path) && !STRATEGY_ACCOUNT_DETAIL_PATH.test(path)) return false;
  return isAdminRequest(req, adminKey);
}

function canAccess(req, session) {
  if (!session) return false;
  if (session.role === "owner") return true;
  return isAlphaPage(req) || isAlphaAsset(req) || isAlphaReadApi(req);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLogin(error = "", returnTo = "/") {
  const safeReturnTo = returnTo && String(returnTo).startsWith("/") ? returnTo : "/";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Market Dashboard Login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070b12; color: #e8edf5; }
    main { width: min(420px, calc(100vw - 32px)); }
    form { display: grid; gap: 14px; padding: 28px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: #101722; box-shadow: 0 24px 80px rgba(0,0,0,.42); }
    h1 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: 0; }
    p { margin: 0; color: #9ca8ba; font-size: 14px; line-height: 1.5; }
    label { display: grid; gap: 8px; font-size: 13px; color: #c9d3e1; }
    input { width: 100%; box-sizing: border-box; padding: 12px 13px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: inherit; font: inherit; }
    input:focus { outline: 2px solid #5aa7ff; outline-offset: 2px; }
    button { min-height: 42px; border: 0; border-radius: 6px; background: #5aa7ff; color: #06111f; font: inherit; font-weight: 700; cursor: pointer; }
    .error { min-height: 20px; color: #ffb4b4; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <form method="post" action="/auth/login">
      <h1>Market Dashboard</h1>
      <p>Enter the dashboard password or the Alpha Team read-only code.</p>
      <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo)}">
      <label>Password
        <input name="password" type="password" autocomplete="current-password" autofocus required>
      </label>
      <button type="submit">Log in</button>
      <div class="error" role="status">${escapeHtml(error)}</div>
    </form>
  </main>
</body>
</html>`;
}

function createSiteAuth(config) {
  const enabled = Boolean(config.sitePassword || config.alphaAccessCode);

  function classifyPassword(password) {
    if (config.sitePassword && safeEqual(password, config.sitePassword)) return "owner";
    if (config.alphaAccessCode && safeEqual(password, config.alphaAccessCode)) return "alpha";
    return null;
  }

  return {
    enabled,
    sessionFromRequest: (req) => sessionFromRequest(req, config),
    setSessionCookie: (res, req, role) => setSessionCookie(res, req, role, config),
    clearSessionCookie,
    classifyPassword,
    requireAccess(req, res, next) {
      if (!enabled || isPublicAuthPath(req) || isPublicDecisionRequest(req)) {
        next();
        return;
      }
      if (isLedgerApiPath(req)) {
        const keys = { ledgerKey: config.ledgerKey, adminKey: config.adminKey };
        if (isLedgerRequest(req, keys) || (isLedgerFormPath(req) && isLedgerParamRequest(req, keys))) {
          next();
          return;
        }
      }
      if (isTradingLabMachineReadRequest(req, config.adminKey)) {
        next();
        return;
      }
      const session = sessionFromRequest(req, config);
      if (canAccess(req, session)) {
        req.siteSession = session;
        next();
        return;
      }
      if (wantsJson(req)) {
        res.status(session ? 403 : 401).json({ error: session ? "Read-only access is not allowed for this resource." : "Login required." });
        return;
      }
      const returnTo = encodeURIComponent(req.originalUrl || "/");
      res.redirect(302, `/login?returnTo=${returnTo}`);
    },
    loginPage(req, res) {
      res.setHeader("Cache-Control", "no-store");
      res.send(renderLogin("", req.query.returnTo || "/"));
    },
    login(req, res) {
      const password = req.body && req.body.password;
      const returnTo = req.body && req.body.returnTo && String(req.body.returnTo).startsWith("/")
        ? req.body.returnTo
        : "/";
      const role = classifyPassword(password);
      if (!role) {
        res.status(401);
        res.setHeader("Cache-Control", "no-store");
        res.send(renderLogin("Password was not accepted.", returnTo));
        return;
      }
      setSessionCookie(res, req, role, config);
      res.redirect(303, role === "alpha" && !returnTo.includes("view=alpha") ? "/signal-screener.html?view=alpha" : returnTo);
    },
    logout(req, res) {
      clearSessionCookie(res);
      res.redirect(303, "/login");
    },
  };
}

module.exports = { createSiteAuth, parseCookies, decodeSession, encodeSession };
