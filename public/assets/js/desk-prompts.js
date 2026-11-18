/* Prompts the website sends when it runs a desk through the Reporter Room.
   The Reporter Room's own Crypto prompt lists trending tokens; the desk
   pages and Today's Top 10 want crypto *news*, so they send this one. */
(function (global) {
  "use strict";

  var CRYPTO_NEWS = [
    "{date}",
    "TOP 10 CRYPTO NEWS BRIEF (LAST 24-48 HOURS)",
    "",
    "Search for verified cryptocurrency news from the last 24-48 hours and rank the 10 stories that matter most.",
    "This is news, not a list of trending tokens.",
    "",
    "Cover: regulation and enforcement (SEC, CFTC, EU MiCA, Asia); ETF flows and institutional moves;",
    "big BTC, ETH and large-cap moves and why they happened; exchanges, stablecoins and protocols",
    "(hacks, launches, upgrades, listings); and on-chain or macro shifts that moved the market.",
    "One event appears once, however many outlets covered it.",
    "",
    "Open with one line before #1: **The tape:** what is driving crypto today, in one sentence.",
    "",
    "Then exactly 10 items:",
    "**#[N] [EMOJI] [ASSET/TOPIC] — [headline with the number or name in it]**",
    "- What happened: the fact, with the figure (price, % move, flows, amount hacked)",
    "- Why it matters: who it hits and what it changes",
    "- Source: the publication or official body that reported it",
    "",
    "Pick an [EMOJI] for the kind of story (⚖️ regulation, 🏦 institutions/ETFs, 📈 price move,",
    "🔓 hack/exploit, 🚀 launch/upgrade, 💵 stablecoin, ⛓️ on-chain).",
    "Separate confirmed facts from forecasts; no buy/sell advice.",
  ].join("\n");

  global.DeskPrompts = { crypto: CRYPTO_NEWS };
})(window);
