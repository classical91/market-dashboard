const express = require("express");

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
            videos: result.value.videos,
          };
        }

        return {
          handle: channel.handle,
          label: channel.label,
          category: channel.category,
          error: result.reason?.message || "Failed to load feed",
        };
      });

      const videos = sortByPublishedDateDesc(
        payload.flatMap((channel) =>
          (channel.videos || []).map((video) => ({
            ...video,
            channelHandle: channel.handle,
            channelLabel: channel.label,
            channelCategory: channel.category,
          })),
        ),
      );

      res.json({
        videos,
        failedFeeds: payload.filter((channel) => channel.error),
        channels: payload,
      });
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
