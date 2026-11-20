"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMessage,
  normalizeTrade,
  toNanoseconds,
  multiplyDecimal,
  decodeFrame,
} = require("../src/services/kucoin-live-trades/normalizer");
const { spotTradeFrame, futuresTradeFrame, INSTRUMENTS } = require("./helpers/kucoin-mock-websocket");

const bin = (text) => Buffer.from(text, "utf8");

test("binary frames decode to text in every shape the WebSocket can hand over", () => {
  const text = '{"message":"welcome"}';
  assert.equal(decodeFrame(text), text);
  assert.equal(decodeFrame(bin(text)), text);
  const ab = new TextEncoder().encode(text).buffer;
  assert.equal(decodeFrame(ab), text);
  assert.equal(decodeFrame(new Uint8Array(ab)), text);
});

test("welcome, pong, ack and error frames are classified per the documented protocol", () => {
  const welcome = parseMessage(bin('{"sessionId":"2f63","message":"welcome","pingInterval":18000}'));
  assert.deepEqual(welcome, { kind: "welcome", sessionId: "2f63", pingInterval: 18000, pingTimeout: null });

  const pong = parseMessage(bin('{"op":"pong","id": "p1", "ts": 1795157002263271386}'));
  assert.equal(pong.kind, "pong");
  assert.equal(pong.id, "p1");
  assert.equal(pong.serverTime, "1795157002263271386", "nanosecond server time is not rounded");

  // The live feed acks with a boolean; the docs show the string "true".
  assert.deepEqual(parseMessage('{"id":"sub1","result":true}'), { kind: "ack", id: "sub1", ok: true, message: null, code: null });
  assert.equal(parseMessage('{"id":"sub1","result":"true"}').ok, true);
  const rejected = parseMessage('{"id":"sub2","result":false,"message":"symbol not exists"}');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.message, "symbol not exists");

  assert.equal(parseMessage('{"code":"400100","msg":"bad request"}').kind, "error");
  assert.equal(parseMessage("not json").kind, "invalid");
  assert.equal(parseMessage("[1,2]").kind, "invalid");
});

test("trade frames keep nanosecond timestamps and 17-digit ids exact", () => {
  const msg = parseMessage(bin(spotTradeFrame()));
  assert.equal(msg.kind, "trade");
  assert.equal(msg.tradeType, "SPOT");
  assert.equal(msg.marketType, "spot");
  assert.equal(msg.pushTimeNs, "1795157002409118287");
  assert.equal(msg.data.M, "1795157002407000000");
  assert.equal(msg.data.E, "25376143998074880");
  // Proof the quoting matters: a plain JSON.parse rounds the odd 19-digit value.
  assert.notEqual(BigInt(JSON.parse(spotTradeFrame()).P), 1795157002409118287n);
  const odd = parseMessage(spotTradeFrame({ id: "25376143998074881" }));
  assert.equal(odd.data.E, "25376143998074881");
  assert.notEqual(String(JSON.parse(spotTradeFrame({ id: "25376143998074881" })).d.E), "25376143998074881");
  assert.equal(msg.data.ti, "25376143998074880");
});

test("spot trades normalize to base quantity and price × quantity notional", () => {
  const msg = parseMessage(spotTradeFrame({ price: "92525.6", qty: "0.00008036", side: "sell" }));
  const result = normalizeTrade(msg.data, { marketType: "spot", instrument: INSTRUMENTS.spot.BTC, pushTimeNs: msg.pushTimeNs, receivedAt: 123 });
  assert.equal(result.ok, true);
  const t = result.trade;
  assert.equal(t.exchange, "kucoin");
  assert.equal(t.marketType, "spot");
  assert.equal(t.symbol, "BTC-USDT");
  assert.equal(t.tradeId, "25376143998074880");
  assert.equal(t.price, 92525.6);
  assert.equal(t.quantity, 0.00008036);
  assert.equal(t.quantityUnit, "BTC");
  assert.equal(t.baseQuantity, 0.00008036);
  assert.equal(t.notional, 7.435357216);
  assert.equal(t.notionalCurrency, "USDT");
  assert.equal(t.side, "sell");
  assert.equal(t.aggressor, "seller");
  assert.equal(t.sideVerified, true);
  assert.equal(t.exchangeTimeNs, "1795157002407000000");
  assert.equal(t.exchangeTimeMs, 1795157002407);
  assert.equal(t.pushTimeNs, "1795157002409118287");
  assert.equal(t.receivedAt, 123);
});

