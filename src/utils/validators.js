function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || "");
}

function normalizeAddress(value) {
  return isAddress(value) ? value.toLowerCase() : null;
}

module.exports = {
  isAddress,
  normalizeAddress,
};
