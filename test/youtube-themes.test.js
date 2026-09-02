"use strict";

// Covers YouTube Intelligence theme resolution: that a channel reaches a theme
// through its category alone, that the derived markets theme catches whatever
// the others do not, and that the shipped themes match the shared catalogue.

const test = require("node:test");
const assert = require("node:assert");

const {
  YOUTUBE_THEMES,
  DEFAULT_THEME_ID,
  resolveYoutubeThemes,
  themeSections,
} = require("../src/config/youtube-themes");
const { SHARED_THEMES } = require("../src/config/intelligence-themes");

function byId(themes, id) {
  return themes.find((theme) => theme.id === id);
}

test("a channel joins a theme through its category, with no membership to edit", () => {
  const themes = resolveYoutubeThemes(undefined, [
    { handle: "stockmoe", category: "Stocks" },
    { handle: "diggers", category: "Archaeology" },
    { handle: "shortcuts", category: "Shortcuts & Automation" },
  ]);

  assert.deepEqual(byId(themes, "dig").channels.map((c) => c.handle), ["diggers"]);
  assert.deepEqual(byId(themes, "stack").channels.map((c) => c.handle), ["shortcuts"]);
});

test("category matching ignores case and surrounding space", () => {
  const themes = resolveYoutubeThemes(undefined, [{ handle: "diggers", category: "  archaeology " }]);
  assert.deepEqual(byId(themes, "dig").channels.map((c) => c.handle), ["diggers"]);
});

test("a channel in the Tech category appears in the Tech Stack theme", () => {
  const themes = resolveYoutubeThemes(undefined, [{ handle: "techdaily", category: "Tech" }]);
  assert.deepEqual(byId(themes, "stack").channels.map((c) => c.handle), ["techdaily"]);
  assert.equal(themes.some((theme) => theme.name === "Tech"), false);
});

test("a custom category becomes a selectable theme with its matching channels", () => {
  const themes = resolveYoutubeThemes(undefined, [
    { handle: "tester-one", category: "Test" },
    { handle: "tester-two", category: " test " },
    { handle: "stockmoe", category: "Stocks" },
  ]);

  const testTheme = themes.find((theme) => theme.name === "Test");
  assert.ok(testTheme);
  assert.match(testTheme.id, /^category:/);
  assert.deepEqual(testTheme.channels.map((channel) => channel.handle), ["tester-one", "tester-two"]);
  assert.deepEqual(
    themes.find((theme) => theme.name === "Stocks").channels.map((channel) => channel.handle),
    ["stockmoe"],
  );
});

test("the derived markets theme holds every channel, so none is ever stranded", () => {
  const themes = resolveYoutubeThemes(undefined, [
    { handle: "stockmoe", category: "Stocks" },
    { handle: "diggers", category: "Archaeology" },
    // A category no theme declares: it must still be reachable somewhere.
    { handle: "oddity", category: "Something Brand New" },
  ]);

  const markets = byId(themes, DEFAULT_THEME_ID);
  assert.deepEqual(markets.channels.map((c) => c.handle), ["stockmoe", "diggers", "oddity"]);
  assert.ok(markets.sections.includes("Something Brand New"), "the new category becomes a section");
});

test("a theme's empty sections survive, so the manage panel can suggest them", () => {
  const themes = resolveYoutubeThemes(undefined, []);
  const dig = byId(themes, "dig");

  assert.deepEqual(dig.channels, [], "no channels yet");
  assert.ok(dig.sections.includes("Lost Civilizations"), "but the layout is still offered");
  assert.ok(themeSections().includes("AI Labs"), "and reaches the category suggestions");
});

test("every shipped theme is resolvable, uniquely identified and accented", () => {
  const themes = resolveYoutubeThemes(undefined, []);
  const ids = themes.map((theme) => theme.id);

  assert.equal(ids[0], DEFAULT_THEME_ID, "markets stays first");
  assert.equal(new Set(ids).size, ids.length, "theme ids are unique");
  for (const theme of themes) {
    assert.ok(theme.name, `${theme.id} has a name`);
    assert.ok(theme.accent, `${theme.id} has an accent`);
  }
});

test("the shared themes are the catalogue's, not a second copy of it", () => {
  for (const shared of SHARED_THEMES) {
    const mine = YOUTUBE_THEMES.find((theme) => theme.id === shared.id);
    assert.ok(mine, `${shared.id} is offered on the YouTube page`);
    assert.equal(mine.name, shared.name);
    assert.equal(mine.description, shared.description);
    assert.equal(mine.accent, shared.accent);
    assert.deepEqual(mine.sections, shared.sections);
  }
});

test("resolving never mutates the catalogue, so one page cannot change the other's themes", () => {
  const before = JSON.stringify(SHARED_THEMES);
  resolveYoutubeThemes(undefined, [{ handle: "oddity", category: "Something Brand New" }]);
  resolveYoutubeThemes(undefined, [{ handle: "other", category: "Another One" }]);
  assert.equal(JSON.stringify(SHARED_THEMES), before);
});
