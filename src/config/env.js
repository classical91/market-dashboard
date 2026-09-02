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

function parseJsonArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ONCHAIN_MODE presets tune how many Covalent pages/credits an overview
// refresh may spend. Explicit ONCHAIN_* env vars still override the preset.
// cheap (default): 1 page of 50 rows over 6h, cached 5 min — survives small
// credit budgets. normal: the previous defaults. deep: wider scans for manual
// deep dives.
const ONCHAIN_MODE_PRESETS = {
  cheap: {
    overviewCacheMs: 300000,
    overviewLookbackHours: 6,
    pageSize: 50,
    overviewPageLimit: 1,
    tokenPageLimit: 1,
  },
  normal: {
    overviewCacheMs: 180000,
    overviewLookbackHours: 24,
    pageSize: 100,
    overviewPageLimit: 2,
    tokenPageLimit: 2,
  },
  deep: {
    overviewCacheMs: 120000,
    overviewLookbackHours: 24,
    pageSize: 100,
    overviewPageLimit: 4,
    tokenPageLimit: 4,
  },
};

const onchainMode = String(process.env.ONCHAIN_MODE || "cheap").toLowerCase();
const onchainModeDefaults = ONCHAIN_MODE_PRESETS[onchainMode] || ONCHAIN_MODE_PRESETS.cheap;

