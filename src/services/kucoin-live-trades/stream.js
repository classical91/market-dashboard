"use strict";

// One shared KuCoin public WebSocket per market type (spot, futures), carrying
// every symbol any browser tab is watching. Browser tabs never talk to KuCoin;
// they read this server over SSE.
//
// Protocol (KuCoin UTA WebSocket V2, public channels — docs-new
// "websocket-api/introduction"):
//   1. connect to wss://x-push-spot.kucoin.com or wss://x-push-futures.kucoin.com
//      (no token, no API key)
//   2. server sends {"sessionId", "message":"welcome", "pingInterval":18000}
//   3. client sends {"id","action":"subscribe","channel":"trade","symbol","tradeType"}
//      and the server acks {"id","result":true}
//   4. client sends {"id","op":"ping","timestamp"} every pingInterval and the
//      server answers {"op":"pong","id","ts"}. No pong in time = broken link.
//      Pinging more than once a second gets the connection dropped.
//   5. trades arrive as {"T":"trade.SPOT"|"trade.FUTURES","P",d:{...}}
//
// KuCoin also drops connections during load-balancer switches (documented as
// up to one or two a week), so reconnect + resubscribe is a normal path.

const { EventEmitter } = require("node:events");
const { parseMessage, TRADE_TYPE_BY_MARKET } = require("./normalizer");

const DEFAULT_URLS = Object.freeze({
  spot: "wss://x-push-spot.kucoin.com",
  futures: "wss://x-push-futures.kucoin.com",
});
const OPEN = 1;

/**
 * Node 22+ ships a WHATWG WebSocket (undici). Older runtimes (package.json
 * allows Node 18; CI runs 20) fall back to the `ws` package, which exposes
 * the same onopen/onmessage/onclose/binaryType surface used here.
 */
function resolveWebSocket() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    return require("ws");
  } catch {
    return null;
  }
}

