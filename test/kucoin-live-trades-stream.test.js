"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { KucoinPublicSocket, backoffDelay, DEFAULT_URLS } = require("../src/services/kucoin-live-trades/stream");
const { MockKucoinWebSocket, spotTradeFrame } = require("./helpers/kucoin-mock-websocket");

const quiet = { log() {}, warn() {}, error() {} };

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1795157000000 });
  MockKucoinWebSocket.reset();
  const socket = new KucoinPublicSocket({
    marketType: "spot",
    WebSocketImpl: MockKucoinWebSocket,
    now: () => Date.now(),
    random: () => 0.5,
    logger: quiet,
    ...opts,
  });
  const events = [];
  for (const name of ["open", "subscribed", "disconnected", "trade", "subscription-error"]) {
    socket.on(name, (payload) => events.push({ name, payload }));
  }
  t.after(() => socket.stop());
  return { socket, events, tick: (ms) => t.mock.timers.tick(ms) };
}

test("the documented public endpoints are the defaults", () => {
  assert.equal(DEFAULT_URLS.spot, "wss://x-push-spot.kucoin.com");
  assert.equal(DEFAULT_URLS.futures, "wss://x-push-futures.kucoin.com");
});

test("connects lazily, waits for welcome, then subscribes to the trade channel", (t) => {
  const { socket, events } = setup(t);
  assert.equal(MockKucoinWebSocket.instances.length, 0, "no socket before anyone subscribes");
  socket.subscribe("BTC-USDT");
  const ws = MockKucoinWebSocket.latest();
  assert.equal(ws.url, "wss://x-push-spot.kucoin.com");
  assert.equal(ws.binaryType, "arraybuffer");
  assert.equal(ws.sent.length, 0, "nothing is sent before the welcome message");
  ws.welcome();
  assert.equal(socket.state, "open");
  const [sub] = ws.subscriptions();
  assert.deepEqual({ ...sub, id: undefined }, { id: undefined, action: "subscribe", channel: "trade", symbol: "BTC-USDT", tradeType: "SPOT" });
  assert.match(sub.id, /^[A-Za-z0-9_.!@#$%^&*-]{1,40}$/, "public-channel id charset and length");
  ws.ackAll();
  assert.equal(events.find((e) => e.name === "subscribed").payload.symbol, "BTC-USDT");
  assert.equal(socket.status().subscriptions[0].state, "active");

  ws.receive(spotTradeFrame());
  const trade = events.find((e) => e.name === "trade").payload;
  assert.equal(trade.symbol, "BTC-USDT");
  assert.equal(trade.pushTimeNs, "1795157002409118287");
  ws.receive(spotTradeFrame({ symbol: "DOGE-USDT" }));
  assert.equal(events.filter((e) => e.name === "trade").length, 1, "unwatched symbols are ignored");
});

test("a second symbol shares the open socket", (t) => {
  const { socket } = setup(t);
  socket.subscribe("BTC-USDT");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  socket.subscribe("ETH-USDT");
  assert.equal(MockKucoinWebSocket.instances.length, 1);
  assert.deepEqual(ws.subscriptions().map((m) => m.symbol), ["BTC-USDT", "ETH-USDT"]);
});

test("pings at the server's pingInterval and reconnects when no pong arrives", (t) => {
  const { socket, events, tick } = setup(t, { pongTimeoutMs: 5000 });
  socket.subscribe("BTC-USDT");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome({ pingInterval: 18000 });
  ws.ackAll();
  tick(18000);
  const ping = ws.sent.find((m) => m.op === "ping");
  assert.ok(ping, "ping sent after pingInterval");
  assert.ok(typeof ping.id === "string" && typeof ping.timestamp === "number");
  ws.pong();
  tick(5000);
  assert.equal(socket.state, "open", "answered ping keeps the connection");
  tick(13000); // next ping
  tick(5000); // no pong
  assert.equal(socket.state, "reconnecting");
  assert.equal(events.filter((e) => e.name === "disconnected").length, 1);
  assert.match(socket.status().lastError, /pong timeout/);
  assert.equal(ws.closedByClient, true, "the dead socket is closed");
});

test("never pings more than once per second even if told to", (t) => {
  const { socket, tick } = setup(t);
  socket.subscribe("BTC-USDT");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome({ pingInterval: 100 });
  tick(1000);
  assert.ok(ws.sent.filter((m) => m.op === "ping").length <= 1);
});

test("reconnects with jittered exponential backoff and resubscribes everything", (t) => {
  const { socket, events, tick } = setup(t, { backoffBaseMs: 1000 });
  socket.subscribe("BTC-USDT");
  socket.subscribe("SOL-USDT");
  let ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  ws.serverClose(1005);
  assert.equal(socket.state, "reconnecting");
  // attempt 1: ceiling 1000ms, equal jitter with random 0.5 → 750ms
  assert.equal(socket.status().nextReconnectAt - Date.now(), 750);
  tick(749);
  assert.equal(MockKucoinWebSocket.instances.length, 1);
  tick(1);
  assert.equal(MockKucoinWebSocket.instances.length, 2);
  ws = MockKucoinWebSocket.latest();
  ws.serverClose(1006); // fails before welcome
  assert.equal(socket.status().nextReconnectAt - Date.now(), 1500, "attempt 2 doubles the ceiling");
  tick(1500);
  ws = MockKucoinWebSocket.latest();
  ws.welcome();
  assert.deepEqual(ws.subscriptions().map((m) => m.symbol).sort(), ["BTC-USDT", "SOL-USDT"]);
  ws.ackAll();
  assert.equal(events.filter((e) => e.name === "subscribed").length, 4);
});

test("a connection that stayed up resets the backoff", (t) => {
  const { socket, tick } = setup(t, { stableAfterMs: 60000 });
  socket.subscribe("BTC-USDT");
  let ws = MockKucoinWebSocket.latest();
  ws.serverClose();
  tick(750);
  ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  for (let i = 0; i < 4; i++) { tick(18000); ws.pong(); }
  ws.serverClose();
  assert.equal(socket.status().reconnectAttempt, 1);
});

test("the storm guard caps connection attempts per minute", (t) => {
  const { socket, tick } = setup(t, { maxConnectsPerMinute: 3, backoffBaseMs: 10, backoffMaxMs: 10 });
  socket.subscribe("BTC-USDT");
  for (let i = 0; i < 3; i++) {
    MockKucoinWebSocket.latest().serverClose();
    tick(10);
  }
  assert.equal(MockKucoinWebSocket.instances.length, 3);
  MockKucoinWebSocket.latest().serverClose();
  const wait = socket.status().nextReconnectAt - Date.now();
  assert.ok(wait > 50000, `waits for the minute window (${wait}ms)`);
  tick(10);
  assert.equal(MockKucoinWebSocket.instances.length, 3);
});

test("a missing ack or welcome forces a reconnect", (t) => {
  const { socket, tick } = setup(t, { ackTimeoutMs: 4000, welcomeTimeoutMs: 3000 });
  socket.subscribe("BTC-USDT");
  tick(3000);
  assert.equal(socket.state, "reconnecting");
  assert.match(socket.status().lastError, /welcome/);
  tick(1000);
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  tick(4000);
  assert.equal(socket.state, "reconnecting");
  assert.match(socket.status().lastError, /no subscription ack/);
});

test("a rejected subscription is reported and retried", (t) => {
  const { socket, events, tick } = setup(t, { subscribeRetryMs: 2000 });
  socket.subscribe("BTC-USDT");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll({ result: false });
  assert.equal(events.find((e) => e.name === "subscription-error").payload.symbol, "BTC-USDT");
  assert.equal(socket.status().subscriptions[0].state, "error");
  tick(2000);
  assert.equal(ws.subscriptions().length, 2);
});

test("the last unsubscribe sends unsubscribe and closes without reconnecting", (t) => {
  const { socket, tick } = setup(t);
  socket.subscribe("BTC-USDT");
  socket.subscribe("ETH-USDT");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  socket.unsubscribe("ETH-USDT");
  assert.deepEqual(ws.subscriptions("unsubscribe").map((m) => [m.symbol, m.channel, m.tradeType]), [["ETH-USDT", "trade", "SPOT"]]);
  assert.equal(socket.state, "open");
  socket.unsubscribe("BTC-USDT");
  assert.equal(socket.state, "idle");
  assert.equal(ws.closedByClient, true);
  tick(120000);
  assert.equal(MockKucoinWebSocket.instances.length, 1, "no reconnect once nobody is watching");
});

test("resubscribe() refreshes one symbol on the open socket", (t) => {
  const { socket } = setup(t);
  socket.subscribe("BTC-USDT");
  socket.subscribe("ETH-USDT");
  const ws = MockKucoinWebSocket.latest();
  assert.equal(socket.resubscribe("BTC-USDT"), false, "nothing to do before the socket is open");
  ws.welcome();
  ws.ackAll();
  assert.equal(socket.resubscribe("BTC-USDT"), true);
  assert.deepEqual(ws.subscriptions("unsubscribe").map((m) => m.symbol), ["BTC-USDT"]);
  assert.deepEqual(ws.subscriptions().map((m) => m.symbol), ["BTC-USDT", "ETH-USDT", "BTC-USDT"]);
  assert.equal(socket.resubscribe("SOL-USDT"), false, "unknown symbols are ignored");
});

test("stop() clears every timer and refuses new work", (t) => {
  const { socket, tick } = setup(t);
  socket.subscribe("BTC-USDT");
  MockKucoinWebSocket.latest().serverClose();
  socket.stop();
  tick(600000);
  assert.equal(MockKucoinWebSocket.instances.length, 1);
  socket.subscribe("BTC-USDT");
  assert.equal(MockKucoinWebSocket.instances.length, 1);
  assert.equal(socket.state, "stopped");
});

test("backoff stays within its jitter band and the cap", () => {
  const opts = { baseMs: 1000, maxMs: 60000 };
  assert.equal(backoffDelay(1, { ...opts, random: () => 0 }), 500);
  assert.equal(backoffDelay(1, { ...opts, random: () => 1 }), 1000);
  assert.equal(backoffDelay(4, { ...opts, random: () => 0 }), 4000);
  assert.equal(backoffDelay(30, { ...opts, random: () => 1 }), 60000);
});

// Real sockets, no mocks: a local server speaking KuCoin's public protocol,
// exercised through both WebSocket clients the service can run on.
test("speaks the protocol over real WebSocket connections (ws and built-in)", async (t) => {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  t.after(() => new Promise((resolve) => wss.close(resolve)));
  const received = [];
  wss.on("connection", (conn) => {
    conn.send(Buffer.from('{"sessionId":"local","message":"welcome","pingInterval":18000}'), { binary: true });
    conn.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.action === "subscribe") {
        conn.send(Buffer.from(`{"id":"${msg.id}","result":true}`), { binary: true });
        conn.send(Buffer.from(spotTradeFrame()), { binary: true });
      }
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const clients = [["ws", require("ws")]];
  if (typeof globalThis.WebSocket === "function") clients.push(["built-in", globalThis.WebSocket]);
  for (const [name, WebSocketImpl] of clients) {
    const socket = new KucoinPublicSocket({ marketType: "spot", url, WebSocketImpl, logger: quiet });
    const trade = new Promise((resolve) => socket.once("trade", resolve));
    socket.subscribe("BTC-USDT");
    const got = await trade;
    assert.equal(got.data.M, "1795157002407000000", `${name}: exact nanoseconds`);
    assert.equal(got.pushTimeNs, "1795157002409118287", `${name}: push time`);
    assert.equal(socket.status().subscriptions[0].state, "active", `${name}: acked`);
    assert.equal(socket.sessionId, "local");
    socket.stop();
  }
  assert.ok(received.filter((m) => m.action === "subscribe").every((m) => m.channel === "trade" && m.tradeType === "SPOT"));
});
