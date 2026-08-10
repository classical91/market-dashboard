"use strict";

// Shared rounding for every Trading Lab money and R-multiple figure.
//
// Why this is not `Math.round(x * 100) / 100`: TraderClaw's Python engines
// round with Python's built-in round(), which is half-to-even ("banker's
// rounding") applied to the exact binary value of the double. JS's Math.round
// is half-up and biased toward +Infinity, so a -0.125 loss and a +0.125 win
// would round in opposite directions, and every exact tie would disagree with
// the Python side by a cent.
//
// That one cent matters here for two reasons: the parity check
// (scripts/traderclaw-parity.js) is the evidence that lets TraderClaw be
// archived, and it can only be evidence if the two engines agree exactly; and
// half-even keeps rounding unbiased across a long trade history, where a
// half-up rule would slowly inflate net P&L.

const MAX_TOFIXED_DIGITS = 100;
const GUARD_DIGITS = 18;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;

  const negative = value < 0;
  const abs = Math.abs(value);

  // toFixed switches to exponential notation past 1e21, and no realistic
  // account balance gets there — fall back rather than mis-parse.
  if (abs >= 1e21) return value;

  // The exact decimal expansion of the double, carried well past the rounding
  // position so a true tie is distinguishable from a value that merely looks
  // like one at two decimals.
  const expanded = abs.toFixed(Math.min(digits + GUARD_DIGITS, MAX_TOFIXED_DIGITS));
  const dot = expanded.indexOf(".");
  const intPart = expanded.slice(0, dot);
  const fraction = expanded.slice(dot + 1);
  const kept = fraction.slice(0, digits);
  const rest = fraction.slice(digits);

  let roundUp;
  const first = rest[0];
  if (first > "5") {
    roundUp = true;
  } else if (first < "5") {
    roundUp = false;
  } else if (rest.slice(1).replace(/0+$/, "").length) {
    // Something beyond the 5 — above the halfway point after all.
    roundUp = true;
  } else {
    // An exact tie: round to even, which is what Python does.
    const lastKept = digits > 0 ? kept[digits - 1] : intPart[intPart.length - 1];
    roundUp = Number(lastKept) % 2 === 1;
  }

  // Assemble as an integer so the final division is the only float operation.
  let scaled = BigInt(intPart + kept.padEnd(digits, "0"));
  if (roundUp) scaled += 1n;

  const result = Number(scaled) / 10 ** digits;
  return negative ? -result : result;
}

module.exports = { round };
