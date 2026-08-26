const { createServiceError } = require("../utils/errors");

/**
 * Prefer the official X API when a bearer token is configured. The
 * syndication endpoint stays on as a best-effort emergency fallback only: it
 * is unofficial, unversioned and rate limits hard, so nothing in the
 * freshness contract below depends on it succeeding.
 *
 * The central invariant of this module: an old post may be perfectly valid,
 * but old *unchecked* data must never be presented as live. Every feed that
 * leaves this service therefore carries when it was last attempted, when it
 * was last successfully fetched, which provider answered, and what state that
 * provider is in — separately from how old its newest post happens to be.
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
// Purely a *content* label: posts older than this are marked archival so the
// UI can say so. It is deliberately NOT a health signal — an account that has
// not posted in two months still has a perfectly fresh feed the moment we
// successfully check it.
const ARCHIVAL_POST_AGE_MS = 45 * 24 * 60 * 60 * 1000;
// Recent-search query length cap for self-serve API access.
const MAX_QUERY_LENGTH = 512;
const MAX_RESULTS_PER_BATCH = 100;
// Recent search only indexes ~7 days; a since_id older than that is rejected
// with a 400, so only poll incrementally when the anchor post is younger.
const SINCE_ID_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

// Which upstream answered.
const PROVIDER_X_API = "x-api";
const PROVIDER_X_TIMELINE = "x-api-timeline";
const PROVIDER_SYNDICATION = "syndication";
const PROVIDER_CACHE = "cache";

// How that upstream is behaving. Distinct from dataState: a provider can be
// down (`auth_failed`) while the feed we serve is merely `stale`.
const STATE_OK = "ok";
const STATE_NOT_CONFIGURED = "not_configured";
const STATE_AUTH_FAILED = "auth_failed";
const STATE_FORBIDDEN = "forbidden";
const STATE_RATE_LIMITED = "rate_limited";
const STATE_TIMEOUT = "timeout";
const STATE_PARSE_ERROR = "parse_error";
const STATE_NETWORK_ERROR = "network_error";
const STATE_UPSTREAM_ERROR = "upstream_error";
const STATE_CIRCUIT_OPEN = "circuit_open";
const STATE_NO_DATA = "no_data";

// What the *data* we are serving is worth.
//   live        — confirmed current by a successful check just now
//   degraded    — current, but only the emergency fallback could confirm it
//   stale       — served from cache; the last check did not succeed
//   unavailable — nothing to serve
const DATA_LIVE = "live";
const DATA_DEGRADED = "degraded";
const DATA_STALE = "stale";
const DATA_UNAVAILABLE = "unavailable";

// A rejected credential cannot fix itself within a refresh, and every further
// official call spends quota to be told the same thing. Hold the circuit open
// long enough to stop the cascade, short enough that a repaired token
// recovers without a redeploy.
const AUTH_CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;
// X's own rate-limit windows are 15 minutes; Retry-After wins where sent.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const SYNDICATION_COOLDOWN_MS = 10 * 60 * 1000;
// Syndication is unofficial and unmetered by us — 22 accounts hitting it at
// once is what earns the 429 in the first place.
const SYNDICATION_MAX_CONCURRENCY = 3;

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
    return " (token valid but access denied — the app must be attached to a Project and the account needs available X API credits)";
  }
  if (status === 429) {
    return " (rate limited — too many requests, or the monthly post-read cap is reached)";
  }
  return "";
}

/**
 * Maps an upstream HTTP status onto a provider state. The distinction that
 * matters downstream is "this will keep failing until a human changes
 * something" (auth/forbidden) versus "this may work again shortly"
 * (rate limit, timeout, 5xx).
 */
function classifyStatus(status) {
  if (status === 401) return STATE_AUTH_FAILED;
  if (status === 403) return STATE_FORBIDDEN;
  if (status === 429) return STATE_RATE_LIMITED;
  return STATE_UPSTREAM_ERROR;
}

/** Classifies a thrown error (transport-level, or one we raised ourselves). */
function classifyThrown(err) {
  if (err?.providerState) return err.providerState;
  const name = err?.name || "";
  if (name === "AbortError" || name === "TimeoutError") return STATE_TIMEOUT;
  if (name === "SyntaxError") return STATE_PARSE_ERROR;
  if (name === "TypeError") return STATE_NETWORK_ERROR;
  return STATE_UPSTREAM_ERROR;
}

