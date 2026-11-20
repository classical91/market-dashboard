"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { KucoinLiveTradesService } = require("../src/services/kucoin-live-trades/service");
const { createKucoinLiveTradesRouter } = require("../src/routes/kucoin-live-trades");
const { MockKucoinWebSocket, spotTradeFrame, futuresTradeFrame, stubInstruments } = require("./helpers/kucoin-mock-websocket");

const quiet = { log() {}, warn() {}, error() {} };

async function serve(t, serviceOpts = {}, { start = true } = {}) {
  MockKucoinWebSocket.reset();
  const service = new KucoinLiveTradesService({
    instruments: stubInstruments(),
    WebSocketImpl: MockKucoinWebSocket,
    logger: quiet,
    flushIntervalMs: 20,
    statsIntervalMs: 40,
    lingerMs: 60,
    ...serviceOpts,
  });
  if (start) service.start();
  const app = express();
  app.use("/api/kucoin-live-trades", createKucoinLiveTradesRouter({ kucoinLiveTradesService: service }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { service, base: `http://127.0.0.1:${server.address().port}/api/kucoin-live-trades` };
}

/** Minimal SSE client over fetch: collects { event, data } records. */
async function openSse(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events = [];
  const waiters = [];
  const client = { res, events, closed: false };
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (!event || !data) continue;
          events.push({ event: event[1], data: JSON.parse(data[1]) });
          for (const w of [...waiters]) w();
        }
      }
    } catch { /* aborted */ }
    client.closed = true;
    for (const w of [...waiters]) w();
  })();
  client.next = (name, predicate = () => true, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const started = events.length;
    let i = 0;
    const check = () => {
      for (; i < events.length; i++) {
        if (events[i].event === name && predicate(events[i].data)) {
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          return resolve(events[i].data);
        }
      }
      if (client.closed) {
        waiters.splice(waiters.indexOf(check), 1);
        clearTimeout(timer);
        reject(new Error(`stream closed before ${name}`));
      }
    };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(check), 1);
      reject(new Error(`timed out waiting for ${name} (saw ${events.slice(started).map((e) => e.event).join(",")})`));
    }, timeoutMs);
    waiters.push(check);
    check();
  });
  client.close = () => controller.abort();
  return client;
}

