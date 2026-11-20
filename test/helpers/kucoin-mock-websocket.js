"use strict";

// Deterministic stand-in for KuCoin's public WebSocket (x-push-spot /
// x-push-futures). Frames are delivered as binary Buffers, like the live feed,
// and trade frames are written as raw JSON text so the 19-digit nanosecond
// timestamps and 17-digit spot execution ids reach the parser unrounded.

class MockKucoinWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.binaryType = "blob";
    this.closedByClient = false;
    MockKucoinWebSocket.instances.push(this);
  }

  static reset() {
    MockKucoinWebSocket.instances = [];
  }

  static latest() {
    return MockKucoinWebSocket.instances[MockKucoinWebSocket.instances.length - 1];
  }

  /** Server side: accept the connection and send the documented welcome. */
  welcome({ pingInterval = 18000, sessionId = "mock-session" } = {}) {
    this.readyState = 1;
    this.receive({ sessionId, message: "welcome", pingInterval });
  }

  receive(message) {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    if (this.onmessage) this.onmessage({ data: Buffer.from(text, "utf8") });
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(JSON.parse(text));
  }

  subscriptions(action = "subscribe") {
    return this.sent.filter((m) => m.action === action);
  }

  /** Acknowledges every subscribe request not yet acknowledged. */
  ackAll({ result = true } = {}) {
    this.acked = this.acked || new Set();
    for (const msg of this.sent) {
      if (msg.action !== "subscribe" || this.acked.has(msg.id)) continue;
      this.acked.add(msg.id);
      this.receive({ id: msg.id, result });
    }
  }

  pong() {
    const ping = [...this.sent].reverse().find((m) => m.op === "ping");
    this.receive(`{"op":"pong","id":"${ping ? ping.id : "x"}","ts":1795157002263271386}`);
  }

  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }

  /** Server side: drop the connection. */
  serverClose(code = 1006, reason = "") {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}
MockKucoinWebSocket.instances = [];

function spotTradeFrame({ symbol = "BTC-USDT", id = "25376143998074880", price = "61718.8", qty = "0.00048537", side = "buy", timeNs = "1795157002407000000", pushNs = "1795157002409118287" } = {}) {
  return `{"T":"trade.SPOT", "P":${pushNs}, "d":{"E":${id},"M":${timeNs},"S":"${side}","p":"${price}","q":"${qty}","s":"${symbol}","ti":"${id}"}}`;
}

function futuresTradeFrame({ symbol = "XBTUSDTM", id = "1956223171570", price = "61685.4", qty = "3", side = "buy", timeNs = "1795157007197000000", pushNs = "1795157007202794623" } = {}) {
  return `{"T":"trade.FUTURES", "P":${pushNs}, "d":{"p":"${price}","q":"${qty}","s":"${symbol}","S":"${side}","E":${id},"ti":"${id}","rpi":false,"M":${timeNs}}}`;
}

const INSTRUMENTS = {
  spot: {
    BTC: { marketType: "spot", asset: "BTC", symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT", multiplier: 1, multiplierText: "1", quantityUnit: "BTC", tickSize: "0.1", isInverse: false },
    ETH: { marketType: "spot", asset: "ETH", symbol: "ETH-USDT", baseCurrency: "ETH", quoteCurrency: "USDT", multiplier: 1, multiplierText: "1", quantityUnit: "ETH", tickSize: "0.01", isInverse: false },
    SOL: { marketType: "spot", asset: "SOL", symbol: "SOL-USDT", baseCurrency: "SOL", quoteCurrency: "USDT", multiplier: 1, multiplierText: "1", quantityUnit: "SOL", tickSize: "0.01", isInverse: false },
  },
  futures: {
    BTC: { marketType: "futures", asset: "BTC", symbol: "XBTUSDTM", baseCurrency: "XBT", quoteCurrency: "USDT", settlementCurrency: "USDT", multiplier: 0.001, multiplierText: "0.001", quantityUnit: "contracts", tickSize: "0.1", isInverse: false },
    ETH: { marketType: "futures", asset: "ETH", symbol: "ETHUSDTM", baseCurrency: "ETH", quoteCurrency: "USDT", settlementCurrency: "USDT", multiplier: 0.01, multiplierText: "0.01", quantityUnit: "contracts", tickSize: "0.01", isInverse: false },
    SOL: { marketType: "futures", asset: "SOL", symbol: "SOLUSDTM", baseCurrency: "SOL", quoteCurrency: "USDT", settlementCurrency: "USDT", multiplier: 0.1, multiplierText: "0.1", quantityUnit: "contracts", tickSize: "0.001", isInverse: false },
  },
};

/** Instrument registry stub with the shape KucoinInstrumentRegistry exposes. */
function stubInstruments(resolved = INSTRUMENTS) {
  return {
    async load() { return { ...resolved, missing: [], fetchedAt: 0 }; },
    async get(marketType, asset) {
      const item = resolved[marketType] && resolved[marketType][asset];
      if (!item) {
        const err = new Error(`no ${marketType} ${asset}`);
        err.statusCode = 404;
        throw err;
      }
      return item;
    },
    status() { return { loaded: true }; },
  };
}

module.exports = { MockKucoinWebSocket, spotTradeFrame, futuresTradeFrame, INSTRUMENTS, stubInstruments };
