"use strict";

// KuCoin UTA WebSocket V2 (wss://x-push-spot.kucoin.com and
// wss://x-push-futures.kucoin.com) message parsing and trade normalization.
//
// Two things in the raw frames cannot go through a plain JSON.parse:
//
// - `P` (push time) and `M` (match time) are nanosecond epoch integers
//   (~1.8e18), and spot `E` is a 17-digit execution id. All three are larger
//   than Number.MAX_SAFE_INTEGER, so JSON.parse would silently round them.
//   They are quoted before parsing so they survive as exact strings.
// - Frames arrive as binary WebSocket messages carrying UTF-8 JSON text.
//
// Side semantics: KuCoin documents the trade `side` as the *taker* order side
// ("Filled side, indicates the taker order side" — Get Trades, UTA REST V2 and
// Classic Get Trade History). A "buy" trade is therefore an aggressive buy that
// lifted the ask, which is what buy/sell pressure needs. The live smoke test
// (scripts/kucoin-live-trades-smoke.js) re-checks this against REST history.

const MARKET_TYPES = Object.freeze(["spot", "futures"]);
const TRADE_TYPE_BY_MARKET = Object.freeze({ spot: "SPOT", futures: "FUTURES" });
const MARKET_BY_TRADE_TYPE = Object.freeze({ SPOT: "spot", FUTURES: "futures" });

// Keys whose values can exceed 2^53 in KuCoin frames.
const BIG_INT_KEYS = /("(?:P|M|E|ts|timestamp)"\s*:\s*)(-?\d{16,})/g;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const INTEGER = /^\d+$/;

// Plausible exchange clock range, in nanoseconds: 2017-01-01 .. 2100-01-01.
const MIN_TIME_NS = 1483228800000n * 1000000n;
const MAX_TIME_NS = 4102444800000n * 1000000n;

function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8");
  return String(data);
}

function safeParse(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text.replace(BIG_INT_KEYS, '$1"$2"'));
  } catch {
    return null;
  }
}

/**
 * Classifies one KuCoin public-channel frame.
 * Returns { kind, ... } where kind is welcome | pong | ack | trade | error | unknown | invalid.
 */
function parseMessage(raw) {
  const text = decodeFrame(raw);
  const msg = safeParse(text);
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { kind: "invalid", text };

  if (msg.message === "welcome" || msg.data === "welcome") {
    const pingInterval = Number(msg.pingInterval);
    const pingTimeout = Number(msg.pingTimeout);
    return {
      kind: "welcome",
      sessionId: msg.sessionId ? String(msg.sessionId) : null,
      pingInterval: Number.isFinite(pingInterval) && pingInterval > 0 ? pingInterval : null,
      pingTimeout: Number.isFinite(pingTimeout) && pingTimeout > 0 ? pingTimeout : null,
    };
  }
  if (msg.op === "pong" || msg.type === "pong") {
    return { kind: "pong", id: msg.id != null ? String(msg.id) : null, serverTime: msg.ts != null ? String(msg.ts) : null };
  }
  if (typeof msg.T === "string" && msg.T.startsWith("trade.")) {
    const tradeType = msg.T.slice("trade.".length).toUpperCase();
    return {
      kind: "trade",
      tradeType,
      marketType: MARKET_BY_TRADE_TYPE[tradeType] || null,
      pushTimeNs: msg.P != null ? String(msg.P) : null,
      data: msg.d && typeof msg.d === "object" ? msg.d : null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(msg, "result")) {
    // The docs show "result": "true"; the live feed sends a boolean.
    const ok = msg.result === true || msg.result === "true";
    return {
      kind: "ack",
      id: msg.id != null ? String(msg.id) : null,
      ok,
      message: ok ? null : String(msg.message || msg.msg || "subscription rejected"),
      code: msg.code != null ? String(msg.code) : null,
    };
  }
  if (msg.type === "error" || msg.code != null || msg.msg != null) {
    return {
      kind: "error",
      id: msg.id != null ? String(msg.id) : null,
      code: msg.code != null ? String(msg.code) : null,
      message: String(msg.msg || msg.message || msg.data || "error"),
    };
  }
  return { kind: "unknown", message: msg };
}

function toDecimal(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? { text: String(value), value } : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? { text, value: parsed } : null;
}

/**
 * Normalizes an epoch timestamp of unknown unit (s, ms, µs, ns) to an exact
 * nanosecond BigInt. KuCoin sends nanoseconds; magnitude detection keeps the
 * parser honest if a field ever arrives in another unit.
 */
function toNanoseconds(value) {
  if (value == null) return null;
  let text;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    text = String(value);
  } else text = String(value).trim();
  if (!INTEGER.test(text)) return null;
  let ns = BigInt(text);
  const digits = text.replace(/^0+/, "").length;
  if (digits <= 10) ns *= 1000000000n;
  else if (digits <= 13) ns *= 1000000n;
  else if (digits <= 16) ns *= 1000n;
  if (ns < MIN_TIME_NS || ns > MAX_TIME_NS) return null;
  return ns;
}

function splitDecimal(text) {
  const str = String(text);
  if (!/^\d+(?:\.\d+)?$/.test(str)) return null;
  const [whole, frac = ""] = str.split(".");
  return { digits: BigInt(whole + frac), scale: frac.length };
}

