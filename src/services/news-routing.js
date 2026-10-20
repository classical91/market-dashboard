"use strict";

// Where a categorized news broadcast is allowed to land.
//
// The tables below are the defaults. Settings -> Telegram -> News Category
// Routing can override any category with its own chat/topic list, saved as
// `categoryDestinations` in the broadcast ledger settings; a category with no
// override keeps the default here. Only an admin can change that setting, so
// the guarantee below still holds: TELEGRAM_CHAT_IDS alone never widens it.
//
// This was previously a private table inside the broadcast-ledger route, which
// was fine while the ledger was the only sender. The Daily Reporter now sends
// per category too, and two independent copies of a destination table is how a
// category ends up in the right topic on one path and the default channel on
// the other. One table, imported by both.
//
// The ids are approved forum topics, not configuration: a broader
// TELEGRAM_CHAT_IDS cannot widen news routing, because these targets replace
// the configured chat list rather than adding to it.

const FINANCE_NEWS_TYPES = new Set(["Stock", "Crypto", "Economics"]);

// Stock, Crypto and Economics deliberately share one pair of destinations.
// Splitting them needs real chat/topic ids, not a guess — see README.
const FINANCE_NEWS_DESTINATIONS = Object.freeze([
  Object.freeze({ chatId: "-1001841650798", threadId: "6297" }),
  Object.freeze({ chatId: "-1001941064823", threadId: "984" }),
]);

// Geopolitics has its own topic — the War Room. It is the one category that
// does not share the finance pair, and it previously followed TELEGRAM_CHAT_IDS
// like an uncategorized send, which put war-room stories in the general
// channels alongside the market digests.
const GEOPOLITICS_DESTINATIONS = Object.freeze([
  Object.freeze({ chatId: "-1001841650798", threadId: "75972" }),
]);

const MAX_DESTINATIONS_PER_CATEGORY = 10;
// A numeric chat id (groups and channels are negative) or a public
// @channelusername — the two forms the Bot API accepts as chat_id.
const CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const THREAD_ID_PATTERN = /^\d{1,12}$/;

/** The shipped destinations for a category, before any Settings override. */
function defaultDestinationsForNewsType(newsType) {
  if (FINANCE_NEWS_TYPES.has(newsType)) return FINANCE_NEWS_DESTINATIONS.map((target) => ({ ...target }));
  if (newsType === "Geopolitics") return GEOPOLITICS_DESTINATIONS.map((target) => ({ ...target }));
  return null;
}

function toTarget(destination) {
  return destination.threadId
    ? { chatId: destination.chatId, threadId: destination.threadId }
    : { chatId: destination.chatId };
}

/**
 * The locked destinations for a news category, or `null` when the category has
 * none and the sender should fall back to the configured chat list.
 *
 * A Settings override wins over the default. An override that is an empty
 * list means "no topic of its own": the category falls back to the configured
 * chat list, exactly like an uncategorized send.
 *
 * `financeTopicRoutingEnabled` is the single "is category routing on?" switch,
 * governing every locked topic rather than only the finance ones. Kept under
 * its original name so stored settings keep working.
 */
function destinationsForNewsType(newsType, settings) {
  if (settings?.financeTopicRoutingEnabled === false) return null;
  const overrides = settings?.categoryDestinations;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, newsType)) {
    const list = overrides[newsType];
    return Array.isArray(list) && list.length ? list.map(toTarget) : null;
  }
  return defaultDestinationsForNewsType(newsType);
}

/**
 * Validates the `categoryDestinations` setting: `{ [category]: [{ chatId, threadId }] }`.
 *
 * `strict` (a save from Settings) throws a 400-shaped error naming the first
 * bad row, because silently dropping a mistyped chat id would quietly reroute
 * that category. Non-strict (reading the stored file) keeps what is valid.
 */
function normalizeCategoryDestinations(input, { categories = null, strict = false } = {}) {
  const fail = (message) => {
    if (!strict) return null;
    const err = new Error(message);
    err.statusCode = 400;
    err.expose = true;
    throw err;
  };
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    fail("categoryDestinations must be an object keyed by category");
    return {};
  }

  const result = {};
  for (const [rawCategory, list] of Object.entries(input).slice(0, 40)) {
    const category = String(rawCategory).trim().slice(0, 40);
    if (!category) continue;
    if (categories && !categories.includes(category)) {
      fail(`Unknown news category: ${category}`);
      continue;
    }
    if (!Array.isArray(list)) {
      fail(`${category}: destinations must be a list`);
      continue;
    }
    if (list.length > MAX_DESTINATIONS_PER_CATEGORY) {
      fail(`${category}: at most ${MAX_DESTINATIONS_PER_CATEGORY} destinations`);
    }
    const seen = new Set();
    const destinations = [];
    list.slice(0, MAX_DESTINATIONS_PER_CATEGORY).forEach((entry, index) => {
      const where = `${category} destination ${index + 1}`;
      const chatId = String(entry?.chatId == null ? "" : entry.chatId).trim();
      const threadId = String(entry?.threadId == null ? "" : entry.threadId).trim();
      if (!CHAT_ID_PATTERN.test(chatId)) {
        fail(`${where}: "${chatId}" is not a Telegram chat id (e.g. -1001841650798 or @channelname)`);
        return;
      }
      if (threadId && !THREAD_ID_PATTERN.test(threadId)) {
        fail(`${where}: topic id "${threadId}" must be a number`);
        return;
      }
      const key = `${chatId}:${threadId}`;
      if (seen.has(key)) {
        fail(`${where} repeats an earlier destination`);
        return;
      }
      seen.add(key);
      destinations.push({ chatId, threadId: threadId || null });
    });
    result[category] = destinations;
  }
  return result;
}

module.exports = {
  FINANCE_NEWS_TYPES,
  FINANCE_NEWS_DESTINATIONS,
  GEOPOLITICS_DESTINATIONS,
  MAX_DESTINATIONS_PER_CATEGORY,
  defaultDestinationsForNewsType,
  destinationsForNewsType,
  normalizeCategoryDestinations,
};
