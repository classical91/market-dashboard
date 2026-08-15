"use strict";

// Named execution-cost assumptions.
//
// A backtest's numbers are only meaningful against the friction they were
// charged, and "we used realistic costs" is not a reproducible statement. These
// are the named sets a research run may be executed under, so an experiment can
// record WHICH assumption produced it rather than three loose decimals a reader
// has to interpret.
//
// Two things these are NOT:
//
//   They are not the deployment's configuration. BACKTEST_TAKER_FEE_RATE and
//   friends are read by PaperTradingService for EVERY book, forward paper
//   included, so changing their defaults would re-price live paper accounting
//   mid-flight. Choosing a scenario for a research run is a per-run decision;
//   changing what a deployment charges is a deployment decision. See
//   docs/trading-lab.md.
//
//   They are not a substitute for a funding feed. `fundingRate8h` here is an
//   EXECUTION COST charged against P&L while a position is open. The
//   checklist's `marketContext.fundingRate` is MARKET EVIDENCE used for
//   scoring and for the funding kill switch. Setting one does nothing for the
//   other, and conflating them is easy because they share a word.

const SCENARIOS = Object.freeze({
  // The default research baseline: a standard (undiscounted) perp taker tier
  // with modest slippage. Conservative enough that a strategy has to survive
  // realistic friction, without being so harsh that it discards strategies
  // that would work in practice.
  baseline: Object.freeze({
    id: "baseline",
    label: "Baseline — standard taker tier",
    takerFeeRate: 0.0006, // 0.06%
    slippageRate: 0.0002, // 0.02%
    // Zero, deliberately, and labelled wherever it is reported. No funding
    // feed exists, so charging an invented rate would be the execution-cost
    // version of the mistake the checklist just stopped making about macro
    // data. A run with funding excluded says so rather than passing for one
    // that accounted for it.
    fundingRate8h: 0,
  }),

  // The stress test, not the baseline. A strategy that looks good under
  // `baseline` AND survives this is far stronger evidence than one tuned
  // around cheap execution — but starting here would reject strategies that
  // are fine in practice, so it is a second run rather than a stricter first
  // one.
  stress: Object.freeze({
    id: "stress",
    label: "Stress — punitive fees and slippage",
    takerFeeRate: 0.001, // 0.10%
    slippageRate: 0.0005, // 0.05%
    fundingRate8h: 0,
  }),

  // Explicitly frictionless. Useful for isolating whether a result is driven
  // by the rules or by the friction, and useless as evidence on its own.
  frictionless: Object.freeze({
    id: "frictionless",
    label: "Frictionless — no costs at all",
    takerFeeRate: 0,
    slippageRate: 0,
    fundingRate8h: 0,
  }),
});

const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));

function getCostScenario(id) {
  const key = String(id || "");
  const scenario = SCENARIOS[key];
  if (!scenario) {
    throw Object.assign(
      new Error(`Unknown cost scenario "${key}" (expected one of ${SCENARIO_IDS.join(", ")})`),
      { statusCode: 400, expose: true },
    );
  }
  return scenario;
}

/**
 * Which named scenario a set of applied costs corresponds to, or null when it
 * matches none of them.
 *
 * Recorded on runs and experiments so a stored result says "baseline" rather
 * than leaving a reader to compare three decimals by eye. A deployment running
 * its own rates simply gets null, which is honest — it is a custom assumption,
 * not a named one.
 */
function identifyCostScenario(costs) {
  if (!costs) return null;
  const match = SCENARIO_IDS.find(
    (id) =>
      Number(costs.takerFeeRate) === SCENARIOS[id].takerFeeRate &&
      Number(costs.slippageRate) === SCENARIOS[id].slippageRate &&
      Number(costs.fundingRate8h) === SCENARIOS[id].fundingRate8h,
  );
  return match || null;
}

/**
 * The caveats a set of costs deserves, in words.
 *
 * A zero rate is not a neutral rate, it is an EXCLUDED one, and a run that
 * excluded a cost has to say which — otherwise its expectancy quietly reads as
 * though everything was accounted for.
 */
function costCaveats(costs) {
  if (!costs) return [];
  const out = [];
  const zero = (v) => !Number(v);

  if (zero(costs.takerFeeRate) && zero(costs.slippageRate) && zero(costs.fundingRate8h)) {
    out.push(
      "Frictionless run: no fees, slippage or funding were charged. These numbers are not evidence of a tradeable edge.",
    );
    return out;
  }
  if (zero(costs.takerFeeRate)) out.push("Trading fees were NOT charged in this run.");
  if (zero(costs.slippageRate)) out.push("Slippage was NOT applied in this run.");
  if (zero(costs.fundingRate8h)) {
    out.push(
      "Funding was NOT charged in this run — no funding feed is wired up, so a rate would have been invented rather than measured. " +
        "Expect a real funding cost to weigh most on whichever strategy holds positions longest.",
    );
  }
  return out;
}

module.exports = { SCENARIOS, SCENARIO_IDS, getCostScenario, identifyCostScenario, costCaveats };
