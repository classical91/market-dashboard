"use strict";

// The narrowing that stands between the YouTube Intelligence feed and Main Hub.
//
// The contract under test is not YouTube's — it is what this server agrees to
// hand a different app on a different origin. Two halves to that: the fields a
// widget needs arrive intact, and the fields it has no business seeing do not
// travel even when the feed carries them.

const test = require("node:test");
const assert = require("node:assert/strict");

const { narrowLiveFeed } = require("../src/services/youtube-live-feed");

/** A feed video, in the shape getIntelligence builds. */
function video(overrides = {}) {
  return {
    id: "vid-1",
    title: "Morning stream",
    url: "https://www.youtube.com/watch?v=vid-1",
    thumbnail: "https://i.ytimg.com/vi/vid-1/hq.jpg",
    publishedAt: "2026-09-15T10:00:00.000Z",
    state: "live",
    scheduledStartTime: null,
    actualStartTime: "2026-09-15T10:00:00.000Z",
    concurrentViewers: 1240,
    statusSource: "api",
    channelHandle: "stockmoe",
    channelLabel: "Stock Moe",
    channelCategory: "Markets",
    channelCategoryId: "cat-1",
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    videos: [],
    live: [],
    upcoming: [],
    channels: [],
    failedFeeds: [],
    meta: {
      apiConfigured: true,
      liveDetection: "api",
      quotaCoolingDown: false,
      generatedAt: "2026-09-15T10:05:00.000Z",
    },
    ...overrides,
  };
}

test("one live stream carries the fields a player and a card need", () => {
  const result = narrowLiveFeed(payload({ live: [video()] }));

  assert.equal(result.live.length, 1);
  assert.deepEqual(result.live[0], {
    videoId: "vid-1",
    title: "Morning stream",
    channelName: "Stock Moe",
    channelHandle: "stockmoe",
    thumbnail: "https://i.ytimg.com/vi/vid-1/hq.jpg",
    status: "live",
    scheduledStartTime: null,
    actualStartTime: "2026-09-15T10:00:00.000Z",
    viewerCount: 1240,
    watchUrl: "https://www.youtube.com/watch?v=vid-1",
  });
  assert.equal(result.meta.liveDetection, "api");
});

test("multiple live streams keep their feed order", () => {
  const result = narrowLiveFeed(payload({
    live: [
      video({ id: "a", title: "First" }),
      video({ id: "b", title: "Second", channelLabel: "Other" }),
      video({ id: "c", title: "Third" }),
    ],
  }));

  assert.deepEqual(result.live.map((entry) => entry.videoId), ["a", "b", "c"]);
  assert.equal(result.live[1].channelName, "Other");
});

test("upcoming with nothing live still answers, and says so", () => {
  const result = narrowLiveFeed(payload({
    upcoming: [video({
      id: "later",
      state: "upcoming",
      scheduledStartTime: "2026-09-15T18:00:00.000Z",
      actualStartTime: null,
      concurrentViewers: null,
    })],
  }));

  assert.deepEqual(result.live, []);
  assert.equal(result.upcoming.length, 1);
  assert.equal(result.upcoming[0].status, "upcoming");
  assert.equal(result.upcoming[0].scheduledStartTime, "2026-09-15T18:00:00.000Z");
  assert.equal(result.upcoming[0].viewerCount, null);
});

test("no live and no upcoming is an empty answer, not a missing one", () => {
  const result = narrowLiveFeed(payload());

  assert.deepEqual(result.live, []);
  assert.deepEqual(result.upcoming, []);
  assert.equal(result.meta.liveDetection, "api");
});

// The distinction the widget's empty state is built on: "nothing is live" and
// "we could not check" must not look the same from the outside.
test("a degraded status lookup is reported as degraded, not as nothing live", () => {
  const result = narrowLiveFeed(payload({
    meta: { apiConfigured: true, liveDetection: "degraded", quotaCoolingDown: true, generatedAt: null },
  }));

  assert.equal(result.meta.liveDetection, "degraded");
});

