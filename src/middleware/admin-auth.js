const crypto = require("crypto");

// Constant-time comparison that never throws on length mismatch.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// True when the request carries a valid x-admin-key header. Used both by the
// requireAdmin guard and by read routes that reveal extra detail to admins.
function isAdminRequest(req, adminKey) {
  if (!adminKey) {
    return false;
  }
  const provided = req.get("x-admin-key") || "";
  return provided.length > 0 && safeEqual(provided, adminKey);
}

// Express middleware factory that gates action/mutation endpoints.
//
// - When ADMIN_API_KEY is unset the endpoints are DISABLED (503) rather than
//   left open, so a misconfigured deploy can never expose credit-spending or
//   broadcast routes to anonymous callers.
// - When it is set, callers must present a matching x-admin-key header.
function createRequireAdmin({ adminKey, allowOwnerSession = false }) {
  const configured = typeof adminKey === "string" && adminKey.length > 0;

  return function requireAdmin(req, res, next) {
    // Browser-facing management surfaces may explicitly opt into the signed
    // owner session established by site-auth. This is deliberately disabled
    // by default so machine and credit-spending routes keep their existing
    // key-only contract unless their caller opts in.
    if (allowOwnerSession && req.siteSession?.role === "owner") {
      next();
      return;
    }

    if (!configured) {
      res.status(503).json({
        error:
          "Action endpoints are disabled. Set ADMIN_API_KEY on the server to enable them.",
      });
      return;
    }

    if (!isAdminRequest(req, adminKey)) {
      res.status(401).json({ error: "Unauthorized: a valid x-admin-key header is required." });
      return;
    }

    next();
  };
}

module.exports = { createRequireAdmin, isAdminRequest };
