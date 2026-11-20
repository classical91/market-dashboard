"use strict";

// Rolling order-flow analytics for one KuCoin feed (one market type + one
// instrument), computed only from normalized executions this server received.
//
// Memory is bounded regardless of trade volume:
// - recent trades:  a capped buffer (default 2000)
// - dedup ids:      a capped insertion-ordered Map (default 20000)
// - per-second buckets for the rolling 1m / 5m / 15m windows (≤ ~16 min kept)
// - per-minute buckets for the charts (default 120 minutes kept)
// - large trades:   a capped list (default 300)
//
// Coverage is explicit. A rolling window is "complete" only when this server
// has held a continuous subscription for the whole window; after a reconnect
// the trades missed during the gap are gone, so the window restarts.

const WINDOWS = Object.freeze({ "1m": 60 * 1000, "5m": 5 * 60 * 1000, "15m": 15 * 60 * 1000 });
const LARGE_TRADE_THRESHOLDS = Object.freeze([10000, 50000, 100000, 500000]);
const SECOND = 1000;
const MINUTE = 60 * 1000;

function emptyFlow() {
  return {
    buyNotional: 0,
    sellNotional: 0,
    buyBase: 0,
    sellBase: 0,
    buyCount: 0,
    sellCount: 0,
    // Trades whose notional could not be computed; shown, never counted in flow.
    unpricedCount: 0,
    largest: null,
  };
}

function addToFlow(flow, trade) {
  if (trade.notional == null || !trade.sideVerified) {
    flow.unpricedCount += 1;
    return;
  }
  if (trade.side === "buy") {
    flow.buyNotional += trade.notional;
    flow.buyBase += trade.baseQuantity || 0;
    flow.buyCount += 1;
  } else {
    flow.sellNotional += trade.notional;
    flow.sellBase += trade.baseQuantity || 0;
    flow.sellCount += 1;
  }
  if (!flow.largest || trade.notional > flow.largest.notional) flow.largest = trade;
}

function mergeFlow(into, flow) {
  into.buyNotional += flow.buyNotional;
  into.sellNotional += flow.sellNotional;
  into.buyBase += flow.buyBase;
  into.sellBase += flow.sellBase;
  into.buyCount += flow.buyCount;
  into.sellCount += flow.sellCount;
  into.unpricedCount += flow.unpricedCount;
  if (flow.largest && (!into.largest || flow.largest.notional > into.largest.notional)) into.largest = flow.largest;
}

/** Derived figures for a flow total; pure, exported for tests. */
function describeFlow(flow) {
  const total = flow.buyNotional + flow.sellNotional;
  return {
    buyNotional: flow.buyNotional,
    sellNotional: flow.sellNotional,
    totalNotional: total,
    // Volume delta: aggressive buy notional − aggressive sell notional.
    deltaNotional: flow.buyNotional - flow.sellNotional,
    buyBase: flow.buyBase,
    sellBase: flow.sellBase,
    deltaBase: flow.buyBase - flow.sellBase,
    buyCount: flow.buyCount,
    sellCount: flow.sellCount,
    tradeCount: flow.buyCount + flow.sellCount,
    unpricedCount: flow.unpricedCount,
    // Buy pressure: aggressive buy notional / classified notional × 100.
    buyPressurePct: total > 0 ? (flow.buyNotional / total) * 100 : null,
    // Buy/sell ratio is undefined (null) when there is no sell volume.
    buySellRatio: flow.sellNotional > 0 ? flow.buyNotional / flow.sellNotional : null,
    largest: flow.largest,
  };
}

class TradeAggregator {
  constructor({
    feedKey,
    instrument,
    now = Date.now,
    maxTrades = 2000,
    dedupSize = 20000,
    maxLargeTrades = 300,
    largeTradeMin = LARGE_TRADE_THRESHOLDS[0],
    minuteHistory = 120,
  } = {}) {
    this.feedKey = feedKey || null;
    this.instrument = instrument || null;
    this.now = now;
    this.maxTrades = maxTrades;
    this.dedupSize = dedupSize;
    this.maxLargeTrades = maxLargeTrades;
    this.largeTradeMin = largeTradeMin;
    this.minuteHistory = minuteHistory;
    this.reset("feed opened");
  }

