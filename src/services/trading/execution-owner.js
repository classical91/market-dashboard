"use strict";

// Persistent positions name the process that owns their lifecycle. Strategy
// identity answers "which account?"; execution ownership answers "which loop
// may mark or close it?". Keeping those separate prevents two experiments that
// share a strategy identity from silently managing each other's trades.
const EXECUTION_OWNERS = Object.freeze({
  LIVE_RESEARCH: "live-research",
  LIVE_SCANNER: "live-scanner",
  SIGNAL_BRIDGE: "signal-bridge",
  TRADING_LAB: "trading-lab",
  BACKTEST: "backtest",
});

function ownerFromSignalSource(signalSource) {
  const source = String(signalSource || "");
  if (source.startsWith("live-research:")) return EXECUTION_OWNERS.LIVE_RESEARCH;
  if (source.startsWith("live-scanner:")) return EXECUTION_OWNERS.LIVE_SCANNER;
  if (source.startsWith("signal-bot:")) return EXECUTION_OWNERS.SIGNAL_BRIDGE;
  if (source.startsWith("backtest:")) return EXECUTION_OWNERS.BACKTEST;
  return null;
}

function positionOwner(position) {
  const explicit = position && (position.executionOwner || position.meta?.executionOwner);
  return explicit ? String(explicit) : ownerFromSignalSource(position && position.signalSource);
}

function ownedBy(position, owner) {
  return positionOwner(position) === owner;
}

function signalBridgeMayManage(position) {
  const owner = positionOwner(position);
  return owner !== EXECUTION_OWNERS.LIVE_RESEARCH && owner !== EXECUTION_OWNERS.LIVE_SCANNER;
}

module.exports = {
  EXECUTION_OWNERS,
  ownerFromSignalSource,
  positionOwner,
  ownedBy,
  signalBridgeMayManage,
};
