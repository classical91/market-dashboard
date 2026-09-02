"use strict";

/**
 * Built-in X Intelligence themes.
 *
 * The themes themselves come from src/config/intelligence-themes.js, which X
 * Intelligence and YouTube Intelligence share. This module is only the X-shaped
 * view of them: the same themes, each given the empty `memberships` list the
 * template registry expects.
 *
 * A theme is a template preset: a named workspace with its own accent colour
 * and its own section layout. The markets theme is special — it is seeded from
 * the tracked-account list (see seedMarkets in x-template-registry) so a fresh
 * install opens on a populated feed. Every other theme ships with its sections
 * only and no memberships: which handles belong in "Lost Civilizations" or
 * "AI Labs" is a judgement call for whoever runs the dashboard, and inventing
 * handles would seed the feed with accounts that may not exist.
 *
 * Sections are still worth shipping. They are what makes a theme a theme: the
 * admin UI lists them as the drop targets an account gets assigned to, so an
 * empty theme is ready to fill rather than a blank page.
 *
 * Adding a theme to the catalogue is enough. The registry seeds it on a fresh
 * install and backfills it into an existing one exactly once — see
 * BUILT_IN_THEMES's use in XTemplateRegistry.ensureSeeded — so a theme deleted
 * by an admin stays deleted.
 */

const { sharedThemesWithMemberships } = require("./intelligence-themes");

// X templates carry a `memberships` list of X handles, so the catalogue's
// themes arrive with an empty one. Identity — name, description, accent and
// sections — is the catalogue's, shared with YouTube Intelligence so the two
// pages cannot drift into offering different versions of the same theme.
const BUILT_IN_THEMES = sharedThemesWithMemberships("memberships");

module.exports = { BUILT_IN_THEMES };
