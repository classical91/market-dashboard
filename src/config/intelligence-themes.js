"use strict";

/**
 * The shared theme catalogue for the intelligence pages.
 *
 * X Intelligence and YouTube Intelligence both offer the same themes, and both
 * used to spell each one out in full — the same name, description, accent and
 * section list written twice. Renaming a theme or adding a section meant
 * editing two files and keeping them in agreement by hand; the first time they
 * disagreed, one page would quietly be a theme behind the other.
 *
 * A theme's identity lives here — name, description and accent. What differs
 * between the pages is how membership is expressed, and each config adds that
 * on top of these definitions rather than restating the whole theme.
 *
 * Sections belong to YouTube alone. There, a theme's sections ARE the category
 * names a channel joins the theme through, so they are part of its identity.
 * X Intelligence has no sections: an X template is a flat list of handles, and
 * x-themes.js drops the field when it reads this catalogue.
 *
 * Not every theme belongs here. A theme that only makes sense on one page (the
 * YouTube markets theme, derived from its channel list) stays local to it.
 * This is for the ones both pages are meant to keep identical.
 *
 * Adding a theme here gives it to both pages at once, with no accounts or
 * channels in it: which ones belong to "Dig Site" is a judgement call for
 * whoever runs the dashboard, and inventing handles would point the feeds at
 * accounts that may not exist.
 */

const SHARED_THEMES = [
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
  },
  {
    id: "stack",
    name: "Tech Stack",
    description: "Apple, automation, AI models and the people building them",
    accent: "tech",
    sections: [
      "Tech",
      "Apple & iOS",
      "Shortcuts & Automation",
      "AI Labs",
      "AI Tooling",
      "Devs & Builders",
    ],
  },
];

/**
 * The catalogue as plain theme definitions.
 *
 * Returns copies: the arrays here are module state read by both pages, and a
 * caller that normalized or sorted one in place would change the other page's
 * themes as a side effect.
 */
function sharedThemes() {
  return SHARED_THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    accent: theme.accent,
    sections: theme.sections.slice(),
  }));
}

module.exports = { SHARED_THEMES, sharedThemes };
