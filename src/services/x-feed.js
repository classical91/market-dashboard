const { createServiceError } = require("../utils/errors");

/**
 * Prefer the official X API when a bearer token is configured. The
 * syndication endpoint remains as a fallback because some deployments may not
 * have paid X API access yet.
 */
const X_API_URL = "https://api.x.com/2/tweets/search/recent";
const X_USER_LOOKUP_URL = (handle) =>
  `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`;
const X_USER_TIMELINE_URL = (userId) =>
  `https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`;
const SYNDICATION_URL = (handle) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`;

const REQUEST_TIMEOUT_MS = 10000;
const FEED_TTL_MS = 15 * 60 * 1000;
const LATEST_GOOD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// User IDs never change, so cache the handle -> ID mapping for a long time.
const USER_ID_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_ACCOUNT = 8;
const MAX_FALLBACK_POST_AGE_MS = 45 * 24 * 60 * 60 * 1000;
// Recent-search query length cap on the Basic tier.
const MAX_QUERY_LENGTH = 512;
const MAX_RESULTS_PER_BATCH = 100;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function xBearerToken() {
  const raw = (
    process.env.X_API_BEARER_TOKEN ||
    process.env.X_BEARER_TOKEN ||
    process.env.TWITTER_BEARER_TOKEN ||
    ""
  ).trim();
  // Tolerate common paste mistakes: surrounding quotes and a "Bearer " prefix.
  return raw.replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * A 401/403 from the X API is a configuration problem, not a transient
 * failure — point at the likely cause so it is obvious from the logs.
 */
function apiStatusHint(status) {
  if (status === 401) {
    return " (bearer token rejected — check X_API_BEARER_TOKEN is the app's Bearer Token, freshly copied, with no quotes)";
  }
  if (status === 403) {
    return " (token valid but access denied — recent search needs a paid X API plan and the app must be attached to a Project)";
  }
  if (status === 429) {
    return " (rate limited — too many requests or monthly post cap reached)";
  }
  return "";
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

const TWEET_LOOKUP_PARAMS = {
  "tweet.fields": "author_id,created_at,attachments",
  expansions: "author_id,attachments.media_keys",
  "user.fields": "name,username",
  "media.fields": "type,url,preview_image_url",
};

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

function batchQuery(handles) {
  const terms = handles.map((handle) => `from:${handle}`).join(" OR ");
  return `(${terms}) -is:retweet -is:reply`;
}

/**
 * Packs handles into as few recent-search queries as fit under the query
 * length cap, so a page refresh costs a couple of API requests instead of
 * one per account (which blows through the per-15-minute rate limit).
 */
function buildQueryBatches(handles) {
  const batches = [];
  let current = [];
  for (const handle of handles) {
    const candidate = current.concat(handle);
    if (current.length && batchQuery(candidate).length > MAX_QUERY_LENGTH) {
      batches.push(current);
      current = [handle];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function ensureFallbackIsRecent(feed, handle) {
  if (newestPostAgeMs(feed) <= MAX_FALLBACK_POST_AGE_MS) return feed;
  throw createServiceError(`Fallback X feed for @${handle} is stale`, 502);
}

class XFeedService {
  constructor({ cache } = {}) {
    this.cache = cache;
    this._inflightBatches = new Map();
    this._inflightTimelines = new Map();
  }

  /**
   * One recent-search request covering every handle in the batch. Returns
   * feeds as a Map of handle -> feed (handles with no posts in the search
   * window map to an empty feed) plus a `truncated` flag: when the response
   * filled a whole page, an empty feed may just mean the handle was crowded
   * out by higher-volume accounts rather than genuinely quiet.
   */
  async _fetchApiBatch(handles) {
    const token = xBearerToken();
    if (!token) {
      throw createServiceError("X API bearer token is not configured", 503);
    }

    const maxResults = handles.length === 1 ? 10 : MAX_RESULTS_PER_BATCH;
    const params = new URLSearchParams({
      query: batchQuery(handles),
      max_results: String(maxResults),
      sort_order: "recency",
      ...TWEET_LOOKUP_PARAMS,
    });

    const response = await fetchJsonWithTimeout(`${X_API_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "MarketDashboard/1.0",
      },
    });
    if (!response.ok) {
      throw createServiceError(
        `X API returned ${response.status} for batch of ${handles.length} handles${apiStatusHint(response.status)}`,
        502,
      );
    }

    const data = await response.json();
    const tweets = Array.isArray(data.data) ? data.data : [];
    const usersById = new Map((data.includes?.users || []).map((user) => [user.id, user]));
    const mediaByKey = new Map((data.includes?.media || []).map((media) => [media.media_key, media]));

    const postsByHandle = new Map(handles.map((handle) => [handle.toLowerCase(), []]));
    for (const tweet of tweets) {
      if (!tweet.id || !tweet.text) continue;
      const username = usersById.get(tweet.author_id)?.username;
      const bucket = username ? postsByHandle.get(username.toLowerCase()) : null;
      if (bucket) bucket.push(mapXApiPost(tweet, usersById, mediaByKey, username));
    }

    const feeds = new Map();
    for (const handle of handles) {
      const posts = postsByHandle
        .get(handle.toLowerCase())
        .filter((post) => post.publishedAt)
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, MAX_POSTS_PER_ACCOUNT);
      feeds.set(handle, { handle, posts, source: "api" });
    }
    const truncated = Boolean(data.meta?.next_token) || tweets.length >= maxResults;
    return { feeds, truncated };
  }

  _fetchApiBatchDeduped(handles) {
    const key = handles.join(",");
    const inflight = this._inflightBatches.get(key);
    if (inflight) return inflight;

    const pending = this._fetchApiBatch(handles).finally(() => {
      this._inflightBatches.delete(key);
    });
    this._inflightBatches.set(key, pending);
    return pending;
  }

  async _lookupUserId(handle) {
    const cacheKey = `x:userid:${handle.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const response = await fetchJsonWithTimeout(X_USER_LOOKUP_URL(handle), {
      headers: {
        Authorization: `Bearer ${xBearerToken()}`,
        "User-Agent": "MarketDashboard/1.0",
      },
    });
    if (!response.ok) {
      throw createServiceError(
        `X API returned ${response.status} looking up @${handle}${apiStatusHint(response.status)}`,
        502,
      );
    }
    const data = await response.json();
    const userId = data.data?.id;
    if (!userId) {
      throw createServiceError(`X API returned no user for @${handle}`, 502);
    }
    this.cache.set(cacheKey, userId, USER_ID_TTL_MS);
    return userId;
  }

  /**
   * Recent search only covers the last ~7 days, so an account that posts
   * infrequently comes back empty even though it has a perfectly good
   * timeline. The user-timeline endpoint returns the account's latest posts
   * regardless of age, at the cost of two extra requests (user lookup is
   * cached long-term, so usually one).
   */
  async _fetchTimelineFeed(handle) {
    const token = xBearerToken();
    if (!token) {
      throw createServiceError("X API bearer token is not configured", 503);
    }

    const userId = await this._lookupUserId(handle);
    const params = new URLSearchParams({
      max_results: "10",
      exclude: "retweets,replies",
      ...TWEET_LOOKUP_PARAMS,
    });
    const response = await fetchJsonWithTimeout(`${X_USER_TIMELINE_URL(userId)}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "MarketDashboard/1.0",
      },
    });
    if (!response.ok) {
      throw createServiceError(
        `X API returned ${response.status} for @${handle}'s timeline${apiStatusHint(response.status)}`,
        502,
      );
    }

    const data = await response.json();
    const tweets = Array.isArray(data.data) ? data.data : [];
    const usersById = new Map((data.includes?.users || []).map((user) => [user.id, user]));
    const mediaByKey = new Map((data.includes?.media || []).map((media) => [media.media_key, media]));

    const posts = tweets
      .filter((tweet) => tweet.id && tweet.text)
      .map((tweet) => mapXApiPost(tweet, usersById, mediaByKey, handle))
      .filter((post) => post.publishedAt)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_POSTS_PER_ACCOUNT);

    return { handle, posts, source: "api-timeline" };
  }

  _fetchTimelineFeedDeduped(handle) {
    const inflight = this._inflightTimelines.get(handle);
    if (inflight) return inflight;

    const pending = this._fetchTimelineFeed(handle).finally(() => {
      this._inflightTimelines.delete(handle);
    });
    this._inflightTimelines.set(handle, pending);
    return pending;
  }

  async _fetchSyndicationFeed(handle) {
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

  _cacheFreshFeed(handle, feed) {
    this.cache.set(`x:feed:${handle}`, feed, FEED_TTL_MS);
    this.cache.set(`x:feed:latest:${handle}`, feed, LATEST_GOOD_TTL_MS);
  }

  /**
   * Serves the long-lived "last known good" entry so posts stay on screen
   * across refreshes/restarts when a fresh fetch fails, marked stale so the
   * client can tell it apart from a live feed.
   */
  _lastKnownGoodFeed(handle) {
    const lastKnownGood = this.cache.get(`x:feed:latest:${handle}`);
    if (lastKnownGood && newestPostAgeMs(lastKnownGood) <= MAX_FALLBACK_POST_AGE_MS) {
      return { ...lastKnownGood, source: "cache", stale: true };
    }
    return null;
  }

  async _fallbackFeed(handle, reason) {
    if (xBearerToken()) {
      try {
        const feed = await this._fetchTimelineFeedDeduped(handle);
        if (feed.posts.length) {
          this._cacheFreshFeed(handle, feed);
          return feed;
        }
      } catch (err) {
        console.warn(`[x-feed] @${handle}: ${reason}; timeline fallback failed: ${err.message}`);
      }
    }

    try {
      const feed = await this._fetchSyndicationFeed(handle);
      this._cacheFreshFeed(handle, feed);
      return feed;
    } catch (err) {
      const lastKnownGood = this._lastKnownGoodFeed(handle);
      if (lastKnownGood) return lastKnownGood;
      console.warn(`[x-feed] @${handle}: ${reason}; syndication fallback failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Fetches feeds for all handles at once. Fresh cache entries are served
   * directly; the remaining handles are packed into batched X API queries.
   * Handles the API returns nothing for (quiet account, rate limit, missing
   * token) fall back to the account's user timeline, then syndication, then
   * the last-known-good cache.
   */
  async getAccountFeeds(handles) {
    const feeds = new Map();
    const misses = [];
    for (const handle of handles) {
      const cached = this.cache.get(`x:feed:${handle}`);
      if (cached) feeds.set(handle, cached);
      else misses.push(handle);
    }
    if (!misses.length) return feeds;

    const apiFailures = new Map();
    if (xBearerToken()) {
      const batches = buildQueryBatches(misses);
      const settled = await Promise.allSettled(
        batches.map((batch) => this._fetchApiBatchDeduped(batch)),
      );
      const crowdedOut = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          for (const [handle, feed] of result.value.feeds) {
            if (feed.posts.length) {
              this._cacheFreshFeed(handle, feed);
              feeds.set(handle, feed);
            } else if (result.value.truncated) {
              // A full page sorted by recency can be dominated by one
              // high-volume account (e.g. Barchart), leaving quieter handles
              // with zero posts even though they tweeted recently.
              crowdedOut.push(handle);
            }
          }
          return;
        }
        const message = result.reason?.message || "X API request failed";
        console.warn(`[x-feed] X API batch failed (${batches[index].join(", ")}): ${message}`);
        batches[index].forEach((handle) => apiFailures.set(handle, message));
      });

      if (crowdedOut.length) {
        console.warn(
          `[x-feed] batch page was full; re-fetching crowded-out handles individually: ${crowdedOut.join(", ")}`,
        );
        const topUps = await Promise.allSettled(
          crowdedOut.map((handle) => this._fetchApiBatchDeduped([handle])),
        );
        topUps.forEach((result, index) => {
          const handle = crowdedOut[index];
          if (result.status === "fulfilled") {
            const feed = result.value.feeds.get(handle);
            if (feed.posts.length) {
              this._cacheFreshFeed(handle, feed);
              feeds.set(handle, feed);
            }
            return;
          }
          const message = result.reason?.message || "X API request failed";
          console.warn(`[x-feed] X API top-up failed for @${handle}: ${message}`);
          apiFailures.set(handle, message);
        });
      }
    }

    await Promise.all(
      misses
        .filter((handle) => !feeds.has(handle))
        .map(async (handle) => {
          const reason = apiFailures.get(handle) || "no recent X API posts";
          try {
            feeds.set(handle, await this._fallbackFeed(handle, reason));
          } catch (err) {
            feeds.set(handle, { handle, posts: null, error: err.message });
          }
        }),
    );
    return feeds;
  }

  async getAccountFeed(handle) {
    const feeds = await this.getAccountFeeds([handle]);
    const feed = feeds.get(handle);
    if (feed?.error) throw createServiceError(feed.error, 502);
    return feed;
  }
}

module.exports = { XFeedService };
