"use strict";

/**
 * YouTube Intelligence themes.
 *
 * A theme is a named view over the tracked channels: it owns a subset of them,
 * files each under a section, and carries an accent colour. The page fetches
 * every channel once and filters client-side, so switching themes costs no
 * request and no extra YouTube quota — which is the reason themes are a view
 * rather than a separate feed per theme.
 *
 * Membership is by handle, matching src/config/youtube-channels.js. One channel
 * may sit in several themes; a handle naming no configured channel is dropped
 * (see resolveYoutubeThemes) rather than rendering a theme that silently shows
 * fewer channels than it lists.
 *
 * The markets theme is derived from the channel list itself, so a channel added
 * to youtube-channels.js shows up there without being named twice. Every other
 * theme ships with its sections and no channels: which YouTube channels belong
 * under "Lost Civilizations" or "AI Labs" is a judgement call for whoever runs
 * the dashboard, and inventing handles here would build feed URLs for channels
 * that may not exist.
 *
 * Adding a theme is adding an entry here. Nothing persists — unlike the X
 * template registry there is no runtime editing, so the config is the whole
 * source of truth and a deploy is how a theme changes.
 */

const { resolveYoutubeChannels } = require("./youtube-channels");

const DEFAULT_THEME_ID = "markets";

const YOUTUBE_THEMES = [
  {
    id: DEFAULT_THEME_ID,
    name: "Markets",
    description: "Live streams, scheduled streams and latest uploads from trusted channels",
    accent: "market",
    // Sections and channels both come from the channel list — see
    // resolveYoutubeThemes. Listing them here would mean editing two files to
    // add one channel.
    derived: true,
    sections: [],
    channels: [],
  },
  {
    id: "dig",
    name: "Dig Site",
    description: "Archaeology, ancient history and the questions still open",
    accent: "relic",
    sections: [
      "Archaeology",
      "Ancient History",
      "Lost Civilizations",
      "Unexplained",
      "Open Questions",
    ],
    channels: [],
  },
  {
    id: "stack",
    name: "Tech Stack",
    description: "Apple, automation, AI models and the people building them",
    accent: "tech",
    sections: [
      "Apple & iOS",
      "Shortcuts & Automation",
      "AI Labs",
      "AI Tooling",
      "Devs & Builders",
    ],
    channels: [],
  },
];

function normalizeHandle(value) {
  return String(value == null ? "" : value).trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Resolves the configured themes against the channel list the service actually
 * has, so what a theme claims and what it can render cannot disagree.
 *
 * A membership may be written as a bare handle ("stockmoe") or as
 * { handle, section }. A bare handle keeps the channel's own category as its
 * section, which is what makes the derived markets theme work.
 */
function resolveYoutubeThemes(themes = YOUTUBE_THEMES, channels = resolveYoutubeChannels()) {
  const byHandle = new Map((channels || []).map((channel) => [normalizeHandle(channel.handle), channel]));

  return themes.map((theme) => {
    const memberships = [];
    const sections = Array.isArray(theme.sections) ? theme.sections.slice() : [];

    const entries = theme.derived
      ? (channels || []).map((channel) => ({ handle: channel.handle, section: channel.category }))
      : (Array.isArray(theme.channels) ? theme.channels : []);

    for (const entry of entries) {
      const raw = typeof entry === "string" ? { handle: entry, section: "" } : entry || {};
      const handle = normalizeHandle(raw.handle);
      const channel = byHandle.get(handle);
      // A handle with no channel behind it is dropped: the feed has nothing to
      // show for it, and counting it would overstate the theme.
      if (!channel) continue;
      if (memberships.some((member) => member.handle === handle)) continue;

      const section = String(raw.section || channel.category || "Other").trim() || "Other";
      if (!sections.includes(section)) sections.push(section);
      memberships.push({ handle, section });
    }

    return {
      id: theme.id,
      name: theme.name,
      description: theme.description || "",
      accent: theme.accent || "market",
      sections,
      channels: memberships,
    };
  });
}

module.exports = { YOUTUBE_THEMES, DEFAULT_THEME_ID, resolveYoutubeThemes, normalizeHandle };