const config = {
  port: parseNumber(process.env.PORT, 3000),
  admin: {
    // Shared secret guarding action/mutation endpoints. When empty, those
    // endpoints are disabled rather than left open (see admin-auth middleware).
    apiKey: process.env.ADMIN_API_KEY || "",
  },
  access: {
    // Optional website-level login. Owner access can browse the whole dashboard;
    // Alpha access is read-only and limited to shared ?view=alpha pages.
    sitePassword: process.env.MARKET_DASHBOARD_LOGIN_PASSWORD || "",
    alphaAccessCode: process.env.ALPHA_TEAM_ACCESS_CODE || "",
  },
  broadcastLedger: {
    // Deliberately its own secret rather than reusing ADMIN_API_KEY: this key
    // lives on a phone (the iOS/GPT shortcut) and in the ShareBot67 agent
    // config, and it should only be able to write broadcast receipts — not
    // spend OpenAI credits or fire a Telegram broadcast. Falls back to
    // ADMIN_API_KEY so an existing deploy keeps working before the new
    // variable is set.
    apiKey: process.env.BROADCAST_LEDGER_API_KEY || "",
    rateLimitPerMinute: parseNumber(process.env.BROADCAST_LEDGER_RATE_LIMIT_PER_MIN, 60),
    // Watch the configured Telegram channels and auto-record every post as a
    // receipt. Off unless explicitly switched on by exact value: it starts a
    // poll loop against the Telegram API, and only one process may consume a
    // given bot's updates.
    ingestEnabled: process.env.BROADCAST_LEDGER_INGEST_ENABLED === "true",
    ingestIntervalMs: parseNumber(process.env.BROADCAST_LEDGER_INGEST_INTERVAL_MS, 60_000),
    // Optional, independent ingest watchlist. When omitted, legacy installs
    // safely inherit the exact Telegram broadcast destinations (including
    // forum topic ids). Use the Settings UI to deliberately select none.
    watchTargets: String(process.env.BROADCAST_LEDGER_TELEGRAM_WATCHLIST || "").trim()
      ? parseList(process.env.BROADCAST_LEDGER_TELEGRAM_WATCHLIST)
      : null,
    // Operational alerts must not be broadcast into the public/news rooms.
    // Configure one or more private chat/topic targets explicitly.
    notificationTargets: parseList(process.env.BROADCAST_LEDGER_NOTIFICATION_CHAT_IDS),
  },
  reporter: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.REPORTER_MODEL || "gpt-5.4-mini",
  },
  newsroom: {
    // Sections one scheduled newsroom cycle is expected to produce. Empty
    // means the reporter's own default set rather than "no sections", so an
    // unset variable can never quietly turn a cycle into a no-op.
    sections: parseList(process.env.NEWSROOM_SECTIONS),
    // Optional "HH:MM,HH:MM" in UTC, used only to report the next expected run
    // in the health endpoint. The schedule itself lives in the external cron —
    // this repository never starts a timer for it — so a wrong value here
    // misreports a time, it cannot cause or skip a run.
    expectedRunTimesUtc: parseList(process.env.NEWSROOM_EXPECTED_RUN_TIMES_UTC),
    // How many cycles to retain. Cycles are small (no report text — that lives
    // in the generation log), so the default keeps months of history.
    historyCap: parseNumber(process.env.NEWSROOM_CYCLE_HISTORY, 200),
    // Deliver the sections that exist when another expected section could not
    // be generated. Off by default: a digest that silently drops a category
    // reads as a complete report to everyone in the room, and the next run of
    // the same slot generates only what is missing and then delivers. Turn it
    // on when a late category is worth less than a late report.
    allowPartialDelivery: process.env.NEWSROOM_ALLOW_PARTIAL_DELIVERY === "true",
    // Read-only identity check against the ShareBot/OpenClaw gateway. This is
    // the one preflight check this repository cannot answer on its own — the
    // agent and its model route are configured outside it — so it stays
    // unverified until an operator points it at a real endpoint.
    agentPreflight: {
      // A GET that reports who the credential is, e.g. a whoami/agent-lookup.
      // Never a run endpoint: the preflight must not make the agent do work.
      url: String(process.env.NEWSROOM_AGENT_PREFLIGHT_URL || "").trim(),
      // Header the gateway wants the credential in. Bearer is assembled for
      // Authorization; any other header sends the token verbatim.
      header: String(process.env.NEWSROOM_AGENT_PREFLIGHT_HEADER || "Authorization").trim(),
      // The credential the *scheduled* run uses. A route that works by hand
      // and fails on a schedule is usually two different credentials, so this
      // is deliberately its own variable rather than reusing another key.
      token: process.env.NEWSROOM_AGENT_PREFLIGHT_TOKEN || "",
      // Optional: the agent/model identity the response must name. Without it
      // the check only proves the credential resolves to *someone*.
      expectIdentity: String(process.env.NEWSROOM_AGENT_PREFLIGHT_EXPECT || "").trim(),
      timeoutMs: parseNumber(process.env.NEWSROOM_AGENT_PREFLIGHT_TIMEOUT_MS, 8000),
    },
  },
  aiAnalysis: {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.AI_ANALYSIS_MODEL || process.env.REPORTER_MODEL || "gpt-5.4-mini",
    chartImgApiKey: process.env.CHART_IMG_API_KEY || "",
    chartImgBaseUrl:
      process.env.CHART_IMG_BASE_URL || "https://api.chart-img.com/v2/tradingview/advanced-chart/storage",
    cacheMs: parseNumber(process.env.AI_ANALYSIS_CACHE_MS, 30 * 60 * 1000),
    presets: parseJsonArray(process.env.AI_ANALYSIS_SYMBOLS),
  },
  layoutAnalysis: {
    // Free alternative to the chart-img presets above: screenshots your own
    // saved/shared TradingView layouts (tradingview.com/x/<id>/) with a
    // headless browser instead of a paid chart-rendering API. Configure as
    // AI_ANALYSIS_LAYOUTS='[{"id":"btc-4h","label":"BTC 4h Setup","url":"https://www.tradingview.com/x/XXXXXXXX/"}]'
    layouts: parseJsonArray(process.env.AI_ANALYSIS_LAYOUTS) || [],
    timeoutMs: parseNumber(process.env.LAYOUT_CAPTURE_TIMEOUT_MS, 25000),
  },
  youtube: {
    // YouTube Data API v3 key. Server-side only — it is never sent to the
    // browser, and every request that carries it is redacted before logging.
    // Without it the page still runs on RSS, but only for channels whose
    // UC... ID is known (config or YOUTUBE_CHANNEL_IDS), and live/upcoming
    // detection is unavailable.
    apiKey: process.env.YOUTUBE_API_KEY || "",
    // Optional handle -> UC... overrides. JSON or "handle=UC...,handle=UC...".
    channelIds: process.env.YOUTUBE_CHANNEL_IDS || "",
    maxVideosPerChannel: parseNumber(process.env.YOUTUBE_MAX_VIDEOS_PER_CHANNEL, 8),
    requestTimeoutMs: parseNumber(process.env.YOUTUBE_REQUEST_TIMEOUT_MS, 10000),
    // How long to stop calling the API after it reports the daily quota is
    // gone, so an exhausted key isn't re-hit on every refresh.
    quotaCooldownMs: parseNumber(process.env.YOUTUBE_QUOTA_COOLDOWN_MS, 30 * 60 * 1000),
    ttls: {
      channelId: parseNumber(process.env.YOUTUBE_CHANNEL_ID_CACHE_MS, 30 * 24 * 60 * 60 * 1000),
      channelMeta: parseNumber(process.env.YOUTUBE_CHANNEL_META_CACHE_MS, 24 * 60 * 60 * 1000),
      uploads: parseNumber(process.env.YOUTUBE_UPLOADS_CACHE_MS, 10 * 60 * 1000),
      videoStatus: parseNumber(process.env.YOUTUBE_LIVE_CACHE_MS, 2 * 60 * 1000),
      liveSearch: parseNumber(process.env.YOUTUBE_LIVE_SEARCH_CACHE_MS, 30 * 60 * 1000),
    },
    // search.list costs 100 units a call against a 10,000/day default quota,
    // so it stays off unless explicitly switched on with a raised quota.
    liveSearchEnabled: process.env.YOUTUBE_LIVE_SEARCH_ENABLED === "true",
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatIds: parseList(process.env.TELEGRAM_CHAT_IDS),
    dashboardUrl: String(process.env.MARKET_DASHBOARD_URL || "").replace(/\/+$/, ""),
  },
  newsTelegram: {
    botToken: process.env.NEWS_TELEGRAM_BOT_TOKEN || "",
    chatIds: parseList(process.env.NEWS_TELEGRAM_CHAT_IDS),
    dashboardUrl: String(process.env.MARKET_DASHBOARD_URL || "").replace(/\/+$/, ""),
  },
  signalBot: {
    // On by default whenever Telegram is configured; set SIGNAL_BOT_ENABLED=false to opt out.
    enabled: process.env.SIGNAL_BOT_ENABLED !== "false",
    intervalMs: parseNumber(process.env.SIGNAL_BOT_INTERVAL_MS, 15 * 60 * 1000),
    timeframes: parseList(process.env.SIGNAL_BOT_TIMEFRAMES),
    minChecks: parseNumber(process.env.SIGNAL_BOT_MIN_CHECKS, 4),
    // Trading Lab bridge. Off by default and opt-in by exact value: every
    // FLAT -> LONG/SHORT transition is scored and logged either way, but
    // nothing is opened — even on paper — until this is explicitly "true".
    paperTradeEnabled: process.env.SIGNAL_BOT_PAPER_TRADE_ENABLED === "true",
    book: process.env.SIGNAL_BOT_BOOK || "main",
    // Marking open paper positions to market on the bot's interval is what
    // lets stops and take-profits resolve without the dashboard open. Harmless
    // when no positions are open, so it defaults on; set to "false" to opt out.
    autoMarkEnabled: process.env.SIGNAL_BOT_AUTO_MARK_ENABLED !== "false",
  },
  liveScanner: {
    // Native live paper-trading scanner: pulls its own Bitget perpetual
    // candles and runs its own strategy, so no TradingView webhook is needed.
    // Off unless explicitly switched on by exact value — an unset or
    // misspelled variable leaves it disabled rather than trading.
    enabled: process.env.ENABLE_LIVE_SCANNER === "true",
    symbol: process.env.LIVE_SCANNER_SYMBOL || "BTCUSDT.P",
    timeframe: process.env.LIVE_SCANNER_TIMEFRAME || "15m",
    strategy: process.env.LIVE_SCANNER_STRATEGY || "mindset_v1",
    intervalMs: parseNumber(process.env.LIVE_SCANNER_INTERVAL_MS, 60 * 1000),
    // Higher-timeframe context for the checklist's regime/daily-bias buckets.
    // A 15m bar has no opinion on the daily trend, so this stays coarse.
    contextInterval: process.env.LIVE_SCANNER_CONTEXT_INTERVAL || "4h",
    book: process.env.LIVE_SCANNER_BOOK || "main",
    // Paper positions are the point of enabling the scanner, so this defaults
    // on once ENABLE_LIVE_SCANNER=true. Set it to "false" for an observe-only
    // run that still scores and logs every signal but opens nothing. Either
    // way the ledger is paper — no live-order code is reachable from here.
    paperTradeEnabled: process.env.LIVE_SCANNER_PAPER_TRADE_ENABLED !== "false",
  },
  liveResearch: {
    // Evidence collection for every candle-compatible strategy account. This
    // is independent of lifecycle promotion and remains paper-only.
    enabled: process.env.LIVE_RESEARCH_ENABLED !== "false",
    // Single-market escape hatches, unset by default. A default of "BTCUSDT"
    // here would win over the top-20 universe below and quietly pin every demo
    // account to one pair.
    symbol: process.env.LIVE_RESEARCH_SYMBOL || null,
    timeframe: process.env.LIVE_RESEARCH_TIMEFRAME || null,
    // The market universe every demo account watches. Empty means "the default
    // top-20 list" rather than "no markets", so an unset variable can never
    // silently produce accounts with nothing to trade.
    symbols: parseList(process.env.LIVE_RESEARCH_SYMBOLS),
    // 1h only for now. Adding a timeframe multiplies runner count by the number
    // of markets, so it is a deliberate change rather than a default.
    timeframes: parseList(process.env.LIVE_RESEARCH_TIMEFRAMES),
    intervalMs: parseNumber(process.env.LIVE_RESEARCH_INTERVAL_MS, 60 * 1000),
  },
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
    mode: onchainMode,
    overviewCacheMs: parseNumber(process.env.ONCHAIN_OVERVIEW_CACHE_MS, onchainModeDefaults.overviewCacheMs),
    detailCacheMs: parseNumber(process.env.ONCHAIN_DETAIL_CACHE_MS, 60000),
    // How long to pause Covalent calls after a credit (402) or rate-limit (429)
    // error, so an exhausted account isn't re-hit on every overview refresh.
    covalentCreditCooldownMs: parseNumber(process.env.COVALENT_CREDIT_COOLDOWN_MS, 1800000),
    covalentRateCooldownMs: parseNumber(process.env.COVALENT_RATELIMIT_COOLDOWN_MS, 120000),
    // Serve the cached overview longer while Covalent is cooling down, so the
    // degraded window doesn't burn Etherscan/DefiLlama calls every refresh.
    cooldownCacheMs: parseNumber(process.env.ONCHAIN_COOLDOWN_CACHE_MS, 600000),
    overviewLookbackHours: parseNumber(
      process.env.ONCHAIN_OVERVIEW_LOOKBACK_HOURS,
      onchainModeDefaults.overviewLookbackHours,
    ),
    detailLookbackDays: parseNumber(process.env.ONCHAIN_DETAIL_LOOKBACK_DAYS, 7),
    pageSize: parseNumber(process.env.ONCHAIN_OVERVIEW_PAGE_SIZE, onchainModeDefaults.pageSize),
    detailPageSize: parseNumber(process.env.ONCHAIN_DETAIL_PAGE_SIZE, 100),
    overviewPageLimit: parseNumber(
      process.env.ONCHAIN_OVERVIEW_PAGE_LIMIT,
      onchainModeDefaults.overviewPageLimit,
    ),
    tokenPageLimit: parseNumber(process.env.ONCHAIN_TOKEN_PAGE_LIMIT, onchainModeDefaults.tokenPageLimit),
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