function upstreamError(message, { providerState, status, retryAfterMs } = {}) {
  const error = createServiceError(message, 502);
  error.providerState = providerState || STATE_UPSTREAM_ERROR;
  if (status) error.upstreamStatus = status;
  if (retryAfterMs) error.retryAfterMs = retryAfterMs;
  return error;
}

/**
 * Honours whatever the upstream told us about when to come back, so a
 * cooldown reflects the provider's own window rather than a guess.
 */
function retryAfterMsFrom(response) {
  const get = response?.headers?.get?.bind(response.headers);
  if (!get) return null;

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }

  const reset = get("x-rate-limit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) return Math.max(0, epochSeconds * 1000 - Date.now());
  }
  return null;
}

/**
 * A one-provider breaker. Open means "do not spend another request on this
 * provider yet" — the point is that one known-bad credential cannot cascade
 * into a request per account.
 */
class ProviderCircuit {
  constructor(name) {
    this.name = name;
    this._openUntil = 0;
    this._state = null;
    this._reason = null;
    this._openedAt = null;
  }

  isOpen(now = Date.now()) {
    return this._openUntil > now;
  }

  open(state, reason, cooldownMs) {
    const now = Date.now();
    const until = now + Math.max(0, cooldownMs);
    // Never shorten an open circuit: the earliest failure knows best.
    if (until <= this._openUntil) return;
    this._openUntil = until;
    this._state = state;
    this._reason = reason;
    this._openedAt = now;
    console.warn(
      `[x-feed] ${this.name} circuit open for ${Math.round(cooldownMs / 1000)}s (${state}): ${reason}`,
    );
  }

  reset() {
    this._openUntil = 0;
    this._state = null;
    this._reason = null;
    this._openedAt = null;
  }

  /** The error a caller should fail with instead of making the request. */
  rejection(label) {
    const seconds = Math.max(0, Math.ceil((this._openUntil - Date.now()) / 1000));
    return upstreamError(
      `${label} skipped: ${this.name} unavailable (${this._state}) for another ${seconds}s — ${this._reason}`,
      { providerState: STATE_CIRCUIT_OPEN },
    );
  }

  snapshot() {
    return {
      provider: this.name,
      open: this.isOpen(),
      state: this._state,
      reason: this._reason,
      openedAt: this._openedAt ? new Date(this._openedAt).toISOString() : null,
      retryAt: this._openUntil ? new Date(this._openUntil).toISOString() : null,
    };
  }
}

/** Bounds how many fallback requests may be in flight at once. */
class ConcurrencyLimit {
  constructor(limit) {
    this.limit = limit;
    this._active = 0;
    this._waiting = [];
  }

  async run(task) {
    if (this._active >= this.limit) {
      await new Promise((resolve) => this._waiting.push(resolve));
    }
    this._active += 1;
    try {
      return await task();
    } finally {
      this._active -= 1;
      const next = this._waiting.shift();
      if (next) next();
    }
  }
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
  "tweet.fields": "author_id,created_at,attachments,note_tweet",
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
    // Long-form posts (>280 chars) arrive truncated in `text`; the full body
    // lives in `note_tweet` when requested.
    text: tweet.note_tweet?.text || tweet.text,
    image: image || null,
    url: `https://x.com/${username}/status/${tweet.id}`,
    publishedAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : null,
  };
}

function newestPostTime(posts) {
  return (posts || []).reduce((latest, post) => {
    const time = post.publishedAt ? new Date(post.publishedAt).getTime() : 0;
    return Math.max(latest, Number.isFinite(time) ? time : 0);
  }, 0);
}

function newestPostAgeMs(feed) {
  const newest = newestPostTime(feed.posts);
  return newest ? Date.now() - newest : Infinity;
}

/**
 * Stamps a feed with the freshness contract. `newestPostAt` describes the
 * content; `lastAttemptAt` / `lastSuccessfulFetchAt` describe the data. They
 * are reported separately on purpose — conflating them is what let a quiet
 * account look like an outage, and an outage look like a quiet account.
 */
