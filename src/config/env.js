const DEFAULT_TRACKED_TOKENS = [
  {
    symbol: "USDC",
    name: "USD Coin",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6,
  },
];

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTrackedTokens(value) {
  if (!value) {
    return DEFAULT_TRACKED_TOKENS;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return DEFAULT_TRACKED_TOKENS;
    }

    const normalized = parsed
      .map((token) => ({
        symbol: String(token.symbol || "").trim().toUpperCase(),
        name: String(token.name || "").trim() || null,
        contractAddress: String(token.contractAddress || "")
          .trim()
          .toLowerCase(),
        decimals: parseNumber(token.decimals, 18),
      }))
      .filter((token) => /^0x[a-f0-9]{40}$/.test(token.contractAddress) && token.symbol);

    return normalized.length ? normalized : DEFAULT_TRACKED_TOKENS;
  } catch {
    return DEFAULT_TRACKED_TOKENS;
  }
}

const trackedTokens = parseTrackedTokens(process.env.ONCHAIN_TRACKED_TOKENS);
const ignoredAddresses = Array.from(
  new Set(
    [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      ...parseList(process.env.ONCHAIN_IGNORED_ADDRESSES).map((address) => address.toLowerCase()),
    ].filter((address) => /^0x[a-f0-9]{40}$/.test(address)),
  ),
);

const config = {
  port: parseNumber(process.env.PORT, 3000),
  defillama: {
    baseUrl: process.env.DEFILLAMA_API_BASE_URL || "https://stablecoins.llama.fi/",
    coinsBaseUrl: process.env.DEFILLAMA_COINS_API_BASE_URL || "https://coins.llama.fi/",
    chain: process.env.DEFILLAMA_CHAIN || "Ethereum",
    coinChain: process.env.DEFILLAMA_COIN_CHAIN || "ethereum",
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_KEY || "",
    baseUrl: process.env.ETHERSCAN_API_BASE_URL || "https://api.etherscan.io",
    chainId: String(process.env.ETHERSCAN_CHAIN_ID || "1"),
    requestTimeoutMs: parseNumber(process.env.ETHERSCAN_API_REQUEST_TIMEOUT_MS, 15000),
    retryCount: parseNumber(process.env.ETHERSCAN_API_RETRIES, 2),
  },
  covalent: {
    apiKey: process.env.COVALENT_API_KEY || process.env.COVALENT_KEY || "",
    baseUrl: process.env.COVALENT_API_BASE_URL || "https://api.covalenthq.com",
    chainName: process.env.COVALENT_CHAIN_NAME || "eth-mainnet",
    requestTimeoutMs: parseNumber(process.env.COVALENT_API_REQUEST_TIMEOUT_MS, 15000),
    retryCount: parseNumber(process.env.COVALENT_API_RETRIES, 2),
  },
  onchain: {
    dataSourceLabel: "DefiLlama + Etherscan + Covalent (Dune-free)",
    overviewCacheMs: parseNumber(process.env.ONCHAIN_OVERVIEW_CACHE_MS, 180000),
    detailCacheMs: parseNumber(process.env.ONCHAIN_DETAIL_CACHE_MS, 60000),
    overviewLookbackHours: parseNumber(process.env.ONCHAIN_OVERVIEW_LOOKBACK_HOURS, 24),
    detailLookbackDays: parseNumber(process.env.ONCHAIN_DETAIL_LOOKBACK_DAYS, 7),
    pageSize: parseNumber(process.env.ONCHAIN_OVERVIEW_PAGE_SIZE, 100),
    detailPageSize: parseNumber(process.env.ONCHAIN_DETAIL_PAGE_SIZE, 100),
    overviewPageLimit: parseNumber(process.env.ONCHAIN_OVERVIEW_PAGE_LIMIT, 2),
    tokenPageLimit: parseNumber(process.env.ONCHAIN_TOKEN_PAGE_LIMIT, 2),
    maxLargeTransfers: parseNumber(process.env.ONCHAIN_MAX_LARGE_TRANSFERS, 25),
    maxWalletRows: parseNumber(process.env.ONCHAIN_MAX_WALLET_ROWS, 10),
    maxTokenRows: parseNumber(process.env.ONCHAIN_MAX_TOKEN_ROWS, 10),
    maxDetailTransfers: parseNumber(process.env.ONCHAIN_MAX_DETAIL_TRANSFERS, 25),
    largeTransferThresholdUsd: parseNumber(process.env.ONCHAIN_LARGE_TRANSFER_THRESHOLD_USD, 100000),
    whaleThresholdUsd: parseNumber(process.env.ONCHAIN_WHALE_THRESHOLD_USD, 100000),
    trackedTokens,
    ignoredAddresses,
    defillamaChain: process.env.DEFILLAMA_CHAIN || "Ethereum",
    defillamaCoinChain: process.env.DEFILLAMA_COIN_CHAIN || "ethereum",
  },
};

module.exports = { config };