test("an unconfigured API reads as unavailable", () => {
  const result = narrowLiveFeed(payload({
    meta: { apiConfigured: false, liveDetection: "unavailable", generatedAt: null },
  }));

  assert.equal(result.meta.liveDetection, "unavailable");
});

test("an unrecognised detection value is treated as never checked", () => {
  const result = narrowLiveFeed(payload({ meta: { liveDetection: "probably?" } }));

  assert.equal(result.meta.liveDetection, "unavailable");
});

test("a malformed payload does not throw", () => {
  for (const bad of [null, undefined, {}, { live: "nope", upcoming: 7 }, { meta: null }]) {
    const result = narrowLiveFeed(bad);
    assert.deepEqual(result.live, []);
    assert.deepEqual(result.upcoming, []);
    assert.equal(result.meta.liveDetection, "unavailable");
    assert.ok(Date.parse(result.meta.generatedAt) > 0, "generatedAt is always an instant");
  }
});

// An ordinary upload rendered under a LIVE badge is the one thing this widget
// must never do, so the state is re-checked rather than inferred from the array.
test("an ordinary upload in the live array is dropped", () => {
  const result = narrowLiveFeed(payload({
    live: [video({ id: "upload", state: "video" }), video({ id: "real" })],
  }));

  assert.deepEqual(result.live.map((entry) => entry.videoId), ["real"]);
});

test("a video with no id is dropped rather than linked nowhere", () => {
  const result = narrowLiveFeed(payload({ live: [video({ id: "" }), video({ id: "ok" })] }));

  assert.deepEqual(result.live.map((entry) => entry.videoId), ["ok"]);
});

test("a nonsense viewer count is dropped rather than rendered", () => {
  const counts = [-5, "many", NaN, undefined];
  for (const concurrentViewers of counts) {
    const result = narrowLiveFeed(payload({ live: [video({ concurrentViewers })] }));
    assert.equal(result.live[0].viewerCount, null, `${String(concurrentViewers)} is not a count`);
  }
});

test("a channel with no label falls back to its handle", () => {
  const result = narrowLiveFeed(payload({ live: [video({ channelLabel: null })] }));

  assert.equal(result.live[0].channelName, "stockmoe");
});

test("a video with no thumbnail gets YouTube's own", () => {
  const result = narrowLiveFeed(payload({ live: [video({ thumbnail: null })] }));

  assert.equal(result.live[0].thumbnail, "https://img.youtube.com/vi/vid-1/hqdefault.jpg");
});

// The reason this module exists rather than the route spreading the payload.
test("internal state and failure detail never travel", () => {
  const result = narrowLiveFeed(payload({
    live: [video({ statusSource: "api", channelCategoryId: "cat-1", publishedAt: "2026-09-15T10:00:00.000Z" })],
    failedFeeds: [{ handle: "dead", reason: "quota", error: "Feed unavailable" }],
    channels: [{ handle: "stockmoe", videos: [video()] }],
    videos: [video(), video({ id: "unrelated", state: "video" })],
    meta: { apiConfigured: true, liveDetection: "api", quotaCoolingDown: true, generatedAt: null },
  }));

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("quotaCoolingDown"), "quota state stays here");
  assert.ok(!serialized.includes("apiConfigured"), "configuration state stays here");
  assert.ok(!serialized.includes("failedFeeds"), "per-channel failures stay here");
  assert.ok(!serialized.includes("unrelated"), "the wider feed stays here");

  assert.deepEqual(Object.keys(result).sort(), ["live", "meta", "upcoming"]);
  assert.deepEqual(Object.keys(result.meta).sort(), ["generatedAt", "liveDetection"]);
  assert.deepEqual(Object.keys(result.live[0]).sort(), [
    "actualStartTime", "channelHandle", "channelName", "scheduledStartTime",
    "status", "thumbnail", "title", "videoId", "viewerCount", "watchUrl",
  ]);
});

test("a long live list is capped", () => {
  const many = Array.from({ length: 30 }, (_, index) => video({ id: `v${index}` }));
  const result = narrowLiveFeed(payload({ live: many, upcoming: many.map((v) => ({ ...v, state: "upcoming" })) }));

  assert.equal(result.live.length, 12);
  assert.equal(result.upcoming.length, 5);
});
