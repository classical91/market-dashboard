"use strict";

const crypto = require("crypto");

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
    config.traderclawPassword,
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
  if (!["owner", "traderclaw", "alpha"].includes(role)) return null;
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

function clearSessionCookie(res, req) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  );
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

function isPublicAuthPath(req) {
  return req.path === "/login"
    || req.path === "/auth/login"
    || req.path === "/auth/logout"
    || req.path === "/api/alpha-team/access"
    || req.path === "/api/health";
}

function canAccess(req, session) {
  if (!session) return false;
  if (session.role === "owner" || session.role === "traderclaw") return true;
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
      <p>Enter your dashboard account password or the Alpha Team read-only code.</p>
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
  const enabled = Boolean(config.sitePassword || config.traderclawPassword || config.alphaAccessCode);
  const configuredPasswords = [config.sitePassword, config.traderclawPassword, config.alphaAccessCode].filter(Boolean);
  if (new Set(configuredPasswords).size !== configuredPasswords.length) {
    throw new Error("Website account passwords must be distinct");
  }
  const revokedSessions = new Map();

  function requestSessionValue(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME] || "";
  }

  function pruneRevokedSessions(now = Date.now()) {
    for (const [value, expires] of revokedSessions) {
      if (expires <= now) revokedSessions.delete(value);
    }
  }

  function activeSessionFromRequest(req) {
    const value = requestSessionValue(req);
    pruneRevokedSessions();
    if (revokedSessions.has(value)) return null;
    return decodeSession(value, config);
  }

  function classifyPassword(password) {
    if (config.sitePassword && safeEqual(password, config.sitePassword)) return "owner";
    if (config.traderclawPassword && safeEqual(password, config.traderclawPassword)) return "traderclaw";
    if (config.alphaAccessCode && safeEqual(password, config.alphaAccessCode)) return "alpha";
    return null;
  }

  return {
    enabled,
    sessionFromRequest: activeSessionFromRequest,
    setSessionCookie: (res, req, role) => setSessionCookie(res, req, role, config),
    clearSessionCookie,
    classifyPassword,
    requireAccess(req, res, next) {
      if (!enabled || isPublicAuthPath(req)) {
        next();
        return;
      }
      const session = activeSessionFromRequest(req);
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
      const value = requestSessionValue(req);
      const session = decodeSession(value, config);
      if (session) revokedSessions.set(value, session.expires);
      clearSessionCookie(res, req);
      res.redirect(303, "/login");
    },
  };
}

module.exports = { createSiteAuth, parseCookies, decodeSession, encodeSession };
