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
  { handle: "stockmoe", label: "StockMoe", category: "Crypto", channelId: "" },
  { handle: "jaysoncasper", label: "Jayson Casper", category: "Geopolitics", channelId: "" },
  { handle: "tradersreality", label: "Trader's Reality", category: "Crypto", channelId: "" },
  { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto", channelId: "" },
  { handle: "CanadianPrepper", label: "Canadian Prepper", category: "War", channelId: "" },
  { handle: "MFN", label: "MFN", category: "War", channelId: "" },
  { handle: "WION", label: "WION", category: "War", channelId: "" },
  { handle: "amtv", label: "AMTV", category: "War", channelId: "" },
  { handle: "davidhookstead", label: "David Hookstead", category: "War", channelId: "" },
  { handle: "SteveRam", label: "Steve Ram", category: "War", channelId: "" },
  { handle: "PrestonStewart", label: "Preston Stewart", category: "War", channelId: "" },
  { handle: "RoboNuggets", label: "Robo Nuggets", category: "Tech", channelId: "" },
  { handle: "EverydayTechTV", label: "Everyday Tech TV", category: "Tech", channelId: "" },
  { handle: "SmartHomeSolver", label: "Smart Home Solver", category: "Tech", channelId: "" },
  { handle: "aliabdaal", label: "Ali Abdaal", category: "Tech", channelId: "" },
  { handle: "saradietschy", label: "Sara Dietschy", category: "Tech", channelId: "" },
  { handle: "mkbhd", label: "MKBHD", category: "Tech", channelId: "" },
  { handle: "jvtechtea", label: "JV Tech Tea", category: "Tech", channelId: "" },
  { handle: "MatthewCassinelli", label: "Matthew Cassinelli", category: "Tech", channelId: "" },
  { handle: "MattTalkTech", label: "Matt Talks Tech", category: "Tech", channelId: "" },
  { handle: "9to5Mac", label: "9to5Mac", category: "Tech", channelId: "" },
  { handle: "unboxtherapy", label: "Unbox Therapy", category: "Tech", channelId: "" },
  { handle: "iReviewsVideos", label: "iReviews", category: "Tech", channelId: "" },
  { handle: "Notion", label: "Notion", category: "Tech", channelId: "" },
  { handle: "Apple", label: "Apple", category: "Tech", channelId: "" },
  { handle: "howtechmobile", label: "HowTech Mobile", category: "Tech", channelId: "" },
  { handle: "iOSPro", label: "iOS Pro", category: "Tech", channelId: "" },
  { handle: "clarkkegley", label: "Clark Kegley", category: "Mentors", channelId: "" },
  { handle: "lewishowes", label: "Lewis Howes", category: "Mentors", channelId: "" },
  { handle: "newearth-sylvie-ivanova", label: "New Earth — Sylvie Ivanova", category: "Underworld", channelId: "" },
  { handle: "joerogan", label: "Joe Rogan", category: "Underworld", channelId: "" },
  { handle: "theAIsearch", label: "The AI Search", category: "Tech", channelId: "" },
  { handle: "JeffSu", label: "Jeff Su", category: "Tech", channelId: "" },
  { handle: "aiadvantage", label: "AI Advantage", category: "Tech", channelId: "" },
  { handle: "beardfm", label: "Beard FM", category: "Tech", channelId: "" },
  { handle: "nateherk", label: "Nate Herk", category: "Tech", channelId: "" },
  { handle: "morecryptoonline", label: "More Crypto Online", category: "Crypto", channelId: "" },
  { handle: "MindMathMoney", label: "Mind Math Money", category: "Crypto", channelId: "" },
  { handle: "OscarRamos", label: "Oscar Ramos", category: "Crypto", channelId: "" },
  { handle: "AnthonyPompliano", label: "Anthony Pompliano", category: "Crypto", channelId: "" },
  { handle: "DaytradeWarrior", label: "Day Trade Warrior", category: "Crypto", channelId: "" },
  { handle: "stevenvanmetre5087", label: "Steven Van Metre", category: "Crypto", channelId: "" },
  { handle: "fxmentorus", label: "FX Mentor US", category: "Crypto", channelId: "" },
  { handle: "mreflow", label: "Mr. E Flow", category: "Crypto", channelId: "" },
  { handle: "J_Bravo", label: "J Bravo", category: "Crypto", channelId: "" },
  { handle: "jordancamirand", label: "Jordan Camirand", category: "Crypto", channelId: "" },
  { handle: "MyFinancialFriend", label: "My Financial Friend", category: "Crypto", channelId: "" },
  { handle: "FrankieCandles", label: "Frankie Candles", category: "Crypto", channelId: "" },
  { handle: "AdrianMorrison", label: "Adrian Morrison", category: "Sales", channelId: "" },
  { handle: "TheDiaryOfACEOClips", label: "The Diary Of A CEO Clips", category: "Underworld", channelId: "" },
  { handle: "mikewanders", label: "Mike Wanders", category: "Underworld", channelId: "" },
  { handle: "JasonAChannel", label: "Jason A", category: "Underworld", channelId: "" },
  { handle: "CashJordan", label: "Cash Jordan", category: "War", channelId: "" },
  { handle: "MaxAfterburnerusa", label: "Max Afterburner", category: "War", channelId: "" },
  { handle: "DannyHaiphongYT", label: "Danny Haiphong", category: "War", channelId: "" },
  { handle: "NYPrepper", label: "NY Prepper", category: "War", channelId: "" },
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
