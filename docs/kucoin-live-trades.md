# KuCoin Live Trades Terminal

`/kucoin-live-trades.html` — sidebar **TradeHunter → Live Trades**. A real-time
execution tape for KuCoin spot and USDT-margined perpetual futures: Time &
Sales, large prints ("Whale Trades"), and rolling order-flow analytics.

It is **read-only**. Only KuCoin's public market-data channels are used: no API
key, token, account endpoint, wallet access or order placement exists anywhere
in this feature.

## Architecture

```
KuCoin                          Market Dashboard server                         Browser tabs
──────                          ───────────────────────                         ────────────
wss://x-push-spot.kucoin.com ◄─ KucoinPublicSocket (spot)  ─┐
wss://x-push-futures.kucoin.com ◄ KucoinPublicSocket (futures)┤
                                                            ▼
                                  normalizer → TradeAggregator (per feed)
                                                            │
                                  KucoinLiveTradesService   │  SSE: snapshot, trades (batched),
                                  (feeds, fan-out, watchdog)├─────────────────► stats, status ──► EventSource
https://api.kucoin.com ◄──────── KucoinInstrumentRegistry  │
  /api/ua/v2/market/instrument   (symbols + multipliers)
```

| File | Role |
| --- | --- |
| `src/services/kucoin-live-trades/stream.js` | One shared WebSocket per market type. Welcome → subscribe → ack, ping/pong keepalive, reconnect with jittered exponential backoff, storm guard, resubscribe. |
| `src/services/kucoin-live-trades/normalizer.js` | Frame decoding and classification; trade validation and normalization; exact decimal notional; nanosecond timestamps. |
| `src/services/kucoin-live-trades/aggregator.js` | Per-feed rolling windows (1m/5m/15m), CVD, per-minute buckets, large trades, dedup, coverage tracking. All buffers bounded. |
| `src/services/kucoin-live-trades/instruments.js` | Resolves BTC/ETH/SOL to listed KuCoin symbols and futures multipliers; 1 h cache, last-good copy on failure. |
| `src/services/kucoin-live-trades/service.js` | Feed lifecycle (ref-counted by viewers, 30 s linger), SSE fan-out, batching, stats, stale-feed watchdog, shutdown. |
| `src/routes/kucoin-live-trades.js` | `GET /api/kucoin-live-trades/{status,symbols,snapshot,stream}`. |
| `public/kucoin-live-trades.html`, `public/assets/js/kucoin-live-trades.js`, `public/assets/styles/kucoin-live-trades.css` | The page. Vanilla JS, canvas charts, no new dependency. |
| `scripts/kucoin-live-trades-smoke.js` | Live integration smoke test against KuCoin. |

### Why SSE

Trades only flow server → browser, so Server-Sent Events fit: plain HTTP
through the existing Express stack and site login, automatic browser
reconnect, and no WebSocket server to add. The repository had no existing
push mechanism to reuse.

### Shared upstream connections

There is at most one KuCoin socket per market type, opened only when the first
viewer opens a feed. Every tab watching `BTC-USDT` shares one subscription and
one aggregator. When the last viewer of a feed leaves, the feed lingers 30 s
(so a reload does not churn), then the server sends `unsubscribe`; with no
symbols left the socket is closed and not reconnected.

### Runtime only

`createApp()` constructs the service but starts nothing: no socket, no timer.
`server.js` calls `app.locals.kucoinLiveTrades.start()` after `listen`, like
the Signal Bot and Live Scanner. Until then `/stream` answers `503`. On
`SIGTERM`/`SIGINT`, `server.js` calls `stop()`, which ends every SSE stream,
closes the KuCoin sockets and clears all timers.

## KuCoin protocol (as implemented)

From KuCoin's docs ("UTA WebSocket V2 → Introduction" and "Public Channels →
Trade", <https://www.kucoin.com/docs-new>), verified against the live feed:

1. Connect to `wss://x-push-spot.kucoin.com` or `wss://x-push-futures.kucoin.com`. No token.
2. Server sends `{"sessionId":…,"message":"welcome","pingInterval":18000}`. Nothing is sent before it (10 s timeout → reconnect).
3. Subscribe: `{"id","action":"subscribe","channel":"trade","symbol":"BTC-USDT","tradeType":"SPOT"}`. Ids use the public-channel charset, ≤ 40 chars.
4. Ack: `{"id","result":true}` (the docs show `"true"`; the live feed sends a boolean; both accepted). No ack in 10 s → reconnect. `result:false` → reported on the page and retried every 15 s.
5. Keepalive: `{"id","op":"ping","timestamp"}` every `pingInterval` (never faster than every 2 s — KuCoin drops clients pinging more than once a second); no `pong` in 10 s → reconnect.
6. Trades: `{"T":"trade.SPOT","P":<push ns>,"d":{"E","M":<match ns>,"S":"buy|sell","p","q","s","ti"}}`; futures add `rpi`.

