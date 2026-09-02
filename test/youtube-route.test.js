"use strict";

// Boots the real app and checks the /api/youtube/channels contract: that a
// total outage degrades into `failedFeeds` rather than a 500 or a leaked
// configuration detail, and that a healthy fetch returns the shape the
// frontend reads. Order matters — the outage case runs first, while nothing
// is cached yet.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-youtube-"));
process.env.YOUTUBE_API_KEY = "route-test-key";
process.env.YOUTUBE_CHANNEL_IDS = "stockmoe=UCaaaaaaaaaaaaaaaaaaaaaa";
delete process.env.ADMIN_API_KEY;
delete process.env.MARKET_DASHBOARD_LOGIN_PASSWORD;

const { createApp } = require("../src/app");

const originalFetch = global.fetch;
let server;
let base;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test.before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  global.fetch = originalFetch;
  return new Promise((resolve) => server.close(resolve));
});

test("a total outage degrades into failedFeeds instead of a 500", async () => {
  global.fetch = async (url) => {
    if (String(url).startsWith(base)) return originalFetch(url);
    throw new Error("network down");
  };

  const res = await originalFetch(`${base}/api/youtube/channels`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.deepEqual(body.videos, []);
  assert.deepEqual(body.live, []);
  assert.deepEqual(body.upcoming, []);
  assert.equal(body.failedFeeds.length, 4, "every configured channel reports its own failure");
  body.failedFeeds.forEach((channel) => {
    assert.equal(typeof channel.reason, "string");
    assert.equal(typeof channel.error, "string");
  });

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("route-test-key"), "the API key must never reach the client");
  assert.ok(!serialized.includes("googleapis.com"), "request URLs must stay server-side");
});

test("channels endpoint returns the full intelligence shape", async () => {
  global.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith(base)) return originalFetch(url);

    // Handle -> ID resolution. Only the channels without a configured ID reach
    // this, and none of them resolve here.
    if (target.includes("forHandle=") || target.includes("forUsername=")) {
      return jsonResponse({ items: [] });
    }
    if (target.includes("/youtube/v3/channels")) {
      return jsonResponse({
        items: [
          {
            id: "UCaaaaaaaaaaaaaaaaaaaaaa",
            snippet: { title: "StockMoe", thumbnails: {} },
            contentDetails: { relatedPlaylists: { uploads: "UUaaaaaaaaaaaaaaaaaaaaaa" } },
          },
        ],
      });
    }
    if (target.includes("/youtube/v3/playlistItems")) {
      return jsonResponse({
        items: [
          {
            contentDetails: { videoId: "vid-a", videoPublishedAt: "2026-08-01T10:00:00Z" },
            snippet: { title: "An upload", thumbnails: {} },
          },
        ],
      });
    }
    if (target.includes("/youtube/v3/videos")) {
      return jsonResponse({
        items: [
          {
            id: "vid-a",
            snippet: {
              title: "An upload",
              liveBroadcastContent: "none",
              publishedAt: "2026-08-01T10:00:00Z",
              thumbnails: {},
            },
          },
        ],
      });
    }
    throw new Error(`unstubbed fetch: ${target}`);
  };

  const res = await originalFetch(`${base}/api/youtube/channels`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body.videos));
  assert.ok(Array.isArray(body.live));
  assert.ok(Array.isArray(body.upcoming));
  assert.ok(Array.isArray(body.channels));
  assert.ok(Array.isArray(body.failedFeeds));
  assert.equal(body.meta.apiConfigured, true);
  assert.equal(body.channels.length, 4, "failed channels stay in the list so the UI can name them");

  const stockmoe = body.channels.find((channel) => channel.handle === "stockmoe");
  assert.equal(stockmoe.source, "api");
  assert.equal(stockmoe.videos.length, 1);
  assert.equal(stockmoe.videos[0].id, "vid-a");
  assert.equal(stockmoe.videos[0].channelLabel, "StockMoe");
  assert.equal(stockmoe.videos[0].state, "video");

  // The three channels with no configured ID and no API resolution still fail
  // on their own, without taking StockMoe down with them.
  assert.equal(body.failedFeeds.length, 3);
  assert.equal(body.videos.length, 1);

  // Themes ride along with the feed so the switcher renders in one round trip.
  assert.ok(Array.isArray(body.themes), "the payload carries the theme list");
  assert.equal(body.themes[0].id, "markets");
  assert.deepEqual(
    body.themes[0].channels.map((entry) => entry.handle).sort(),
    body.channels.map((channel) => channel.handle).sort(),
    "the derived markets theme covers exactly the tracked channels",
  );
  for (const theme of body.themes) {
    // Every membership must name a channel the feed fetched, or the switcher's
    // count promises videos the page cannot show.
    for (const member of theme.channels) {
      assert.ok(
        body.channels.some((channel) => channel.handle === member.handle),
        `${theme.id} names an untracked channel: ${member.handle}`,
      );
    }
  }
});

test("an unknown channel handle is a 404, not a crash", async () => {
  const res = await originalFetch(`${base}/api/youtube/channels/not-a-real-handle`);
  assert.equal(res.status, 404);
});
