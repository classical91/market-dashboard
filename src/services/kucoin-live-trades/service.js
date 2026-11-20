"use strict";

// KuCoin Live Trades: shared upstream feeds + Server-Sent Events fan-out.
//
// - One KuCoin WebSocket per market type, opened on demand when the first
//   browser starts watching a feed and closed after the last one leaves
//   (after a short linger, so a page reload does not churn subscriptions).
// - Every browser tab is an SSE client of this server; N tabs watching
//   BTC-USDT share one upstream subscription and one aggregator.
// - Timers (trade batching, stats, watchdog, heartbeats) run only after
//   start(), which server.js calls. createApp() and tests construct the
//   service without leaving anything running.
//
// Read-only by construction: only public market data channels are used; no
// API key, token, account or order endpoint is reachable from this module.

const { KucoinPublicSocket, DEFAULT_URLS } = require("./stream");
const { normalizeTrade, MARKET_TYPES } = require("./normalizer");
const { TradeAggregator } = require("./aggregator");
const { SUPPORTED_ASSETS } = require("./instruments");

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

class KucoinLiveTradesService {
  constructor({
    enabled = true,
    instruments,
    WebSocketImpl,
    urls = DEFAULT_URLS,
    socketOptions = {},
    aggregatorOptions = {},
    now = Date.now,
    logger = console,
    flushIntervalMs = 250,
    statsIntervalMs = 1000,
    heartbeatMs = 15 * 1000,
    staleAfterMs = 30 * 1000,
    resubscribeAfterMs = 5 * 60 * 1000,
    lingerMs = 30 * 1000,
    maxClients = 200,
    maxBufferedBytes = 2 * 1024 * 1024,
    maxPendingTrades = 5000,
    snapshotTradeLimit = 500,
  } = {}) {
    if (!instruments) throw new Error("KucoinLiveTradesService needs an instrument registry");
    this.enabled = enabled;
    this.instruments = instruments;
    this.WebSocketImpl = WebSocketImpl;
    this.urls = { ...DEFAULT_URLS, ...urls };
    this.socketOptions = socketOptions;
    this.aggregatorOptions = aggregatorOptions;
    this.now = now;
    this.logger = logger;
    this.options = {
      flushIntervalMs, statsIntervalMs, heartbeatMs, staleAfterMs, resubscribeAfterMs,
      lingerMs, maxClients, maxBufferedBytes, maxPendingTrades, snapshotTradeLimit,
    };
    this.running = false;
    this.startedAt = null;
    this.sockets = {};
    this.feeds = new Map(); // "spot:BTC" -> feed
    this.feedsBySymbol = { spot: new Map(), futures: new Map() };
    this.creating = new Map();
    this.clients = new Set();
    this.timers = { flush: null, stats: null };
    this.lastHeartbeatAt = 0;
    this.clientSeq = 0;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (!this.enabled) {
      this.logger.log && this.logger.log("[KuCoinLiveTrades] Disabled via KUCOIN_LIVE_TRADES_ENABLED=false");
      return false;
    }
    if (this.running) return true;
    this.running = true;
    this.startedAt = this.now();
    this.timers.flush = setInterval(() => this.flush(), this.options.flushIntervalMs);
    this.timers.stats = setInterval(() => this.tick(), this.options.statsIntervalMs);
    if (this.timers.flush.unref) this.timers.flush.unref();
    if (this.timers.stats.unref) this.timers.stats.unref();
    this.logger.log && this.logger.log("[KuCoinLiveTrades] Ready: upstream sockets open when a browser starts watching a feed");
    return true;
  }

  stop() {
    this.running = false;
    clearInterval(this.timers.flush);
    clearInterval(this.timers.stats);
    this.timers.flush = this.timers.stats = null;
    for (const client of [...this.clients]) {
      this.writeRaw(client, "event: shutdown\ndata: {\"reason\":\"server stopping\"}\n\n");
      this.dropClient(client);
    }
    for (const feed of this.feeds.values()) clearTimeout(feed.lingerTimer);
    for (const socket of Object.values(this.sockets)) {
      socket.stop();
      socket.removeAllListeners();
    }
    this.sockets = {};
    this.feeds.clear();
    this.feedsBySymbol = { spot: new Map(), futures: new Map() };
  }