test("futures contracts are converted with the exchange multiplier, never read as coins", () => {
  for (const [asset, qty, price, base, notional] of [
    ["BTC", "3", "61685.4", 0.003, 185.0562],
    ["ETH", "100", "1749.09", 1, 1749.09],
    ["SOL", "232", "72.749", 23.2, 1687.7768],
  ]) {
    const instrument = INSTRUMENTS.futures[asset];
    const msg = parseMessage(futuresTradeFrame({ symbol: instrument.symbol, qty, price }));
    const { ok, trade } = normalizeTrade(msg.data, { marketType: "futures", instrument });
    assert.equal(ok, true, asset);
    assert.equal(trade.quantity, Number(qty), `${asset} keeps the contract count`);
    assert.equal(trade.quantityUnit, "contracts");
    assert.equal(trade.baseQuantity, base, `${asset} base quantity`);
    assert.equal(trade.notional, notional, `${asset} notional is exact`);
    assert.notEqual(trade.baseQuantity, trade.quantity);
  }
});

test("futures notional is withheld rather than guessed without a usable multiplier", () => {
  const msg = parseMessage(futuresTradeFrame());
  const noMultiplier = { ...INSTRUMENTS.futures.BTC, multiplier: null, multiplierText: null };
  let r = normalizeTrade(msg.data, { marketType: "futures", instrument: noMultiplier });
  assert.equal(r.ok, true);
  assert.equal(r.trade.notional, null);
  assert.equal(r.trade.baseQuantity, null);
  assert.match(r.trade.notionalReason, /multiplier/);

  r = normalizeTrade(msg.data, { marketType: "futures", instrument: { ...INSTRUMENTS.futures.BTC, isInverse: true } });
  assert.equal(r.trade.notional, null);
  assert.match(r.trade.notionalReason, /inverse/);
});

test("invalid executions are rejected with a reason", () => {
  const instrument = INSTRUMENTS.spot.BTC;
  const base = parseMessage(spotTradeFrame()).data;
  const cases = [
    [{ ...base, p: "0" }, /price/],
    [{ ...base, p: "-5" }, /price/],
    [{ ...base, p: "abc" }, /price/],
    [{ ...base, q: "0" }, /quantity/],
    [{ ...base, q: null }, /quantity/],
    [{ ...base, S: "hold" }, /side/],
    [{ ...base, s: "ETH-USDT" }, /does not match/],
    [{ ...base, s: undefined }, /symbol/],
    [{ ...base, ti: undefined, E: undefined }, /trade id/],
    [{ ...base, ti: undefined, E: 25376143998074880 }, /unsafe/],
    [{ ...base, M: "abc" }, /time/],
    [{ ...base, M: "12" }, /time/],
  ];
  for (const [data, reason] of cases) {
    const r = normalizeTrade(data, { marketType: "spot", instrument });
    assert.equal(r.ok, false, JSON.stringify(data));
    assert.match(r.reason, reason);
  }
  assert.equal(normalizeTrade(null, { marketType: "spot", instrument }).ok, false);
  assert.equal(normalizeTrade(base, { marketType: "spot", instrument: null }).ok, false);
  assert.equal(normalizeTrade(base, { marketType: "futures", instrument }).ok, false, "instrument market must match");
});

test("timestamps of any unit normalize to exact nanoseconds", () => {
  assert.equal(toNanoseconds("1795157002407000000"), 1795157002407000000n);
  assert.equal(toNanoseconds("1795157002407123456"), 1795157002407123456n);
  assert.equal(toNanoseconds("1795157002407"), 1795157002407000000n);
  assert.equal(toNanoseconds(1795157002407), 1795157002407000000n);
  assert.equal(toNanoseconds("1795157002407123"), 1795157002407123000n);
  assert.equal(toNanoseconds("1795157002"), 1795157002000000000n);
  assert.equal(toNanoseconds("99"), null, "implausible dates are rejected");
  assert.equal(toNanoseconds("-1795157002407"), null);
  assert.equal(toNanoseconds(1.5e18), null, "unsafe numbers are refused");
});

test("decimal products are exact", () => {
  assert.equal(multiplyDecimal("232", "0.1"), "23.2");
  assert.equal(multiplyDecimal("72.749", "23.2"), "1687.7768");
  assert.equal(multiplyDecimal("3", "0.001"), "0.003");
  assert.equal(multiplyDecimal("0.5", "2"), "1");
  assert.equal(multiplyDecimal("1e3", "2"), null);
});
