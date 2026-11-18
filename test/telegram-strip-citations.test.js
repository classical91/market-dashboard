"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { TelegramService, stripCitations } = require("../src/services/telegram");

// As the web-search model writes a crypto desk run: every bullet ends in an
// inline "([domain](url))" citation.
const CRYPTO_RUN = [
  "1. **#1 Pearl (PEARL) - meme / social buzz**",
  "- Why it is trending: showing up in CoinGecko's U.S. trending list with strong recent attention. ([coingecko.com](https://www.coingecko.com/en/highlights/trending-crypto/united-states?utm_source=openai))",
  "- Main catalyst or signal: fresh search interest and repeated mentions in \"buzz\" roundups on Nov. 18, 2026. ([pickaxe.io](https://www.pickaxe.io/resources/news/pudgy-penguins-tops-searches-amid-solana-10-buzz?utm_source=openai))",
  "",
  "2. **#2 Venice Token (VVV) - AI / ecosystem token**",
  "- Quick caution if relevant: momentum here looks sentiment-led, so reversals can be sharp ([crypvu.com](https://crypvu.com/en/alts.html?utm_source=openai), [coingecko.com](https://www.coingecko.com/?utm_source=openai)).",
].join("\n");

test("inline web-search citations are removed from the posted copy", () => {
  const out = stripCitations(CRYPTO_RUN);
  assert.doesNotMatch(out, /https?:\/\//);
  assert.doesNotMatch(out, /coingecko\.com|pickaxe\.io|crypvu\.com/);
  assert.equal(
    out,
    [
      "1. **#1 Pearl (PEARL) - meme / social buzz**",
      "- Why it is trending: showing up in CoinGecko's U.S. trending list with strong recent attention.",
      "- Main catalyst or signal: fresh search interest and repeated mentions in \"buzz\" roundups on Nov. 18, 2026.",
      "",
      "2. **#2 Venice Token (VVV) - AI / ecosystem token**",
      "- Quick caution if relevant: momentum here looks sentiment-led, so reversals can be sharp.",
    ].join("\n"),
  );
});

test("story text is kept: ordinary parentheses, prose links and story wording survive", () => {
  assert.equal(stripCitations("Pearl (PEARL) rose 12% (24h)."), "Pearl (PEARL) rose 12% (24h).");
  assert.equal(
    stripCitations("[Reuters reported](https://reuters.com/x) a cut. Sources say more is coming."),
    "Reuters reported a cut. Sources say more is coming.",
  );
});

test("bare URLs, Sources lines and link-only bullets are dropped", () => {
  const out = stripCitations([
    "Fed holds rates (https://example.com/fed). Details: https://example.com/a",
    "",
    "**Sources:**",
    "- [reuters.com](https://reuters.com/a)",
    "- https://bloomberg.com/b",
    "Source: CoinDesk",
  ].join("\n"));
  assert.equal(out, "Fed holds rates. Details:");
});

test("postReportSection posts the report without its sources", async () => {
  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }), text: async () => "" };
  };
  try {
    const telegram = new TelegramService({ botToken: "123456:test-token", chatIds: ["-100123"] });
    await telegram.postReportSection({ newsType: "Crypto", text: CRYPTO_RUN, date: "November 18, 2026" });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /CRYPTO TOP 10/);
    assert.match(sent[0].text, /<b>#1 Pearl \(PEARL\) - meme \/ social buzz<\/b>/);
    assert.doesNotMatch(sent[0].text, /utm_source|https?:\/\//);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a report that is nothing but sources is refused rather than posted empty", async () => {
  const telegram = new TelegramService({ botToken: "123456:test-token", chatIds: ["-100123"] });
  await assert.rejects(
    telegram.postReportSection({ newsType: "Crypto", text: "Sources:\n- https://example.com" }),
    /Nothing to send/,
  );
});
