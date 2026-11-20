#!/usr/bin/env node
"use strict";

// Live integration smoke test for the KuCoin Live Trades Terminal.
//
// Talks to KuCoin's real public endpoints (no API key) and checks, per feed:
//   1. instrument metadata resolves the symbol and futures multiplier
//   2. the WebSocket sends welcome, acks the trade subscription and delivers
//      trades that pass normalization
//   3. the same trade ids appear in REST history (GET /api/ua/v2/market/trade)
//      with the same price, size, time and side — confirming the WebSocket side
//      is the taker side KuCoin documents for REST
//   4. (with --keepalive) a ping is answered with a pong
//
// Usage:
//   node scripts/kucoin-live-trades-smoke.js                 # spot+futures BTC
//   node scripts/kucoin-live-trades-smoke.js --all           # BTC, ETH, SOL
//   node scripts/kucoin-live-trades-smoke.js --seconds 20 --keepalive
//
// Behind an HTTP(S) proxy, run with NODE_USE_ENV_PROXY=1 (Node ≥ 22.21) so the
// built-in WebSocket and fetch use HTTPS_PROXY.

const { KucoinInstrumentRegistry } = require("../src/services/kucoin-live-trades/instruments");
const { KucoinPublicSocket } = require("../src/services/kucoin-live-trades/stream");
const { normalizeTrade, safeParse, toNanoseconds, TRADE_TYPE_BY_MARKET } = require("../src/services/kucoin-live-trades/normalizer");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SECONDS = Number(option("seconds", 12));
const REST = option("rest", "https://api.kucoin.com");
const assets = flag("all") ? ["BTC", "ETH", "SOL"] : [option("asset", "BTC").toUpperCase()];
const markets = option("market", "") ? [option("market")] : ["spot", "futures"];
const quiet = { log() {}, warn() {}, error() {} };

async function restTrades(marketType, symbol) {
  const url = `${REST}/api/ua/v2/market/trade?tradeType=${TRADE_TYPE_BY_MARKET[marketType]}&symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = safeParse(await res.text());
  if (!res.ok || !body || body.code !== "200000") throw new Error(`REST trades ${symbol}: HTTP ${res.status} ${body && body.code}`);
  return body.data.list;
}

async function smokeFeed(registry, marketType, asset) {
  const report = { feed: `${marketType}:${asset}`, ok: false, checks: [] };
  const check = (name, pass, detail = "") => report.checks.push({ name, pass: Boolean(pass), detail });
  const instrument = await registry.get(marketType, asset);
  report.symbol = instrument.symbol;
  check("instrument resolved", instrument.symbol, `${instrument.symbol}${marketType === "futures" ? ` multiplier ${instrument.multiplierText} ${asset}/contract` : ""}`);
  if (marketType === "futures") check("futures multiplier from metadata", instrument.multiplier > 0 && instrument.quantityUnit === "contracts", instrument.multiplierText);

  const socket = new KucoinPublicSocket({ marketType, logger: quiet });
  const trades = [];
  const rejected = [];
  let welcome = null;
  let subscribed = null;
  let pong = false;
  socket.on("open", (e) => { welcome = e; });
  socket.on("subscribed", (e) => { subscribed = e; });
  socket.on("trade", ({ data, pushTimeNs, receivedAt }) => {
    const r = normalizeTrade(data, { marketType, instrument, pushTimeNs, receivedAt });
    if (r.ok) trades.push(r.trade);
    else rejected.push(r.reason);
  });
  const origHandle = socket.handleFrame.bind(socket);
  socket.handleFrame = (data) => {
    const before = socket.lastPongAt;
    origHandle(data);
    if (socket.lastPongAt !== before) pong = true;
  };

  socket.subscribe(instrument.symbol);
  const deadline = Date.now() + SECONDS * 1000 + (flag("keepalive") ? 20000 : 0);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!flag("keepalive") && subscribed && trades.length >= 25) break;
    if (flag("keepalive") && pong && trades.length >= 5 && Date.now() > deadline - 20000) break;
  }
  const status = socket.status();
  socket.stop();

  check("welcome message", welcome && welcome.sessionId, welcome ? `session ${welcome.sessionId}, pingInterval ${status.pingIntervalMs}ms` : status.lastError || "none");
  check("subscription acknowledged", subscribed, subscribed ? "" : status.lastError || "no ack");
  check("live trades received", trades.length > 0, `${trades.length} trades, ${rejected.length} rejected${rejected.length ? ` (${[...new Set(rejected)].join("; ")})` : ""}`);
  check("no invalid trades", rejected.length === 0);
  if (flag("keepalive")) check("ping answered with pong", pong);

  if (trades.length) {
    const ids = new Set(trades.map((t) => t.tradeId));
    check("trade ids unique", ids.size === trades.length);
    const notionalOk = trades.every((t) => {
      const expected = marketType === "futures" ? t.price * t.quantity * instrument.multiplier : t.price * t.quantity;
      return t.notional != null && Math.abs(t.notional - expected) <= Math.max(1e-6, expected * 1e-9);
    });
    check("notional = price × quantity × multiplier", notionalOk);
    const latency = trades.map((t) => t.receivedAt - t.exchangeTimeMs).sort((a, b) => a - b);
    report.latencyMs = { median: latency[Math.floor(latency.length / 2)], max: latency[latency.length - 1] };

    // REST cross-check of the most recent WebSocket trades.
    const rest = await restTrades(marketType, instrument.symbol);
    const byId = new Map(rest.map((r) => [String(r.tradeId), r]));
    const matched = trades.filter((t) => byId.has(t.tradeId));
    let sideAgree = 0;
    let fieldsAgree = 0;
    for (const t of matched) {
      const r = byId.get(t.tradeId);
      if (String(r.side).toLowerCase() === t.side) sideAgree += 1;
      const restNs = toNanoseconds(r.ts);
      if (Number(r.price) === t.price && Number(r.size) === t.quantity && restNs != null && restNs.toString() === t.exchangeTimeNs) fieldsAgree += 1;
    }
    report.restMatched = matched.length;
    check("trades found in REST history", matched.length > 0, `${matched.length} of ${trades.length} matched by trade id (REST returns the latest ${rest.length})`);
    check("side matches REST taker side", matched.length > 0 && sideAgree === matched.length, `${sideAgree}/${matched.length}`);
    check("price, size and nanosecond time match REST", matched.length > 0 && fieldsAgree === matched.length, `${fieldsAgree}/${matched.length}`);
  }
  report.ok = report.checks.every((c) => c.pass);
  return report;
}

(async () => {
  if (typeof globalThis.WebSocket !== "function") {
    console.error("This Node.js has no global WebSocket (need Node 22+).");
    process.exit(2);
  }
  const registry = new KucoinInstrumentRegistry({ baseUrl: REST });
  const reports = [];
  for (const asset of assets) {
    for (const marketType of markets) {
      try {
        reports.push(await smokeFeed(registry, marketType, asset));
      } catch (err) {
        reports.push({ feed: `${marketType}:${asset}`, ok: false, checks: [{ name: "run", pass: false, detail: err.message }] });
      }
    }
  }
  for (const r of reports) {
    console.log(`\n${r.ok ? "PASS" : "FAIL"}  ${r.feed}${r.symbol ? ` (${r.symbol})` : ""}${r.latencyMs ? `  latency median ${r.latencyMs.median}ms max ${r.latencyMs.max}ms` : ""}`);
    for (const c of r.checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  const failed = reports.filter((r) => !r.ok).length;
  console.log(`\n${reports.length - failed}/${reports.length} feeds passed`);
  process.exit(failed ? 1 : 0);
})();
