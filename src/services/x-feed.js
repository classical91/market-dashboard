const { createServiceError } = require("../utils/errors");

/**
 * X (Twitter) has no free official RSS/API. This pulls from the same
 * undocumented syndication endpoint X's own `widgets.js` embed uses to
 * render a profile timeline, since public Nitter-style mirrors have largely
 * been shut down. It's unofficial and could change or stop working without
 * notice — there is no supported alternative that doesn't require a paid
 * X API plan.
 */
const SYNDICATION_URL = (handle) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`;

const REQUEST_TIMEOUT_MS = 5000;
const FEED_TTL_MS = 15 * 60 * 1000;
const LATEST_GOOD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_ACCOUNT = 8;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function extractNextData(html) {
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Finds the first photo attached to a tweet by walking its own subtree for
 * media objects (entities.media / extended_entities.media both contain
 * `media_url_https` + a `type` of "photo" on the syndication payload).
 */
function firstPhotoUrl(node, seen) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstPhotoUrl(item, seen);
      if (found) return found;
    }
    return null;
  }
  if (seen.has(node)) return null;
  seen.add(node);
  if (typeof node.media_url_https === "string" && (!node.type || node.type === "photo")) {
    return node.media_url_https;
  }
  for (const value of Object.values(node)) {
    const found = firstPhotoUrl(value, seen);
    if (found) return found;
  }
  return null;
}

/**
 * The exact JSON shape isn't documented and can shift, so rather than
 * hardcoding a path, walk the whole tree looking for tweet-shaped objects
 * (full_text/text + id_str + created_at).
 */
function collectTweets(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectTweets(item, out, seen));
    return;
  }
  const text = typeof node.full_text === "string" ? node.full_text : node.text;
  const idStr = node.id_str || (typeof node.id === "string" ? node.id : null);
  const createdAt = node.created_at;
  if (typeof text === "string" && typeof idStr === "string" && typeof createdAt === "string" && !seen.has(idStr)) {
    seen.add(idStr);
    out.push({ idStr, text, createdAt, image: firstPhotoUrl(node, new Set()) });
  }
  Object.values(node).forEach((value) => collectTweets(value, out, seen));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

class XFeedService {
  constructor({ cache } = {}) {
    this.cache = cache;
  }

  async _fetchFeed(handle) {
    const response = await fetchWithTimeout(SYNDICATION_URL(handle), REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      throw createServiceError(`Syndication endpoint returned ${response.status} for @${handle}`, 502);
    }

    const html = await response.text();
    const data = extractNextData(html);
    if (!data) {
      throw createServiceError(`Could not parse timeline data for @${handle}`, 502);
    }

    const tweets = [];
    collectTweets(data, tweets, new Set());
    if (!tweets.length) {
      throw createServiceError(`No posts found for @${handle}`, 502);
    }

    const posts = tweets
      .map((tweet) => ({
        id: tweet.idStr,
        text: tweet.text,
        image: tweet.image || null,
        url: `https://x.com/${handle}/status/${tweet.idStr}`,
        publishedAt: new Date(tweet.createdAt).toISOString(),
      }))
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_POSTS_PER_ACCOUNT);

    return { handle, posts };
  }

  /**
   * Keeps posts on screen across refreshes/restarts instead of them
   * disappearing: successful fetches are also written to a long-lived
   * "last known good" entry, which is served as a fallback whenever a fresh
   * fetch fails (X's syndication endpoint is unofficial and can be flaky).
   */
  async getAccountFeed(handle) {
    const latestGoodKey = `x:feed:latest:${handle}`;
    try {
      return await this.cache.getOrLoad(`x:feed:${handle}`, FEED_TTL_MS, async () => {
        const feed = await this._fetchFeed(handle);
        this.cache.set(latestGoodKey, feed, LATEST_GOOD_TTL_MS);
        return feed;
      });
    } catch (err) {
      const lastKnownGood = this.cache.get(latestGoodKey);
      if (lastKnownGood) return lastKnownGood;
      throw err;
    }
  }
}

module.exports = { XFeedService };
