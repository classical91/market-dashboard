"use strict";

/**
 * Built-in X Intelligence themes.
 *
 * A theme is a template preset: a named workspace with its own accent colour
 * and its own section layout. The markets theme is special — it is seeded from
 * the tracked-account list (see seedMarkets in x-template-registry) so a fresh
 * install opens on a populated feed. Every other theme ships with its sections
 * only and no memberships: which handles belong in "Ancient Sites" or "AI Labs"
 * is a judgement call for whoever runs the dashboard, and inventing handles
 * here would seed the feed with accounts that may not exist.
 *
 * Sections are still worth shipping. They are what makes a theme a theme: the
 * admin UI lists them as the drop targets an account gets assigned to, so an
 * empty theme is ready to fill rather than a blank page.
 *
 * Adding a theme here is enough. The registry seeds it on a fresh install and
 * backfills it into an existing one exactly once — see BUILT_IN_THEMES's use in
 * XTemplateRegistry.ensureSeeded — so a theme deleted by an admin stays deleted.
 */

const BUILT_IN_THEMES = [
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
    memberships: [],
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
    memberships: [],
  },
];

module.exports = { BUILT_IN_THEMES };
