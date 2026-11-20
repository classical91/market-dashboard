"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TradeAggregator, describeFlow, emptyFlow, addToFlow } = require("../src/services/kucoin-live-trades/aggregator");
const { INSTRUMENTS } = require("./helpers/kucoin-mock-websocket");

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
let seq = 0;
function trade({ side = "buy", notional = 1000, base = 0.01, at = T0, id, price = 100000 } = {}) {
  seq += 1;
  return {
    exchange: "kucoin",
    marketType: "spot",
    symbol: "BTC-USDT",
    asset: "BTC",
    tradeId: id || `t${seq}`,
    price,
    quantity: base,
    baseQuantity: base,
    notional,
    side,
    sideVerified: true,
    exchangeTimeMs: at,
    exchangeTimeNs: `${at}000000`,
    receivedAt: at,
  };
}

function make(now, opts = {}) {
  return new TradeAggregator({ feedKey: "spot:BTC", instrument: INSTRUMENTS.spot.BTC, now: () => now.value, ...opts });
}

test("buy pressure, ratio and delta come from aggressive notional only", () => {
  const flow = emptyFlow();
  addToFlow(flow, trade({ side: "buy", notional: 3000, base: 0.03 }));
  addToFlow(flow, trade({ side: "sell", notional: 1000, base: 0.01 }));
  addToFlow(flow, { ...trade({ side: "buy", notional: null }), notional: null });
  addToFlow(flow, { ...trade({ side: "sell", notional: 5000 }), sideVerified: false });
  const d = describeFlow(flow);
  assert.equal(d.buyNotional, 3000);
  assert.equal(d.sellNotional, 1000);
  assert.equal(d.totalNotional, 4000);
  assert.equal(d.deltaNotional, 2000);
  assert.equal(d.buyPressurePct, 75);
  assert.equal(d.buySellRatio, 3);
  assert.ok(Math.abs(d.deltaBase - 0.02) < 1e-12);
  assert.equal(d.unpricedCount, 2, "unpriced or unverified trades are shown but not classified");
  assert.equal(d.largest.notional, 3000);

  const onlyBuys = describeFlow({ ...emptyFlow(), buyNotional: 10, buyCount: 1 });
  assert.equal(onlyBuys.buySellRatio, null, "no sell volume means no ratio, not infinity");
  assert.equal(describeFlow(emptyFlow()).buyPressurePct, null);
});

test("duplicate trade ids are dropped and the id memory is bounded", () => {
  const now = { value: T0 };
  const agg = make(now, { dedupSize: 3 });
  assert.equal(agg.add(trade({ id: "a" })), true);
  assert.equal(agg.add(trade({ id: "a" })), false);
  assert.equal(agg.counts.duplicates, 1);
  agg.add(trade({ id: "b" }));
  agg.add(trade({ id: "c" }));
  agg.add(trade({ id: "d" }));
  assert.equal(agg.seen.size, 3);
  assert.equal(agg.seen.has("a"), false, "oldest id evicted");
  assert.equal(agg.trades.length, 4);
});

test("rolling windows only count trades inside the window and say when they are partial", () => {
  const now = { value: T0 };
  const agg = make(now);
  agg.markSubscribed(T0);
  agg.add(trade({ side: "buy", notional: 1000, at: T0 + 1000 }));
  agg.add(trade({ side: "sell", notional: 400, at: T0 + 2000 }));
  now.value = T0 + 90 * 1000;
  agg.add(trade({ side: "buy", notional: 200, at: now.value - 500 }));

  let s = agg.stats();
  assert.equal(s.windows["1m"].buyNotional, 200, "the 1m window excludes trades older than 60s");
  assert.equal(s.windows["1m"].sellNotional, 0);
  assert.equal(s.windows["1m"].complete, true);
  assert.equal(s.windows["5m"].buyNotional, 1200);
  assert.equal(s.windows["5m"].sellNotional, 400);
  assert.equal(s.windows["5m"].deltaNotional, 800);
  assert.equal(s.windows["5m"].buyPressurePct, 75);
  assert.equal(s.windows["5m"].complete, false, "90s of history is not a 5m measurement");
  assert.equal(s.windows["5m"].coveredMs, 90000);
  assert.equal(s.windows["5m"].tradeCount, 3);
  assert.equal(s.windows["5m"].tradesPerMinute, 2, "rate uses the covered time, not the nominal window");

  now.value = T0 + 6 * 60 * 1000;
  s = agg.stats();
  assert.equal(s.windows["5m"].complete, true);
  assert.equal(s.windows["5m"].buyNotional, 200);
  assert.equal(s.windows["15m"].complete, false);
});