function backoffDelay(attempt, { baseMs, maxMs, random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // "Equal jitter": half fixed, half random. Never zero, so a fleet of
  // restarting clients cannot synchronize into a reconnect storm.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

class KucoinPublicSocket extends EventEmitter {
  constructor({
    marketType,
    url = DEFAULT_URLS[marketType],
    WebSocketImpl = resolveWebSocket(),
    now = Date.now,
    random = Math.random,
    logger = console,
    backoffBaseMs = 1000,
    backoffMaxMs = 60 * 1000,
    stableAfterMs = 60 * 1000,
    maxConnectsPerMinute = 10,
    welcomeTimeoutMs = 10 * 1000,
    ackTimeoutMs = 10 * 1000,
    pongTimeoutMs = 10 * 1000,
    defaultPingIntervalMs = 18 * 1000,
    minPingIntervalMs = 2 * 1000,
    subscribeRetryMs = 15 * 1000,
  } = {}) {
    super();
    if (!TRADE_TYPE_BY_MARKET[marketType]) throw new Error(`Unknown KuCoin market type: ${marketType}`);
    this.marketType = marketType;
    this.tradeType = TRADE_TYPE_BY_MARKET[marketType];
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.options = {
      backoffBaseMs, backoffMaxMs, stableAfterMs, maxConnectsPerMinute,
      welcomeTimeoutMs, ackTimeoutMs, pongTimeoutMs, defaultPingIntervalMs, minPingIntervalMs, subscribeRetryMs,
    };

    this.state = "idle"; // idle | connecting | open | reconnecting | stopped
    this.ws = null;
    this.wanted = new Set();
    this.subscriptions = new Map(); // symbol -> { state: pending|active|error, id, at, error }
    this.pendingAcks = new Map(); // ack id -> { symbol, action, timer }
    this.timers = { reconnect: null, welcome: null, ping: null, pong: null };
    this.retryTimers = new Set();
    this.attempt = 0;
    this.reconnects = 0;
    this.connectTimes = [];
    this.sessionId = null;
    this.pingIntervalMs = null;
    this.openedAt = null;
    this.lastMessageAt = null;
    this.lastPongAt = null;
    this.lastError = null;
    this.nextReconnectAt = null;
    this.seq = 0;
  }

  nextId(prefix) {
    this.seq = (this.seq + 1) % 1e9;
    // Public-channel ids: [A-Za-z0-9_.!@#$%^&*-], at most 40 characters.
    return `${prefix}-${this.now().toString(36)}-${this.seq}`;
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  subscribe(symbol) {
    if (this.state === "stopped") return;
    this.wanted.add(symbol);
    if (this.state === "open") this.sendSubscription(symbol, "subscribe");
    else if (this.state === "idle") this.connect();
    // connecting / reconnecting: the welcome handler subscribes everything wanted.
  }

  unsubscribe(symbol) {
    if (!this.wanted.delete(symbol)) return;
    const sub = this.subscriptions.get(symbol);
    this.subscriptions.delete(symbol);
    if (this.state === "open" && sub && sub.state !== "error") this.sendSubscription(symbol, "unsubscribe");
    if (this.wanted.size === 0) this.close("no subscribers");
  }

  /**
   * Re-sends unsubscribe + subscribe for one symbol on the open socket. Used
   * when a subscription looks silently dead while the connection itself still
   * answers pings; unlike a reconnect it leaves the other feeds untouched.
   */
  resubscribe(symbol) {
    if (this.state !== "open" || !this.wanted.has(symbol)) return false;
    this.sendSubscription(symbol, "unsubscribe");
    this.sendSubscription(symbol, "subscribe");
    return true;
  }

  sendSubscription(symbol, action) {
    const id = this.nextId(action === "subscribe" ? "sub" : "unsub");
    const ok = this.send({ id, action, channel: "trade", symbol, tradeType: this.tradeType });
    if (!ok) return;
    if (action === "subscribe") {
      this.subscriptions.set(symbol, { state: "pending", id, at: this.now(), error: null });
      const timer = setTimeout(() => {
        if (!this.pendingAcks.has(id)) return;
        this.pendingAcks.delete(id);
        this.forceReconnect(`no subscription ack for ${symbol}`);
      }, this.options.ackTimeoutMs);
      this.pendingAcks.set(id, { symbol, action, timer });
    }
  }

  handleAck(msg) {
    const pending = msg.id ? this.pendingAcks.get(msg.id) : null;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(msg.id);
    if (pending.action !== "subscribe" || !this.wanted.has(pending.symbol)) return;
    if (msg.ok) {
      const at = this.now();
      this.subscriptions.set(pending.symbol, { state: "active", id: msg.id, at, error: null });
      this.emit("subscribed", { symbol: pending.symbol, at });
    } else {
      this.subscriptions.set(pending.symbol, { state: "error", id: msg.id, at: this.now(), error: msg.message });
      this.lastError = `subscribe ${pending.symbol}: ${msg.message}`;
      this.emit("subscription-error", { symbol: pending.symbol, message: msg.message });
      const symbol = pending.symbol;
      const retry = setTimeout(() => {
        this.retryTimers.delete(retry);
        const sub = this.subscriptions.get(symbol);
        if (this.state === "open" && this.wanted.has(symbol) && sub && sub.state === "error") this.sendSubscription(symbol, "subscribe");
      }, this.options.subscribeRetryMs);
      this.retryTimers.add(retry);
    }
    this.emitState();
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  connect() {
    if (this.state === "stopped" || this.ws) return;
    if (typeof this.WebSocketImpl !== "function") {
      this.lastError = "No WebSocket client available (needs Node 22+ or the ws package)";
      this.state = "idle";
      this.emitState();
      return;
    }
    const now = this.now();
    this.connectTimes = this.connectTimes.filter((t) => now - t < 60 * 1000);
    this.connectTimes.push(now);
    this.state = "connecting";
    this.sessionId = null;
    this.emitState();

    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.lastError = err.message;
      this.state = "reconnecting";
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    try { ws.binaryType = "arraybuffer"; } catch {}

    this.timers.welcome = setTimeout(() => this.forceReconnect("no welcome message"), this.options.welcomeTimeoutMs);
    ws.onmessage = (event) => { if (this.ws === ws) this.handleFrame(event.data); };
    ws.onerror = (event) => {
      if (this.ws !== ws) return;
      this.lastError = (event && (event.message || (event.error && event.error.message))) || "WebSocket error";
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.handleClose(event && event.code ? `closed (${event.code}${event.reason ? ` ${event.reason}` : ""})` : "closed");
    };
  }

  handleFrame(data) {
    this.lastMessageAt = this.now();
    const msg = parseMessage(data);
    switch (msg.kind) {
      case "welcome": return this.handleWelcome(msg);
      case "pong":
        this.lastPongAt = this.lastMessageAt;
        clearTimeout(this.timers.pong);
        this.timers.pong = null;
        return undefined;
      case "ack": return this.handleAck(msg);
      case "trade":
        if (msg.tradeType !== this.tradeType || !msg.data) return undefined;
        if (!this.wanted.has(msg.data.s)) return undefined;
        this.emit("trade", { symbol: msg.data.s, data: msg.data, pushTimeNs: msg.pushTimeNs, receivedAt: this.lastMessageAt });
        return undefined;
      case "error":
        this.lastError = `${msg.code ? `${msg.code} ` : ""}${msg.message}`;
        if (msg.id && this.pendingAcks.has(msg.id)) this.handleAck({ id: msg.id, ok: false, message: msg.message });
        this.emitState();
        return undefined;
      default:
        return undefined;
    }
  }

  handleWelcome(msg) {
    clearTimeout(this.timers.welcome);
    this.timers.welcome = null;
    this.state = "open";
    this.sessionId = msg.sessionId;
    this.openedAt = this.now();
    this.lastError = null;
    this.nextReconnectAt = null;
    this.pingIntervalMs = Math.max(this.options.minPingIntervalMs, msg.pingInterval || this.options.defaultPingIntervalMs);
    this.startPing();
    this.emit("open", { sessionId: this.sessionId, at: this.openedAt });
    for (const symbol of this.wanted) this.sendSubscription(symbol, "subscribe");
    this.emitState();
  }

  startPing() {
    clearInterval(this.timers.ping);
    this.timers.ping = setInterval(() => {
      if (this.state !== "open") return;
      if (!this.send({ id: this.nextId("ping"), op: "ping", timestamp: this.now() })) return;
      if (!this.timers.pong) {
        this.timers.pong = setTimeout(() => {
          this.timers.pong = null;
          this.forceReconnect("pong timeout");
        }, this.options.pongTimeoutMs);
      }
    }, this.pingIntervalMs);
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.lastError = err.message;
      return false;
    }
  }

  clearConnectionTimers() {
    clearTimeout(this.timers.welcome);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.pong);
    this.timers.welcome = this.timers.ping = this.timers.pong = null;
    for (const pending of this.pendingAcks.values()) clearTimeout(pending.timer);
    this.pendingAcks.clear();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  detachSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch {}
  }

  handleClose(reason) {
    const wasOpen = this.state === "open";
    const stable = wasOpen && this.openedAt != null && this.now() - this.openedAt >= this.options.stableAfterMs;
    this.clearConnectionTimers();
    this.detachSocket();
    this.subscriptions.clear();
    if (!this.lastError || wasOpen) this.lastError = reason;
    this.emit("disconnected", { reason, at: this.now() });
    if (this.state === "stopped") return;
    if (this.wanted.size === 0) {
      this.state = "idle";
      this.emitState();
      return;
    }
    // A connection that stayed up resets the backoff; a flapping one does not.
    if (stable) this.attempt = 0;
    this.state = "reconnecting";
    this.scheduleReconnect();
  }

  forceReconnect(reason) {
    if (this.state === "stopped" || this.state === "idle") return;
    this.logger.warn && this.logger.warn(`[KuCoinLiveTrades] ${this.marketType} reconnect: ${reason}`);
    this.lastError = reason;
    this.handleClose(reason);
  }

  scheduleReconnect() {
    if (this.timers.reconnect || this.state === "stopped") return;
    this.attempt += 1;
    let delay = backoffDelay(this.attempt, {
      baseMs: this.options.backoffBaseMs,
      maxMs: this.options.backoffMaxMs,
      random: this.random,
    });
    // Storm guard: never more than maxConnectsPerMinute connection attempts.
    const now = this.now();
    const recent = this.connectTimes.filter((t) => now - t < 60 * 1000);
    if (recent.length >= this.options.maxConnectsPerMinute) {
      delay = Math.max(delay, recent[0] + 60 * 1000 - now);
    }
    this.nextReconnectAt = now + delay;
    this.reconnects += 1;
    this.emitState();
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      this.nextReconnectAt = null;
      if (this.state === "stopped" || this.wanted.size === 0) {
        if (this.state !== "stopped") this.state = "idle";
        return;
      }
      this.connect();
    }, delay);
  }

  close(reason = "closed") {
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = null;
    this.nextReconnectAt = null;
    this.clearConnectionTimers();
    const hadSocket = Boolean(this.ws);
    this.detachSocket();
    this.subscriptions.clear();
    if (this.state !== "stopped") this.state = "idle";
    this.attempt = 0;
    if (hadSocket) this.emit("disconnected", { reason, at: this.now() });
    this.emitState();
  }

  stop() {
    this.wanted.clear();
    this.close("stopped");
    this.state = "stopped";
    this.emitState();
  }

  emitState() {
    this.emit("state", this.status());
  }

  status() {
    return {
      marketType: this.marketType,
      url: this.url,
      state: this.state,
      sessionId: this.sessionId,
      openedAt: this.openedAt,
      lastMessageAt: this.lastMessageAt,
      lastPongAt: this.lastPongAt,
      pingIntervalMs: this.pingIntervalMs,
      reconnectAttempt: this.attempt,
      reconnects: this.reconnects,
      nextReconnectAt: this.nextReconnectAt,
      lastError: this.lastError,
      subscriptions: [...this.wanted].map((symbol) => {
        const sub = this.subscriptions.get(symbol);
        return { symbol, state: sub ? sub.state : "waiting", since: sub ? sub.at : null, error: sub ? sub.error : null };
      }),
    };
  }
}

module.exports = { KucoinPublicSocket, DEFAULT_URLS, backoffDelay, resolveWebSocket };
