"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SignalBotService } = require("../src/services/signal-bot");
const { MemoryCache } = require("../src/services/cache");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { TelegramService } = require("../src/services/telegram");

function recordingTelegram(onSend = () => {}) {
  return {
    configured: true,
    alertDeliveries: (messages) => messages,
    signalAlertMessages: (events) => [{ kind: "signal", events }],
    patternAlertMessages: (events) => [{ kind: "pattern", events }],
    async sendAlertDelivery({ kind, events }) {
      onSend(kind, events);
      return true;
    },
  };
}

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
  const telegram = recordingTelegram((kind, events) => {
    if (kind === "signal") sent.push(events);
  });
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
      [{
        symbol: "BTCUSDT",
        signal: "LONG",
        score: 83,
        trendRegime: "TREND_UP",
        indicators: { rsi: 56.2, macdBullish: true, aboveVwap: true, bullishChecks: 5 },
      }],
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
  assert.equal(second.screenerTransitions[0].trendRegime, "TREND_UP");
  assert.equal(second.screenerTransitions[0].indicators.rsi, 56.2);
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
      return patternsByCycle[Math.min(cycle, patternsByCycle.length - 1)].map((row) => ({
        candleCloseTime: Date.now() - 60_000 + cycle * 1000,
        ...row,
      }));
    },
  };
  const telegram = recordingTelegram((kind, events) => {
    if (kind === "pattern") patternSent.push(events);
  });
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
      [{ symbol: "BTCUSDT", interval: "4h", pattern: { pattern: "Falling Wedge", bias: "bullish", status: "breakout", breakoutCrossed: true, score: 62 }, divergence: null, chart: makeChart(105) }],
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
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish", pivotTimes: [1, 2] }, chart: makeChart(50) }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish", pivotTimes: [1, 2] }, chart: makeChart(51) }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish", pivotTimes: [2, 3] }, chart: makeChart(52) }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: null, chart: null }],
      [{ symbol: "ETHUSDT", interval: "4h", pattern: null, divergence: { type: "Regular Bullish", bias: "bullish", pivotTimes: [2, 3] }, chart: makeChart(52) }],
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
  await bot.runOnce();
  assert.equal(patternSent.length, 2, "same divergence label with a new pivot must alert");
  assert.equal(logged.length, 2);
  await bot.runOnce();
  await bot.runOnce();
  assert.equal(patternSent.length, 2, "rediscovering the same pivots must stay quiet");
});