function decorateFeed(feed, { provider, providerState, dataState, lastSuccessfulFetchAt, staleReason }) {
  const now = new Date().toISOString();
  const newestAt = newestPostTime(feed.posts);
  return {
    ...feed,
    provider,
    providerState,
    dataState,
    lastAttemptAt: now,
    lastSuccessfulFetchAt: lastSuccessfulFetchAt || null,
    newestPostAt: newestAt ? new Date(newestAt).toISOString() : null,
    // Content age, not health: an archival feed can still be perfectly live.
    archival: newestAt ? Date.now() - newestAt > ARCHIVAL_POST_AGE_MS : false,
    stale: dataState === DATA_STALE,
    ...(staleReason ? { staleReason } : {}),
  };
}

/** A feed we just confirmed against a provider. */
function liveFeed(feed, provider, dataState = DATA_LIVE) {
  return decorateFeed(feed, {
    provider,
    providerState: STATE_OK,
    dataState,
    lastSuccessfulFetchAt: new Date().toISOString(),
  });
}

// Post IDs are 64-bit snowflakes serialized as strings; compare as BigInt.
function comparePostIds(a, b) {
  try {
    const diff = BigInt(a) - BigInt(b);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  } catch {
    return 0;
  }
}

function newestPostId(posts) {
  let newest = null;
  for (const post of posts || []) {
    if (post.id && (!newest || comparePostIds(post.id, newest) > 0)) newest = post.id;
  }
  return newest;
}

function mergePosts(fresh, prior) {
  const seen = new Set(fresh.map((post) => post.id));
  return fresh
    .concat((prior || []).filter((post) => !seen.has(post.id)))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, MAX_POSTS_PER_ACCOUNT);
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

class XFeedService {
  constructor({ cache } = {}) {
    this.cache = cache;
    this._inflightBatches = new Map();
    this._inflightTimelines = new Map();
    this._officialCircuit = new ProviderCircuit("x-api");
    this._syndicationCircuit = new ProviderCircuit("syndication");
    this._syndicationLimit = new ConcurrencyLimit(SYNDICATION_MAX_CONCURRENCY);
  }

  /**
   * Trips the official-X breaker on the errors that cannot resolve themselves
   * inside a refresh. Called from wherever the status is first read, so the
   * first response to come back protects every call still to be made.
   */
  _noteOfficialFailure(state, message, retryAfterMs) {
    if (state === STATE_AUTH_FAILED || state === STATE_FORBIDDEN) {
      this._officialCircuit.open(state, message, AUTH_CIRCUIT_COOLDOWN_MS);
    } else if (state === STATE_RATE_LIMITED) {
      this._officialCircuit.open(state, message, retryAfterMs || RATE_LIMIT_COOLDOWN_MS);
    }
  }

  /** Health of both providers, for diagnostics and for the API contract. */
  providerHealth() {
    return {
      official: {
        ...this._officialCircuit.snapshot(),
        configured: Boolean(xBearerToken()),
      },
      syndication: this._syndicationCircuit.snapshot(),
    };
  }

  /**
   * Where the last-known-good feeds are persisted, and whether that store
   * survived the last boot. Without this, "the volume was never mounted" and
   * "the cache legitimately expired" look identical from the outside.
   */
  cacheDiagnostics() {
    if (typeof this.cache?.describe !== "function") {
      return { persistent: false, note: "In-memory cache: nothing survives a restart." };
    }
    return { persistent: true, ...this.cache.describe() };
  }

  /** Lets an operator clear a breaker after repairing the credential. */
  resetCircuits() {
    this._officialCircuit.reset();
    this._syndicationCircuit.reset();
    return this.providerHealth();
  }

