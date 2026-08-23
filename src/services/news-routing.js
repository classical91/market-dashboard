"use strict";

// Where a categorized news broadcast is allowed to land.
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

/**
 * The locked destinations for a news category, or `null` when the category has
 * none and the sender should fall back to the configured chat list.
 *
 * `financeTopicRoutingEnabled` is the single "is category routing on?" switch,
 * governing every locked topic rather than only the finance ones. Kept under
 * its original name so stored settings keep working.
 */
function destinationsForNewsType(newsType, settings) {
  if (settings?.financeTopicRoutingEnabled === false) return null;
  if (FINANCE_NEWS_TYPES.has(newsType)) return FINANCE_NEWS_DESTINATIONS.map((target) => ({ ...target }));
  if (newsType === "Geopolitics") return GEOPOLITICS_DESTINATIONS.map((target) => ({ ...target }));
  return null;
}

module.exports = {
  FINANCE_NEWS_TYPES,
  FINANCE_NEWS_DESTINATIONS,
  GEOPOLITICS_DESTINATIONS,
  destinationsForNewsType,
};