const until = async (fn, timeoutMs = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("two browser tabs share one upstream subscription and both receive every trade", async (t) => {
  const { service, base } = await serve(t);
  const a = await openSse(`${base}/stream?market=spot&asset=BTC`);
  t.after(() => a.close());
  assert.equal(a.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const snapA = await a.next("snapshot");
  assert.equal(snapA.feed, "spot:BTC");
  assert.equal(snapA.instrument.symbol, "BTC-USDT");
  assert.deepEqual(snapA.trades, [], "no fake trades before the feed delivers");

  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  await a.next("status", (s) => s.state === "live");

  const b = await openSse(`${base}/stream?asset=BTC`);
  t.after(() => b.close());
  await b.next("snapshot");
  assert.equal(MockKucoinWebSocket.instances.length, 1, "one upstream socket");
  assert.equal(ws.subscriptions().length, 1, "one upstream subscription");
  assert.equal(service.status().clients, 2);

  // A current exchange time, so the trade falls inside the rolling windows.
  ws.receive(spotTradeFrame({ id: "25376143998074881", side: "sell", price: "61718.8", qty: "0.5", timeNs: `${Date.now()}000000` }));
  ws.receive(spotTradeFrame({ id: "25376143998074881" })); // duplicate id
  ws.receive(spotTradeFrame({ id: "25376143998074882", price: "0" })); // invalid
  for (const client of [a, b]) {
    const batch = await client.next("trades");
    assert.equal(batch.trades.length, 1);
    assert.equal(batch.trades[0].tradeId, "25376143998074881");
    assert.equal(batch.trades[0].notional, 30859.4);
    assert.equal(batch.trades[0].side, "sell");
  }
  const stats = await a.next("stats", (s) => s.stats.counts.accepted === 1);
  assert.equal(stats.stats.counts.duplicates, 1);
  assert.equal(stats.status.rejected, 1);
  assert.match(stats.status.lastRejectReason, /price/);
  assert.equal(stats.stats.windows["5m"].sellNotional, 30859.4);
  assert.equal(stats.stats.windows["5m"].complete, false);
});

test("disconnecting the last viewer cleans up the client and, after the linger, the upstream subscription", async (t) => {
  const { service, base } = await serve(t);
  const a = await openSse(`${base}/stream?market=spot&asset=ETH`);
  await a.next("snapshot");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  a.close();
  await until(() => service.status().clients === 0);
  assert.equal(service.feeds.size, 1, "feed lingers briefly for page reloads");
  await until(() => service.feeds.size === 0);
  assert.deepEqual(ws.subscriptions("unsubscribe").map((m) => m.symbol), ["ETH-USDT"]);
  assert.equal(ws.closedByClient, true, "no watchers left: upstream socket closed");
});

test("a viewer returning within the linger keeps the same session", async (t) => {
  const { base } = await serve(t, { lingerMs: 500 });
  const a = await openSse(`${base}/stream?asset=SOL`);
  const first = await a.next("snapshot");
  a.close();
  await new Promise((r) => setTimeout(r, 50));
  const b = await openSse(`${base}/stream?asset=SOL`);
  t.after(() => b.close());
  const second = await b.next("snapshot");
  assert.equal(second.session.id, first.session.id);
});

test("switching market or pair opens the matching feed with its own session", async (t) => {
  const { base } = await serve(t);
  const spot = await openSse(`${base}/stream?market=spot&asset=BTC`);
  t.after(() => spot.close());
  const spotSnap = await spot.next("snapshot");
  const fut = await openSse(`${base}/stream?market=futures&asset=BTC`);
  t.after(() => fut.close());
  const futSnap = await fut.next("snapshot");
  assert.equal(futSnap.instrument.symbol, "XBTUSDTM");
  assert.notEqual(futSnap.session.id, spotSnap.session.id);
  const [spotWs, futWs] = MockKucoinWebSocket.instances;
  assert.equal(spotWs.url, "wss://x-push-spot.kucoin.com");
  assert.equal(futWs.url, "wss://x-push-futures.kucoin.com");
  futWs.welcome();
  assert.deepEqual(futWs.subscriptions().map((m) => [m.symbol, m.tradeType]), [["XBTUSDTM", "FUTURES"]]);
  futWs.ackAll();
  futWs.receive(futuresTradeFrame({ qty: "12", price: "90551.8" }));
  const batch = await fut.next("trades");
  assert.equal(batch.trades[0].quantity, 12);
  assert.equal(batch.trades[0].baseQuantity, 0.012);
  assert.equal(batch.trades[0].notional, 1086.6216);
  assert.equal(spot.events.filter((e) => e.event === "trades").length, 0, "futures trades never reach the spot feed");

  const bySymbol = await openSse(`${base}/stream?market=futures&symbol=ETHUSDTM`);
  t.after(() => bySymbol.close());
  assert.equal((await bySymbol.next("snapshot")).feed, "futures:ETH");
});

test("upstream reconnects are visible to viewers and resubscribe the feed", async (t) => {
  const { base } = await serve(t, { socketOptions: { backoffBaseMs: 20, random: () => 0 } });
  const a = await openSse(`${base}/stream?asset=BTC`);
  t.after(() => a.close());
  await a.next("snapshot");
  let ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  await a.next("status", (s) => s.state === "live");
  ws.serverClose(1001, "load balancing");
  const reconnecting = await a.next("status", (s) => s.state === "reconnecting");
  assert.match(reconnecting.message, /Reconnecting/);
  await until(() => MockKucoinWebSocket.instances.length === 2);
  ws = MockKucoinWebSocket.latest();
  ws.welcome();
  assert.deepEqual(ws.subscriptions().map((m) => m.symbol), ["BTC-USDT"]);
  ws.ackAll();
  await a.next("status", (s) => s.state === "live");
  const stats = await a.next("stats", (s) => s.stats.coverage.gaps === 1);
  assert.ok(stats.stats.coverage.since != null);
});

test("a subscribed feed with no trades turns stale, then re-subscribes only that symbol", async (t) => {
  const clock = { value: Date.now() };
  const { service, base } = await serve(t, { now: () => clock.value, staleAfterMs: 1000, resubscribeAfterMs: 5000 });
  const a = await openSse(`${base}/stream?asset=BTC`);
  t.after(() => a.close());
  await a.next("snapshot");
  const ws = MockKucoinWebSocket.latest();
  ws.welcome();
  ws.ackAll();
  await a.next("status", (s) => s.state === "live");
  clock.value += 2000;
  const stale = await a.next("status", (s) => s.state === "stale");
  assert.match(stale.message, /no trade has arrived/);
  clock.value += 5000;
  await until(() => ws.subscriptions("unsubscribe").length === 1 && ws.subscriptions().length === 2);
  assert.deepEqual(ws.subscriptions("unsubscribe").map((m) => m.symbol), ["BTC-USDT"]);
  assert.equal(service.sockets.spot.state, "open", "the shared socket is not torn down");
  assert.equal(MockKucoinWebSocket.instances.length, 1);
  ws.ackAll();
  const after = await a.next("stats", (s) => s.status.resubscribes === 1);
  assert.equal(after.stats.coverage.gaps, 0, "a re-subscribe on a live socket is not counted as a gap");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ws.subscriptions().length, 2, "no re-subscribe storm: waits another full interval");
});

test("snapshot, symbols and status endpoints are read-only views", async (t) => {
  const { base } = await serve(t);
  let res = await fetch(`${base}/snapshot?market=futures&asset=SOL`);
  let body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status.state, "idle");
  assert.equal(body.instrument.multiplier, 0.1);
  assert.deepEqual(body.trades, []);
  assert.equal(MockKucoinWebSocket.instances.length, 0, "a snapshot never opens an upstream socket");

  res = await fetch(`${base}/symbols`);
  body = await res.json();
  assert.equal(body.futures.BTC.symbol, "XBTUSDTM");
  assert.deepEqual(body.assets, ["BTC", "ETH", "SOL"]);

  res = await fetch(`${base}/status`);
  body = await res.json();
  assert.equal(body.running, true);
  assert.equal(body.sockets.spot.state, "idle");

  for (const bad of ["market=options&asset=BTC", "asset=DOGE", "market=futures&symbol=XBTUSDM"]) {
    res = await fetch(`${base}/snapshot?${bad}`);
    assert.equal(res.status, 400, bad);
  }
  res = await fetch(`${base}/stream?asset=DOGE`);
  assert.equal(res.status, 400);
});

