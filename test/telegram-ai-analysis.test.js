"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  AI_ANALYSIS_TELEGRAM_WORD_LIMIT,
  TelegramService,
  countWords,
} = require("../src/services/telegram");

test("AI analysis Telegram captions stay within the 150-word broadcast limit", async () => {
  const originalFetch = global.fetch;
  const sentBodies = [];
  global.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => "",
    };
  };

  try {
    const telegram = new TelegramService({ botToken: "123456:test-token", chatIds: ["-100123"] });
    await telegram.postAIAnalysis({
      chartUrl: "https://example.com/chart.png",
      label: "BTCUSDT",
      interval: "1W",
      verdict: "HOLD",
      analysis: Array.from({ length: 220 }, (_, index) => `word${index + 1}`).join(" "),
    });

    assert.equal(sentBodies.length, 1);
    assert.ok(sentBodies[0].caption, "sendPhoto caption should be populated");
    assert.ok(
      countWords(sentBodies[0].caption) <= AI_ANALYSIS_TELEGRAM_WORD_LIMIT,
      `caption exceeded ${AI_ANALYSIS_TELEGRAM_WORD_LIMIT} words`,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
