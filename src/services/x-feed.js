const { createServiceError } = require("../utils/errors");

/**
 * Prefer the official X API when a bearer token is configured. The
 * syndication endpoint remains as a fallback because some deployments may not
 * have paid X API access yet.
 */
const X_API_URL = "https://api.x.com/2/tweets/search/recent";
const SYNDICATION_URL = (handle) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`;

const REQUEST_TIMEOUT_MS = 10000;
const FEED_TTL_MS = 15 * 60 * 1000;
const LATEST_GOOD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_ACCOUNT = 8;
const MAX_FALLBACK_POST_AGE_MS = 45 * 24 * 60 * 60 * 1000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function xBearerToken() {
  return (
    process.env.X_API_BEARER_TOKEN ||
    process.env.X_BEARER_TOKEN ||
    process.env.TWITTER_BEARER_TOKEN ||
    ""
  ).trim();
}

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

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function mapXApiPost(tweet, usersById, mediaByKey, handle) {
  const user = tweet.author_id ? usersById.get(tweet.author_id) : null;
  const username = user?.username || handle;
  const mediaKey = Array.isArray(tweet.attachments?.media_keys) ? tweet.attachments.media_keys[0] : null;
  const media = mediaKey ? mediaByKey.get(mediaKey) : null;
  const image =
    media?.type === "photo" ? media.url :
    media?.type === "video" || media?.type === "animated_gif" ? media.preview_image_url :
    null;

  return {
    id: tweet.id,
    text: tweet.text,
    image: image || null,
    url: `https://x.com/${username}/status/${tweet.id}`,
    publishedAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : null,
  };
}

function newestPostAgeMs(feed) {
  const newest = (feed.posts || []).reduce((latest, post) => {
    const time = post.publishedAt ? new Date(post.publishedAt).getTime() : 0;
    return Math.max(latest, Number.isFinite(time) ? time : 0);
  }, 0);
  return newest ? Date.now() - newest : Infinity;
}

function ensureFallbackIsRecent(feed, handle) {
  if (newestPostAgeMs(feed) <= MAX_FALLBACK_POST_AGE_MS) return feed;
  throw createServiceError(`Fallback X feed for @${handle} is stale`, 502);
}

class XFeedService {
  constructor({ cache } = {}) {
    this.cache = cache;
  }

  async _fetchApiFeed(handle) {
    const token = xBearerToken();
    if (!token) {
      throw createServiceError("X API bearer token is not configured", 503);
    }

    const params = new URLSearchParams({
      query: `from:${handle} -is:retweet -is:reply`,
      max_results: String(Math.max(10, MAX_POSTS_PER_ACCOUNT)),
      sort_order: "recency",
      "tweet.fields": "author_id,created_at,attachments",
      expansions: "author_id,attachments.media_keys",
      "user.fields": "name,username",
      "media.fields": "type,url,preview_image_url",
    });

    const response = await fetchJsonWithTimeout(`${X_API_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "MarketDashboard/1.0",
      },
    });
    if (!response.ok) {
      throw createServiceError(`X API returned ${response.status} for @${handle}`, 502);
    }

    const data = await response.json();
    const tweets = Array.isArray(data.data) ? data.data : [];
    if (!tweets.length) {
      throw createServiceError(`No X API posts found for @${handle}`, 502);
    }

    const usersById = new Map((data.includes?.users || []).map((user) => [user.id, user]));
    const mediaByKey = new Map((data.includes?.media || []).map((media) => [media.media_key, media]));
    const posts = tweets
      .filter((tweet) => tweet.id && tweet.text)
      .map((tweet) => mapXApiPost(tweet, usersById, mediaByKey, handle))
      .filter((post) => post.publishedAt)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_POSTS_PER_ACCOUNT);

    if (!posts.length) {
      throw createServiceError(`No usable X API posts found for @${handle}`, 502);
    }

    return { handle, posts };
  }

  async _fetchFeed(handle) {
    if (xBearerToken()) {
      try {
        return await this._fetchApiFeed(handle);
      } catch (err) {
        // Fall through to syndication. It is less reliable, but better than
        // blanking the whole X Intelligence page during an API hiccup.
      }
    }

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

    return ensureFallbackIsRecent({ handle, posts, source: "syndication" }, handle);
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
      if (lastKnownGood && newestPostAgeMs(lastKnownGood) <= MAX_FALLBACK_POST_AGE_MS) return lastKnownGood;
      throw err;
    }
  }
}

module.exports = { XFeedService };
