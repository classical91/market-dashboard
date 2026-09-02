const express = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createYoutubeRouter({ youtubeService, channels, themes = [] }) {
  const router = express.Router();

  router.get(
    "/channels",
    asyncRoute(async (req, res) => {
      // getIntelligence never rejects on a single bad channel — failures come
      // back in `failedFeeds` so one dead feed cannot blank the whole page.
      const payload = await youtubeService.getIntelligence(channels);
      // Themes ride along with the feed rather than sitting on their own
      // endpoint: the page cannot render a theme without the videos anyway, and
      // one response keeps the switcher from flashing the wrong name first.
      res.json({ ...payload, themes });
    }),
  );

  router.get(
    "/channels/:handle",
    asyncRoute(async (req, res) => {
      const channel = channels.find((item) => item.handle === req.params.handle);
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
