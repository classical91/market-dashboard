"use strict";

/**
 * Minimal in-process rate limiter.
 *
 * The repo carries no rate-limit dependency and adding one for a couple of
 * endpoints isn't worth it, so this is a fixed-window counter keyed by
 * caller. Two honest limitations: the window resets when the dyno restarts,
 * and the count is per-instance rather than global. Both are fine for the
 * job here — stopping a stuck shortcut or a scraper from hammering the
 * ledger — and neither is a substitute for the API key that actually
 * guards the route.
 */

const DEFAULT_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 5000;

function defaultKeyFor(req) {
  // Prefer the proxy-forwarded client address: on Railway every request
  // arrives from the edge, so req.ip alone would bucket the whole world
  // together.
  const forwarded = String(req.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || "unknown";
}

function createRateLimit({ limit = 60, windowMs = DEFAULT_WINDOW_MS, keyFor = defaultKeyFor } = {}) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    if (!(limit > 0)) {
      next();
      return;
    }

    const now = Date.now();
    const key = keyFor(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      // Opportunistic sweep: expired buckets are dropped as we go, so the
      // map can't grow without bound on a long-lived process.
      if (buckets.size >= MAX_TRACKED_KEYS) {
        for (const [existingKey, existing] of buckets) {
          if (existing.resetAt <= now) buckets.delete(existingKey);
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests — slow down and retry.", retryAfter });
      return;
    }

    next();
  };
}

module.exports = { createRateLimit };
