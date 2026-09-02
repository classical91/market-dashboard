"use strict";

/**
 * YouTube Intelligence themes.
 *
 * A theme is a named view over the tracked channels: it owns a set of sections
 * and carries an accent colour. The page fetches every channel once and filters
 * client-side, so switching themes costs no request and no YouTube quota —
 * which is why a theme is a view rather than a separate feed.
 *
 * A channel joins a theme through its category. A theme's sections ARE category
 * names, and a channel whose category matches one of them is in that theme.
 *
 * That indirection is the point. The alternative — a theme listing member
 * handles — means adding a channel is two edits: register it, then put it in a
 * theme. Since a channel needs a category anyway, letting the category do the
 * placing makes adding a channel under "Archaeology" all it takes to fill the
 * Dig Site theme, with no second step to forget. The cost is that a channel
 * sits in one theme rather than several, which matches how these are used: a
 * channel is about one subject.
 *
 * Theme identity (name, description, accent, sections) is shared with X
 * Intelligence via src/config/intelligence-themes.js so the two pages cannot
 * drift apart. The markets theme is local to this page because it is derived:
 * it owns whatever categories the channel list actually has, so a channel added
 * under a brand-new category is never stranded outside every theme.
 */

const { sharedThemes } = require("./intelligence-themes");

const DEFAULT_THEME_ID = "markets";

const MARKETS_THEME = {
  id: DEFAULT_THEME_ID,
  name: "Markets",
  description: "Live streams, scheduled streams and latest uploads from trusted channels",
  accent: "market",
  // Sections come from the channel list itself — see resolveYoutubeThemes.
  derived: true,
  sections: [],
};

// Membership is by category here, so the catalogue's definitions are used as
// they are — there is no per-channel membership list to add.
const YOUTUBE_THEMES = [MARKETS_THEME].concat(sharedThemes());

function normalizeSection(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function normalizeHandle(value) {
  return String(value == null ? "" : value).trim().replace(/^@+/, "").toLowerCase();
}

function categoryThemeId(category) {
  return `category:${encodeURIComponent(normalizeSection(category))}`;
}

/**
 * Resolves each theme against the channels the service actually has.
 *
 * Every theme reports the channels it currently holds, so the switcher's count
 * and the feed can never disagree: both are computed from one list. A section
 * with no channels behind it is kept — it is what tells the admin panel which
 * categories a theme is waiting to be filled with.
 */
function resolveYoutubeThemes(themes = YOUTUBE_THEMES, channels = []) {
  const list = Array.isArray(channels) ? channels : [];

  const resolved = themes.map((theme) => {
    // The derived theme takes its sections from the channels, in first-seen
    // order, so a channel added under a new category is immediately visible
    // somewhere rather than invisible until the config catches up.
    const sections = theme.derived ? [] : (theme.sections || []).slice();
    if (theme.derived) {
      for (const channel of list) {
        const section = String(channel.category || "Other").trim() || "Other";
        if (!sections.includes(section)) sections.push(section);
      }
    }

    const wanted = new Set(sections.map(normalizeSection));
    const members = list
      .filter((channel) => wanted.has(normalizeSection(channel.category)))
      .map((channel) => ({
        handle: normalizeHandle(channel.handle),
        section: String(channel.category || "Other").trim() || "Other",
      }));

    return {
      id: theme.id,
      name: theme.name,
      description: theme.description || "",
      accent: theme.accent || "market",
      sections,
      channels: members,
    };
  });

  // A category typed in the manage panel should become selectable immediately.
  // Categories already claimed by a named theme (for example Tech -> Tech
  // Stack) stay there; every other category receives its own generated theme.
  const claimed = new Set();
  for (const theme of themes) {
    if (theme.derived) continue;
    for (const section of theme.sections || []) claimed.add(normalizeSection(section));
  }

  const custom = [];
  for (const channel of list) {
    const category = String(channel.category || "Other").trim() || "Other";
    const normalized = normalizeSection(category);
    if (claimed.has(normalized)) continue;
    let theme = custom.find((entry) => entry.normalized === normalized);
    if (!theme) {
      theme = {
        normalized,
        id: categoryThemeId(category),
        name: category,
        description: `${category} channels`,
        accent: "market",
        sections: [category],
        channels: [],
      };
      custom.push(theme);
    }
    theme.channels.push({ handle: normalizeHandle(channel.handle), section: category });
  }

  return resolved.concat(custom.map(({ normalized, ...theme }) => theme));
}

/**
 * Every section any theme offers.
 *
 * This no longer seeds YouTube categories. It used to, which meant a section a
 * theme names — Archaeology, AI Labs — became a YouTube category on first boot
 * with no channel in it. YouTube categories are created deliberately in the
 * manage panel now, so themes and categories are independent.
 */
function themeSections(themes = YOUTUBE_THEMES) {
  const sections = [];
  for (const theme of themes) {
    for (const section of theme.sections || []) {
      if (!sections.some((entry) => normalizeSection(entry) === normalizeSection(section))) {
        sections.push(section);
      }
    }
  }
  return sections;
}

module.exports = {
  YOUTUBE_THEMES,
  DEFAULT_THEME_ID,
  resolveYoutubeThemes,
  themeSections,
  normalizeHandle,
};
