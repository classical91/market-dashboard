"use strict";

function isUsablePrice(price) {
  return Number.isFinite(Number(price)) && Number(price) > 0;
}

function replayOrderForPositions(positions = [], bar = {}) {
  const open = positions.filter((p) => p && p.status === "open");
  const hasLong = open.some((p) => p.direction === "LONG");
  const hasShort = open.some((p) => p.direction === "SHORT");
  const adverseIsLow = hasLong || !hasShort;
  const extremes = adverseIsLow ? [bar.low, bar.high] : [bar.high, bar.low];
  const prices = [bar.open, ...extremes, bar.close].filter(isUsablePrice).map(Number);
  return { prices, mixed: hasLong && hasShort };
}

function replayOrder(trader, bar) {
  return replayOrderForPositions(trader.getOpenPositions(), bar);
}

module.exports = { replayOrder, replayOrderForPositions };
