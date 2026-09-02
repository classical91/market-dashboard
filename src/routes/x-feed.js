const express = require("express");
const { DATA_STATES, worstDataState, safeDataState } = require("../services/x-feed");
const { DEFAULT_CATEGORIES } = require("../services/x-account-registry");
const { DEFAULT_TEMPLATE_ID } = require("../services/x-template-registry");
const { createServiceError } = require("../utils/errors");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sortByPublishedDateDesc(items) {
  return items.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function isoTimes(values) {
  return values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time));
}

function newestIso(values) {
  const times = isoTimes(values);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * The conservative aggregate. "All accounts were checked N ago" is only
 * honest if it uses the account checked longest ago — anything else lets a
 * single fresh account speak for the ones served from a 15-minute cache.
 * Returns null when any account was never checked at all.
 */
function oldestIso(values) {
  if (values.some((value) => !value)) return null;
  const times = isoTimes(values);
  return times.length === values.length && times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * The worst case among accounts that actually confirmed something — which is
 * exactly the set whose posts are on screen. Accounts that never succeeded
 * contribute no cards, so excluding them does not understate anything; using
 * the *newest* confirmation instead would, on a mixed feed.
 */
function oldestConfirmedIso(values) {
  const times = isoTimes(values);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * The response is authoritative about freshness so the client never has to
 * infer provider health from `posts.length`. Every account reports when it
 * was last checked, when it was last successfully fetched, and which provider
 * answered — separately from how old its newest post is.
 */
function describeAccount(account, feed) {
  const base = {
    handle: account.handle,
    label: account.label,
    category: account.category,
  };

  if (feed && !feed.error) {
    return {
      ...base,
      posts: feed.posts,
      source: feed.source || "api",
      provider: feed.provider || null,
      providerState: feed.providerState || null,
      // Never defaults to live: a feed with no freshness metadata is one we
      // cannot vouch for, not one we confirmed.
      dataState: safeDataState(feed),
      lastCheckedAt: feed.lastAttemptAt || null,
      lastSuccessfulFetchAt: feed.lastSuccessfulFetchAt || null,
      newestPostAt: feed.newestPostAt || null,
      archival: Boolean(feed.archival),
      stale: Boolean(feed.stale),
      ...(feed.staleReason ? { staleReason: feed.staleReason } : {}),
    };
  }

  return {
    ...base,
    error: feed?.error || "Failed to load feed",
    provider: feed?.provider || null,
    providerState: feed?.providerState || null,
    dataState: DATA_STATES.UNAVAILABLE,
    lastCheckedAt: feed?.lastAttemptAt || null,
    lastSuccessfulFetchAt: feed?.lastSuccessfulFetchAt || null,
    newestPostAt: null,
  };
}

function assertKnownTemplateHandles(input, accountRegistry) {
  const known = new Set(accountRegistry.list().map((account) => account.handle.toLowerCase()));
  const unknown = (Array.isArray(input?.memberships) ? input.memberships : [])
    .map((entry) => String(entry?.handle || "").replace(/^@+/, "").toLowerCase())
    .filter((handle) => handle && !known.has(handle));
  if (unknown.length) {
    throw createServiceError(`Template references untracked X account @${unknown[0]}`, 400);
  }
}

function createXFeedRouter({ xFeedService, accountRegistry, templateRegistry, requireAdmin }) {
  const router = express.Router();

  router.get(
    "/accounts",
    asyncRoute(async (req, res) => {
      // Read per request: the tracked list is editable at runtime now, so a
      // list captured at boot would serve deleted accounts until a restart.
      const templateId = req.query.template || DEFAULT_TEMPLATE_ID;
      const template = templateRegistry.get(templateId);
      const accounts = templateRegistry.resolveAccounts(template.id, accountRegistry.list());
      const feeds = await xFeedService.getAccountFeeds(accounts.map((account) => account.handle));
      const payload = accounts.map((account) => describeAccount(account, feeds.get(account.handle)));

      const posts = sortByPublishedDateDesc(
        payload.flatMap((account) =>
          (account.posts || []).map((post) => ({
            ...post,
            handle: account.handle,
            label: account.label,
            category: account.category,
          })),
        ),
      );

      const counts = payload.reduce((acc, account) => {
        acc[account.dataState] = (acc[account.dataState] || 0) + 1;
        return acc;
      }, {});

      res.json({
        template,
        // Worst-of across accounts: the feed as a whole is only "live" when
        // every account was confirmed current on this refresh.
        status: worstDataState(payload.map((account) => account.dataState)),
        // When this response was assembled — not when X was last contacted.
        // A response served from the 15-minute feed cache is generated now
        // and checked some time ago, and the two must not be conflated.
        generatedAt: new Date().toISOString(),
        lastCheckedAt: oldestIso(payload.map((account) => account.lastCheckedAt)),
        mostRecentSuccessfulFetchAt: newestIso(
          payload.map((account) => account.lastSuccessfulFetchAt),
        ),
        // The conservative counterpart, and the one a "how old is this?"
        // banner should quote: the freshest account must not speak for the
        // rest of a mixed feed.
        oldestSuccessfulFetchAt: oldestConfirmedIso(
          payload.map((account) => account.lastSuccessfulFetchAt),
        ),
        newestPostAt: newestIso(payload.map((account) => account.newestPostAt)),
        counts,
        providers: xFeedService.providerHealth(),
        posts,
        failedFeeds: payload.filter((account) => account.error),
        staleFeeds: payload.filter((account) => account.stale),
        accounts: payload,
      });
    }),
  );

  // Template definitions are public for the same reason account metadata is:
  // the page needs them to render its switcher before an admin action occurs.
  router.get(
    "/templates",
    asyncRoute(async (req, res) => {
      res.json({
        templates: templateRegistry.list(),
        defaultTemplateId: DEFAULT_TEMPLATE_ID,
        registry: templateRegistry.describe(),
      });
    }),
  );

  // Reading the tracked list needs no admin key: it returns the same handles,
  // labels and categories that /accounts already serves publicly, and the
  // manage panel has to render before anyone can be asked for a key.
  router.get(
    "/accounts/config",
    asyncRoute(async (req, res) => {
      res.json({
        accounts: accountRegistry.list(),
        categories: DEFAULT_CATEGORIES,
        registry: accountRegistry.describe(),
      });
    }),
  );

  // Mutations are admin-gated. Both are deliberately synchronous with respect
  // to X: no upstream call is made, so a rejected token or a rate-limited
  // provider can neither block account management nor half-apply a change.
  if (requireAdmin) {
    router.post(
      "/templates",
      requireAdmin,
      asyncRoute(async (req, res) => {
        assertKnownTemplateHandles(req.body, accountRegistry);
        const template = templateRegistry.create(req.body || {});
        res.status(201).json({ template, templates: templateRegistry.list() });
      }),
    );

    router.put(
      "/templates/order",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const templates = templateRegistry.reorder(req.body?.ids);
        res.json({ templates });
      }),
    );

    router.put(
      "/templates/:id",
      requireAdmin,
      asyncRoute(async (req, res) => {
        assertKnownTemplateHandles(req.body, accountRegistry);
        const template = templateRegistry.update(req.params.id, req.body || {});
        res.json({ template, templates: templateRegistry.list() });
      }),
    );

    router.post(
      "/templates/:id/duplicate",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const template = templateRegistry.duplicate(req.params.id, req.body || {});
        res.status(201).json({ template, templates: templateRegistry.list() });
      }),
    );

    router.delete(
      "/templates/:id",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const removed = templateRegistry.remove(req.params.id);
        res.json({ removed, templates: templateRegistry.list() });
      }),
    );

    router.post(
      "/accounts/config",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const account = accountRegistry.add(req.body || {});
        res.status(201).json({ added: account, accounts: accountRegistry.list() });
      }),
    );

    router.delete(
      "/accounts/config/:handle",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const removed = accountRegistry.remove(req.params.handle);
        res.json({ removed, accounts: accountRegistry.list() });
      }),
    );
  }

  // Admin-only: reports provider health and where the persistent cache
  // actually lives, so a token failure can be told apart from a volume that
  // was never mounted. Never exposes the token itself.
  if (requireAdmin) {
    router.get(
      "/diagnostics",
      requireAdmin,
      asyncRoute(async (req, res) => {
        res.json({
          generatedAt: new Date().toISOString(),
          providers: xFeedService.providerHealth(),
          cache: xFeedService.cacheDiagnostics(),
          registry: accountRegistry.describe(),
          templateRegistry: templateRegistry.describe(),
        });
      }),
    );

    router.post(
      "/diagnostics/reset-circuits",
      requireAdmin,
      asyncRoute(async (req, res) => {
        res.json({ reset: true, providers: xFeedService.resetCircuits() });
      }),
    );
  }

  return router;
}

module.exports = { createXFeedRouter };