  // ── Upstream sockets ─────────────────────────────────────────────────────

  socketFor(marketType) {
    if (this.sockets[marketType]) return this.sockets[marketType];
    const socket = new KucoinPublicSocket({
      marketType,
      url: this.urls[marketType],
      // undefined → the socket picks Node's built-in WebSocket or `ws`.
      ...(this.WebSocketImpl ? { WebSocketImpl: this.WebSocketImpl } : {}),
      now: this.now,
      logger: this.logger,
      ...this.socketOptions,
    });
    socket.on("trade", (event) => this.handleTrade(marketType, event));
    socket.on("subscribed", ({ symbol, at }) => {
      const feed = this.feedsBySymbol[marketType].get(symbol);
      if (!feed) return;
      feed.aggregator.markSubscribed(at);
      feed.subscribedAt = at;
      this.broadcastStatus(feed);
    });
    socket.on("disconnected", ({ at }) => {
      for (const feed of this.feedsBySymbol[marketType].values()) {
        feed.aggregator.markDisconnected(at);
        feed.subscribedAt = null;
      }
    });
    socket.on("state", () => {
      for (const feed of this.feedsBySymbol[marketType].values()) this.broadcastStatus(feed);
    });
    this.sockets[marketType] = socket;
    return socket;
  }

  handleTrade(marketType, { symbol, data, pushTimeNs, receivedAt }) {
    const feed = this.feedsBySymbol[marketType].get(symbol);
    if (!feed) return;
    const result = normalizeTrade(data, { marketType, instrument: feed.instrument, pushTimeNs, receivedAt });
    if (!result.ok) {
      feed.rejected += 1;
      feed.lastRejectReason = result.reason;
      return;
    }
    if (!feed.aggregator.add(result.trade)) return; // duplicate trade id
    feed.lastTradeAt = receivedAt;
    feed.pending.push(result.trade);
    if (feed.pending.length > this.options.maxPendingTrades) {
      feed.droppedFromBatch += feed.pending.length - this.options.maxPendingTrades;
      feed.pending.splice(0, feed.pending.length - this.options.maxPendingTrades);
    }
  }

  // ── Feeds ────────────────────────────────────────────────────────────────

  static feedKey(marketType, asset) {
    return `${marketType}:${asset}`;
  }

  validateFeed(marketType, asset) {
    const market = String(marketType || "").toLowerCase();
    const base = String(asset || "").toUpperCase();
    if (!MARKET_TYPES.includes(market)) throw httpError(400, "market must be spot or futures");
    if (!SUPPORTED_ASSETS.includes(base)) throw httpError(400, `asset must be one of ${SUPPORTED_ASSETS.join(", ")}`);
    return { marketType: market, asset: base };
  }

  async acquireFeed(marketType, asset) {
    const key = KucoinLiveTradesService.feedKey(marketType, asset);
    if (this.feeds.has(key)) return this.feeds.get(key);
    if (this.creating.has(key)) return this.creating.get(key);
    const promise = (async () => {
      const instrument = await this.instruments.get(marketType, asset);
      if (!this.running) throw httpError(503, "KuCoin live trades are not running");
      if (this.feeds.has(key)) return this.feeds.get(key);
      const feed = {
        key,
        marketType,
        asset,
        symbol: instrument.symbol,
        instrument,
        aggregator: new TradeAggregator({ feedKey: key, instrument, now: this.now, ...this.aggregatorOptions }),
        clients: new Set(),
        pending: [],
        lingerTimer: null,
        createdAt: this.now(),
        subscribedAt: null,
        lastTradeAt: null,
        lastResubscribeAt: null,
        rejected: 0,
        lastRejectReason: null,
        droppedFromBatch: 0,
        lastStatusJson: null,
      };
      this.feeds.set(key, feed);
      this.feedsBySymbol[marketType].set(instrument.symbol, feed);
      this.socketFor(marketType).subscribe(instrument.symbol);
      return feed;
    })();
    this.creating.set(key, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(key);
    }
  }

  closeFeed(feed) {
    clearTimeout(feed.lingerTimer);
    feed.lingerTimer = null;
    if (feed.clients.size > 0) return;
    this.feeds.delete(feed.key);
    this.feedsBySymbol[feed.marketType].delete(feed.symbol);
    const socket = this.sockets[feed.marketType];
    if (socket) socket.unsubscribe(feed.symbol);
  }

