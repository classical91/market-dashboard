"use strict";

// The registry says what a strategy IS. Two separate questions follow from
// that, and conflating them is the failure this file exists to prevent:
//
//   scannerEligible    may the live scanner run it forward on PAPER?
//   realMoneyEligible  has it completed validation such that real money could
//                      later be approved?
//
// mindset_v1 is the first and not the second. Nothing is the second.

const test = require("node:test");
const assert = require("node:assert");

const {
  LIFECYCLE_STATUSES,
  SCANNER_STATUSES,
  listStrategies,
  describe: describeById,
  describeStrategy,
  computeScannerEligible,
  computeRealMoneyEligible,
  getScannerStrategy,
} = require("../src/services/trading/strategies");
const { assertValidLifecycle } = require("../src/services/trading/strategies/lifecycle");
const { LiveScannerService } = require("../src/services/trading/live-scanner");

/* ── Vocabulary ───────────────────────────────────────────── */

test("the lifecycle vocabulary is the documented one", () => {
  assert.deepEqual(LIFECYCLE_STATUSES, [
    "experimental",
    "backtest",
    "validated",
    "forward-paper",
    "real-money-eligible",
    "retired",
  ]);
  // "live-eligible" was ambiguous between "the live scanner may run it" and
  // "it may trade real money". It is gone, and must not come back.
  assert.ok(!LIFECYCLE_STATUSES.includes("live-eligible"));
});

test("only forward-paper and real-money-eligible permit forward operation", () => {
  assert.deepEqual(SCANNER_STATUSES, ["forward-paper", "real-money-eligible"]);
  // `validated` deliberately does not: passing historical criteria earns the
  // right to BE promoted to forward-paper, it is not the promotion itself.
  assert.ok(!SCANNER_STATUSES.includes("validated"));
});

test("every registered strategy carries complete lifecycle metadata", () => {
  const strategies = listStrategies();
  assert.ok(strategies.length >= 2);

  for (const s of strategies) {
    for (const field of ["id", "name", "version", "description", "status"]) {
      assert.equal(typeof s[field], "string", `${s.id}.${field} must be a string`);
      assert.ok(s[field].length > 0, `${s.id}.${field} must not be empty`);
    }
    for (const field of ["supportsBacktest", "supportsEventReplay", "supportsLiveScanner", "scannerEligible", "realMoneyEligible"]) {
      assert.equal(typeof s[field], "boolean", `${s.id}.${field} must be a boolean`);
    }
    assert.ok(LIFECYCLE_STATUSES.includes(s.status), `${s.id} has an unknown status`);
    assert.ok(s.requiredWarmupBars >= 0);
    // The old ambiguous field must not be served to any client.
    assert.equal(s.liveEligible, undefined);
  }
});

/* ── The two eligibilities ────────────────────────────────── */

test("mindset_v1 is scanner eligible but NOT real-money eligible", () => {
  const mindset = describeById("mindset_v1");
  assert.equal(mindset.status, "forward-paper");
  assert.equal(mindset.supportsBacktest, true);
  assert.equal(mindset.supportsLiveScanner, true);
  assert.equal(mindset.scannerEligible, true, "the live paper scanner runs it today");
  assert.equal(mindset.realMoneyEligible, false, "running forward on paper is not approval to trade real money");
  assert.equal(mindset.version, "1.0.0");
});

test("smc_v1 is neither scanner eligible nor real-money eligible", () => {
  const smc = describeById("smc_v1");
  assert.equal(smc.status, "backtest");
  assert.equal(smc.supportsBacktest, true);
  assert.equal(smc.supportsLiveScanner, false);
  assert.equal(smc.scannerEligible, false);
  assert.equal(smc.realMoneyEligible, false);
});

test("nothing is real-money eligible", () => {
  assert.deepEqual(listStrategies({ realMoneyEligible: true }), []);
});

test("live demo research capability is independent of lifecycle promotion", () => {
  const byId = new Map(listStrategies().map((strategy) => [strategy.id, strategy]));
  for (const id of ["mindset_v1", "smc_v1", "donchian_breakout_v1", "vwap_reversion_v1"]) {
    assert.equal(byId.get(id).liveResearchEligible, true, id);
    assert.ok(byId.get(id).rules && byId.get(id).rules.positionSizing, `${id} has no structured rules`);
  }
  assert.equal(byId.get("smc_v1").status, "backtest");
  assert.equal(byId.get("smc_v1").scannerEligible, false);
  assert.equal(byId.get("shadow_bananagun_v1").liveResearchEligible, false);
});

