/**
 * YouTube Intelligence
 *
 * Hybrid data path, in preference order per channel:
 *
 *   1. YouTube Data API v3 (YOUTUBE_API_KEY) — uploads plus live/upcoming
 *      state, scheduled and actual start times.
 *   2. YouTube RSS (feeds/videos.xml?channel_id=UC...) — uploads only, free,
 *      no key. Requires a *known* channel ID.
 *   3. Last known good feed from cache, served stale, when both fail.
 *
 * Deliberately absent: scraping youtube.com/@handle HTML for a channel ID.
 * That is what used to run here, and it is what broke in production — from a
 * datacenter IP YouTube answers the handle page with a consent/bot-check
 * interstitial instead of the channel document, so the `"channelId":"UC..."`
 * match never fired and every channel failed at step one, before RSS was ever
 * reached.
 *
 * Quota shape (default 10,000 units/day). Per refresh *cycle*, not per page
 * view — everything below is cached server-side:
 *   channels.list       1 unit per channel   (24h TTL; uploads playlist ID is permanent)
 *   playlistItems.list  1 unit per channel   (10min TTL)
 *   videos.list         1 unit per 50 videos (2min TTL, batched across channels)
 * Four channels therefore cost ~5 units per 2-10 minutes, a few thousand units
 * a day even under constant refreshing. search.list is 100 units per call and
 * is never used on the request path — see `liveSearchEnabled` below.
 */

const { createServiceError } = require("../utils/errors");
const { isChannelId } = require("../config/youtube-channels");

const API_BASE = "https://www.googleapis.com/youtube/v3";
const RSS_URL = (channelId) =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

const DEFAULT_TTLS = {
  // Handle -> UC... never changes for a live channel, and a wrong answer here
  // breaks everything downstream, so this is cached hard.
  channelId: 30 * 24 * 60 * 60 * 1000,
  // Uploads playlist ID is permanent; title/avatar change rarely.
  channelMeta: 24 * 60 * 60 * 1000,
  uploads: 10 * 60 * 1000,
  // Live state is the one thing that genuinely moves minute to minute.
  videoStatus: 2 * 60 * 1000,
  // Served only when the live paths are all failing.
  lastGood: 24 * 60 * 60 * 1000,
  liveSearch: 30 * 60 * 1000,
};

const REQUEST_TIMEOUT_MS = 10000;
const MAX_VIDEO_IDS_PER_LOOKUP = 50;
const VIDEO_STATUS_CACHE_KEY = "yt:status";

/**
 * Coarse, safe-to-render failure reasons. The frontend gets one of these plus
 * a short sentence; the provider's own message stays in the server log.
 */
const FAILURE_REASONS = {
  MISSING_API_KEY: "missing-api-key",
  QUOTA_EXCEEDED: "quota-exceeded",
  API_REJECTED: "api-rejected",
  RSS_FAILED: "rss-failed",
  CHANNEL_ID_UNRESOLVED: "channel-id-unresolved",
};

const SAFE_MESSAGES = {
  [FAILURE_REASONS.MISSING_API_KEY]: "YouTube Data API key is not configured",
  [FAILURE_REASONS.QUOTA_EXCEEDED]: "YouTube API quota exhausted",
  [FAILURE_REASONS.API_REJECTED]: "YouTube API rejected the request",
  [FAILURE_REASONS.RSS_FAILED]: "YouTube feed is unavailable",
  [FAILURE_REASONS.CHANNEL_ID_UNRESOLVED]: "Channel ID could not be resolved",
};

/**
 * @param {string} reason  One of FAILURE_REASONS — rendered to the browser.
 * @param {string} detail  Full cause, logged server-side only.
 */
function feedError(reason, detail, statusCode = 502) {
  const error = createServiceError(SAFE_MESSAGES[reason] || "YouTube feed failed", statusCode);
  error.reason = reason;
  error.detail = detail || SAFE_MESSAGES[reason] || "";
  return error;
}

/** Never let an API key reach a log line, an error message or the browser. */
function redactKey(value) {
  return String(value || "").replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
}

function decodeXmlEntities(value) {
  if (!value) return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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

function bestThumbnail(thumbnails, videoId) {
  const picked =
    thumbnails?.maxres || thumbnails?.standard || thumbnails?.high || thumbnails?.medium || thumbnails?.default;
  return picked?.url || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null);
}

