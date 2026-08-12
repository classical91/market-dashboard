#!/usr/bin/env node
/**
 * Resolves the configured YouTube handles to their permanent UC... channel IDs
 * and prints them, so they can be pasted into src/config/youtube-channels.js
 * or set as YOUTUBE_CHANNEL_IDS.
 *
 * Baking the IDs in is worth doing once: it removes a channels.list call per
 * handle, and it is what lets the keyless RSS fallback work on a fresh deploy
 * that has no YOUTUBE_API_KEY at all.
 *
 * Usage:
 *   YOUTUBE_API_KEY=... node scripts/resolve-youtube-channels.js
 */

require("dotenv").config();

const { MemoryCache } = require("../src/services/cache");
const { YouTubeIntelligenceService } = require("../src/services/youtube");
const { resolveYoutubeChannels } = require("../src/config/youtube-channels");
const { config } = require("../src/config/env");

async function main() {
  if (!config.youtube.apiKey) {
    console.error("YOUTUBE_API_KEY is not set — channel ID resolution needs the YouTube Data API.");
    process.exit(1);
  }

  const channels = resolveYoutubeChannels(config.youtube.channelIds);
  const service = new YouTubeIntelligenceService({
    cache: new MemoryCache(),
    apiKey: config.youtube.apiKey,
    channels,
  });

  const resolved = [];
  let failed = false;

  for (const channel of channels) {
    try {
      const channelId = await service.resolveChannelId(channel);
      resolved.push({ ...channel, channelId });
      console.log(`@${channel.handle} -> ${channelId}`);
    } catch (error) {
      failed = true;
      console.error(`@${channel.handle} -> FAILED: ${error.detail || error.message}`);
    }
  }

  if (resolved.length) {
    console.log("\n--- src/config/youtube-channels.js ---");
    resolved.forEach((channel) => {
      console.log(
        `  { handle: "${channel.handle}", label: "${channel.label}", ` +
          `category: "${channel.category}", channelId: "${channel.channelId}" },`,
      );
    });

    console.log("\n--- YOUTUBE_CHANNEL_IDS ---");
    console.log(resolved.map((channel) => `${channel.handle}=${channel.channelId}`).join(","));
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