test("scanner eligibility needs capability AND a status that permits it", () => {
  const base = {
    id: "x",
    name: "X",
    version: "0.1.0",
    description: "d",
    supportsBacktest: true,
    requiredWarmupBars: 1,
  };

  // Capable, but the lifecycle has not reached forward operation.
  for (const status of ["experimental", "backtest", "validated", "retired"]) {
    assert.equal(
      computeScannerEligible({ ...base, status, supportsLiveScanner: true }),
      false,
      `${status} must not confer scanner eligibility`,
    );
  }
  // Status permits it, but the strategy cannot run in the scanner at all.
  for (const status of SCANNER_STATUSES) {
    assert.equal(computeScannerEligible({ ...base, status, supportsLiveScanner: false }), false);
    assert.equal(computeScannerEligible({ ...base, status, supportsLiveScanner: true }), true);
  }
});

test("real-money eligibility is a lifecycle claim, independent of scanner capability", () => {
  const base = { id: "x", name: "X", version: "0.1.0", description: "d", supportsBacktest: true, requiredWarmupBars: 1 };

  assert.equal(computeRealMoneyEligible({ ...base, status: "forward-paper", supportsLiveScanner: true }), false);
  assert.equal(computeRealMoneyEligible({ ...base, status: "validated", supportsLiveScanner: true }), false);
  assert.equal(computeRealMoneyEligible({ ...base, status: "real-money-eligible", supportsLiveScanner: false }), true);
});

test("a strategy cannot self-certify either eligibility", () => {
  const rogue = {
    id: "rogue_v1",
    name: "Rogue",
    version: "1.0.0",
    description: "claims to be ready",
    status: "backtest",
    supportsBacktest: true,
    supportsLiveScanner: false,
    scannerEligible: true, // ignored
    realMoneyEligible: true, // ignored
    requiredWarmupBars: 10,
  };
  const described = describeStrategy(rogue);
  assert.equal(described.scannerEligible, false);
  assert.equal(described.realMoneyEligible, false);
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
  assert.throws(() => assertValidLifecycle({ ...ok, status: "live-eligible" }), /expected one of/);
  assert.throws(() => assertValidLifecycle({ ...ok, version: undefined }), /must declare a version/);
  assert.throws(() => assertValidLifecycle({ ...ok, supportsLiveScanner: "yes" }), /must declare supportsBacktest/);
});

/* ── Runtime enforcement ──────────────────────────────────── */
//
// Previously this was only asserted by reading the scanner's source. Now the
// scanner asks the registry at construction, so these are real refusals.

const lab = { book: () => ({}) };

test("the scanner resolves an eligible strategy through the registry", () => {
  const scanner = new LiveScannerService({ tradingLabService: lab, strategy: "mindset_v1" });
  assert.equal(scanner.strategy, "mindset_v1");
  assert.equal(scanner.status().strategy, "mindset_v1");
  assert.equal(scanner.status().strategyVersion, "1.0.0");
  assert.equal(scanner.status().mode, "paper");
});

test("the scanner refuses a backtest-only strategy instead of falling back", () => {
  assert.throws(
    () => new LiveScannerService({ tradingLabService: lab, strategy: "smc_v1" }),
    (err) => /smc_v1/.test(err.message) && /does not support the live scanner/.test(err.message),
  );
});

test("the scanner refuses an unknown strategy, and names what is registered", () => {
  assert.throws(
    () => new LiveScannerService({ tradingLabService: lab, strategy: "moon_v9" }),
    (err) => /Unknown strategy "moon_v9"/.test(err.message) && /mindset_v1/.test(err.message),
  );
});

test("being in the registry confers no scanner permission by itself", () => {
  // smc_v1 is a first-class registry citizen — backtestable, versioned,
  // described — and is still refused by the scanner.
  assert.ok(describeById("smc_v1"), "smc_v1 is registered");
  assert.throws(() => getScannerStrategy("smc_v1"), /does not support the live scanner/);

  // And a strategy whose status merely permits forward operation is still
  // refused when it cannot run in the scanner.
  assert.throws(
    () =>
      getScannerStrategy(
        // not registered under any id — presence is the whole question
        "validated_but_absent",
      ),
    /Unknown strategy/,
  );
});

test("the scanner's evaluator is the registry's, so forward and backtest cannot drift", () => {
  const scanner = new LiveScannerService({ tradingLabService: lab, strategy: "mindset_v1" });
  const { evaluateMindsetV1 } = require("../src/services/trading/strategies/mindset-v1-rules");

  const candles = [];
  for (let i = 0; i < 120; i += 1) {
    const close = 100 + i * 0.2 + Math.sin(i / 9) * 4;
    candles.push({
      openTime: i * 900000,
      closeTime: (i + 1) * 900000 - 1,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    });
  }

  const direct = evaluateMindsetV1(candles);
  const viaScanner = scanner._strategyFn(candles);
  assert.equal(viaScanner.signal, direct.signal);
  assert.deepEqual(viaScanner.indicators, direct.indicators);
  assert.deepEqual(viaScanner.reasons, direct.reasons);
});