  reset(reason = "reset") {
    const at = this.now();
    this.session = { id: `${this.feedKey || "feed"}:${at}`, startedAt: at, reason };
    this.trades = [];
    this.seen = new Map();
    this.seconds = new Map();
    this.minutes = new Map();
    this.largeTrades = [];
    // CVD for this session, in both denominations; the UI labels which.
    this.cvd = { quote: 0, base: 0, quoteCurrency: "USDT", baseCurrency: this.instrument ? this.instrument.asset : null };
    this.coverage = { since: null, gaps: 0, lastGapAt: null, connected: false };
    this.counts = { accepted: 0, duplicates: 0 };
    this.latest = null;
    this.lastPruneAt = null;
  }

  /** The upstream subscription is (again) confirmed: coverage starts now. */
  markSubscribed(at = this.now()) {
    if (this.coverage.since == null) this.coverage.since = at;
    this.coverage.connected = true;
  }

  /** The upstream connection dropped: trades may be missed until resubscribed. */
  markDisconnected(at = this.now()) {
    if (this.coverage.connected || this.coverage.since != null) {
      this.coverage.gaps += 1;
      this.coverage.lastGapAt = at;
    }
    this.coverage.since = null;
    this.coverage.connected = false;
  }

  remember(tradeId) {
    if (this.seen.has(tradeId)) return false;
    this.seen.set(tradeId, true);
    if (this.seen.size > this.dedupSize) {
      // Map iteration is insertion order: drop the oldest ids.
      const excess = this.seen.size - this.dedupSize;
      let removed = 0;
      for (const key of this.seen.keys()) {
        this.seen.delete(key);
        if (++removed >= excess) break;
      }
    }
    return true;
  }

  /** Adds a normalized trade. Returns false for a duplicate trade id. */
  add(trade) {
    if (!trade || !trade.tradeId) return false;
    if (!this.remember(trade.tradeId)) {
      this.counts.duplicates += 1;
      return false;
    }
    this.counts.accepted += 1;

    this.trades.push(trade);
    if (this.trades.length > this.maxTrades * 1.25) this.trades.splice(0, this.trades.length - this.maxTrades);
    if (!this.latest || trade.exchangeTimeMs >= this.latest.exchangeTimeMs) this.latest = trade;

    const secondKey = Math.floor(trade.exchangeTimeMs / SECOND);
    let second = this.seconds.get(secondKey);
    if (!second) {
      second = emptyFlow();
      this.seconds.set(secondKey, second);
    }
    addToFlow(second, trade);

    const minuteKey = Math.floor(trade.exchangeTimeMs / MINUTE) * MINUTE;
    let minute = this.minutes.get(minuteKey);
    if (!minute) {
      minute = { ...emptyFlow(), t: minuteKey, large: LARGE_TRADE_THRESHOLDS.map(() => 0), open: trade.price, high: trade.price, low: trade.price, close: trade.price, cvdQuote: 0, cvdBase: 0 };
      this.minutes.set(minuteKey, minute);
    }
    addToFlow(minute, trade);
    minute.high = Math.max(minute.high, trade.price);
    minute.low = Math.min(minute.low, trade.price);
    minute.close = trade.price;

    if (trade.notional != null && trade.sideVerified) {
      const sign = trade.side === "buy" ? 1 : -1;
      this.cvd.quote += sign * trade.notional;
      this.cvd.base += sign * (trade.baseQuantity || 0);
      LARGE_TRADE_THRESHOLDS.forEach((threshold, index) => {
        if (trade.notional >= threshold) minute.large[index] += 1;
      });
      if (trade.notional >= this.largeTradeMin) {
        this.largeTrades.unshift(trade);
        if (this.largeTrades.length > this.maxLargeTrades) this.largeTrades.length = this.maxLargeTrades;
      }
    }
    minute.cvdQuote = this.cvd.quote;
    minute.cvdBase = this.cvd.base;

    this.prune();
    return true;
  }

