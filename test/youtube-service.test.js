"use strict";

// Covers the hybrid YouTube path end to end with a stubbed global fetch:
// API configured, API key missing, quota exhaustion, RSS failure, one channel
// down while others work, and the live / upcoming / normal-upload states.

const test = require("node:test");
const assert = require("node:assert");

const { YouTubeIntelligenceService, FAILURE_REASONS, redactKey } = require("../src/services/youtube");
const { MemoryCache } = require("../src/services/cache");
const {
  YOUTUBE_CHANNELS,
  resolveYoutubeChannels,
  parseChannelIdOverrides,
} = require("../src/config/youtube-channels");

const CHANNELS = [
  { handle: "stockmoe", label: "StockMoe", category: "Crypto", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" },
  { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto", channelId: "UCbbbbbbbbbbbbbbbbbbbbbb" },
];

const SILENT_LOGGER = { warn() {} };

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function xmlResponse(xml, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => xml,
  };
}

function rssFeed(title, videoId) {
  return `<?xml version="1.0"?><feed><title>${title}</title><entry>` +
    `<yt:videoId>${videoId}</yt:videoId><title>${title} upload</title>` +
    `<published>2026-08-01T10:00:00+00:00</published>` +
    `<media:thumbnail url="https://i.ytimg.com/vi/${videoId}/hq.jpg"/>` +
    `</entry></feed>`;
}

function playlistItems(videoId, title) {
  return {
    items: [
      {
        contentDetails: { videoId, videoPublishedAt: "2026-08-01T10:00:00Z" },
        snippet: { title, thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` } } },
      },
    ],
  };
}

function channelMeta(channelId, title) {
  return {
    items: [
      {
        id: channelId,
        snippet: { title, thumbnails: {} },
        contentDetails: { relatedPlaylists: { uploads: channelId.replace(/^UC/, "UU") } },
      },
    ],
  };
}

/**
 * Routes stubbed responses by URL fragment and records every request so tests
 * can assert on quota behaviour (e.g. that search.list is never called).
 */
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [fragment, responder] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        const value = typeof responder === "function" ? responder(String(url), calls) : responder;
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return calls;
}

function makeService(overrides = {}) {
  return new YouTubeIntelligenceService({
    cache: new MemoryCache(),
    apiKey: "test-key",
    channels: CHANNELS,
    logger: SILENT_LOGGER,
    ...overrides,
  });
}

const originalFetch = global.fetch;
test.afterEach(() => {
  global.fetch = originalFetch;
});

/* ── A. API key configured and working ─────────────────────────────────── */

test("A: with a working API key, uploads and live state come from the Data API", async () => {
  stubFetch({
    "/channels?": (url) =>
      jsonResponse(channelMeta(url.includes("UCaaa") ? "UCaaaaaaaaaaaaaaaaaaaaaa" : "UCbbbbbbbbbbbbbbbbbbbbbb", "Chan")),
    "/playlistItems?": (url) =>
      jsonResponse(playlistItems(url.includes("UUaaa") ? "vid-a" : "vid-b", "An upload")),
    "/videos?": jsonResponse({
      items: [
        {
          id: "vid-a",
          snippet: { title: "An upload", liveBroadcastContent: "none", publishedAt: "2026-08-01T10:00:00Z", thumbnails: {} },
        },
        {
          id: "vid-b",
          snippet: { title: "An upload", liveBroadcastContent: "none", publishedAt: "2026-08-01T09:00:00Z", thumbnails: {} },
        },
      ],
    }),
  });

  const payload = await makeService().getIntelligence();

  assert.equal(payload.failedFeeds.length, 0);
  assert.equal(payload.videos.length, 2);
  assert.equal(payload.meta.apiConfigured, true);
  assert.equal(payload.meta.liveDetection, "api");
  assert.equal(payload.channels[0].source, "api");
  assert.equal(payload.videos[0].channelLabel, "StockMoe");
});

test("A: no search.list call is made on the request path", async () => {
  const calls = stubFetch({
    "/channels?": jsonResponse(channelMeta("UCaaaaaaaaaaaaaaaaaaaaaa", "Chan")),
    "/playlistItems?": jsonResponse(playlistItems("vid-a", "An upload")),
    "/videos?": jsonResponse({ items: [] }),
  });

  await makeService().getIntelligence();

  assert.ok(
    calls.every((url) => !url.includes("/youtube/v3/search")),
    "search.list costs 100 units and must not run per request",
  );
});

test("A: repeated refreshes are served from cache rather than re-hitting the API", async () => {
  const calls = stubFetch({
    "/channels?": jsonResponse(channelMeta("UCaaaaaaaaaaaaaaaaaaaaaa", "Chan")),
    "/playlistItems?": jsonResponse(playlistItems("vid-a", "An upload")),
    "/videos?": jsonResponse({ items: [] }),
  });

  const service = makeService();
  await service.getIntelligence();
  const afterFirst = calls.length;
  await service.getIntelligence();
  await service.getIntelligence();

  assert.equal(calls.length, afterFirst, "cached refreshes must not spend quota");
});

/* ── B. API key missing ────────────────────────────────────────────────── */

test("B: with no API key, known channel IDs still serve uploads over RSS", async () => {
  stubFetch({
    "feeds/videos.xml": (url) => xmlResponse(rssFeed("Chan", url.includes("UCaaa") ? "vid-a" : "vid-b")),
  });

  const payload = await makeService({ apiKey: "" }).getIntelligence();

  assert.equal(payload.failedFeeds.length, 0);
  assert.equal(payload.videos.length, 2);
  assert.equal(payload.meta.apiConfigured, false);
  assert.equal(payload.meta.liveDetection, "unavailable");
  assert.equal(payload.channels[0].source, "rss");
  assert.deepEqual(payload.live, []);
  assert.deepEqual(payload.upcoming, []);
});

test("B: with no API key and no known channel ID, the failure names the cause", async () => {
  stubFetch({});

  const service = makeService({
    apiKey: "",
    channels: [{ handle: "stockmoe", label: "StockMoe", category: "Stocks", channelId: "" }],
  });
  const payload = await service.getIntelligence();

  assert.equal(payload.failedFeeds.length, 1);
  assert.equal(payload.failedFeeds[0].reason, FAILURE_REASONS.CHANNEL_ID_UNRESOLVED);
});

test("B: the handle page is never scraped, whatever the configuration", async () => {
  const calls = stubFetch({
    "feeds/videos.xml": xmlResponse(rssFeed("Chan", "vid-a")),
  });

  await makeService({ apiKey: "" }).getIntelligence();

  assert.ok(
    calls.every((url) => !/youtube\.com\/@/.test(url)),
    "channel IDs must never be scraped from the handle page again",
  );
});

/* ── C. API quota / API failure ────────────────────────────────────────── */

test("C: a quota error falls back to RSS and starts a cooldown", async () => {
  const calls = stubFetch({
    "/channels?": jsonResponse(
      { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } },
      403,
    ),
    "feeds/videos.xml": (url) => xmlResponse(rssFeed("Chan", url.includes("UCaaa") ? "vid-a" : "vid-b")),
  });

  const service = makeService();
  const payload = await service.getIntelligence();

  assert.equal(payload.failedFeeds.length, 0, "RSS should carry the page when quota is gone");
  assert.equal(payload.videos.length, 2);
  assert.equal(payload.channels[0].source, "rss");
  assert.equal(service.quotaCoolingDown, true);
  assert.equal(payload.meta.quotaCoolingDown, true);

  // While cooling down, no further API calls are attempted at all.
  const beforeSecondRun = calls.filter((url) => url.includes("googleapis.com")).length;
  await service.getIntelligence();
  const afterSecondRun = calls.filter((url) => url.includes("googleapis.com")).length;
  assert.equal(afterSecondRun, beforeSecondRun, "an exhausted key must not be re-hit every refresh");
});

test("C: a rejected key falls back to RSS without claiming quota trouble", async () => {
  stubFetch({
    "/channels?": jsonResponse({ error: { message: "bad key", errors: [{ reason: "keyInvalid" }] } }, 400),
    "feeds/videos.xml": xmlResponse(rssFeed("Chan", "vid-a")),
  });

  const service = makeService();
  const payload = await service.getIntelligence();

  assert.equal(payload.videos.length, 2);
  assert.equal(service.quotaCoolingDown, false);
});

/* ── D. RSS temporarily unavailable ────────────────────────────────────── */

test("D: a transient RSS outage is served from the last known good feed", async () => {
  let rssUp = true;
  stubFetch({
    "feeds/videos.xml": (url) =>
      rssUp ? xmlResponse(rssFeed("Chan", url.includes("UCaaa") ? "vid-a" : "vid-b")) : xmlResponse("", 503),
  });

  const service = makeService({ apiKey: "", ttls: { uploads: 0 } });
  const warm = await service.getIntelligence();
  assert.equal(warm.videos.length, 2);

  rssUp = false;
  const degraded = await service.getIntelligence();

  assert.equal(degraded.failedFeeds.length, 0);
  assert.equal(degraded.videos.length, 2);
  assert.equal(degraded.channels[0].stale, true);
  assert.equal(degraded.channels[0].source, "cache");
});

test("D: an RSS outage with no cached feed reports rss-failed", async () => {
  stubFetch({ "feeds/videos.xml": xmlResponse("", 500) });

  const payload = await makeService({ apiKey: "" }).getIntelligence();

  assert.equal(payload.failedFeeds.length, 2);
  assert.equal(payload.failedFeeds[0].reason, FAILURE_REASONS.RSS_FAILED);
  assert.deepEqual(payload.videos, []);
});

/* ── E. One channel fails, the others work ─────────────────────────────── */

test("E: one broken channel does not take the other channels down", async () => {
  stubFetch({
    "feeds/videos.xml": (url) =>
      url.includes("UCaaa") ? xmlResponse("", 404) : xmlResponse(rssFeed("CryptosRUs", "vid-b")),
  });

  const payload = await makeService({ apiKey: "" }).getIntelligence();

  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].channelLabel, "CryptosRUs");
  assert.equal(payload.failedFeeds.length, 1);
  assert.equal(payload.failedFeeds[0].label, "StockMoe");
});

/* ── F/G/H/I. Live, upcoming and normal-upload classification ──────────── */

function stubApiWithStatuses(items) {
  stubFetch({
    "/channels?": (url) =>
      jsonResponse(channelMeta(url.includes("UCaaa") ? "UCaaaaaaaaaaaaaaaaaaaaaa" : "UCbbbbbbbbbbbbbbbbbbbbbb", "Chan")),
    "/playlistItems?": (url) =>
      jsonResponse(playlistItems(url.includes("UUaaa") ? "vid-a" : "vid-b", "Some video")),
    "/videos?": jsonResponse({ items }),
  });
}

test("F: no live streams yields empty live/upcoming lists, not an error", async () => {
  stubApiWithStatuses([
    { id: "vid-a", snippet: { title: "Upload A", liveBroadcastContent: "none", publishedAt: "2026-08-01T10:00:00Z", thumbnails: {} } },
    { id: "vid-b", snippet: { title: "Upload B", liveBroadcastContent: "none", publishedAt: "2026-08-01T09:00:00Z", thumbnails: {} } },
  ]);

  const payload = await makeService().getIntelligence();

  assert.deepEqual(payload.live, []);
  assert.deepEqual(payload.upcoming, []);
  assert.equal(payload.failedFeeds.length, 0);
  assert.equal(payload.videos.length, 2);
});

test("G: a channel that is live is reported with viewers and actual start time", async () => {
  stubApiWithStatuses([
    {
      id: "vid-a",
      snippet: { title: "Live macro stream", liveBroadcastContent: "live", publishedAt: "2026-08-12T08:00:00Z", thumbnails: {} },
      liveStreamingDetails: { actualStartTime: "2026-08-12T08:05:00Z", concurrentViewers: "1420" },
    },
    { id: "vid-b", snippet: { title: "Upload B", liveBroadcastContent: "none", publishedAt: "2026-08-01T09:00:00Z", thumbnails: {} } },
  ]);

  const payload = await makeService().getIntelligence();

  assert.equal(payload.live.length, 1);
  assert.equal(payload.live[0].id, "vid-a");
  assert.equal(payload.live[0].title, "Live macro stream");
  assert.equal(payload.live[0].concurrentViewers, 1420);
  assert.equal(payload.live[0].actualStartTime, "2026-08-12T08:05:00.000Z");
  assert.equal(payload.live[0].channelLabel, "StockMoe");
  assert.equal(payload.upcoming.length, 0);
});

test("H: a scheduled stream is reported as upcoming with its start time", async () => {
  stubApiWithStatuses([
    {
      id: "vid-a",
      snippet: { title: "Scheduled FOMC review", liveBroadcastContent: "upcoming", publishedAt: "2026-08-11T08:00:00Z", thumbnails: {} },
      liveStreamingDetails: { scheduledStartTime: "2026-08-13T18:00:00Z" },
    },
    { id: "vid-b", snippet: { title: "Upload B", liveBroadcastContent: "none", publishedAt: "2026-08-01T09:00:00Z", thumbnails: {} } },
  ]);

  const payload = await makeService().getIntelligence();

  assert.equal(payload.upcoming.length, 1);
  assert.equal(payload.upcoming[0].id, "vid-a");
  assert.equal(payload.upcoming[0].scheduledStartTime, "2026-08-13T18:00:00.000Z");
  assert.equal(payload.live.length, 0);
});

test("H: upcoming streams are ordered by soonest scheduled start", async () => {
  stubApiWithStatuses([
    {
      id: "vid-a",
      snippet: { title: "Later", liveBroadcastContent: "upcoming", publishedAt: "2026-08-11T08:00:00Z", thumbnails: {} },
      liveStreamingDetails: { scheduledStartTime: "2026-08-20T18:00:00Z" },
    },
    {
      id: "vid-b",
      snippet: { title: "Sooner", liveBroadcastContent: "upcoming", publishedAt: "2026-08-10T08:00:00Z", thumbnails: {} },
      liveStreamingDetails: { scheduledStartTime: "2026-08-13T18:00:00Z" },
    },
  ]);

  const payload = await makeService().getIntelligence();

  assert.deepEqual(payload.upcoming.map((video) => video.title), ["Sooner", "Later"]);
});

test("I: a finished stream is a normal upload again, even before the flag clears", async () => {
  stubApiWithStatuses([
    {
      id: "vid-a",
      snippet: { title: "Yesterday's stream", liveBroadcastContent: "live", publishedAt: "2026-08-11T08:00:00Z", thumbnails: {} },
      liveStreamingDetails: { actualStartTime: "2026-08-11T08:05:00Z", actualEndTime: "2026-08-11T10:00:00Z" },
    },
    { id: "vid-b", snippet: { title: "Upload B", liveBroadcastContent: "none", publishedAt: "2026-08-01T09:00:00Z", thumbnails: {} } },
  ]);

  const payload = await makeService().getIntelligence();

  assert.equal(payload.live.length, 0);
  assert.equal(payload.videos.length, 2);
  assert.equal(payload.videos.every((video) => video.state === "video"), true);
});

test("I: uploads still render when only the live-status lookup fails", async () => {
  stubFetch({
    "/channels?": (url) =>
      jsonResponse(channelMeta(url.includes("UCaaa") ? "UCaaaaaaaaaaaaaaaaaaaaaa" : "UCbbbbbbbbbbbbbbbbbbbbbb", "Chan")),
    "/playlistItems?": (url) =>
      jsonResponse(playlistItems(url.includes("UUaaa") ? "vid-a" : "vid-b", "Some video")),
    "/videos?": jsonResponse({ error: { message: "boom", errors: [{ reason: "backendError" }] } }, 500),
  });

  const payload = await makeService().getIntelligence();

  assert.equal(payload.videos.length, 2);
  assert.equal(payload.failedFeeds.length, 0);
  assert.equal(payload.meta.liveDetection, "degraded");
});

/* ── Channel ID resolution and secret hygiene ──────────────────────────── */

test("an unknown channel ID is resolved through channels.list, not by scraping", async () => {
  const calls = stubFetch({
    "forHandle": jsonResponse({ items: [{ id: "UCcccccccccccccccccccccc" }] }),
    "/channels?part=snippet": jsonResponse(channelMeta("UCcccccccccccccccccccccc", "Resolved")),
    "/playlistItems?": jsonResponse(playlistItems("vid-c", "An upload")),
    "/videos?": jsonResponse({ items: [] }),
  });

  const service = makeService({
    channels: [{ handle: "stockmoe", label: "StockMoe", category: "Stocks", channelId: "" }],
  });
  const payload = await service.getIntelligence();

  assert.equal(payload.channels[0].channelId, "UCcccccccccccccccccccccc");
  assert.ok(calls.some((url) => url.includes("forHandle=%40stockmoe")));
  assert.ok(calls.every((url) => !/youtube\.com\/@/.test(url)));
});

test("failures surfaced to the browser carry no API key or request URL", async () => {
  stubFetch({
    "/channels?": jsonResponse({ error: { message: "key=super-secret leaked", errors: [{ reason: "keyInvalid" }] } }, 400),
    "feeds/videos.xml": xmlResponse("", 500),
  });

  const payload = await makeService({ apiKey: "super-secret" }).getIntelligence();
  const serialized = JSON.stringify(payload);

  assert.ok(!serialized.includes("super-secret"), "the API key must never reach the client payload");
  assert.ok(!serialized.includes("googleapis.com"), "request URLs must stay server-side");
  assert.equal(payload.failedFeeds.length, 2);
});

test("redactKey strips the key from any URL before it is logged", () => {
  assert.equal(
    redactKey("https://www.googleapis.com/youtube/v3/videos?id=abc&key=SECRET123"),
    "https://www.googleapis.com/youtube/v3/videos?id=abc&key=[redacted]",
  );
});

/* ── Channel config ────────────────────────────────────────────────────── */

test("channel ID overrides parse from both JSON and key=value form", () => {
  assert.deepEqual(parseChannelIdOverrides('{"stockmoe":"UCaaaaaaaaaaaaaaaaaaaaaa"}'), {
    stockmoe: "UCaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseChannelIdOverrides("stockmoe=UCaaaaaaaaaaaaaaaaaaaaaa,@cryptosrus:UCbbbbbbbbbbbbbbbbbbbbbb"), {
    stockmoe: "UCaaaaaaaaaaaaaaaaaaaaaa",
    cryptosrus: "UCbbbbbbbbbbbbbbbbbbbbbb",
  });
});

test("malformed channel ID overrides are dropped, not thrown", () => {
  assert.deepEqual(parseChannelIdOverrides("stockmoe=not-a-channel-id"), {});
  assert.deepEqual(parseChannelIdOverrides("{broken json"), {});
  assert.deepEqual(parseChannelIdOverrides(""), {});
});

test("resolveYoutubeChannels applies overrides over the static config", () => {
  const resolved = resolveYoutubeChannels("stockmoe=UCaaaaaaaaaaaaaaaaaaaaaa");
  const stockmoe = resolved.find((channel) => channel.handle === "stockmoe");
  assert.equal(stockmoe.channelId, "UCaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(resolved.length, YOUTUBE_CHANNELS.length, "every configured channel is preserved");
});