function toIso(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * `liveBroadcastContent` is the API's own live/upcoming/none flag, but it can
 * lag for a few minutes after a stream ends — an `actualEndTime` is the
 * unambiguous "this is a replay now" signal, so it wins.
 */
function classifyVideo(snippet, liveDetails) {
  if (liveDetails?.actualEndTime) return "video";
  const flag = snippet?.liveBroadcastContent;
  if (flag === "live") return "live";
  if (flag === "upcoming") return "upcoming";
  return "video";
}

function sortByPublishedDateDesc(items) {
  return items.slice().sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

class YouTubeIntelligenceService {
  /**
   * @param {object}  options
   * @param {object}  options.cache     MemoryCache-compatible store.
   * @param {object} [options.idCache]  Optional persistent store for resolved
   *   channel IDs. Persisting them is what lets the RSS fallback survive a
   *   restart on a deploy with no API key.
   * @param {string} [options.apiKey]   YOUTUBE_API_KEY.
   * @param {object} [options.logger]
   */
  constructor({
    cache,
    idCache,
    apiKey = "",
    channels = [],
    ttls = {},
    maxVideosPerChannel = 8,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    quotaCooldownMs = 30 * 60 * 1000,
    liveSearchEnabled = false,
    logger = console,
  } = {}) {
    this.cache = cache;
    this.idCache = idCache || cache;
    this.apiKey = String(apiKey || "").trim();
    this.channels = channels;
    this.ttls = { ...DEFAULT_TTLS, ...ttls };
    this.maxVideosPerChannel = maxVideosPerChannel;
    this.requestTimeoutMs = requestTimeoutMs;
    this.quotaCooldownMs = quotaCooldownMs;
    this.liveSearchEnabled = liveSearchEnabled;
    this.logger = logger;
    // Set when the API answers "out of quota", so an exhausted key is not
    // re-hit on every single refresh for the rest of the day.
    this.quotaCooldownUntil = 0;
    this.pendingStatusLookup = null;
  }

  get apiConfigured() {
    return Boolean(this.apiKey);
  }

  get quotaCoolingDown() {
    return this.quotaCooldownUntil > Date.now();
  }

  channelFor(handle) {
    return this.channels.find((channel) => channel.handle === handle) || null;
  }

  log(message) {
    this.logger?.warn?.(`[youtube] ${redactKey(message)}`);
  }

  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One YouTube Data API call. Throws a reason-tagged error for every failure
   * mode so callers can decide whether falling back to RSS is worthwhile.
   */
  async apiRequest(resource, params) {
    if (!this.apiConfigured) {
      throw feedError(FAILURE_REASONS.MISSING_API_KEY, "YOUTUBE_API_KEY is not set", 503);
    }

    if (this.quotaCoolingDown) {
      const seconds = Math.ceil((this.quotaCooldownUntil - Date.now()) / 1000);
      throw feedError(
        FAILURE_REASONS.QUOTA_EXCEEDED,
        `skipping ${resource}.list — quota cooldown active for another ${seconds}s`,
      );
    }

    const query = new URLSearchParams({ ...params, key: this.apiKey });
    const url = `${API_BASE}/${resource}?${query.toString()}`;

    let response;
    try {
      response = await this.fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    } catch (error) {
      const cause = error.name === "AbortError" ? `timed out after ${this.requestTimeoutMs}ms` : error.message;
      throw feedError(FAILURE_REASONS.API_REJECTED, `${resource}.list request failed: ${cause}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let apiReason = "";
      let apiMessage = "";
      try {
        const parsed = JSON.parse(body);
        apiReason = parsed?.error?.errors?.[0]?.reason || "";
        apiMessage = parsed?.error?.message || "";
      } catch {
        apiMessage = body.slice(0, 300);
      }

      const quotaReasons = ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"];
      if (quotaReasons.includes(apiReason) || response.status === 429) {
        this.quotaCooldownUntil = Date.now() + this.quotaCooldownMs;
        throw feedError(
          FAILURE_REASONS.QUOTA_EXCEEDED,
          `${resource}.list returned ${response.status} (${apiReason || "rate limited"}): ${apiMessage} — ` +
            `pausing API calls for ${Math.round(this.quotaCooldownMs / 60000)}m`,
        );
      }

      throw feedError(
        FAILURE_REASONS.API_REJECTED,
        `${resource}.list returned ${response.status}${apiReason ? ` (${apiReason})` : ""}: ${apiMessage}`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw feedError(FAILURE_REASONS.API_REJECTED, `${resource}.list returned unparseable JSON: ${error.message}`);
    }
  }

  /**
   * Configured ID > cached ID > channels.list lookup. Never scrapes.
   * 1 quota unit, and only on the very first miss for a handle.
   */
  async resolveChannelId(channel) {
    if (isChannelId(channel.channelId)) return channel.channelId;

    const cacheKey = `yt:channelId:${channel.handle}`;
    const cached = this.idCache.get(cacheKey);
    if (cached) return cached;

    if (!this.apiConfigured) {
      throw feedError(
        FAILURE_REASONS.CHANNEL_ID_UNRESOLVED,
        `no channel ID configured for @${channel.handle} and no API key to resolve one — ` +
          `set YOUTUBE_API_KEY, or add the UC... ID via YOUTUBE_CHANNEL_IDS`,
        503,
      );
    }

    return this.idCache.getOrLoad(cacheKey, this.ttls.channelId, async () => {
      // forHandle is the modern lookup; forUsername still resolves the legacy
      // /user/ names some older channels kept.
      for (const params of [{ forHandle: `@${channel.handle}` }, { forUsername: channel.handle }]) {
        const data = await this.apiRequest("channels", { part: "id", ...params });
        const id = data?.items?.[0]?.id;
        if (isChannelId(id)) return id;
      }

      throw feedError(
        FAILURE_REASONS.CHANNEL_ID_UNRESOLVED,
        `channels.list returned no channel for @${channel.handle} — the handle may have been renamed`,
      );
    });
  }

  /** channels.list: uploads playlist + display title. 1 unit, cached 24h. */
  async getChannelMeta(channelId) {
    return this.cache.getOrLoad(`yt:meta:${channelId}`, this.ttls.channelMeta, async () => {
      const data = await this.apiRequest("channels", { part: "snippet,contentDetails", id: channelId });
      const item = data?.items?.[0];
      if (!item) {
        throw feedError(FAILURE_REASONS.API_REJECTED, `channels.list returned no channel for id ${channelId}`);
      }

      return {
        channelId,
        title: item.snippet?.title || null,
        thumbnail: bestThumbnail(item.snippet?.thumbnails, null),
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
      };
    });
  }

  /**
   * playlistItems.list against the uploads playlist. 1 unit, cached 10min.
   * The uploads playlist carries scheduled and live streams too, which is why
   * live detection does not need search.list.
   */
  async getUploadsViaApi(channel, channelId) {
    const meta = await this.getChannelMeta(channelId);
    if (!meta.uploadsPlaylistId) {
      throw feedError(FAILURE_REASONS.API_REJECTED, `channel ${channelId} exposes no uploads playlist`);
    }

    return this.cache.getOrLoad(`yt:uploads:${channelId}`, this.ttls.uploads, async () => {
      const data = await this.apiRequest("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: meta.uploadsPlaylistId,
        maxResults: String(this.maxVideosPerChannel),
      });

      const videos = (data?.items || [])
        .map((item) => {
          const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
          if (!videoId) return null;
          return {
            id: videoId,
            title: item.snippet?.title || "Untitled",
            // videoPublishedAt is the video's own date; snippet.publishedAt is
            // when it was added to the playlist, which drifts on re-uploads.
            publishedAt: toIso(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt),
            url: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnail: bestThumbnail(item.snippet?.thumbnails, videoId),
          };
        })
        .filter(Boolean);

      return { channelId, title: meta.title || channel.label, videos, source: "api" };
    });
  }

  /** Free, keyless, uploads-only. Needs a known channel ID. */
  async getUploadsViaRss(channel, channelId) {
    return this.cache.getOrLoad(`yt:rss:${channelId}`, this.ttls.uploads, async () => {
      let response;
      try {
        response = await this.fetchWithTimeout(RSS_URL(channelId), { headers: { Accept: "application/xml" } });
      } catch (error) {
        const cause = error.name === "AbortError" ? `timed out after ${this.requestTimeoutMs}ms` : error.message;
        throw feedError(FAILURE_REASONS.RSS_FAILED, `RSS request failed for ${channelId}: ${cause}`);
      }

      if (!response.ok) {
        throw feedError(FAILURE_REASONS.RSS_FAILED, `RSS returned ${response.status} for ${channelId}`);
      }

      const xml = await response.text();
      const { channelTitle, videos } = parseFeedXml(xml);

      return {
        channelId,
        title: channelTitle || channel.label,
        videos: videos.slice(0, this.maxVideosPerChannel),
        source: "rss",
      };
    });
  }

  /**
   * videos.list for live/upcoming state and start times. 1 unit per 50 IDs,
   * batched across every channel, cached 2min. Returns {} rather than throwing
   * — losing live state should degrade the page, not fail it.
   */
  async getVideoStatuses(videoIds) {
    const ids = Array.from(new Set(videoIds.filter(Boolean))).sort();
    if (!ids.length || !this.apiConfigured) return {};

    // One fixed cache key holding {ids, statuses}, rather than a key derived
    // from the ID list: that set changes every time any channel publishes, and
    // MemoryCache only evicts on read, so a per-ID-set key would accumulate
    // dead entries for the life of the process. Comparing the covered IDs
    // gives the same hit rate for one entry. IDs are compared, not statuses,
    // because videos.list silently omits private or deleted videos.
    const cached = this.cache.get(VIDEO_STATUS_CACHE_KEY);
    if (cached && ids.every((id) => cached.ids.includes(id))) {
      return cached.statuses;
    }

    // Cheap inflight dedup so two concurrent page loads share one lookup.
    if (this.pendingStatusLookup) return this.pendingStatusLookup;

    this.pendingStatusLookup = (async () => {
      const statuses = {};

      for (const batch of chunk(ids, MAX_VIDEO_IDS_PER_LOOKUP)) {
        const data = await this.apiRequest("videos", {
          part: "snippet,liveStreamingDetails",
          id: batch.join(","),
        });

        (data?.items || []).forEach((item) => {
          const live = item.liveStreamingDetails;
          statuses[item.id] = {
            state: classifyVideo(item.snippet, live),
            title: item.snippet?.title || null,
            thumbnail: bestThumbnail(item.snippet?.thumbnails, item.id),
            publishedAt: toIso(item.snippet?.publishedAt),
            scheduledStartTime: toIso(live?.scheduledStartTime),
            actualStartTime: toIso(live?.actualStartTime),
            actualEndTime: toIso(live?.actualEndTime),
            concurrentViewers: live?.concurrentViewers ? Number(live.concurrentViewers) : null,
          };
        });
      }

      this.cache.set(VIDEO_STATUS_CACHE_KEY, { ids, statuses }, this.ttls.videoStatus);
      return statuses;
    })();

    try {
      return await this.pendingStatusLookup;
    } catch (error) {
      // Losing live state should degrade the page, not fail it.
      this.log(`live/upcoming status lookup failed: ${error.detail || error.message}`);
      return {};
    } finally {
      this.pendingStatusLookup = null;
    }
  }

  /**
   * Opt-in only (YOUTUBE_LIVE_SEARCH_ENABLED=true). search.list costs 100
   * units per call against a 10,000/day default quota, so four channels polled
   * every 30 minutes is ~19,000 units/day — twice the free allowance on its
   * own. The uploads-playlist path above already surfaces live and scheduled
   * streams for channels that publish them normally; enable this only with a
   * raised quota, and expect the TTL to do the heavy lifting.
   */
  async findLiveViaSearch(channelId) {
    if (!this.liveSearchEnabled || !this.apiConfigured) return [];

    try {
      return await this.cache.getOrLoad(`yt:livesearch:${channelId}`, this.ttls.liveSearch, async () => {
        const data = await this.apiRequest("search", {
          part: "snippet",
          channelId,
          eventType: "live",
          type: "video",
          maxResults: "3",
        });
        return (data?.items || []).map((item) => item.id?.videoId).filter(Boolean);
      });
    } catch (error) {
      this.log(`live search failed for ${channelId}: ${error.detail || error.message}`);
      return [];
    }
  }

  /**
   * Uploads for one channel, walking API -> RSS -> last-known-good.
   * Accepts a handle or a channel object so the existing per-channel route
   * keeps working unchanged.
   */
  async getChannelFeed(channelOrHandle) {
    const channel =
      typeof channelOrHandle === "string" ? this.channelFor(channelOrHandle) : channelOrHandle;

    if (!channel) {
      throw createServiceError(`Unknown YouTube channel: ${channelOrHandle}`, 404);
    }

    const lastGoodKey = `yt:lastgood:${channel.handle}`;
    let channelId = null;
    let firstError = null;

    try {
      channelId = await this.resolveChannelId(channel);
    } catch (error) {
      this.log(`@${channel.handle}: ${error.detail || error.message}`);
      firstError = error;
    }

    if (channelId && this.apiConfigured) {
      try {
        const feed = await this.getUploadsViaApi(channel, channelId);
        this.cache.set(lastGoodKey, feed, this.ttls.lastGood);
        return { ...feed, handle: channel.handle, stale: false };
      } catch (error) {
        this.log(`@${channel.handle}: API uploads failed, trying RSS — ${error.detail || error.message}`);
        firstError = firstError || error;
      }
    }

    if (channelId) {
      try {
        const feed = await this.getUploadsViaRss(channel, channelId);
        this.cache.set(lastGoodKey, feed, this.ttls.lastGood);
        return { ...feed, handle: channel.handle, stale: false };
      } catch (error) {
        this.log(`@${channel.handle}: RSS failed — ${error.detail || error.message}`);
        firstError = firstError || error;
      }
    }

    // Everything live is down: a slightly old feed beats an empty page.
    const lastGood = this.cache.get(lastGoodKey);
    if (lastGood) {
      this.log(`@${channel.handle}: serving last known good feed (${lastGood.videos.length} videos)`);
      return { ...lastGood, handle: channel.handle, source: "cache", stale: true };
    }

    throw firstError || feedError(FAILURE_REASONS.RSS_FAILED, `no feed available for @${channel.handle}`);
  }

  /**
   * The whole page in one call: uploads for every channel, then a single
   * batched live/upcoming lookup across all of them.
   */
  async getIntelligence(channels = this.channels) {
    const results = await Promise.allSettled(channels.map((channel) => this.getChannelFeed(channel)));

    const feeds = channels.map((channel, index) => {
      const result = results[index];
      if (result.status === "fulfilled") {
        return { channel, feed: result.value, error: null };
      }
      return { channel, feed: null, error: result.reason };
    });

    const videoIds = feeds.flatMap((entry) => (entry.feed?.videos || []).map((video) => video.id));

    if (this.liveSearchEnabled) {
      const extra = await Promise.all(
        feeds.filter((entry) => entry.feed?.channelId).map((entry) => this.findLiveViaSearch(entry.feed.channelId)),
      );
      extra.flat().forEach((id) => videoIds.push(id));
    }

    const statuses = await this.getVideoStatuses(videoIds);
    const statusesAvailable = Object.keys(statuses).length > 0;

    const channelPayload = [];
    const failedFeeds = [];
    const allVideos = [];

    feeds.forEach(({ channel, feed, error }) => {
      if (!feed) {
        const reason = error?.reason || FAILURE_REASONS.RSS_FAILED;
        failedFeeds.push({
          handle: channel.handle,
          label: channel.label,
          category: channel.category,
          reason,
          // Safe by construction: SAFE_MESSAGES text only, never the detail.
          error: SAFE_MESSAGES[reason] || "Failed to load feed",
        });
        channelPayload.push({
          handle: channel.handle,
          label: channel.label,
          category: channel.category,
          reason,
          error: SAFE_MESSAGES[reason] || "Failed to load feed",
        });
        return;
      }

      const videos = feed.videos.map((video) => {
        const status = statuses[video.id];
        return {
          ...video,
          // API metadata wins where present — an upcoming stream's placeholder
          // title and thumbnail are refreshed the moment it goes live.
          title: status?.title || video.title,
          thumbnail: status?.thumbnail || video.thumbnail,
          publishedAt: status?.publishedAt || video.publishedAt,
          state: status?.state || "video",
          scheduledStartTime: status?.scheduledStartTime || null,
          actualStartTime: status?.actualStartTime || null,
          concurrentViewers: status?.concurrentViewers ?? null,
          statusSource: status ? "api" : feed.source,
          channelHandle: channel.handle,
          channelLabel: channel.label,
          channelCategory: channel.category,
        };
      });

      channelPayload.push({
        handle: channel.handle,
        label: channel.label,
        category: channel.category,
        channelId: feed.channelId,
        title: feed.title,
        source: feed.source,
        stale: Boolean(feed.stale),
        videos,
      });

      allVideos.push(...videos);
    });

    const sorted = sortByPublishedDateDesc(allVideos);
    const live = sorted.filter((video) => video.state === "live");
    const upcoming = sorted
      .filter((video) => video.state === "upcoming")
      .sort((a, b) => {
        const aTime = a.scheduledStartTime ? new Date(a.scheduledStartTime).getTime() : Infinity;
        const bTime = b.scheduledStartTime ? new Date(b.scheduledStartTime).getTime() : Infinity;
        return aTime - bTime;
      });

    return {
      // `videos` stays the full chronological feed the existing frontend
      // already renders; `live` / `upcoming` are subsets of it.
      videos: sorted,
      live,
      upcoming,
      channels: channelPayload,
      failedFeeds,
      meta: {
        apiConfigured: this.apiConfigured,
        // "unavailable" is what the page uses to explain an empty live section
        // without pretending it checked.
        liveDetection: statusesAvailable ? "api" : this.apiConfigured ? "degraded" : "unavailable",
        quotaCoolingDown: this.quotaCoolingDown,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}

// Retained so existing imports keep resolving after the rename.
const YouTubeFeedService = YouTubeIntelligenceService;

module.exports = {
  YouTubeIntelligenceService,
  YouTubeFeedService,
  FAILURE_REASONS,
  SAFE_MESSAGES,
  parseFeedXml,
  classifyVideo,
  redactKey,
};
