const { isAddress, normalizeAddress } = require("./validators");

function toDateIsoString(timestamp) {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

function formatTokenAmount(rawValue, decimals = 18) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return 0;
  }

  const stringValue = String(rawValue).trim();
  if (!stringValue) {
    return 0;
  }

  const negative = stringValue.startsWith("-");
  const digits = stringValue.replace(/^-/, "").replace(/^0+/, "") || "0";
  const whole =
    decimals <= 0
      ? digits
      : digits.length > decimals
        ? digits.slice(0, digits.length - decimals)
        : "0";
  const fraction =
    decimals <= 0
      ? ""
      : digits.length > decimals
        ? digits.slice(digits.length - decimals)
        : digits.padStart(decimals, "0");

  const normalized = Number.parseFloat(
    fraction ? `${negative ? "-" : ""}${whole}.${fraction}` : `${negative ? "-" : ""}${whole}`,
  );

  return Number.isFinite(normalized) ? normalized : 0;
}

function formatUsdAmount(rawValue, decimals = 18, priceUsd = 1) {
  const normalizedAmount = formatTokenAmount(rawValue, decimals);
  const usdValue = normalizedAmount * Number(priceUsd || 0);
  return Number.isFinite(usdValue) ? usdValue : 0;
}

function getCounterpartyAddress(targetAddress, fromAddress, toAddress) {
  const normalizedTarget = normalizeAddress(targetAddress);
  const from = normalizeAddress(fromAddress);
  const to = normalizeAddress(toAddress);

  if (normalizedTarget && from === normalizedTarget) {
    return to;
  }

  if (normalizedTarget && to === normalizedTarget) {
    return from;
  }

  return from || to;
}

module.exports = {
  formatTokenAmount,
  formatUsdAmount,
  getCounterpartyAddress,
  isAddress,
  normalizeAddress,
  toDateIsoString,
};