test("the stream refuses to start feeds until start() has run, and stop() ends streams", async (t) => {
  const { service, base } = await serve(t, {}, { start: false });
  let res = await fetch(`${base}/stream?asset=BTC`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not running/);
  assert.equal(MockKucoinWebSocket.instances.length, 0);

  service.start();
  const a = await openSse(`${base}/stream?asset=BTC`);
  await a.next("snapshot");
  service.stop();
  await a.next("shutdown");
  await until(() => a.closed);
  assert.equal(MockKucoinWebSocket.latest().closedByClient, true);
  assert.equal(service.status().clients, 0);
  res = await fetch(`${base}/stream?asset=BTC`);
  assert.equal(res.status, 503);
});

test("the viewer cap protects the server", async (t) => {
  const { base } = await serve(t, { maxClients: 1 });
  const a = await openSse(`${base}/stream?asset=BTC`);
  t.after(() => a.close());
  await a.next("snapshot");
  const res = await fetch(`${base}/stream?asset=ETH`);
  assert.equal(res.status, 503);
});

test("createApp() wires the service without opening sockets or timers", () => {
  const { createApp } = require("../src/app");
  const app = createApp();
  const service = app.locals.kucoinLiveTrades;
  assert.ok(service instanceof KucoinLiveTradesService);
  assert.equal(service.running, false);
  assert.deepEqual(service.sockets, {});
  assert.equal(service.timers.flush, null);
});
