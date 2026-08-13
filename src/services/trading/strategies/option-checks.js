"use strict";

// Shared validators for caller-supplied strategy options.
//
// These live in their own leaf module rather than in the registry because
// strategies are required BY the registry: importing them back from it would
// close a cycle, which is the same trap that put the mindset_v1 rules in their
// own file. The registry re-exports these so callers still have one place to
// look.

function checkPositiveInt(options, key, { min = 1, max = 5000 } = {}) {
  if (options[key] === undefined) return null;
  const value = Number(options[key]);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return `${key} must be a whole number`;
  if (value < min) return `${key} must be at least ${min}`;
  if (value > max) return `${key} must be at most ${max}`;
  return null;
}

function checkPositiveNumber(options, key, { min = 0, max = 1000, exclusiveMin = true } = {}) {
  if (options[key] === undefined) return null;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) return `${key} must be a number`;
  if (exclusiveMin ? !(value > min) : value < min) return `${key} must be greater than ${min}`;
  if (value > max) return `${key} must be at most ${max}`;
  return null;
}

module.exports = { checkPositiveInt, checkPositiveNumber };