Frames arrive as **binary** WebSocket messages carrying UTF-8 JSON.

KuCoin documents that its load balancer drops connections "one to two times
per week"; reconnect + resubscribe is therefore a normal path, not an error.

## Normalized trade

```js
{
  exchange: "kucoin", marketType: "spot" | "futures", symbol, asset,
  tradeId,              // string, from `ti` (falls back to `E`) — never a Number
  price, priceText,     // number + the exact decimal string
  quantity, quantityText, quantityUnit,   // base asset (spot) or "contracts" (futures)
  baseQuantity,         // spot: quantity; futures: contracts × multiplier
  notional,             // USDT; null when it cannot be computed correctly
  notionalCurrency, notionalReason,
  side, aggressor, sideVerified,          // taker side, see below
  exchangeTimeNs, exchangeTimeMs,         // `M`, exact ns string + ms
  pushTimeNs, receivedAt, rpi,
}
```

- **Precision.** `P`, `M` and spot `E` exceed 2^53. They are quoted before
  `JSON.parse`, so nanosecond times and ids survive exactly. Trade ids are
  strings end to end (including the CSV).
- **Notional.** Spot = price × quantity. Futures = price × contracts ×
  multiplier, with the multiplier (`unitSize`) read from
  `GET /api/ua/v2/market/instrument` — at the time of writing XBTUSDTM 0.001
  BTC, ETHUSDTM 0.01 ETH, SOLUSDTM **0.1** SOL per contract. Products are
  computed with exact decimal arithmetic (no `23.200000000000003`). Only
  linear, USDT-quoted perpetuals are resolved; inverse, USDC-margined and
  delivery contracts are never selected, and a trade without a usable
  multiplier gets `notional: null` and is excluded from every flow metric and
  the whale list.
- **Validation.** Rejected: non-positive or malformed price/quantity, side not
  buy/sell, symbol mismatch, missing or unsafe numeric id, implausible
  timestamp. Rejections are counted per feed (`/status`).
- **Dedup.** Per feed, by trade id, over the last 20 000 ids.

### Side semantics (verified)

KuCoin documents the trade `side` as the **taker** order's side ("Filled side,
indicates the taker order side" — UTA REST V2 *Get Trades*, Classic *Get Trade
History*). The live smoke test matches WebSocket trades to
`GET /api/ua/v2/market/trade` by trade id and checks side, price, size and
nanosecond time agree. In the first run, 67 of 67 matched trades agreed across
all six feeds. "Buy" therefore means an aggressive buy that lifted the ask.

## Analytics

All figures come from normalized executions this server received; nothing is
estimated, back-filled or simulated.

| Metric | Definition |
| --- | --- |
| Buy / sell volume | Sum of USDT notional of taker-buy / taker-sell trades in the window (base units shown alongside). |
| Volume delta | Aggressive buy notional − aggressive sell notional. |
| Buy pressure | Aggressive buy notional ÷ classified notional × 100. Classified = notional computed and side verified. |
| Buy/sell ratio | Buy notional ÷ sell notional; `—` when there is no sell volume. |
| Largest trade | Largest single notional in the window. |
| Trades/min | Trades in the window ÷ covered minutes (not the nominal window). |
| CVD | Running sum of signed notional (USDT; base units on request) since the feed's server session started or the viewer pressed Reset. |

- **Windows** are 1m / 5m / 15m, computed from per-second buckets. A window is
  **complete** only once the server has been continuously subscribed for the
  whole window. After any reconnect, coverage restarts (trades during the gap
  were not received) and the page labels the window *partial* with how much
  is covered. KPIs are always the 5m window and carry the same badge.
- **CVD session.** A feed's session starts when its first viewer opens it and
  ends when the feed is closed (after the last viewer leaves). Switching market
  or pair shows a different feed, so CVD restarts. A reconnect inside a session
  is counted as a gap. The chart says which session/reset it is measured from.
- **Charts** show up to 60 minutes of per-minute buckets the server observed.
  The current and first (partial) minutes are drawn lighter.
- **Whale trades** are ≥ $10k / $50k / $100k / $500k or a custom threshold
  (≥ $10k) and require a computed notional. They are large *public
  executions*, not identifiable wallets: one order can fill as many prints.

## Limitations

- **One venue, one instrument.** Nothing here represents the whole market,
  other exchanges, or KuCoin's other instruments.
- **History starts when someone watches.** There is no backfill; the server
  only knows trades received while a feed was open. A freshly opened feed shows
  partial windows for up to 15 minutes, and server restarts start over.
- **In memory.** Feeds, sessions and buffers are per process. Running several
  replicas gives each its own sessions and its own KuCoin connections.
- **Gaps are not recovered.** Trades missed during a reconnect are not fetched
  from REST (REST returns only the latest 100 trades).