  feedStatus(feed, now = this.now()) {
    const socket = this.sockets[feed.marketType];
    const socketStatus = socket ? socket.status() : null;
    const sub = socketStatus ? socketStatus.subscriptions.find((s) => s.symbol === feed.symbol) : null;
    const lastActivity = feed.lastTradeAt || feed.subscribedAt;
    let state;
    let message;
    if (!socketStatus || socketStatus.state === "idle" || socketStatus.state === "stopped") {
      state = "disconnected";
      message = socketStatus && socketStatus.lastError ? socketStatus.lastError : "Not connected to KuCoin";
    } else if (socketStatus.state === "reconnecting") {
      state = "reconnecting";
      message = `Reconnecting to KuCoin${socketStatus.lastError ? ` after: ${socketStatus.lastError}` : ""}`;
    } else if (socketStatus.state === "connecting") {
      state = "connecting";
      message = "Connecting to KuCoin";
    } else if (!sub || sub.state === "waiting" || sub.state === "pending") {
      state = "connecting";
      message = "Waiting for KuCoin to confirm the subscription";
    } else if (sub.state === "error") {
      state = "error";
      message = `KuCoin rejected the subscription: ${sub.error}`;
    } else if (lastActivity && now - lastActivity > this.options.staleAfterMs) {
      state = "stale";
      message = feed.lastTradeAt
        ? `No trades received for ${Math.round((now - feed.lastTradeAt) / 1000)}s — the connection is up but the feed is quiet or stalled`
        : `Subscribed ${Math.round((now - feed.subscribedAt) / 1000)}s ago and no trade has arrived yet`;
    } else {
      state = "live";
      message = feed.lastTradeAt ? "Live" : "Subscribed — waiting for the first trade";
    }
    return {
      feed: feed.key,
      marketType: feed.marketType,
      asset: feed.asset,
      symbol: feed.symbol,
      state,
      message,
      lastTradeAt: feed.lastTradeAt,
      subscribedAt: feed.subscribedAt,
      staleAfterMs: this.options.staleAfterMs,
      socket: socketStatus ? {
        state: socketStatus.state,
        sessionId: socketStatus.sessionId,
        lastMessageAt: socketStatus.lastMessageAt,
        lastPongAt: socketStatus.lastPongAt,
        reconnects: socketStatus.reconnects,
        nextReconnectAt: socketStatus.nextReconnectAt,
        lastError: socketStatus.lastError,
      } : null,
      rejected: feed.rejected,
      lastRejectReason: feed.lastRejectReason,
      resubscribes: feed.resubscribes || 0,
      clients: feed.clients.size,
      serverTime: now,
    };
  }

  // ── SSE clients ──────────────────────────────────────────────────────────

  async openStream(req, res, { marketType, asset }) {
    if (!this.running) throw httpError(503, "KuCoin live trades are not running on this server");
    if (this.clients.size >= this.options.maxClients) throw httpError(503, "Too many live-trade viewers; try again shortly");
    const feed = await this.acquireFeed(marketType, asset);
    if (!this.running) throw httpError(503, "KuCoin live trades are not running on this server");

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (res.flushHeaders) res.flushHeaders();

    const client = { id: ++this.clientSeq, res, feed, connectedAt: this.now(), closed: false };
    this.clients.add(client);
    feed.clients.add(client);
    clearTimeout(feed.lingerTimer);
    feed.lingerTimer = null;

    this.writeRaw(client, "retry: 5000\n\n");
    this.send(client, "snapshot", this.buildSnapshot(feed));
    const cleanup = () => this.dropClient(client);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return client;
  }

