"use strict";

// The registry says what a strategy IS, never what it is allowed to do.
// These tests pin that distinction, because the failure mode they guard
// against — a strategy quietly becoming live-eligible by existing — is the one
// that costs real money.

const test = require("node:test");
const assert = require("node:assert");

const {
  LIFECYCLE_STATUSES,
  listStrategies,
  describe: describeById,
  describeStrategy,
  computeLiveEligible,
} = require("../src/services/trading/strategies");
const { assertValidLifecycle } = require("../src/services/trading/strategies/lifecycle");

test("the lifecycle vocabulary is the documented one", () => {
  assert.deepEqual(LIFECYCLE_STATUSES, [
    "experimental",
    "backtest",
    "validated",
    "forward-paper",
    "live-eligible",
    "retired",
  ]);
});

test("every registered strategy carries complete lifecycle metadata", () => {
  const strategies = listStrategies();
  assert.ok(strategies.length >= 2);

  for (const s of strategies) {
    for (const field of ["id", "name", "version", "description", "status"]) {
      assert.equal(typeof s[field], "string", `${s.id}.${field} must be a string`);
      assert.ok(s[field].length > 0, `${s.id}.${field} must not be empty`);
    }
    for (const field of ["supportsBacktest", "supportsLiveScanner", "liveEligible"]) {
      assert.equal(typeof s[field], "boolean", `${s.id}.${field} must be a boolean`);
    }
    assert.ok(LIFECYCLE_STATUSES.includes(s.status), `${s.id} has an unknown status`);
    assert.ok(s.requiredWarmupBars > 0);
  }
});

test("mindset_v1 is the forward-paper scanner strategy, and is not live-eligible", () => {
  const mindset = describeById("mindset_v1");
  assert.equal(mindset.status, "forward-paper");
  assert.equal(mindset.supportsBacktest, true);
  assert.equal(mindset.supportsLiveScanner, true);
  // Running forward on a paper ledger is not approval to trade real money.
  assert.equal(mindset.liveEligible, false);
  assert.equal(mindset.version, "1.0.0");
});

test("smc_v1 stays backtest-only", () => {
  const smc = describeById("smc_v1");
  assert.equal(smc.status, "backtest");
  assert.equal(smc.supportsBacktest, true);
  assert.equal(smc.supportsLiveScanner, false);
  assert.equal(smc.liveEligible, false);
});

test("nothing is live-eligible yet", () => {
  assert.deepEqual(listStrategies({ liveEligible: true }), []);
});

test("existing in the registry does not confer eligibility — status and capability must BOTH agree", () => {
  const base = { id: "x", name: "X", version: "0.1.0", description: "d", requiredWarmupBars: 1 };

  // Capability without the lifecycle having got there.
  assert.equal(
    computeLiveEligible({ ...base, status: "forward-paper", supportsLiveScanner: true, supportsBacktest: true }),
    false,
  );
  // Lifecycle there, but the strategy cannot run in the scanner.
  assert.equal(
    computeLiveEligible({ ...base, status: "live-eligible", supportsLiveScanner: false, supportsBacktest: true }),
    false,
  );
  // Both.
  assert.equal(
    computeLiveEligible({ ...base, status: "live-eligible", supportsLiveScanner: true, supportsBacktest: true }),
    true,
  );
});

test("a strategy cannot self-certify as live-eligible", () => {
  const rogue = {
    id: "rogue_v1",
    name: "Rogue",
    version: "1.0.0",
    description: "claims to be ready",
    status: "backtest",
    supportsBacktest: true,
    supportsLiveScanner: false,
    liveEligible: true, // ignored — eligibility is computed, never declared
    requiredWarmupBars: 10,
  };
  assert.equal(describeStrategy(rogue).liveEligible, false);
});

test("registration rejects a strategy with a bad status or no version", () => {
  const ok = {
    id: "ok_v1",
    name: "OK",
    version: "1.0.0",
    description: "d",
    status: "backtest",
    supportsBacktest: true,
    supportsLiveScanner: false,
    requiredWarmupBars: 5,
  };
  assert.doesNotThrow(() => assertValidLifecycle(ok));
  assert.throws(() => assertValidLifecycle({ ...ok, status: "totally-ready" }), /expected one of/);
  assert.throws(() => assertValidLifecycle({ ...ok, version: undefined }), /must declare a version/);
  assert.throws(() => assertValidLifecycle({ ...ok, supportsLiveScanner: "yes" }), /must declare supportsBacktest/);
});

// The live scanner keeps its own strategy table (it must — it resolves a name
// from an env var at construction). This asserts the two never disagree, which
// is what stops a backtest-only strategy from being reachable by
// LIVE_SCANNER_STRATEGY.
test("the live scanner only wires up strategies the registry says may run live", () => {
  const source = require("fs").readFileSync(
    require.resolve("../src/services/trading/live-scanner.js"),
    "utf8",
  );
  const match = source.match(/const STRATEGIES = \{([^}]*)\}/);
  assert.ok(match, "expected the live scanner to declare a STRATEGIES map");

  const wired = match[1]
    .split(",")
    .map((entry) => entry.split(":")[0].trim())
    .filter(Boolean);

  assert.deepEqual(wired, ["mindset_v1"]);
  for (const id of wired) {
    assert.equal(describeById(id).supportsLiveScanner, true, `${id} is wired live but not marked for it`);
  }
  // And the converse: smc_v1 is not reachable from the scanner at all.
  assert.ok(!wired.includes("smc_v1"));
});
