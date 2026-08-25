"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildRecoveryPlan, journalPositionIds, parseArgs } = require("../scripts/plan-learning-journal-recovery");

const BASE = "https://dashboard.example";

test("the dry-run planner joins executions by stable position id and keeps signal statuses separate", () => {
  const accounts = [{ id: "mindset_v1" }, { id: "smc_v1" }];
  const details = new Map([
    ["mindset_v1", { openPositions: [{ id: "P1", symbol: "BTC", openedAt: "2026-08-20T00:00:00Z" }], history: [] }],
    ["smc_v1", { openPositions: [], history: [{ id: "P2", symbol: "ETH", closedAt: "2026-08-21T00:00:00Z" }] }],
  ]);
  const actions = [
    { id: "A1", status: "blocked", symbol: "BTC", direction: "LONG", strategy: "signal-bot:4h" },
    { id: "A2", status: "opened", symbol: "ETH", direction: "SHORT", strategy: "smc_v1" },
    { id: "A3", status: "skipped", symbol: "SOL", direction: "LONG" },
  ];
  const plan = buildRecoveryPlan({ accounts, details, actions, journalIds: new Set(["P1", "ORPHAN"]), baseUrl: BASE });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.writesPerformed, false);
  assert.deepEqual(plan.reconciliation, { matched: 1, missing: 1, orphan: 1 });
  assert.equal(plan.missing[0].positionId, "P2");
  assert.deepEqual(plan.signalActions.byStatus, { blocked: 1, opened: 1, skipped: 1 });
  assert.equal(plan.signalActions.incompleteAttribution, 1);
});

test("journal parsing is idempotent and only accepts Dashboard strategy-account evidence", () => {
  const row = (id, source) => JSON.stringify({
    source_refs: [{ path_or_url: source }],
    trade_state: { position_id: id },
  });
  const text = [
    row("P1", `${BASE}/api/trading-lab/strategy-accounts/mindset_v1`),
    row("P1", `${BASE}/api/trading-lab/strategy-accounts/mindset_v1`),
    row("LOCAL", "C:/paper/history.json"),
  ].join("\n");
  assert.deepEqual([...journalPositionIds(text, BASE)], ["P1"]);
});

test("the CLI requires only a base URL and journal path", () => {
  assert.deepEqual(parseArgs(["--base-url", BASE, "--journal", "journal.jsonl"]), {
    "base-url": BASE,
    journal: "journal.jsonl",
  });
  assert.throws(() => parseArgs(["--base-url", BASE]), /Usage/);
});
