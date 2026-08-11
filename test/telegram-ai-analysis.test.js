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

test("signal alerts include Alpha Team pattern evidence and Trading Lab verdict", async () => {
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
    const telegram = new TelegramService({
      botToken: "123456:test-token",
      chatIds: ["-100123"],
      dashboardUrl: "https://market-dashboard.example",
    });
    await telegram.postSignalAlerts(
      [{
        symbol: "ETHUSDT",
        interval: "15m",
        from: "FLAT",
        to: "LONG",
        score: 83,
        price: 3580.25,
        trendRegime: "TREND_UP",
        indicators: {
          rsi: 56.2,
          adx: 27.4,
          macdBullish: true,
          aboveVwap: true,
          volumeAboveAverage: true,
          ema20AboveEma50: true,
          priceAboveEma200: true,
          bullishChecks: 5,
          bearishChecks: 1,
        },
      }],
      [{
        symbol: "ETHUSDT",
        interval: "15m",
        direction: "LONG",
        status: "dry-run",
        reason: "Would open (paper trading disabled)",
        decision: "TAKE",
        confidenceScore: 82,
      }],
    );

    assert.equal(sentBodies.length, 1);
    const text = sentBodies[0].text;
    assert.match(text, /ALPHA TEAM SIGNALS/);
    assert.match(text, /trend_pullback/);
    assert.match(text, /Regime: TREND_UP/);
    assert.match(text, /Bullish checks 5\/6/);
    assert.match(text, /Verdict: REVIEW/);
    assert.match(text, /Setup passed review/);
    assert.match(text, /Visit: https:\/\/market-dashboard\.example\/signal-screener\.html\?view=alpha/);
    assert.match(text, /Readme: https:\/\/market-dashboard\.example\/alpha-team\.html\?view=alpha/);
    assert.doesNotMatch(text, /dry-run/i);
    assert.doesNotMatch(text, /Would open/i);
    assert.doesNotMatch(text, /paper/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Pattern Scanner alerts link only to the available dashboard page", async () => {
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
    const telegram = new TelegramService({
      botToken: "123456:test-token",
      chatIds: ["-100123"],
      dashboardUrl: "https://market-dashboard.example/",
    });
    await telegram.postPatternAlerts([
      { symbol: "ETHUSDT", interval: "4h", kind: "divergence", name: "Regular Bullish", bias: "bullish" },
      { symbol: "SOLUSDT", interval: "1D", kind: "breakout", name: "Falling Wedge", bias: "bullish", score: 64 },
    ]);

    assert.equal(sentBodies.length, 1);
    const text = sentBodies[0].text;
    assert.match(text, /PATTERN SCANNER/);
    assert.match(text, /WATCH/);
    assert.match(text, /Visit: https:\/\/market-dashboard\.example\/pattern-scanner\.html\?view=alpha/);
    assert.match(text, /Readme: https:\/\/market-dashboard\.example\/alpha-team\.html\?view=alpha/);
    assert.doesNotMatch(text, /automatic live trade/i);
    assert.doesNotMatch(text, /paper/i);
  } finally {
    global.fetch = originalFetch;
  }
});
