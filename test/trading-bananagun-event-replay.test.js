"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { replayBananaGunEvents, loadEventDataset } = require("../src/services/trading/bananagun-event-replay");

function candidate(overrides = {}) {
  return {
    id: "event-1",
    symbol: "BANANA",
    chain: "ethereum",
    token_address: "0xbanana",
    observed_at: "2026-08-12T10:00:30Z",
    signal_timestamp: "2026-08-12T10:00:00Z",
    entry_price_usd: 0.001,
    confluence_score: 82,
    position_usd: 100,
    liquidity_usd: 120000,
    top_holder_pct: 12,
    token_age_minutes: 45,
    honeypot: false,
    sellable: true,
    buy_tax_pct: 2,
    sell_tax_pct: 2,
    contract_risk_score: 20,
    outcome: {
      exit_timestamp: "2026-08-12T10:10:00Z",
      exit_price_usd: 0.0019,
      failed_txs: 1,
    },
    ...overrides,
  };
}

test("fixture event replay produces closed trades with conservative on-chain costs", () => {
  const result = replayBananaGunEvents({ events: [candidate()], dataSource: "fixture" });

  assert.equal(result.status, "ok");
  assert.equal(result.replayType, "event-replay");
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.strategy, "shadow_bananagun_v1");
  assert.ok(trade.costModel.buyCostUsd > 0);
  assert.ok(trade.costModel.sellCostUsd > 0);
  assert.ok(trade.costModel.failedTxCostUsd > 0);
  assert.ok(trade.realizedPnl < 90, "costs must reduce a 90 USD gross move");
});

test("event replay rejects safety snapshots observed after the signal", () => {
  const result = replayBananaGunEvents({
    events: [candidate({ safety: { observed_at: "2026-08-12T10:01:00Z" } })],
    dataSource: "fixture",
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.skipped[0].reasons.includes("safety snapshot is after the signal"), true);
});

test("safety gates, stale events and duplicates are rejected", () => {
  const result = replayBananaGunEvents({
    events: [
      candidate({ id: "low-liq", token_address: "0x1", liquidity_usd: 1 }),
      candidate({ id: "stale", token_address: "0x2", observed_at: "2026-08-12T10:10:00Z" }),
      candidate({ id: "dup-a", token_address: "0x3" }),
      candidate({ id: "dup-b", token_address: "0x3", observed_at: "2026-08-12T10:01:00Z" }),
    ],
    dataSource: "fixture",
  });

  assert.equal(result.trades.length, 1);
  const rejected = result.skipped.flatMap((row) => row.reasons);
  assert.ok(rejected.includes("liquidity below minimum"));
  assert.ok(rejected.includes("stale signal"));
  assert.ok(rejected.includes("duplicate candidate"));
});

test("production loader reports insufficient data when no candidate dataset exists", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "md-bg-empty-"));
  const dataset = loadEventDataset(root);

  assert.equal(dataset.status, "insufficient-data");
  assert.equal(dataset.events.length, 0);
});

test("event replay module has no wallet, signing or live order path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "trading", "bananagun-event-replay.js"), "utf8").toLowerCase();
  for (const forbidden of ["place_order", "wallet", "sign_transaction", "private_key", "banana_gun_api", "bananagun_api"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in event replay`);
  }
});
