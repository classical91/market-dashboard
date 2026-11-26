const express = require("express");

const { resolveYoutubeChannels } = require("../config/youtube-channels");
const { resolveYoutubeThemes } = require("../config/youtube-themes");
const { UNCATEGORIZED_ID, isMixId } = require("../services/youtube-channel-registry");
const { narrowLiveFeed } = require("../services/youtube-live-feed");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * `channelRegistry` is the source of truth, read on every request rather than
 * captured at boot: a channel added through the manage panel has to reach the
 * next feed refresh without a restart, which is the whole point of the
 * registry existing.
 *
 * `channelIdOverrides` is the raw YOUTUBE_CHANNEL_IDS value. It is applied over
 * the stored list on every read rather than baked into the seed, so an operator
 * can still supply channel IDs per-deploy after the registry file exists —
 * folding it into the seed would have silently retired that setting on the
 * first boot after this change.
 */
function createYoutubeRouter({ youtubeService, channelRegistry, channelIdOverrides, summaryService, requireAdmin }) {
  const router = express.Router();

  // `categoryId` names a view of the feed: "all", a category, or a saved mix
  // (a "mix:" ID). Mixes ride on the same parameter so the page's category
  // picker, its remembered choice and ?category= links all work for them.
  function feedChannels(categoryId) {
    const channels = channelRegistry.list();
    const selected = String(categoryId || "").trim();
    const filtered = !selected || selected === "all"
      ? channels
      : isMixId(selected)
        ? channelRegistry.mixChannels(selected) || []
        : channels.filter((channel) => channel.categoryId === selected);
    return resolveYoutubeChannels(channelIdOverrides, filtered);
  }

  // The Live Now widget on Main Hub's Media page.
  //
  // Same ingestion as /channels — one `getIntelligence` call over every tracked
  // channel, sharing the same caches, so this costs no extra YouTube quota. The
  // difference is entirely in what comes back: /channels serves the whole feed
  // to a page that renders the whole feed, and this serves the live and
  // upcoming subsets to a widget that renders a player. See
  // services/youtube-live-feed.js for what is dropped and why.
  //
  // Read-only and unauthenticated by design, which is why it is narrowed
  // upstream of the response rather than in the page: site-auth exempts this
  // exact path (isPublicYoutubeLiveRequest), so whatever this returns is
  // public. It returns which public YouTube streams are live right now — a fact
  // youtube.com will tell anyone who asks.
  router.get(
    "/live",
    asyncRoute(async (req, res) => {
      const payload = await youtubeService.getIntelligence(feedChannels("all"));
      // Two minutes is the live-state TTL the service already keeps, so a
      // shorter cache here would only serve the same answer twice.
      res.set("Cache-Control", "public, max-age=60");
      // The categories ride along for Live Now's "open YouTube Intelligence on a
      // category" picker: id, name and channel count only (see narrowCategories).
      res.json(narrowLiveFeed(payload, channelRegistry.listCategories()));
    }),
  );

  router.get(
    "/channels",
    asyncRoute(async (req, res) => {
      const selectedCategoryId = String(req.query.categoryId || "all").trim() || "all";
      const categories = channelRegistry.listCategories();
      const mixes = channelRegistry.listMixes();
      const mix = isMixId(selectedCategoryId) ? mixes.find((item) => item.id === selectedCategoryId) : null;
      if (selectedCategoryId !== "all" && !mix && !categories.some((category) => category.id === selectedCategoryId)) {
        return res.status(400).json({ error: "Unknown YouTube category" });
      }
      const channels = feedChannels(selectedCategoryId);
      // getIntelligence never rejects on a single bad channel — failures come
      // back in `failedFeeds` so one dead feed cannot blank the whole page.
      const payload = await youtubeService.getIntelligence(channels);
      // Themes ride along with the feed rather than sitting on their own
      // endpoint: the page cannot render a theme without the videos anyway, and
      // one response keeps the switcher from flashing the wrong name first.
      res.json({
        ...payload,
        categories,
        mixes,
        selectedCategoryId,
        selectedCategory: selectedCategoryId === "all"
          ? { id: "all", name: "All Categories", channelCount: channelRegistry.list().length }
          : mix
            ? { id: mix.id, name: mix.name, channelCount: mix.channelCount, mix: true }
            : categories.find((category) => category.id === selectedCategoryId),
        themes: resolveYoutubeThemes(undefined, channels),
      });
    }),
  );

  // Reading the tracked list needs no admin key: it returns the same handles,
  // labels and categories /channels already serves publicly, and the manage
  // panel has to render before anyone can be asked for a key.
  router.get(
    "/channels/config",
    asyncRoute(async (req, res) => {
      res.json({
        channels: channelRegistry.list(),
        categories: channelRegistry.listCategories(),
        mixes: channelRegistry.listMixes(),
        registry: channelRegistry.describe(),
      });
    }),
  );

  // Mutations are admin-gated. Both are deliberately synchronous with respect
  // to YouTube: no upstream call is made, so an exhausted quota can neither
  // block channel management nor half-apply a change. The feed resolves the
  // channel ID on its next refresh, exactly as it does for a seeded channel.
  if (requireAdmin) {
    router.post(
      "/channels/config",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const added = channelRegistry.add(req.body || {});
        res.status(201).json({ added, channels: channelRegistry.list(), categories: channelRegistry.listCategories(), mixes: channelRegistry.listMixes() });
      }),
    );

    router.put(
      "/channels/config/:handle",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const updated = channelRegistry.update(req.params.handle, req.body || {});
        res.json({ updated, channels: channelRegistry.list(), categories: channelRegistry.listCategories(), mixes: channelRegistry.listMixes() });
      }),
    );

    router.delete(
      "/channels/config/:handle",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const removed = channelRegistry.remove(req.params.handle);
        res.json({ removed, channels: channelRegistry.list(), categories: channelRegistry.listCategories(), mixes: channelRegistry.listMixes() });
      }),
    );

    // Saved mixes: a named set of hand-picked channels viewed as one feed.
    router.post(
      "/mixes/config",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const added = channelRegistry.addMix(req.body || {});
        res.status(201).json({ added, mixes: channelRegistry.listMixes() });
      }),
    );

    router.put(
      "/mixes/config/:mixId",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const updated = channelRegistry.updateMix(req.params.mixId, req.body || {});
        res.json({ updated, mixes: channelRegistry.listMixes() });
      }),
    );

    router.delete(
      "/mixes/config/:mixId",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const removed = channelRegistry.removeMix(req.params.mixId);
        res.json({ removed, mixes: channelRegistry.listMixes() });
      }),
    );

    router.post(
      "/categories/config",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const added = channelRegistry.addCategory(req.body || {});
        res.status(201).json({ added, categories: channelRegistry.listCategories() });
      }),
    );

    router.put(
      "/categories/config/:categoryId",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const updated = channelRegistry.updateCategory(req.params.categoryId, req.body || {});
        res.json({ updated, channels: channelRegistry.list(), categories: channelRegistry.listCategories() });
      }),
    );

    router.delete(
      "/categories/config/:categoryId",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const category = channelRegistry.listCategories().find((item) => item.id === req.params.categoryId);
        if (!category || category.id === UNCATEGORIZED_ID) return res.status(404).json({ error: "Category not found" });
        if (category.channelCount && req.body?.reassignToCategoryId == null) {
          return res.status(409).json({
            error: `${category.name} contains ${category.channelCount} channels; choose where to move them`,
            code: "CATEGORY_NOT_EMPTY",
            category,
          });
        }
        const removed = channelRegistry.removeCategory(req.params.categoryId, req.body || {});
        res.json({ removed, channels: channelRegistry.list(), categories: channelRegistry.listCategories() });
      }),
    );
  }

  // Gemini video summaries for the Summarize popup.
  //
  // Reading a cached summary is free, so GET carries the same access as the
  // feed itself. Generating one spends Gemini credits, so POST is admin-gated
  // like the other generate endpoints; the page calls it with the owner
  // session or the stored admin key.
  if (summaryService) {
    router.get(
      "/summary/:videoId",
      asyncRoute(async (req, res) => {
        const cached = summaryService.getCached(req.params.videoId);
        res.json({ ...summaryService.describe(), summary: cached ? { ...cached, cached: true } : null });
      }),
    );

    if (requireAdmin) {
      router.post(
        "/summary/:videoId",
        requireAdmin,
        asyncRoute(async (req, res) => {
          const summary = await summaryService.summarize(req.params.videoId, { refresh: req.body?.refresh === true });
          res.json({ ...summaryService.describe(), summary });
        }),
      );
    }
  }

  router.get(
    "/channels/:handle",
    asyncRoute(async (req, res) => {
      const channel = feedChannels("all")
        .find((item) => item.handle.toLowerCase() === String(req.params.handle).toLowerCase());
      if (!channel) {
        return res.status(404).json({ error: "Unknown channel" });
      }

      const feed = await youtubeService.getChannelFeed(channel);
      res.json({ ...feed, label: channel.label, category: channel.category });
    }),
  );

  return router;
}

module.exports = { createYoutubeRouter };
