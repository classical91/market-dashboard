// Channel IDs (UC...) are the stable identity both the YouTube Data API and
// the public RSS feeds key off. Handles can be renamed and, unlike IDs, cannot
// be turned into an RSS URL — so a known ID is exactly what lets the RSS
// fallback keep working with no API key at all.
//
// Leave `channelId` blank to have the service resolve it once through
// channels.list?forHandle (1 quota unit) and cache it. Filling it in is the
// cheaper, more resilient option: run `node scripts/resolve-youtube-channels.js`
// once with YOUTUBE_API_KEY set and paste the IDs it prints in here, or set
// them per-deploy through YOUTUBE_CHANNEL_IDS.
const YOUTUBE_CHANNELS = [
  { handle: "stockmoe", label: "StockMoe", category: "Stocks", channelId: "" },
  { handle: "jaysoncasper", label: "Jayson Casper", category: "Geopolitics", channelId: "" },
  { handle: "tradersreality", label: "Trader's Reality", category: "Crypto", channelId: "" },
  { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto", channelId: "" },
];

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

function isChannelId(value) {
  return CHANNEL_ID_PATTERN.test(String(value || "").trim());
}

/**
 * Accepts either JSON — {"stockmoe":"UCxxxx..."} — or the terser
 * "stockmoe=UCxxxx...,cryptosrus=UCyyyy..." / "stockmoe:UCxxxx..." form, so a
 * Railway variable can be typed by hand without JSON quoting.
 *
 * Malformed pairs are dropped rather than throwing: a typo in one override
 * should not take the whole page down, and the service still has the API path
 * to fall back on.
 */
function parseChannelIdOverrides(raw) {
  const value = String(raw || "").trim();
  if (!value) return {};

  const overrides = {};
  const record = (handle, channelId) => {
    const key = String(handle || "").trim().toLowerCase().replace(/^@/, "");
    const id = String(channelId || "").trim();
    if (key && isChannelId(id)) overrides[key] = id;
  };

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        Object.entries(parsed).forEach(([handle, id]) => record(handle, id));
      }
      return overrides;
    } catch {
      return overrides;
    }
  }

  value
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const separator = pair.indexOf("=") >= 0 ? "=" : ":";
      const index = pair.indexOf(separator);
      if (index <= 0) return;
      record(pair.slice(0, index), pair.slice(index + 1));
    });

  return overrides;
}

/**
 * Merges the static channel list with any YOUTUBE_CHANNEL_IDS overrides.
 * Invalid `channelId` values in the static list are treated as "unset" so the
 * service resolves them through the API instead of building a broken feed URL.
 */
function resolveYoutubeChannels(overridesRaw = process.env.YOUTUBE_CHANNEL_IDS, channels = YOUTUBE_CHANNELS) {
  const overrides = parseChannelIdOverrides(overridesRaw);

  return channels.map((channel) => {
    const override = overrides[channel.handle.toLowerCase()];
    const configured = isChannelId(channel.channelId) ? channel.channelId.trim() : "";
    return { ...channel, channelId: override || configured };
  });
}

module.exports = {
  YOUTUBE_CHANNELS,
  CHANNEL_ID_PATTERN,
  isChannelId,
  parseChannelIdOverrides,
  resolveYoutubeChannels,
};
