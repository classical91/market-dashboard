"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { SignalBotService } = require("../src/services/signal-bot");
const { MemoryCache } = require("../src/services/cache");

function makeBot({ signalsByCycle }) {
  let cycle = -1;
  const sent = [];
  const screener = {
    // scanAll is called once per timeframe per cycle; advance the cycle only
    // on the first timeframe so both timeframes see the same cycle's data.
    _calls: 0,
    async scanAll(interval) {
      if (this._calls % 2 === 0) cycle += 1;
      this._calls += 1;
      return signalsByCycle[Math.min(cycle, signalsByCycle.length - 1)].map((entry) => ({
        ...entry,
        interval,
      }));
    },
  };
  const telegram = {
    configured: true,
    async postSignalAlerts(transitions) {
      sent.push(transitions);
    },
    async postPatternAlerts() {},
  };
  const bot = new SignalBotService({
    signalScreenerService: screener,
    telegramService: telegram,
    stateCache: new MemoryCache(),
    timeframes: ["4h", "1D"],
  });
  return { bot, sent };
}

test("first scan baselines silently, a flip alerts once, and holding state stays quiet", async () => {
  const { bot, sent } = makeBot({
    signalsByCycle: [
      [{ symbol: "BTCUSDT", signal: "FLAT", score: 50 }],
      [{ symbol: "BTCUSDT", signal: "LONG", score: 83 }],
      [{ symbol: "BTCUSDT", signal: "LONG", score: 83 }],
    ],
  });

  const first = await bot.runOnce();
  assert.equal(first.screenerTransitions.length, 0, "baseline scan must not alert");
  assert.equal(sent.length, 0);

  const second = await bot.runOnce();
  assert.equal(second.screenerTransitions.length, 2, "FLAT->LONG should alert on both timeframes");
  assert.equal(second.screenerTransitions[0].from, "FLAT");
  assert.equal(second.screenerTransitions[0].to, "LONG");
  assert.equal(second.screenerTransitions[0].score, 83);
  assert.equal(sent.length, 1, "transitions are batched into one send");

  const third = await bot.runOnce();
  assert.equal(third.screenerTransitions.length, 0, "unchanged signal must not re-alert");
  assert.equal(sent.length, 1);
});

test("errored scan rows neither alert nor clobber the stored state", async () => {
  const { bot, sent } = makeBot({
    signalsByCycle: [
      [{ symbol: "ETHUSDT", signal: "SHORT", score: 67 }],
      [{ symbol: "ETHUSDT", error: "Binance klines HTTP 500" }],
      [{ symbol: "ETHUSDT", signal: "SHORT", score: 67 }],
    ],
  });

  await bot.runOnce(); // baseline SHORT
  await bot.runOnce(); // errored cycle — no data, no state change
  const third = await bot.runOnce(); // back to SHORT: same as stored state
  assert.equal(third.screenerTransitions.length, 0, "recovering with the same signal must not alert");
  assert.equal(sent.length, 0);
});

function makeChart(close) {
  return { candles: [[0, close, close + 1, close - 1, close]] };
}

function makePatternBot({ patternsByCycle }) {
  let cycle = -1;
  const patternSent = [];
  const logged = [];
  const patternScanner = {
    _calls: 0,
    async scanAll() {
      cycle += 1;
      return patternsByCycle[Math.min(cycle, patternsByCycle.length - 1)];
    },
  };
  const telegram = {
    configured: true,
    async postSignalAlerts() {},
    async postPatternAlerts(events) {
      patternSent.push(events);
    },
  };
  const tracker = {
    async resolveDue() { return []; },
    log(entry) { logged.push(entry); },
  };
  const bot = new SignalBotService({
    signalScreenerService: { async scanAll() { return []; } },
    patternScannerService: patternScanner,
    patternTrackerService: tracker,
    telegramService: telegram,
    stateCache: new MemoryCache(),
    timeframes: ["4h"],
  });
  return { bot, patternSent, logged };
}

test("a pattern reaching breakout alerts and is not re-alerted while it stays breakout", async () => {
  const { bot, patternSent, logged } = makePatternBot({
    patternsByCycle: [
      [{ symbol: "BTCUSDT", interval: "4h", pattern: { pattern: "Falling Wedge", bias: "bullish", status: "forming", score: 40 }, divergence: null, chart: makeChart(100) }],
      [{ symbol: "BTCUSDT", interval: "4h", pattern: { pattern: "Falling Wedge", bias: "bullish", status: "breakout", score: 62 }, divergence: null, chart: makeChart(105) }],
      [{ symbol: "BTCUSDT", interval: "4h", pattern: { pattern: "Falling Wedge", bias: "bullish", status: "breakout", score: 62 }, divergence: null, chart: makeChart(106) }],
    ],
  });

  await bot.runOnce(); // baseline: forming, recorded silently
  assert.equal(patternSent.length, 0);
  assert.equal(logged.length, 0, "baseline must not log a tracker entry either");

  const second = await bot.runOnce(); // forming -> breakout
  assert.equal(second.patternEvents.length, 1);
  assert.equal(second.patternEvents[0].kind, "breakout");
  assert.equal(second.patternEvents[0].name, "Falling Wedge");
  assert.equal(patternSent.length, 1);
  assert.equal(logged.length, 1, "the breakout transition should be tracker-logged");
  assert.equal(logged[0].entryPrice, 105, "logged at the breakout cycle's price, not the earlier forming price");

  await bot.runOnce(); // still breakout, same pattern — no re-alert
  assert.equal(patternSent.length, 1);
});

test("a fresh divergence alerts and is tracker-logged, but does not re-alert while unchanged", async () => {
  const { bot, patternSent, logged } = makePatternBot({
    patternsByCycle: [
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: null, chart: null }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish" }, chart: makeChart(50) }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish" }, chart: makeChart(51) }],
    ],
  });

  await bot.runOnce(); // baseline: no divergence
  const second = await bot.runOnce(); // null -> Regular Bullish
  assert.equal(second.patternEvents.length, 1);
  assert.equal(second.patternEvents[0].kind, "divergence");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, "divergence");
  assert.equal(logged[0].entryPrice, 50);

  await bot.runOnce(); // same divergence persists — no re-alert, no re-log
  assert.equal(patternSent.length, 1);
  assert.equal(logged.length, 1);
});

test("bot without configured telegram reports itself disabled", () => {
  const bot = new SignalBotService({
    signalScreenerService: {},
    telegramService: { configured: false },
    stateCache: new MemoryCache(),
  });
  assert.equal(bot.enabled, false);
});
