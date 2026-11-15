/* Prompts the website sends when it runs a desk through the Reporter Room.
   The Reporter Room's own Crypto prompt lists trending tokens; the desk
   pages and Today's Top 10 want crypto *news*, so they send this one. */
(function (global) {
  "use strict";

  var CRYPTO_NEWS = [
    "{date}",
    "TOP 10 CRYPTO NEWS BRIEF (LAST 24-48 HOURS)",
    "",
    "Search for current, verified cryptocurrency news from the last 24-48 hours and produce a TOP 10 report.",
    "This is news, not a list of trending tokens.",
    "",
    "PRIORITIZE:",
    "- Regulation, enforcement and policy (SEC, CFTC, EU MiCA, Asia)",
    "- ETF flows, approvals and institutional adoption",
    "- Major price moves in BTC, ETH and large caps, with the reason",
    "- Exchange, stablecoin and protocol news: hacks, launches, upgrades, listings",
    "- On-chain or macro developments that moved the market",
    "",
    "RULES:",
    "- Output exactly 10 stories.",
    "- Use a bold numbered heading: **#[N] [ASSET/TOPIC] — [HEADLINE]**",
    "- Add 2-3 short hyphen bullets: what happened, why it matters, and the source.",
    "- Separate confirmed facts from forecasts; no buy/sell advice.",
    "- Avoid duplicating the same event from multiple sources.",
  ].join("\n");

  global.DeskPrompts = { crypto: CRYPTO_NEWS };
})(window);