  dropClient(client) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    const feed = client.feed;
    feed.clients.delete(client);
    try { client.res.end(); } catch {}
    if (feed.clients.size === 0 && this.feeds.get(feed.key) === feed && !feed.lingerTimer) {
      if (!this.running) return this.closeFeed(feed);
      feed.lingerTimer = setTimeout(() => this.closeFeed(feed), this.options.lingerMs);
      if (feed.lingerTimer.unref) feed.lingerTimer.unref();
    }
    return undefined;
  }

  writeRaw(client, text) {
    if (client.closed) return false;
    const res = client.res;
    if (res.writableLength > this.options.maxBufferedBytes) {
      // A tab that cannot keep up must not grow server memory without bound.
      this.dropClient(client);
      return false;
    }
    try {
      res.write(text);
      return true;
    } catch {
      this.dropClient(client);
      return false;
    }
  }

  send(client, event, data) {
    return this.writeRaw(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(feed, event, data) {
    if (feed.clients.size === 0) return;
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...feed.clients]) this.writeRaw(client, text);
  }

  broadcastStatus(feed) {
    const status = this.feedStatus(feed);
    const { serverTime, ...comparable } = status;
    const json = JSON.stringify(comparable);
    if (json === feed.lastStatusJson) return;
    feed.lastStatusJson = json;
    this.broadcast(feed, "status", status);
  }

  // ── Timers ───────────────────────────────────────────────────────────────

  /** Sends batched trades: one SSE event per feed per flush interval. */
  flush() {
    for (const feed of this.feeds.values()) {
      if (feed.pending.length === 0) continue;
      const trades = feed.pending;
      feed.pending = [];
      this.broadcast(feed, "trades", { feed: feed.key, trades });
    }
  }

  /** Stats push, stale-feed watchdog and SSE heartbeats. */
  tick() {
    const now = this.now();
    for (const feed of this.feeds.values()) {
      const status = this.feedStatus(feed, now);
      this.broadcastStatus(feed);
      if (feed.clients.size > 0) {
        this.broadcast(feed, "stats", { feed: feed.key, status, stats: feed.aggregator.stats(now), minutes: feed.aggregator.minuteSeries().slice(-2) });
      }
      // The connection can answer pings while one subscription has silently
      // stopped delivering. Re-subscribe just that symbol: a full reconnect
      // would break coverage for every feed on the socket, and quiet futures
      // pairs legitimately go minutes without a trade. Dead connections are
      // caught separately by the ping/pong timeout.
      const lastActivity = Math.max(feed.lastTradeAt || 0, feed.subscribedAt || 0, feed.lastResubscribeAt || 0);
      const socket = this.sockets[feed.marketType];
      if (status.state === "stale" && socket && lastActivity && now - lastActivity > this.options.resubscribeAfterMs) {
        feed.lastResubscribeAt = now;
        feed.resubscribes = (feed.resubscribes || 0) + 1;
        socket.resubscribe(feed.symbol);
      }
    }
    if (now - this.lastHeartbeatAt >= this.options.heartbeatMs) {
      this.lastHeartbeatAt = now;
      for (const client of [...this.clients]) this.writeRaw(client, `: heartbeat ${now}\n\n`);
    }
  }

  // ── Read models ──────────────────────────────────────────────────────────

  buildSnapshot(feed) {
    return {
      feed: feed.key,
      instrument: feed.instrument,
      status: this.feedStatus(feed),
      ...feed.aggregator.snapshot({ tradeLimit: this.options.snapshotTradeLimit }),
    };
  }

  async snapshot(marketType, asset) {
    const key = KucoinLiveTradesService.feedKey(marketType, asset);
    const feed = this.feeds.get(key);
    if (feed) return this.buildSnapshot(feed);
    const instrument = await this.instruments.get(marketType, asset);
    return {
      feed: key,
      instrument,
      status: {
        feed: key,
        marketType,
        asset,
        symbol: instrument.symbol,
        state: "idle",
        message: this.running
          ? "No viewer is streaming this feed; opening the live stream starts it."
          : "KuCoin live trades are not running on this server.",
        serverTime: this.now(),
      },
      trades: [],
      largeTrades: [],
      minutes: [],
    };
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      startedAt: this.startedAt,
      clients: this.clients.size,
      maxClients: this.options.maxClients,
      sockets: Object.fromEntries(MARKET_TYPES.map((m) => [m, this.sockets[m] ? this.sockets[m].status() : { marketType: m, url: this.urls[m], state: "idle" }])),
      feeds: [...this.feeds.values()].map((feed) => this.feedStatus(feed)),
      instruments: this.instruments.status(),
      serverTime: this.now(),
    };
  }
}

module.exports = { KucoinLiveTradesService, httpError };
