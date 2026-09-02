const express = require("express");

const { resolveYoutubeChannels } = require("../config/youtube-channels");
const { resolveYoutubeThemes, themeSections } = require("../config/youtube-themes");

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
function createYoutubeRouter({ youtubeService, channelRegistry, channelIdOverrides, requireAdmin }) {
  const router = express.Router();

  function feedChannels() {
    return resolveYoutubeChannels(channelIdOverrides, channelRegistry.list());
  }

  router.get(
    "/channels",
    asyncRoute(async (req, res) => {
      const channels = feedChannels();
      // getIntelligence never rejects on a single bad channel — failures come
      // back in `failedFeeds` so one dead feed cannot blank the whole page.
      const payload = await youtubeService.getIntelligence(channels);
      // Themes ride along with the feed rather than sitting on their own
      // endpoint: the page cannot render a theme without the videos anyway, and
      // one response keeps the switcher from flashing the wrong name first.
      res.json({ ...payload, themes: resolveYoutubeThemes(undefined, channels) });
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
        // The categories that place a channel in a theme. Offered, not
        // enforced — a custom category still groups itself under the derived
        // markets theme, so a channel can never be stranded outside every one.
        categories: themeSections(),
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
        res.status(201).json({ added, channels: channelRegistry.list() });
      }),
    );

    router.delete(
      "/channels/config/:handle",
      requireAdmin,
      asyncRoute(async (req, res) => {
        const removed = channelRegistry.remove(req.params.handle);
        res.json({ removed, channels: channelRegistry.list() });
      }),
    );
  }

  router.get(
    "/channels/:handle",
    asyncRoute(async (req, res) => {
      const channel = feedChannels()
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
