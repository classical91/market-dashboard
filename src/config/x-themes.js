"use strict";

/**
 * Built-in X Intelligence themes.
 *
 * The themes themselves come from src/config/intelligence-themes.js, which X
 * Intelligence and YouTube Intelligence share. This module is only the X-shaped
 * view of them: the same identities, each given the empty `handles` list the
 * template registry expects.
 *
 * An X template is a named workspace with its own accent colour and a flat
 * list of the handles it shows. It has no sections. The shared catalogue does
 * carry them, because on YouTube a theme's sections ARE the categories a
 * channel joins it through, so the X view drops the field on the way past.
 *
 * The markets theme is special — it is seeded from the tracked-account list
 * (see seedMarkets in x-template-registry) so a fresh install opens on a
 * populated feed. Every other shared theme ships empty: which handles belong
 * in "Dig Site" or "Tech Stack" is a judgement call for whoever runs the
 * dashboard, and inventing handles would seed the feed with accounts that may
 * not exist. Conspiracy is the exception, because its accounts are known.
 *
 * Adding a theme to the catalogue is enough. The registry seeds it on a fresh
 * install and backfills it into an existing one exactly once — see
 * BUILT_IN_THEMES's use in XTemplateRegistry.ensureSeeded — so a theme deleted
 * by an admin stays deleted.
 */

const { sharedThemes } = require("./intelligence-themes");
const {
  CONSPIRACY_X_ACCOUNTS,
  CONSPIRACY_FOLLOWER_X_ACCOUNTS,
  CONSPIRACY_FOLLOWBACK_HANDLES,
} = require("./x-accounts");

const ALL_CONSPIRACY_X_ACCOUNTS = CONSPIRACY_X_ACCOUNTS.concat(CONSPIRACY_FOLLOWER_X_ACCOUNTS);

// Identity — name, description and accent — is the shared catalogue's, so the
// two pages cannot drift into offering different versions of the same theme.
// `sections` is deliberately not carried over; `handles` replaces it.
const SHARED_X_THEMES = sharedThemes().map((theme) => ({
  id: theme.id,
  name: theme.name,
  description: theme.description,
  accent: theme.accent,
  handles: [],
}));

const CONSPIRACY_THEME = {
  id: "conspiracy",
  name: "Conspiracy",
  description: "Narrative monitoring for unverified hidden-truth and cover-up claims",
  accent: "conspiracy",
  handles: ALL_CONSPIRACY_X_ACCOUNTS.map((account) => account.handle),
};

const BUILT_IN_THEMES = SHARED_X_THEMES.concat(CONSPIRACY_THEME);

const X_TEMPLATE_MEMBERSHIP_PACKS = [{
  id: "conspiracy-followers-2026-09-10",
  templateId: "conspiracy",
  handles: CONSPIRACY_FOLLOWER_X_ACCOUNTS.map((account) => account.handle),
}, {
  id: "conspiracy-followback-prune-2026-09-10",
  templateId: "conspiracy",
  removeHandles: CONSPIRACY_FOLLOWBACK_HANDLES,
  handles: [],
}];

module.exports = { BUILT_IN_THEMES, X_TEMPLATE_MEMBERSHIP_PACKS };
