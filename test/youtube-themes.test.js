"use strict";

// Covers the YouTube Intelligence theme config: that a theme can only claim
// channels the feed actually fetches, that the markets theme stays derived
// from the channel list, and that the shipped themes keep their layout.

const test = require("node:test");
const assert = require("node:assert");

const {
  YOUTUBE_THEMES,
  DEFAULT_THEME_ID,
  resolveYoutubeThemes,
} = require("../src/config/youtube-themes");

const CHANNELS = [
  { handle: "stockmoe", label: "StockMoe", category: "Stocks", channelId: "" },
  { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto", channelId: "" },
];

test("the markets theme is derived from the channel list, not a second copy of it", () => {
  const [markets] = resolveYoutubeThemes(
    [{ id: DEFAULT_THEME_ID, name: "Markets", accent: "market", derived: true, sections: [], channels: [] }],
    CHANNELS,
  );

  assert.deepEqual(markets.channels.map((entry) => entry.handle), ["stockmoe", "cryptosrus"]);
  assert.deepEqual(markets.sections, ["Stocks", "Crypto"], "sections come from the channels' categories");
});

test("a theme cannot claim a channel the feed does not fetch", () => {
  const [theme] = resolveYoutubeThemes(
    [{
      id: "dig",
      name: "Dig Site",
      accent: "relic",
      sections: ["Archaeology"],
      // The second handle is not a configured channel: counting it would tell
      // the switcher this theme has two channels while the feed shows one.
      channels: [{ handle: "stockmoe", section: "Archaeology" }, { handle: "nosuchchannel", section: "Archaeology" }],
    }],
    CHANNELS,
  );

  assert.deepEqual(theme.channels.map((entry) => entry.handle), ["stockmoe"]);
});

test("membership accepts a bare handle and an @ prefix, and never repeats a channel", () => {
  const [theme] = resolveYoutubeThemes(
    [{ id: "stack", name: "Tech Stack", accent: "tech", sections: [], channels: ["@StockMoe", { handle: "stockmoe", section: "AI Labs" }] }],
    CHANNELS,
  );

  assert.equal(theme.channels.length, 1, "one channel is one membership");
  assert.equal(theme.channels[0].handle, "stockmoe");
  assert.deepEqual(theme.sections, ["Stocks"], "a bare handle keeps the channel's own category");
});

test("a section named only by a membership is added to the theme's section list", () => {
  const [theme] = resolveYoutubeThemes(
    [{ id: "dig", name: "Dig Site", accent: "relic", sections: ["Archaeology"], channels: [{ handle: "cryptosrus", section: "Unexplained" }] }],
    CHANNELS,
  );

  assert.deepEqual(theme.sections, ["Archaeology", "Unexplained"]);
});

test("the shipped themes resolve, are uniquely identified, and keep their sections", () => {
  const themes = resolveYoutubeThemes(YOUTUBE_THEMES, CHANNELS);
  const ids = themes.map((theme) => theme.id);

  assert.equal(ids[0], DEFAULT_THEME_ID, "markets stays first");
  assert.equal(new Set(ids).size, ids.length, "theme ids are unique");
  for (const theme of themes) {
    assert.ok(theme.name, `${theme.id} has a name`);
    assert.ok(theme.accent, `${theme.id} has an accent`);
    if (theme.id === DEFAULT_THEME_ID) continue;
    assert.ok(theme.sections.length, `${theme.id} ships a section layout`);
    assert.deepEqual(theme.channels, [], `${theme.id} ships unpopulated`);
  }
});

test("themes resolve to nothing rather than throwing when no channels are configured", () => {
  const themes = resolveYoutubeThemes(YOUTUBE_THEMES, []);
  assert.equal(themes.length, YOUTUBE_THEMES.length);
  assert.deepEqual(themes[0].channels, [], "the derived markets theme is simply empty");
});
