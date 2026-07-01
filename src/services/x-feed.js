const { createServiceError } = require("../utils/errors");

/**
 * X (Twitter) has no free official RSS/API. These are public Nitter mirrors
 * that expose an RSS feed per profile (`/<handle>/rss`). Mirrors go up and
 * down unpredictably, so each fetch tries them in order and remembers which
 * one last worked for a given handle.
 */
const NITTER_INSTANCES = [
  "https://nitter.net",
  "https://nitter.poast.org",
  "https://nitter.privacyredirect.com",
  "https://xcancel.com",
];

const REQUEST_TIMEOUT_MS = 6000;
const FEED_TTL_MS = 10 * 60 * 1000;
const WORKING_INSTANCE_TTL_MS = 5 * 60 * 1000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decodeXmlEntities(value) {
  if (!value) return value;
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeXmlEntities(String(value || "").replace(/<[^>]*>/g, "")).trim();
}

function parseFeedXml(xml, handle) {
  const items = xml.split("<item>").slice(1);
  const posts = items
    .map((chunk) => {
      const link = (chunk.match(/<link>([^<]+)<\/link>/) || [])[1];
      const title = (chunk.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
      const pubDate = (chunk.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
      if (!link) return null;

      const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
      return {
        id: link,
        text: stripHtml(title) || "",
        url: link.replace(/^https?:\/\/[^/]+/, "https://x.com"),
        publishedAt,
      };
    })
    .filter(Boolean);

  return { handle, posts };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

class XFeedService {
  constructor({ cache, instances } = {}) {
    this.cache = cache;
    this.instances = instances && instances.length ? instances : NITTER_INSTANCES;
  }

  async _fetchFromInstance(instance, handle) {
    const response = await fetchWithTimeout(`${instance}/${handle}/rss`, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      throw createServiceError(`${instance} returned ${response.status} for @${handle}`, 502);
    }
    const xml = await response.text();
    if (!xml.includes("<item>")) {
      throw createServiceError(`${instance} returned no feed items for @${handle}`, 502);
    }
    return parseFeedXml(xml, handle);
  }

  async getAccountFeed(handle) {
    return this.cache.getOrLoad(`x:feed:${handle}`, FEED_TTL_MS, async () => {
      const preferredKey = `x:instance:${handle}`;
      const preferred = this.cache.get(preferredKey);
      const ordered = preferred
        ? [preferred, ...this.instances.filter((i) => i !== preferred)]
        : this.instances;

      let lastErr = null;
      for (const instance of ordered) {
        try {
          const feed = await this._fetchFromInstance(instance, handle);
          this.cache.set(preferredKey, instance, WORKING_INSTANCE_TTL_MS);
          return feed;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || createServiceError(`Could not load a feed for @${handle}`, 502);
    });
  }
}

module.exports = { XFeedService };
