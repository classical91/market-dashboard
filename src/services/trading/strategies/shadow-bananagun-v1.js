"use strict";

// Shadow Banana Gun cannot be replayed over OHLCV candles honestly. Its inputs
// are point-in-time on-chain candidate and safety snapshots, so the Trading Lab
// exposes it as event replay only and refuses production performance when those
// historical events are absent.

const shadowBananagunV1 = {
  id: "shadow_bananagun_v1",
  name: "Shadow Banana Gun v1",
  version: "1.0.0",
  status: "experimental",
  supportsBacktest: false,
  supportsEventReplay: true,
  supportsLiveScanner: false,
  supportsLiveResearch: false,
  requiredWarmupBars: 0,
  description:
    "Point-in-time memecoin candidate replay with safety snapshots and conservative gas, slippage, MEV and failed-transaction costs. Event replay only; candle backtests are refused.",
  // One or two lines of plain English, shown directly on the strategy account
  // card. Separate from `description` because that one is a full paragraph
  // written for a researcher reading the registry, and a card has room for a
  // sentence — the alternative was clipping the long text in the UI, which
  // reliably cuts a qualifying clause and leaves a confident half-sentence
  // that misdescribes the strategy.
  //
  // Lives here, beside the rules it summarises, so it is reviewed in the same
  // diff as a change to what the strategy actually does. A description held in
  // the dashboard instead would drift the moment the rules moved.
  shortDescription:
    "Event-driven on-chain strategy using candidate, liquidity, safety and transaction-cost data. Not candle-based.",
  datasetAvailability: {
    mode: "event-replay",
    required:
      "Historical JSON/JSONL candidate snapshots under data/trading-lab/event-replay/shadow_bananagun_v1/candidates.jsonl",
    productionStatus: "insufficient-data-until-snapshots-exist",
  },
  describeRules() {
    return {
      purpose: "Point-in-time on-chain candidate and safety event replay",
      looksFor: "Candidate, liquidity, safety, gas, slippage, MEV and failed-transaction snapshots",
      longEntry: "Unavailable until a live on-chain candidate and safety feed exists",
      shortEntry: "Not applicable",
      trendFilter: "Not candle based",
      stop: "Defined by the event-replay contract, not OHLCV candles",
      target: "Defined by the event-replay contract, not OHLCV candles",
      positionSizing: "Unavailable for live demo until the required event feed exists",
    };
  },
};

module.exports = { shadowBananagunV1 };