  prune(now = this.now(), { force = false } = {}) {
    // At most once per second: under heavy flow add() runs many times a second.
    if (!force && this.lastPruneAt != null && now - this.lastPruneAt < SECOND) return;
    this.lastPruneAt = now;
    const oldestSecond = Math.floor((now - WINDOWS["15m"] - MINUTE) / SECOND);
    for (const key of this.seconds.keys()) if (key < oldestSecond) this.seconds.delete(key);
    if (this.minutes.size > this.minuteHistory) {
      const keys = [...this.minutes.keys()].sort((a, b) => a - b);
      for (const key of keys.slice(0, keys.length - this.minuteHistory)) this.minutes.delete(key);
    }
  }

  windowStats(windowMs, now = this.now()) {
    const fromSecond = Math.floor((now - windowMs) / SECOND);
    const total = emptyFlow();
    for (const [key, flow] of this.seconds) if (key >= fromSecond) mergeFlow(total, flow);
    const since = this.coverage.since;
    const coveredMs = since == null ? 0 : Math.max(0, Math.min(windowMs, now - since));
    return {
      windowMs,
      ...describeFlow(total),
      tradesPerMinute: coveredMs > 0 ? (total.buyCount + total.sellCount + total.unpricedCount) / (coveredMs / MINUTE) : null,
      coveredMs,
      complete: since != null && now - since >= windowMs,
    };
  }

  tradeRate(now = this.now(), spanMs = 10 * SECOND) {
    const fromSecond = Math.floor((now - spanMs) / SECOND);
    let count = 0;
    for (const [key, flow] of this.seconds) {
      if (key >= fromSecond) count += flow.buyCount + flow.sellCount + flow.unpricedCount;
    }
    const since = this.coverage.since;
    const span = since == null ? spanMs : Math.max(SECOND, Math.min(spanMs, now - since));
    return { perSecond: count / (span / SECOND), spanMs: span };
  }

  stats(now = this.now()) {
    const windows = {};
    for (const [name, ms] of Object.entries(WINDOWS)) windows[name] = this.windowStats(ms, now);
    return {
      feed: this.feedKey,
      at: now,
      session: this.session,
      coverage: { ...this.coverage, historyMs: this.coverage.since == null ? 0 : now - this.coverage.since },
      latest: this.latest,
      tradeRate: this.tradeRate(now),
      windows,
      cvd: { ...this.cvd },
      counts: { ...this.counts },
    };
  }

  minuteSeries() {
    return [...this.minutes.values()]
      .sort((a, b) => a.t - b.t)
      .map((m) => ({
        t: m.t,
        buyNotional: m.buyNotional,
        sellNotional: m.sellNotional,
        buyBase: m.buyBase,
        sellBase: m.sellBase,
        tradeCount: m.buyCount + m.sellCount + m.unpricedCount,
        large: LARGE_TRADE_THRESHOLDS.reduce((acc, threshold, index) => ({ ...acc, [threshold]: m.large[index] }), {}),
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.close,
        cvdQuote: m.cvdQuote,
        cvdBase: m.cvdBase,
      }));
  }

  snapshot({ tradeLimit = 500, now = this.now() } = {}) {
    const recent = this.trades.slice(-Math.max(0, tradeLimit)).reverse();
    return {
      ...this.stats(now),
      trades: recent,
      largeTrades: this.largeTrades.slice(),
      minutes: this.minuteSeries(),
      thresholds: LARGE_TRADE_THRESHOLDS,
    };
  }
}

module.exports = {
  TradeAggregator,
  WINDOWS,
  LARGE_TRADE_THRESHOLDS,
  describeFlow,
  emptyFlow,
  addToFlow,
};