/**
 * Exact product of two plain decimal strings ("72.749" × "23.2"), returned as
 * a decimal string. Avoids float artefacts such as 232 × 0.1 = 23.200000000000003.
 * Returns null when either side is not a plain decimal (e.g. exponent form).
 */
function multiplyDecimal(a, b) {
  const x = splitDecimal(a);
  const y = splitDecimal(b);
  if (!x || !y) return null;
  const scale = x.scale + y.scale;
  let digits = (x.digits * y.digits).toString().padStart(scale + 1, "0");
  let text = scale ? `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}` : digits;
  if (scale) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text;
}

function product(a, b, fallback) {
  const exact = multiplyDecimal(a, b);
  return exact != null ? Number(exact) : fallback;
}

function nsToMs(ns) {
  return Number(ns / 1000000n);
}

function reject(reason) {
  return { ok: false, reason };
}

/**
 * Turns the `d` payload of a trade.SPOT / trade.FUTURES frame into the
 * dashboard's trade record. `instrument` comes from the instrument registry;
 * futures notional is only computed for linear, USDT-quoted contracts with a
 * known multiplier, and is otherwise null (never guessed).
 */
function normalizeTrade(data, { marketType, instrument, pushTimeNs = null, receivedAt = Date.now() } = {}) {
  if (!data || typeof data !== "object") return reject("missing trade payload");
  if (!MARKET_TYPES.includes(marketType)) return reject("unknown market type");
  if (!instrument || instrument.marketType !== marketType) return reject("no instrument metadata");

  const symbol = typeof data.s === "string" ? data.s : null;
  if (!symbol) return reject("missing symbol");
  if (symbol !== instrument.symbol) return reject(`symbol ${symbol} does not match ${instrument.symbol}`);

  const price = toDecimal(data.p);
  if (!price) return reject("invalid price");
  const quantity = toDecimal(data.q);
  if (!quantity) return reject("invalid quantity");

  const sideRaw = typeof data.S === "string" ? data.S.toLowerCase() : "";
  if (sideRaw !== "buy" && sideRaw !== "sell") return reject("invalid side");

  let tradeId = data.ti != null && data.ti !== "" ? data.ti : data.E;
  if (typeof tradeId === "number" && !Number.isSafeInteger(tradeId)) return reject("unsafe numeric trade id");
  tradeId = tradeId != null ? String(tradeId).trim() : "";
  if (!tradeId) return reject("missing trade id");

  const timeNs = toNanoseconds(data.M);
  if (timeNs == null) return reject("invalid trade time");

  let baseQuantity = null;
  let notional = null;
  let quantityUnit;
  let notionalReason = null;
  if (marketType === "spot") {
    quantityUnit = instrument.baseCurrency;
    baseQuantity = quantity.value;
    if (instrument.quoteCurrency === "USDT") notional = product(price.text, quantity.text, price.value * quantity.value);
    else notionalReason = `quote currency ${instrument.quoteCurrency} is not USDT`;
  } else {
    quantityUnit = "contracts";
    const multiplier = Number(instrument.multiplier);
    if (instrument.isInverse) notionalReason = "inverse contract";
    else if (!(Number.isFinite(multiplier) && multiplier > 0)) notionalReason = "missing contract multiplier";
    else if (instrument.quoteCurrency !== "USDT") notionalReason = `quote currency ${instrument.quoteCurrency} is not USDT`;
    else {
      const multiplierText = instrument.multiplierText != null ? String(instrument.multiplierText) : String(multiplier);
      const baseText = multiplyDecimal(quantity.text, multiplierText);
      baseQuantity = baseText != null ? Number(baseText) : quantity.value * multiplier;
      notional = baseText != null ? product(price.text, baseText, price.value * baseQuantity) : price.value * baseQuantity;
    }
  }
  if (notional != null && !(Number.isFinite(notional) && notional > 0)) {
    notional = null;
    notionalReason = "notional not finite";
  }

  const pushNs = toNanoseconds(pushTimeNs);
  return {
    ok: true,
    trade: {
      exchange: "kucoin",
      marketType,
      symbol,
      asset: instrument.asset,
      tradeId,
      price: price.value,
      priceText: price.text,
      quantity: quantity.value,
      quantityText: quantity.text,
      quantityUnit,
      baseQuantity,
      baseCurrency: instrument.asset,
      notional,
      notionalCurrency: notional != null ? "USDT" : null,
      notionalReason,
      side: sideRaw,
      // Taker (aggressor) direction, per KuCoin's documented side semantics.
      aggressor: sideRaw === "buy" ? "buyer" : "seller",
      sideVerified: true,
      exchangeTimeNs: timeNs.toString(),
      exchangeTimeMs: nsToMs(timeNs),
      pushTimeNs: pushNs != null ? pushNs.toString() : null,
      receivedAt,
      rpi: data.rpi === true,
    },
  };
}

module.exports = {
  MARKET_TYPES,
  TRADE_TYPE_BY_MARKET,
  MARKET_BY_TRADE_TYPE,
  decodeFrame,
  safeParse,
  parseMessage,
  normalizeTrade,
  toNanoseconds,
  nsToMs,
  multiplyDecimal,
};