  /**
   * One recent-search request covering every handle in the batch. Returns
   * feeds as a Map of handle -> feed (handles with no posts in the search
   * window map to an empty feed) plus a `truncated` flag: when the response
   * filled a whole page, an empty feed may just mean the handle was crowded
   * out by higher-volume accounts rather than genuinely quiet.
   */
  async _fetchApiBatch(handles, sinceId) {
    const token = xBearerToken();
    if (!token) {
      const error = createServiceError("X API bearer token is not configured", 503);
      error.providerState = STATE_NOT_CONFIGURED;
      throw error;
    }
    if (this._officialCircuit.isOpen()) {
      throw this._officialCircuit.rejection(`Batch of ${handles.length} handles`);
    }

    const maxResults = handles.length === 1 ? 10 : MAX_RESULTS_PER_BATCH;
    const params = new URLSearchParams({
      query: batchQuery(handles),
      max_results: String(maxResults),
      sort_order: "recency",
      ...(sinceId ? { since_id: sinceId } : {}),
      ...TWEET_LOOKUP_PARAMS,
    });

    const response = await fetchJsonWithTimeout(`${X_API_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "MarketDashboard/1.0",
      },
    });
    if (!response.ok) {
      const state = classifyStatus(response.status);
      const retryAfterMs = retryAfterMsFrom(response);
      const message = `X API returned ${response.status} for batch of ${handles.length} handles${apiStatusHint(response.status)}`;
      this._noteOfficialFailure(state, message, retryAfterMs);
      throw upstreamError(message, { providerState: state, status: response.status, retryAfterMs });
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

  _fetchApiBatchDeduped(handles, sinceId) {
    const key = `${handles.join(",")}@${sinceId || ""}`;
    const inflight = this._inflightBatches.get(key);
    if (inflight) return inflight;

    const pending = this._fetchApiBatch(handles, sinceId).finally(() => {
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
      const state = classifyStatus(response.status);
      const retryAfterMs = retryAfterMsFrom(response);
      const message = `X API returned ${response.status} looking up @${handle}${apiStatusHint(response.status)}`;
      this._noteOfficialFailure(state, message, retryAfterMs);
      throw upstreamError(message, { providerState: state, status: response.status, retryAfterMs });
    }
    const data = await response.json();
    const userId = data.data?.id;
    if (!userId) {
      throw upstreamError(`X API returned no user for @${handle}`, { providerState: STATE_NO_DATA });
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
      const error = createServiceError("X API bearer token is not configured", 503);
      error.providerState = STATE_NOT_CONFIGURED;
      throw error;
    }
    if (this._officialCircuit.isOpen()) {
      throw this._officialCircuit.rejection(`Timeline for @${handle}`);
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
      const state = classifyStatus(response.status);
      const retryAfterMs = retryAfterMsFrom(response);
      const message = `X API returned ${response.status} for @${handle}'s timeline${apiStatusHint(response.status)}`;
      this._noteOfficialFailure(state, message, retryAfterMs);
      throw upstreamError(message, { providerState: state, status: response.status, retryAfterMs });
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

  /**
   * Best-effort only, and deliberately throttled: a 429 here puts the whole
   * endpoint in cooldown rather than letting 22 accounts retry into it.
   */
  async _fetchSyndicationFeed(handle) {
    if (this._syndicationCircuit.isOpen()) {
      throw this._syndicationCircuit.rejection(`Syndication for @${handle}`);
    }

    // The whole exchange happens inside the slot — the request, its body, and
    // the cooldown a failure triggers. Releasing the slot before the failure
    // is recorded would hand it to a queued account that then fires a request
    // the cooldown already knows is doomed.
    const html = await this._syndicationLimit.run(async () => {
      // Re-checked here because the check above only saw the state at queue
      // time: with 22 accounts behind a cap of 3, most queue before the first
      // 429 has even landed.
      if (this._syndicationCircuit.isOpen()) {
        throw this._syndicationCircuit.rejection(`Syndication for @${handle}`);
      }

      const response = await fetchWithTimeout(SYNDICATION_URL(handle), REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        const state = classifyStatus(response.status);
        const message = `Syndication endpoint returned ${response.status} for @${handle}`;
        if (state === STATE_RATE_LIMITED) {
          this._syndicationCircuit.open(
            state,
            message,
            retryAfterMsFrom(response) || SYNDICATION_COOLDOWN_MS,
          );
        }
        throw upstreamError(message, { providerState: state, status: response.status });
      }
      return response.text();
    });

    const data = extractNextData(html);
    if (!data) {
      throw upstreamError(`Could not parse timeline data for @${handle}`, {
        providerState: STATE_PARSE_ERROR,
      });
    }

    const tweets = [];
    collectTweets(data, tweets, new Set());
    if (!tweets.length) {
      throw upstreamError(`No posts found for @${handle}`, { providerState: STATE_NO_DATA });
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

    // No age gate here any more. A successful fetch is fresh data even when
    // the account's newest post is months old; `decorateFeed` labels the
    // content as archival and the timestamps say when we last checked.
    return { handle, posts, source: "syndication" };
  }

  _cacheFreshFeed(handle, feed) {
    this.cache.set(`x:feed:${handle}`, feed, FEED_TTL_MS);
    this.cache.set(`x:feed:latest:${handle}`, feed, LATEST_GOOD_TTL_MS);
  }

  /**
   * Serves the long-lived "last known good" entry so posts stay on screen
   * across refreshes/restarts when a fresh fetch fails — marked stale, with
   * the timestamp of the last *successful* fetch, so neither the client nor
   * the reader can mistake it for a live feed.
   */
  _lastKnownGoodFeed(handle, { providerState, staleReason }) {
    const lastKnownGood = this.cache.get(`x:feed:latest:${handle}`);
    if (!lastKnownGood?.posts?.length) return null;
    return decorateFeed(
      { ...lastKnownGood, source: "cache" },
      {
        provider: PROVIDER_CACHE,
        providerState,
        dataState: DATA_STALE,
        // Preserved from the cached entry: when the data was really confirmed.
        lastSuccessfulFetchAt: lastKnownGood.lastSuccessfulFetchAt || null,
        staleReason,
      },
    );
  }

  async _fallbackFeed(handle, failure) {
    const reason = failure.reason;
    let providerState = failure.providerState || STATE_UPSTREAM_ERROR;

    // Skipped outright when the breaker is open: with a rejected credential
    // this is where one bad token turned into a request per account.
    if (xBearerToken() && !this._officialCircuit.isOpen()) {
      try {
        const feed = await this._fetchTimelineFeedDeduped(handle);
        if (feed.posts.length) {
          const live = liveFeed(feed, PROVIDER_X_TIMELINE);
          this._cacheFreshFeed(handle, live);
          return live;
        }
      } catch (err) {
        providerState = classifyThrown(err);
        console.warn(`[x-feed] @${handle}: ${reason}; timeline fallback failed: ${err.message}`);
      }
    }

    try {
      const feed = await this._fetchSyndicationFeed(handle);
      // Current, but only the unofficial fallback could confirm it.
      const degraded = liveFeed(feed, PROVIDER_SYNDICATION, DATA_DEGRADED);
      this._cacheFreshFeed(handle, degraded);
      return degraded;
    } catch (err) {
      const syndicationState = classifyThrown(err);
      const lastKnownGood = this._lastKnownGoodFeed(handle, {
        providerState,
        staleReason: reason,
      });
      if (lastKnownGood) return lastKnownGood;
      console.warn(`[x-feed] @${handle}: ${reason}; syndication fallback failed: ${err.message}`);
      err.providerState = syndicationState;
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
      // Poll incrementally where possible: a handle whose last known feed is
      // recent enough gets a since_id anchor, so recent search only returns
      // (and only bills against the monthly post cap) posts newer than what
      // we already have, instead of re-fetching the same page every refresh.
      const priorPosts = new Map();
      const anchors = new Map();
      for (const handle of misses) {
        const prior = this.cache.get(`x:feed:latest:${handle}`);
        if (!prior?.posts?.length) continue;
        priorPosts.set(handle, prior.posts);
        const anchor = newestPostId(prior.posts);
        if (anchor && newestPostAgeMs(prior) <= SINCE_ID_MAX_AGE_MS) anchors.set(handle, anchor);
      }
      const cacheMerged = (handle, freshPosts) => {
        const posts = mergePosts(freshPosts, priorPosts.get(handle));
        if (!posts.length) return false;
        // Reached here after a successful check, so this is live even when the
        // merge added nothing new and the newest post is days old: the
        // provider confirmed there is nothing newer.
        const feed = liveFeed({ handle, posts, source: "api" }, PROVIDER_X_API);
        this._cacheFreshFeed(handle, feed);
        feeds.set(handle, feed);
        return true;
      };

      const incremental = misses.filter((handle) => anchors.has(handle));
      const cold = misses.filter((handle) => !anchors.has(handle));
      const batches = [
        ...buildQueryBatches(incremental).map((batch) => ({
          handles: batch,
          // The oldest anchor in the batch, so no handle can miss a post.
          sinceId: batch
            .map((handle) => anchors.get(handle))
            .reduce((a, b) => (comparePostIds(a, b) <= 0 ? a : b)),
        })),
        ...buildQueryBatches(cold).map((batch) => ({ handles: batch, sinceId: null })),
      ];

      const settled = await Promise.allSettled(
        batches.map(({ handles: batchHandles, sinceId }) => this._fetchApiBatchDeduped(batchHandles, sinceId)),
      );
      const crowdedOut = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          for (const [handle, feed] of result.value.feeds) {
            if (!cacheMerged(handle, feed.posts) && result.value.truncated) {
              // A full page sorted by recency can be dominated by one
              // high-volume account (e.g. Barchart), leaving quieter handles
              // with zero posts even though they tweeted recently.
              crowdedOut.push(handle);
            }
          }
          return;
        }
        const message = result.reason?.message || "X API request failed";
        const providerState = classifyThrown(result.reason);
        console.warn(`[x-feed] X API batch failed (${batches[index].handles.join(", ")}): ${message}`);
        batches[index].handles.forEach((handle) =>
          apiFailures.set(handle, { reason: message, providerState }),
        );
      });

      // With the breaker open every top-up would be a guaranteed failure.
      if (crowdedOut.length && !this._officialCircuit.isOpen()) {
        console.warn(
          `[x-feed] batch page was full; re-fetching crowded-out handles individually: ${crowdedOut.join(", ")}`,
        );
        const topUps = await Promise.allSettled(
          crowdedOut.map((handle) => this._fetchApiBatchDeduped([handle], anchors.get(handle) || null)),
        );
        topUps.forEach((result, index) => {
          const handle = crowdedOut[index];
          if (result.status === "fulfilled") {
            cacheMerged(handle, result.value.feeds.get(handle).posts);
            return;
          }
          const message = result.reason?.message || "X API request failed";
          console.warn(`[x-feed] X API top-up failed for @${handle}: ${message}`);
          apiFailures.set(handle, { reason: message, providerState: classifyThrown(result.reason) });
        });
      }
    }

    await Promise.all(
      misses
        .filter((handle) => !feeds.has(handle))
        .map(async (handle) => {
          const failure = apiFailures.get(handle) || {
            reason: xBearerToken() ? "no recent X API posts" : "X API bearer token is not configured",
            providerState: xBearerToken() ? STATE_NO_DATA : STATE_NOT_CONFIGURED,
          };
          try {
            feeds.set(handle, await this._fallbackFeed(handle, failure));
          } catch (err) {
            feeds.set(handle, {
              handle,
              posts: null,
              error: err.message,
              provider: null,
              providerState: classifyThrown(err),
              dataState: DATA_UNAVAILABLE,
              lastAttemptAt: new Date().toISOString(),
              lastSuccessfulFetchAt: null,
              newestPostAt: null,
            });
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

// Exported so the route and its tests describe freshness with the same
// vocabulary the service uses, rather than re-spelling the strings.
const DATA_STATES = {
  LIVE: DATA_LIVE,
  DEGRADED: DATA_DEGRADED,
  STALE: DATA_STALE,
  UNAVAILABLE: DATA_UNAVAILABLE,
};

// Worst-first: the aggregate state of a set of feeds is the worst of them.
const DATA_STATE_SEVERITY = [DATA_LIVE, DATA_DEGRADED, DATA_STALE, DATA_UNAVAILABLE];

function worstDataState(states) {
  return states.reduce((worst, state) => {
    const rank = DATA_STATE_SEVERITY.indexOf(state);
    const worstRank = DATA_STATE_SEVERITY.indexOf(worst);
    return rank > worstRank ? state : worst;
  }, DATA_LIVE);
}

module.exports = { XFeedService, DATA_STATES, worstDataState };
