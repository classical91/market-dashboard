const { createServiceError } = require("../utils/errors");

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHANNEL_ID_TTL_MS = 24 * 60 * 60 * 1000;
const FEED_TTL_MS = 10 * 60 * 1000;

function decodeXmlEntities(value) {
  if (!value) return value;
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseFeedXml(xml) {
  const channelTitleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const channelTitle = channelTitleMatch ? decodeXmlEntities(channelTitleMatch[1]) : null;

  const entries = xml.split("<entry>").slice(1);
  const videos = entries
    .map((chunk) => {
      const videoId = (chunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
      const title = (chunk.match(/<title>([^<]*)<\/title>/) || [])[1];
      const published = (chunk.match(/<published>([^<]+)<\/published>/) || [])[1];
      const thumbnail = (chunk.match(/<media:thumbnail url="([^"]+)"/) || [])[1];

      if (!videoId) return null;

      return {
        id: videoId,
        title: decodeXmlEntities(title) || "Untitled",
        publishedAt: published || null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      };
    })
    .filter(Boolean);

  return { channelTitle, videos };
}

class YouTubeFeedService {
  constructor({ cache }) {
    this.cache = cache;
  }

  async resolveChannelId(handle) {
    return this.cache.getOrLoad(`yt:handle:${handle}`, CHANNEL_ID_TTL_MS, async () => {
      const response = await fetch(`https://www.youtube.com/@${handle}`, {
        headers: { "User-Agent": BROWSER_USER_AGENT },
      });

      if (!response.ok) {
        throw createServiceError(`YouTube channel page returned ${response.status} for @${handle}`, 502);
      }

      const html = await response.text();
      const match =
        html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/) ||
        html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);

      if (!match) {
        throw createServiceError(`Could not resolve a channel id for @${handle}`, 502);
      }

      return match[1];
    });
  }

  async getChannelFeed(handle) {
    return this.cache.getOrLoad(`yt:feed:${handle}`, FEED_TTL_MS, async () => {
      const channelId = await this.resolveChannelId(handle);
      const response = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      );

      if (!response.ok) {
        throw createServiceError(`YouTube feed returned ${response.status} for @${handle}`, 502);
      }

      const xml = await response.text();
      const { channelTitle, videos } = parseFeedXml(xml);

      return {
        handle,
        channelId,
        title: channelTitle || handle,
        videos,
      };
    });
  }
}

module.exports = { YouTubeFeedService };
