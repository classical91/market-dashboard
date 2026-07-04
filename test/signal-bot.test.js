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
  assert.equal(first.length, 0, "baseline scan must not alert");
  assert.equal(sent.length, 0);

  const second = await bot.runOnce();
  assert.equal(second.length, 2, "FLAT->LONG should alert on both timeframes");
  assert.equal(second[0].from, "FLAT");
  assert.equal(second[0].to, "LONG");
  assert.equal(second[0].score, 83);
  assert.equal(sent.length, 1, "transitions are batched into one send");

  const third = await bot.runOnce();
  assert.equal(third.length, 0, "unchanged signal must not re-alert");
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
  assert.equal(third.length, 0, "recovering with the same signal must not alert");
  assert.equal(sent.length, 0);
});

test("bot without configured telegram reports itself disabled", () => {
  const bot = new SignalBotService({
    signalScreenerService: {},
    telegramService: { configured: false },
    stateCache: new MemoryCache(),
  });
  assert.equal(bot.enabled, false);
});