test("queued alerts resume after a restart and retry only the destination that failed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "signal-bot-state.json");
  const telegram = new TelegramService({ botToken: "test-token", chatIds: ["-1001:4", "-1002"] });
  const fetchOrig = global.fetch;
  t.after(() => { global.fetch = fetchOrig; });
  let rateLimited = true;
  const attempts = [];
  global.fetch = async (_url, options) => {
    const { chat_id: chatId, message_thread_id: threadId, text } = JSON.parse(options.body);
    const pattern = text.includes("PATTERN SCANNER");
    attempts.push({ chatId, threadId, pattern });
    if (chatId === "-1002" && rateLimited) {
      return { ok: false, status: 429, text: async () => '{"ok":false,"parameters":{"retry_after":60}}' };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const initialTime = Date.now();
  t.mock.method(Date, "now", () => initialTime + clockAdvance);
  let clockAdvance = 0;
  let breakout = false;
  const makeService = () => new SignalBotService({
    signalScreenerService: { async scanAll() {
      return [{ symbol: "BTCUSDT", signal: breakout ? "LONG" : "FLAT" }];
    } },
    patternScannerService: { async scanAll() {
      return [{
        symbol: "BTCUSDT", interval: "4h", candleCloseTime: initialTime - (breakout ? 1000 : 2000),
        pattern: breakout ? { pattern: "Rising Wedge", bias: "bullish", breakoutCrossed: true } : null,
        chart: makeChart(100),
      }];
    } },
    stateCache: new PersistentReporterCache(file, { strictWrites: true }),
    telegramService: telegram,
    timeframes: ["4h"],
  });

  const bot = makeService();
  await bot.runOnce();
  breakout = true;
  await bot.runOnce();
  assert.deepEqual(attempts, [
    { chatId: "-1001", threadId: 4, pattern: true },
    { chatId: "-1002", threadId: undefined, pattern: true },
    { chatId: "-1001", threadId: 4, pattern: false },
  ]);

  const restarted = makeService();
  rateLimited = false;
  await restarted.runOnce();
  assert.equal(attempts.length, 3, "Telegram retry_after must survive the restart");
  clockAdvance = 60_000;
  await restarted.runOnce();
  await restarted.runOnce();
  assert.deepEqual(attempts.slice(3), [
    { chatId: "-1002", threadId: undefined, pattern: true },
    { chatId: "-1002", threadId: undefined, pattern: false },
  ]);
});

test("stale and repeated pattern candles cannot create a fresh alert", async () => {
  const now = Date.now();
  const base = { symbol: "BTCUSDT", interval: "1h", chart: makeChart(100) };
  const breakout = { pattern: "Rising Wedge", bias: "bullish", breakoutCrossed: true };
  const { bot, patternSent, logged } = makePatternBot({ patternsByCycle: [
    [{ ...base, candleCloseTime: now - 120_000 }],
    [{ ...base, candleCloseTime: now - 3_600_000 * 3, pattern: breakout }],
    [{ ...base, candleCloseTime: now - 120_000, pattern: breakout }],
    [{ ...base, candleCloseTime: now - 60_000, pattern: breakout }],
  ] });
  await bot.runOnce();
  await bot.runOnce();
  await bot.runOnce();
  assert.equal(patternSent.length, 0);
  await bot.runOnce();
  assert.equal(patternSent.length, 1);
  assert.equal(logged[0].bias, "bullish");
});

test("bot without configured telegram or an active bridge reports itself disabled", () => {
  const bot = new SignalBotService({
    signalScreenerService: {},
    telegramService: { configured: false },
    stateCache: new MemoryCache(),
  });
  assert.equal(bot.enabled, false);
});

test("paper trading keeps the loop alive even with telegram switched off", () => {
  const bot = new SignalBotService({
    signalScreenerService: {},
    telegramService: { configured: false },
    tradeBridge: { active: true, requiresSchedule: true, async markOpenPositions() {}, async handleTransitions() { return []; } },
    stateCache: new MemoryCache(),
  });
  assert.equal(bot.enabled, true);
});

// ── Trading Lab bridge ──────────────────────────────────────────────────────

// One timeframe, one scanAll call per cycle — simpler than makeBot's
// two-timeframe bookkeeping, which the bridge does not need.
function makeBridgeBot({ bridge, signalsByCycle }) {
  let cycle = -1;
  return new SignalBotService({
    signalScreenerService: {
      async scanAll(interval) {
        cycle += 1;
        return signalsByCycle[Math.min(cycle, signalsByCycle.length - 1)].map((entry) => ({ ...entry, interval }));
      },
    },
    telegramService: recordingTelegram(),
    tradeBridge: bridge,
    stateCache: new MemoryCache(),
    timeframes: ["4h"],
  });
}

function recordingBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    active: true,
    requiresSchedule: true,
    async markOpenPositions() { calls.push(["mark"]); return []; },
    async handleTransitions(transitions) {
      calls.push(["handle", transitions]);
      return transitions.map((t) => ({ symbol: t.symbol, status: "dry-run" }));
    },
    ...overrides,
  };
}

test("transitions reach the bridge with their price, after open positions are marked", async () => {
  const bridge = recordingBridge();
  const bot = makeBridgeBot({
    bridge,
    signalsByCycle: [
      [{ symbol: "BTCUSDT", signal: "FLAT", score: 50, price: 60000 }],
      [{ symbol: "BTCUSDT", signal: "LONG", score: 83, price: 61250 }],
    ],
  });

  await bot.runOnce(); // baseline
  const second = await bot.runOnce();

  // Marking runs first on both cycles so entries are judged against a current
  // ledger, and the transition carries the confirming price.
  assert.deepEqual(bridge.calls.map((c) => c[0]), ["mark", "handle", "mark", "handle"]);
  const [, forwarded] = bridge.calls[3];
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].symbol, "BTCUSDT");
  assert.equal(forwarded[0].from, "FLAT");
  assert.equal(forwarded[0].to, "LONG");
  assert.equal(forwarded[0].price, 61250);
  assert.equal(second.tradeActions.length, 1);
  assert.equal(second.tradeActions[0].status, "dry-run");
});

test("a bridge failure costs the paper trade, not the alert", async () => {
  const bridge = recordingBridge({
    async handleTransitions() { throw new Error("ledger write failed"); },
  });
  const bot = makeBridgeBot({
    bridge,
    signalsByCycle: [
      [{ symbol: "ETHUSDT", signal: "FLAT", score: 50, price: 3000 }],
      [{ symbol: "ETHUSDT", signal: "SHORT", score: 80, price: 2900 }],
    ],
  });

  await bot.runOnce();
  const second = await bot.runOnce();

  assert.equal(second.screenerTransitions.length, 1, "the scan still reports its transition");
  assert.deepEqual(second.tradeActions, []);
});

test("no bridge configured leaves the scan exactly as it was", async () => {
  const bot = makeBridgeBot({
    bridge: undefined,
    signalsByCycle: [
      [{ symbol: "BTCUSDT", signal: "FLAT", score: 50, price: 60000 }],
      [{ symbol: "BTCUSDT", signal: "LONG", score: 83, price: 61250 }],
    ],
  });

  await bot.runOnce();
  const second = await bot.runOnce();
  assert.equal(second.screenerTransitions.length, 1);
  assert.deepEqual(second.tradeActions, []);
});