test("a reconnect gap restarts coverage so windows are never reported complete across it", () => {
  const now = { value: T0 };
  const agg = make(now);
  agg.markSubscribed(T0);
  now.value = T0 + 10 * 60 * 1000;
  assert.equal(agg.stats().windows["5m"].complete, true);
  agg.markDisconnected(now.value);
  let s = agg.stats();
  assert.equal(s.coverage.since, null);
  assert.equal(s.coverage.gaps, 1);
  assert.equal(s.windows["5m"].complete, false);
  assert.equal(s.windows["5m"].coveredMs, 0);
  now.value += 5000;
  agg.markSubscribed(now.value);
  now.value += 60 * 1000;
  s = agg.stats();
  assert.equal(s.windows["1m"].complete, true);
  assert.equal(s.windows["5m"].complete, false);
  assert.equal(s.coverage.historyMs, 60 * 1000);
});

test("CVD sums signed notional and base volume for the session and resets cleanly", () => {
  const now = { value: T0 };
  const agg = make(now);
  agg.add(trade({ side: "buy", notional: 5000, base: 0.05, at: T0 + 1000 }));
  agg.add(trade({ side: "sell", notional: 2000, base: 0.02, at: T0 + 61000 }));
  agg.add(trade({ side: "sell", notional: 4000, base: 0.04, at: T0 + 62000 }));
  assert.equal(agg.cvd.quote, -1000);
  assert.ok(Math.abs(agg.cvd.base + 0.01) < 1e-12);
  const minutes = agg.minuteSeries();
  assert.deepEqual(minutes.map((m) => m.cvdQuote), [5000, -1000], "end-of-minute cumulative values");
  assert.deepEqual(minutes.map((m) => m.tradeCount), [1, 2]);
  const first = agg.session.id;
  now.value += 1;
  agg.reset("instrument changed");
  assert.equal(agg.cvd.quote, 0);
  assert.equal(agg.trades.length, 0);
  assert.notEqual(agg.session.id, first);
  assert.equal(agg.session.reason, "instrument changed");
});

test("large trades are recorded per threshold and the largest 5m trade is found", () => {
  const now = { value: T0 + 1000 };
  const agg = make(now);
  agg.add(trade({ notional: 9999, at: T0 }));
  agg.add(trade({ notional: 10000, at: T0 }));
  agg.add(trade({ notional: 60000, side: "sell", at: T0 }));
  agg.add(trade({ notional: 600000, at: T0 }));
  agg.add({ ...trade({ notional: null, at: T0 }), notional: null });
  assert.deepEqual(agg.largeTrades.map((t) => t.notional), [600000, 60000, 10000]);
  const m = agg.minuteSeries()[0];
  assert.deepEqual(m.large, { 10000: 3, 50000: 2, 100000: 1, 500000: 1 });
  assert.equal(agg.stats().windows["5m"].largest.notional, 600000);
});

test("buffers stay bounded under heavy flow", () => {
  const now = { value: T0 };
  const agg = make(now, { maxTrades: 100, maxLargeTrades: 5, minuteHistory: 3 });
  for (let i = 0; i < 2000; i++) {
    now.value = T0 + i * 1000;
    agg.add(trade({ notional: 20000, at: now.value }));
  }
  assert.ok(agg.trades.length <= 125);
  assert.equal(agg.largeTrades.length, 5);
  assert.ok(agg.minutes.size <= 3);
  assert.ok(agg.seconds.size <= 16 * 60 + 2, `seconds buckets bounded (${agg.seconds.size})`);
  const snap = agg.snapshot({ tradeLimit: 10 });
  assert.equal(snap.trades.length, 10);
  assert.ok(snap.trades[0].exchangeTimeMs > snap.trades[9].exchangeTimeMs, "snapshot is newest first");
});

test("the trade rate is measured over the last 10 seconds of covered time", () => {
  const now = { value: T0 + 20000 };
  const agg = make(now);
  agg.markSubscribed(T0);
  for (let i = 0; i < 30; i++) agg.add(trade({ at: T0 + 10000 + i * 300 }));
  const rate = agg.tradeRate();
  assert.equal(rate.spanMs, 10000);
  assert.ok(rate.perSecond > 2.5 && rate.perSecond <= 3, String(rate.perSecond));
});
