"use strict";

// Futures markets the Cross-Market Open Interest page can compare.
//
// Each entry is one CFTC contract market, identified by its CFTC contract
// market code — the stable key in the Commitments of Traders reports, which
// survives the exchange renaming a contract. `symbol` is the dashboard's short
// label; `marketName` and `exchange` are display text only.
//
// `daily` is where the Daily timeframe reads the market: a Databento dataset
// and the product's parent symbol, so open interest is summed across every
// listed expiry — the same "all futures" total the weekly CFTC figure uses.
//
// `roll` names how the most-traded contract rolls. Quarterly contracts (index,
// rates, FX, DXY) routinely lose or gain a large share of open interest in the
// weeks around the March/June/September/December expiry, and the page flags a
// big change inside that window rather than reading it as positioning.

const ASSET_CLASSES = Object.freeze([
  { key: "indexes", label: "Indexes" },
  { key: "fx", label: "FX" },
  { key: "metals", label: "Metals" },
  { key: "energy", label: "Energy" },
  { key: "rates", label: "Rates" },
  { key: "crypto", label: "Crypto" },
]);

const INSTRUMENTS = Object.freeze([
  { id: "btc-cme", symbol: "BTC", marketName: "Bitcoin", exchange: "CME", assetClass: "crypto", contract: "133741", roll: "monthly", daily: { dataset: "GLBX.MDP3", parent: "BTC.FUT" } },
  { id: "dxy-ice", symbol: "DXY", marketName: "U.S. Dollar Index", exchange: "ICE", assetClass: "fx", contract: "098662", roll: "quarterly", daily: { dataset: "IFUS.IMPACT", parent: "DX.FUT" } },
  { id: "gold-comex", symbol: "GC", marketName: "Gold", exchange: "COMEX", assetClass: "metals", contract: "088691", roll: "bimonthly", daily: { dataset: "GLBX.MDP3", parent: "GC.FUT" } },
  { id: "natgas-nymex", symbol: "NG", marketName: "Natural Gas", exchange: "NYMEX", assetClass: "energy", contract: "023651", roll: "monthly", daily: { dataset: "GLBX.MDP3", parent: "NG.FUT" } },
  { id: "sp500-cme", symbol: "ES", marketName: "E-mini S&P 500", exchange: "CME", assetClass: "indexes", contract: "13874A", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "ES.FUT" } },
  { id: "rty-cme", symbol: "RTY", marketName: "E-mini Russell 2000", exchange: "CME", assetClass: "indexes", contract: "239742", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "RTY.FUT" } },
  { id: "nq-cme", symbol: "NQ", marketName: "E-mini Nasdaq-100", exchange: "CME", assetClass: "indexes", contract: "209742", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "NQ.FUT" } },
  { id: "eth-cme", symbol: "ETH", marketName: "Ether", exchange: "CME", assetClass: "crypto", contract: "146021", roll: "monthly", daily: { dataset: "GLBX.MDP3", parent: "ETH.FUT" } },
  { id: "eur-cme", symbol: "6E", marketName: "Euro FX", exchange: "CME", assetClass: "fx", contract: "099741", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "6E.FUT" } },
  { id: "jpy-cme", symbol: "6J", marketName: "Japanese Yen", exchange: "CME", assetClass: "fx", contract: "097741", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "6J.FUT" } },
  { id: "silver-comex", symbol: "SI", marketName: "Silver", exchange: "COMEX", assetClass: "metals", contract: "084691", roll: "bimonthly", daily: { dataset: "GLBX.MDP3", parent: "SI.FUT" } },
  { id: "copper-comex", symbol: "HG", marketName: "Copper", exchange: "COMEX", assetClass: "metals", contract: "085692", roll: "bimonthly", daily: { dataset: "GLBX.MDP3", parent: "HG.FUT" } },
  { id: "wti-nymex", symbol: "CL", marketName: "WTI Crude Oil", exchange: "NYMEX", assetClass: "energy", contract: "067651", roll: "monthly", daily: { dataset: "GLBX.MDP3", parent: "CL.FUT" } },
  { id: "zn-cbot", symbol: "ZN", marketName: "10-Year T-Note", exchange: "CBOT", assetClass: "rates", contract: "043602", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "ZN.FUT" } },
  { id: "zt-cbot", symbol: "ZT", marketName: "2-Year T-Note", exchange: "CBOT", assetClass: "rates", contract: "042601", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "ZT.FUT" } },
  { id: "zb-cbot", symbol: "ZB", marketName: "U.S. Treasury Bond", exchange: "CBOT", assetClass: "rates", contract: "020601", roll: "quarterly", daily: { dataset: "GLBX.MDP3", parent: "ZB.FUT" } },
]);

// The comparison the reference screenshot shows, in its order.
const DEFAULT_SELECTION = Object.freeze(["btc-cme", "dxy-ice", "gold-comex", "natgas-nymex", "sp500-cme", "rty-cme"]);

// A comparison is read as one shape, so it stays small: the reference plots
// six markets, and past eight the polygon stops being legible.
const MIN_SELECTION = 3;
const MAX_SELECTION = 8;

module.exports = { ASSET_CLASSES, INSTRUMENTS, DEFAULT_SELECTION, MIN_SELECTION, MAX_SELECTION };