- **Stale vs quiet.** A feed with no trade for 30 s (configurable) is marked
  *stale* even if the connection is healthy — KuCoin futures pairs can
  legitimately go quiet that long. After 5 quiet minutes the server
  re-subscribes that one symbol (unsubscribe + subscribe on the same socket)
  in case the subscription silently stopped; other feeds are untouched. A dead
  connection is caught separately by the ping/pong timeout.
- **Clock.** Trade time is KuCoin's match time; ages are computed against the
  server clock (the page corrects for browser clock skew).
- **Custom whale thresholds** below $10k are not offered (the server keeps
  large-trade history from $10k).

## Reliability limits (defaults)

| Setting | Default |
| --- | --- |
| Reconnect backoff | 1 s doubling to 60 s, equal jitter; reset after 60 s stable |
| Storm guard | ≤ 10 connection attempts per minute per market |
| Welcome / ack / pong timeouts | 10 s each |
| Trade batching to browsers | 250 ms; stats every 1 s; SSE heartbeat 15 s |
| Server buffers per feed | 2 000 trades, 20 000 dedup ids, 300 large trades, 120 minutes, ~16 min of seconds |
| Browser buffer | 5 000 trades, 500 large trades; table 100/200/500 rows |
| Viewers | 200 SSE clients (`KUCOIN_LIVE_TRADES_MAX_CLIENTS`); a client more than 2 MB behind is dropped |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KUCOIN_LIVE_TRADES_ENABLED` | `true` | `false` keeps the page but never opens a KuCoin socket (`/stream` → 503). |
| `KUCOIN_SPOT_WS_URL` | `wss://x-push-spot.kucoin.com` | Spot public WebSocket. |
| `KUCOIN_FUTURES_WS_URL` | `wss://x-push-futures.kucoin.com` | Futures public WebSocket. |
| `KUCOIN_REST_BASE_URL` | `https://api.kucoin.com` | Instrument metadata. |
| `KUCOIN_LIVE_TRADES_STALE_AFTER_MS` | `30000` | No-trade interval before a feed is marked stale. |
| `KUCOIN_LIVE_TRADES_MAX_CLIENTS` | `200` | Concurrent SSE viewers. |

The server needs outbound access to those three hosts. On Node 22+ the
built-in `WebSocket` is used; on older runtimes (`package.json` allows Node 18,
CI runs 20) the `ws` package is the fallback. Behind an outbound HTTP(S) proxy,
run Node ≥ 22.21 with `NODE_USE_ENV_PROXY=1` so the built-in `WebSocket` and
`fetch` honour `HTTPS_PROXY` (the `ws` fallback does not read proxy variables). Any reverse
proxy in front of the app must not buffer `text/event-stream` (the stream sends
`X-Accel-Buffering: no`).

## Testing

```bash
npm test                                         # includes the suites below
node --test test/kucoin-live-trades-*.test.js
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome node --test test/kucoin-live-trades-ui.test.js
node scripts/kucoin-live-trades-smoke.js --all   # live, needs KuCoin access
node scripts/kucoin-live-trades-smoke.js --keepalive --market futures
```

Automated tests use a deterministic mock KuCoin socket
(`test/helpers/kucoin-mock-websocket.js`) that sends binary frames with raw
19-digit timestamps. The browser test drives the real page, service and router
on desktop and an iPhone 13 profile; it is skipped when no Chromium is
available.

## Production smoke-test checklist

After deploying (with approval):

1. `GET /api/kucoin-live-trades/status` → `"running": true`, both sockets `idle`.
2. `GET /api/kucoin-live-trades/symbols` → `BTC-USDT`, `ETH-USDT`, `SOL-USDT`; `XBTUSDTM` 0.001, `ETHUSDTM` 0.01, `SOLUSDTM` 0.1; `missing: []`.
3. Open the page (log in). Pill turns **Live** within a few seconds; rows appear newest first; *Last trade* age stays under a few seconds for BTC.
4. Switch to **Futures**: symbol shows `XBTUSDTM · 1 contract = 0.001 BTC`, quantity header says *contracts*, value ≈ price × contracts × 0.001.
5. Switch pair to ETH and SOL on both markets.
6. Compare a handful of prints against KuCoin's own trade history for the pair (time, price, size, side).
7. **Pause display**: rows stop moving, the banner counts new trades, the connection pill stays **Live**. Resume catches up.
8. Set *Min value* to 10 000 and pick each whale threshold; export both CSVs.
9. 1m / 5m / 15m: windows read *partial* until enough history exists, then *fully populated*.
10. Open the page in a second tab: `/status` shows 2 clients and still one subscription per symbol.
11. Close all tabs: after ~30 s `/status` shows the feed gone and the socket `idle`.
12. On a phone: no sideways scroll, table readable, controls tappable.
13. `node scripts/kucoin-live-trades-smoke.js --all` from a machine that can reach KuCoin.
