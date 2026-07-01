const express = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createYoutubeRouter({ youtubeService, channels }) {
  const router = express.Router();

  router.get(
    "/channels",
    asyncRoute(async (req, res) => {
      const results = await Promise.allSettled(
        channels.map((channel) => youtubeService.getChannelFeed(channel.handle)),
      );

      const payload = channels.map((channel, index) => {
        const result = results[index];

        if (result.status === "fulfilled") {
          return {
            handle: channel.handle,
            label: channel.label,
            category: channel.category,
            title: result.value.title,
            videos: result.value.videos.slice(0, 6),
          };
        }

        return {
          handle: channel.handle,
          label: channel.label,
          category: channel.category,
          error: result.reason?.message || "Failed to load feed",
        };
      });

      res.json({ channels: payload });
    }),
  );

  router.get(
    "/channels/:handle",
    asyncRoute(async (req, res) => {
      const channel = channels.find((item) => item.handle === req.params.handle);
      if (!channel) {
        return res.status(404).json({ error: "Unknown channel" });
      }

      const feed = await youtubeService.getChannelFeed(channel.handle);
      res.json({ ...feed, label: channel.label, category: channel.category });
    }),
  );

  return router;
}

module.exports = { createYoutubeRouter };
