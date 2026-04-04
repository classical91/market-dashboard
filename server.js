const express = require("express");
const path = require("path");

require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DUNE_API_KEY = process.env.DUNE_API_KEY || "";
const DUNE_BASE = "https://api.dune.com/api/v1";
const CACHE_TTL_MS = 3 * 60 * 1000;
const cache = new Map();
const ETHEREUM_CHAIN = "ethereum";
const ETHEREUM_STABLECOINS = [
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
];
const EXCHANGE_NAME_MATCHERS = [
  "binance",
  "coinbase",
  "kraken",
  "okx",
  "bybit",
  "bitfinex",
  "kucoin",
  "gate",
  "mexc",
  "upbit",
  "htx",
  "crypto.com",
  "bitstamp",
  "gemini",
];

const Q = {
  stablecoinNetflow: Number(process.env.DUNE_Q_STABLECOIN_NETFLOW || 0),
  topInflows: Number(process.env.DUNE_Q_TOP_INFLOWS || 0),
  topOutflows: Number(process.env.DUNE_Q_TOP_OUTFLOWS || 0),
  accumulatedTokens: Number(process.env.DUNE_Q_ACCUMULATED_TOKENS || 0),
  distributedTokens: Number(process.env.DUNE_Q_DISTRIBUTED_TOKENS || 0),
  largeTransfers: Number(process.env.DUNE_Q_LARGE_TRANSFERS || 0),
  walletSummary: Number(process.env.DUNE_Q_WALLET_SUMMARY || 0),
  walletTransfers: Number(process.env.DUNE_Q_WALLET_TRANSFERS || 0),
  tokenSummary: Number(process.env.DUNE_Q_TOKEN_SUMMARY || 0),
  tokenWhaleActivity: Number(process.env.DUNE_Q_TOKEN_WHALES || 0),
};

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCached(key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getConfiguredQueries() {
  return Object.entries(Q).filter(([, value]) => value > 0);
}

function emptyOverviewPayload() {
  return {
    ts: new Date().toISOString(),
    metrics: {
      stablecoinNetflow: 0,
      totalInflows: 0,
      totalOutflows: 0,
    },
    topInflows: [],
    topOutflows: [],
    accumulatedTokens: [],
    distributedTokens: [],
    largeTransfers: [],
  };
}

function duneHeaders(hasBody = false) {
  return {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    "X-DUNE-API-KEY": DUNE_API_KEY,
  };
}

async function duneRequest(endpoint, options = {}) {
  const hasBody = Boolean(options.body);
  const response = await fetch(`${DUNE_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...duneHeaders(hasBody),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dune ${response.status}: ${text}`);
  }

  return response.json();
}

function duneGetLatest(queryId) {
  return duneRequest(`/query/${queryId}/results`);
}

function duneExecute(queryId, params = {}) {
  return duneRequest(`/query/${queryId}/execute`, {
    method: "POST",
    body: JSON.stringify({ query_parameters: params }),
  });
}

function duneExecuteSql(sql) {
  return duneRequest("/sql/execute", {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
}

function duneStatus(executionId) {
  return duneRequest(`/execution/${executionId}/status`);
}

function duneResults(executionId) {
  return duneRequest(`/execution/${executionId}/results`);
}

async function dunePoll(executionId, maxAttempts = 20, delayMs = 2000) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await duneStatus(executionId);
    if (status.state === "QUERY_STATE_COMPLETED") {
      return duneResults(executionId);
    }

    if (
      status.state === "QUERY_STATE_FAILED" ||
      status.state === "QUERY_STATE_CANCELLED"
    ) {
      const detail =
        status.error?.message ||
        status.error?.type ||
        status.message ||
        "Unknown Dune execution failure";
      throw new Error(`Dune query ${status.state}: ${detail}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Dune poll timeout");
}

function extractRows(result) {
  return result?.result?.rows ?? result?.rows ?? [];
}

function safeNum(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapWalletRows(rows = []) {
  return rows.map((row) => ({
    address: String(row.wallet_address ?? row.address ?? ""),
    label: row.label ?? row.entity ?? null,
    usd: safeNum(row.usd_value ?? row.amount_usd ?? row.net_usd),
    token: row.token_symbol ?? row.symbol ?? null,
    txCount: row.tx_count != null ? safeNum(row.tx_count) : null,
  }));
}

function mapTokenRows(rows = []) {
  return rows.map((row) => ({
    address: String(row.token_address ?? row.contract_address ?? ""),
    symbol: String(row.symbol ?? row.token_symbol ?? "???"),
    usd: safeNum(row.usd_value ?? row.amount_usd ?? row.net_usd),
    walletCount:
      row.wallet_count != null ? safeNum(row.wallet_count) : null,
  }));
}

function mapTransferRows(rows = []) {
  return rows.map((row) => ({
    txHash: String(row.tx_hash ?? row.hash ?? ""),
    address: String(row.wallet_address ?? row.address ?? ""),
    token: String(row.token_symbol ?? row.symbol ?? "???"),
    usd: safeNum(row.usd_value ?? row.amount_usd),
    time: String(row.block_time ?? row.timestamp ?? row.evt_block_time ?? ""),
  }));
}

function isValidEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalizeEvmAddress(value) {
  return String(value).toLowerCase();
}

function evmAddressLiteral(value) {
  return normalizeEvmAddress(value);
}

function stablecoinListSql() {
  return ETHEREUM_STABLECOINS.map((address) => evmAddressLiteral(address)).join(", ");
}

function stablecoinTextListSql() {
  return ETHEREUM_STABLECOINS.map((address) => `'${normalizeEvmAddress(address)}'`).join(", ");
}

function exchangeMatcherSql() {
  return EXCHANGE_NAME_MATCHERS.map(
    (name) => `lower(name) LIKE '%${name.toLowerCase()}%'`
  ).join(" OR ");
}

async function duneSqlRows(sql, maxAttempts = 25, delayMs = 2000) {
  const execution = await duneExecuteSql(sql);
  const results = await dunePoll(execution.execution_id, maxAttempts, delayMs);
  return extractRows(results);
}

function buildStablecoinNetflowSql() {
  return `
    WITH exchange_addresses AS (
      SELECT DISTINCT concat('0x', lower(to_hex(address))) AS address
      FROM labels.addresses
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND (${exchangeMatcherSql()})
    ),
    recent_transfers AS (
      SELECT concat('0x', lower(to_hex("from"))) AS from_address,
             concat('0x', lower(to_hex("to"))) AS to_address,
             amount_usd
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND block_time >= now() - interval '1' day
        AND contract_address IN (${stablecoinListSql()})
    )
    SELECT
      coalesce(sum(CASE WHEN to_address IN (SELECT address FROM exchange_addresses) THEN amount_usd ELSE 0 END), 0)
      - coalesce(sum(CASE WHEN from_address IN (SELECT address FROM exchange_addresses) THEN amount_usd ELSE 0 END), 0)
      AS netflow_usd
    FROM recent_transfers
  `;
}

function hasAllOverviewQueriesConfigured() {
  return [
    Q.stablecoinNetflow,
    Q.topInflows,
    Q.topOutflows,
    Q.accumulatedTokens,
    Q.distributedTokens,
    Q.largeTransfers,
  ].every((value) => value > 0);
}

function buildOverviewBundleSql() {
  return `
    WITH exchange_addresses AS (
      SELECT DISTINCT concat('0x', lower(to_hex(address))) AS wallet_address
      FROM labels.addresses
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND (${exchangeMatcherSql()})
    ),
    flow_transfers AS (
      SELECT concat('0x', lower(to_hex("from"))) AS from_address,
             concat('0x', lower(to_hex("to"))) AS to_address,
             concat('0x', lower(to_hex(contract_address))) AS token_address,
             symbol,
             amount_usd,
             concat('0x', lower(to_hex(tx_hash))) AS tx_hash,
             cast(block_time AS varchar) AS block_time
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
    ),
    active_wallets AS (
      SELECT from_address AS wallet_address FROM flow_transfers
      UNION
      SELECT to_address AS wallet_address FROM flow_transfers
    ),
    wallet_labels AS (
      SELECT concat('0x', lower(to_hex(labels.address))) AS wallet_address,
             arbitrary(labels.name) AS label,
             arbitrary(labels.category) AS category
      FROM labels.addresses AS labels
      INNER JOIN active_wallets
        ON active_wallets.wallet_address = concat('0x', lower(to_hex(labels.address)))
      WHERE labels.blockchain = '${ETHEREUM_CHAIN}'
      GROUP BY 1
    ),
    wallet_flow_events AS (
      SELECT to_address AS wallet_address, amount_usd AS usd_change, tx_hash
      FROM flow_transfers
      UNION ALL
      SELECT from_address AS wallet_address, -amount_usd AS usd_change, tx_hash
      FROM flow_transfers
    ),
    wallet_flows AS (
      SELECT wallet_flow_events.wallet_address,
             arbitrary(wallet_labels.label) AS label,
             arbitrary(wallet_labels.category) AS category,
             sum(wallet_flow_events.usd_change) AS net_usd,
             count(DISTINCT wallet_flow_events.tx_hash) AS tx_count
      FROM wallet_flow_events
      LEFT JOIN wallet_labels ON wallet_labels.wallet_address = wallet_flow_events.wallet_address
      GROUP BY 1
    ),
    top_inflows AS (
      SELECT 'wallet_inflow' AS section,
             wallet_address,
             label,
             net_usd AS usd_value,
             tx_count,
             row_number() OVER (ORDER BY net_usd DESC) AS rn
      FROM wallet_flows
      WHERE net_usd > 50000
        AND coalesce(category, '') NOT IN ('dex', 'contracts', 'safe', 'infrastructure')
    ),
    top_outflows AS (
      SELECT 'wallet_outflow' AS section,
             wallet_address,
             label,
             net_usd AS usd_value,
             tx_count,
             row_number() OVER (ORDER BY net_usd ASC) AS rn
      FROM wallet_flows
      WHERE net_usd < -50000
        AND coalesce(category, '') NOT IN ('dex', 'contracts', 'safe', 'infrastructure')
    ),
    token_flow_events AS (
      SELECT token_address, symbol, to_address AS wallet_address, amount_usd AS usd_change
      FROM flow_transfers
      UNION ALL
      SELECT token_address, symbol, from_address AS wallet_address, -amount_usd AS usd_change
      FROM flow_transfers
    ),
    token_flows AS (
      SELECT token_address,
             arbitrary(symbol) AS symbol,
             sum(usd_change) AS net_usd,
             count(DISTINCT wallet_address) AS wallet_count
      FROM token_flow_events
      WHERE token_address <> '0x0000000000000000000000000000000000000000'
      GROUP BY 1
    ),
    accumulated_tokens AS (
      SELECT 'token_accumulated' AS section,
             token_address,
             symbol,
             net_usd AS usd_value,
             wallet_count,
             row_number() OVER (ORDER BY net_usd DESC) AS rn
      FROM token_flows
      WHERE net_usd > 50000
    ),
    distributed_tokens AS (
      SELECT 'token_distributed' AS section,
             token_address,
             symbol,
             net_usd AS usd_value,
             wallet_count,
             row_number() OVER (ORDER BY net_usd ASC) AS rn
      FROM token_flows
      WHERE net_usd < -50000
    ),
    ranked_large_transfers AS (
      SELECT 'large_transfers' AS section,
             from_address AS wallet_address,
             symbol,
             amount_usd AS usd_value,
             tx_hash,
             block_time,
             row_number() OVER (ORDER BY amount_usd DESC) AS rn
      FROM flow_transfers
      WHERE amount_usd >= 100000
    ),
    stablecoin_metric AS (
      SELECT
        'metric' AS section,
        'stablecoinNetflow' AS metric_name,
        coalesce(sum(CASE WHEN to_address IN (SELECT wallet_address FROM exchange_addresses)
                           AND token_address IN (${stablecoinTextListSql()})
                          THEN amount_usd ELSE 0 END), 0)
        - coalesce(sum(CASE WHEN from_address IN (SELECT wallet_address FROM exchange_addresses)
                             AND token_address IN (${stablecoinTextListSql()})
                            THEN amount_usd ELSE 0 END), 0) AS usd_value
      FROM flow_transfers
    )
    SELECT
      section,
      wallet_address,
      label,
      usd_value,
      tx_count,
      CAST(NULL AS varchar) AS token_address,
      CAST(NULL AS varchar) AS symbol,
      CAST(NULL AS bigint) AS wallet_count,
      CAST(NULL AS varchar) AS tx_hash,
      CAST(NULL AS varchar) AS block_time,
      CAST(NULL AS varchar) AS metric_name
    FROM top_inflows
    WHERE rn <= 20
    UNION ALL
    SELECT
      section,
      wallet_address,
      label,
      usd_value,
      tx_count,
      CAST(NULL AS varchar) AS token_address,
      CAST(NULL AS varchar) AS symbol,
      CAST(NULL AS bigint) AS wallet_count,
      CAST(NULL AS varchar) AS tx_hash,
      CAST(NULL AS varchar) AS block_time,
      CAST(NULL AS varchar) AS metric_name
    FROM top_outflows
    WHERE rn <= 20
    UNION ALL
    SELECT
      section,
      CAST(NULL AS varchar) AS wallet_address,
      CAST(NULL AS varchar) AS label,
      usd_value,
      CAST(NULL AS bigint) AS tx_count,
      token_address,
      symbol,
      wallet_count,
      CAST(NULL AS varchar) AS tx_hash,
      CAST(NULL AS varchar) AS block_time,
      CAST(NULL AS varchar) AS metric_name
    FROM accumulated_tokens
    WHERE rn <= 20
    UNION ALL
    SELECT
      section,
      CAST(NULL AS varchar) AS wallet_address,
      CAST(NULL AS varchar) AS label,
      usd_value,
      CAST(NULL AS bigint) AS tx_count,
      token_address,
      symbol,
      wallet_count,
      CAST(NULL AS varchar) AS tx_hash,
      CAST(NULL AS varchar) AS block_time,
      CAST(NULL AS varchar) AS metric_name
    FROM distributed_tokens
    WHERE rn <= 20
    UNION ALL
    SELECT
      section,
      wallet_address,
      CAST(NULL AS varchar) AS label,
      usd_value,
      CAST(NULL AS bigint) AS tx_count,
      CAST(NULL AS varchar) AS token_address,
      symbol,
      CAST(NULL AS bigint) AS wallet_count,
      tx_hash,
      block_time,
      CAST(NULL AS varchar) AS metric_name
    FROM ranked_large_transfers
    WHERE rn <= 30
    UNION ALL
    SELECT
      section,
      CAST(NULL AS varchar) AS wallet_address,
      CAST(NULL AS varchar) AS label,
      usd_value,
      CAST(NULL AS bigint) AS tx_count,
      CAST(NULL AS varchar) AS token_address,
      CAST(NULL AS varchar) AS symbol,
      CAST(NULL AS bigint) AS wallet_count,
      CAST(NULL AS varchar) AS tx_hash,
      CAST(NULL AS varchar) AS block_time,
      metric_name
    FROM stablecoin_metric
  `;
}

function buildOverviewPayloadFromBundleRows(rows = []) {
  const stablecoinMetric = rows.find(
    (row) => row.section === "metric" && row.metric_name === "stablecoinNetflow"
  );
  const topInflows = mapWalletRows(rows.filter((row) => row.section === "wallet_inflow"));
  const topOutflows = mapWalletRows(rows.filter((row) => row.section === "wallet_outflow"));
  const accumulatedTokens = mapTokenRows(
    rows.filter((row) => row.section === "token_accumulated")
  );
  const distributedTokens = mapTokenRows(
    rows.filter((row) => row.section === "token_distributed")
  );
  const largeTransfers = mapTransferRows(
    rows.filter((row) => row.section === "large_transfers")
  );

  return {
    ts: new Date().toISOString(),
    metrics: {
      stablecoinNetflow: safeNum(stablecoinMetric?.usd_value),
      totalInflows: topInflows.reduce((sum, row) => sum + row.usd, 0),
      totalOutflows: topOutflows.reduce((sum, row) => sum + row.usd, 0),
    },
    topInflows,
    topOutflows,
    accumulatedTokens,
    distributedTokens,
    largeTransfers,
  };
}

function buildCombinedWalletFlowSql() {
  return `
    WITH signed_transfers AS (
      SELECT concat('0x', lower(to_hex("to"))) AS wallet_address,
             amount_usd AS usd_change,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex("from"))) AS wallet_address,
             -amount_usd AS usd_change,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
    ),
    active_wallets AS (
      SELECT DISTINCT wallet_address
      FROM signed_transfers
    ),
    wallet_labels AS (
      SELECT concat('0x', lower(to_hex(labels.address))) AS wallet_address,
             arbitrary(labels.name) AS label,
             arbitrary(labels.category) AS category
      FROM labels.addresses AS labels
      INNER JOIN active_wallets
        ON active_wallets.wallet_address = concat('0x', lower(to_hex(labels.address)))
      WHERE labels.blockchain = '${ETHEREUM_CHAIN}'
      GROUP BY 1
    ),
    wallet_flows AS (
      SELECT signed_transfers.wallet_address,
             arbitrary(wallet_labels.label) AS label,
             arbitrary(wallet_labels.category) AS category,
             coalesce(sum(signed_transfers.usd_change), 0) AS net_usd,
             count(DISTINCT signed_transfers.tx_hash) AS tx_count
      FROM signed_transfers
      LEFT JOIN wallet_labels ON wallet_labels.wallet_address = signed_transfers.wallet_address
      GROUP BY 1
    )
    SELECT *
    FROM (
      SELECT 'wallet_inflow' AS section,
             wallet_address,
             label,
             net_usd AS usd_value,
             tx_count,
             row_number() OVER (ORDER BY net_usd DESC) AS rn
      FROM wallet_flows
      WHERE net_usd > 50000
        AND coalesce(category, '') NOT IN ('dex', 'contracts', 'safe', 'infrastructure')
      UNION ALL
      SELECT 'wallet_outflow' AS section,
             wallet_address,
             label,
             net_usd AS usd_value,
             tx_count,
             row_number() OVER (ORDER BY net_usd ASC) AS rn
      FROM wallet_flows
      WHERE net_usd < -50000
        AND coalesce(category, '') NOT IN ('dex', 'contracts', 'safe', 'infrastructure')
    ) ranked_wallets
    WHERE rn <= 20
  `;
}

function buildCombinedTokenFlowSql() {
  return `
    WITH signed_transfers AS (
      SELECT concat('0x', lower(to_hex(contract_address))) AS token_address,
             symbol,
             concat('0x', lower(to_hex("to"))) AS wallet_address,
             amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex(contract_address))) AS token_address,
             symbol,
             concat('0x', lower(to_hex("from"))) AS wallet_address,
             -amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
    ),
    token_flows AS (
      SELECT token_address,
             arbitrary(symbol) AS symbol,
             coalesce(sum(usd_change), 0) AS net_usd,
             count(DISTINCT wallet_address) AS wallet_count
      FROM signed_transfers
      WHERE token_address <> '0x0000000000000000000000000000000000000000'
      GROUP BY 1
    )
    SELECT *
    FROM (
      SELECT 'token_accumulated' AS section,
             token_address,
             symbol,
             net_usd AS usd_value,
             wallet_count,
             row_number() OVER (ORDER BY net_usd DESC) AS rn
      FROM token_flows
      WHERE net_usd > 50000
      UNION ALL
      SELECT 'token_distributed' AS section,
             token_address,
             symbol,
             net_usd AS usd_value,
             wallet_count,
             row_number() OVER (ORDER BY net_usd ASC) AS rn
      FROM token_flows
      WHERE net_usd < -50000
    ) ranked_tokens
    WHERE rn <= 20
  `;
}

function buildWalletFlowSql(direction) {
  const filter = direction === "inflows" ? "net_usd > 50000" : "net_usd < -50000";
  const sort = direction === "inflows" ? "net_usd DESC" : "net_usd ASC";

  return `
    WITH signed_transfers AS (
      SELECT concat('0x', lower(to_hex("to"))) AS wallet_address,
             amount_usd AS usd_change,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex("from"))) AS wallet_address,
             -amount_usd AS usd_change,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
    ),
    active_wallets AS (
      SELECT DISTINCT wallet_address
      FROM signed_transfers
    ),
    wallet_labels AS (
      SELECT concat('0x', lower(to_hex(labels.address))) AS wallet_address,
             arbitrary(labels.name) AS label,
             arbitrary(labels.category) AS category
      FROM labels.addresses AS labels
      INNER JOIN active_wallets
        ON active_wallets.wallet_address = concat('0x', lower(to_hex(labels.address)))
      WHERE labels.blockchain = '${ETHEREUM_CHAIN}'
      GROUP BY 1
    ),
    wallet_flows AS (
      SELECT signed_transfers.wallet_address,
             arbitrary(wallet_labels.label) AS label,
             coalesce(sum(signed_transfers.usd_change), 0) AS net_usd,
             count(DISTINCT signed_transfers.tx_hash) AS tx_count
      FROM signed_transfers
      LEFT JOIN wallet_labels ON wallet_labels.wallet_address = signed_transfers.wallet_address
      WHERE coalesce(wallet_labels.category, '') NOT IN ('dex', 'contracts', 'safe', 'infrastructure')
      GROUP BY 1
    )
    SELECT wallet_address,
           label,
           net_usd AS usd_value,
           tx_count
    FROM wallet_flows
    WHERE ${filter}
    ORDER BY ${sort}
    LIMIT 20
  `;
}

function buildTokenFlowSql(direction) {
  const filter = direction === "accumulated" ? "net_usd > 50000" : "net_usd < -50000";
  const sort = direction === "accumulated" ? "net_usd DESC" : "net_usd ASC";

  return `
    WITH signed_transfers AS (
      SELECT concat('0x', lower(to_hex(contract_address))) AS token_address,
             symbol,
             concat('0x', lower(to_hex("to"))) AS wallet_address,
             amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex(contract_address))) AS token_address,
             symbol,
             concat('0x', lower(to_hex("from"))) AS wallet_address,
             -amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND amount_usd >= 10000
        AND block_time >= now() - interval '1' day
    )
    SELECT token_address,
           arbitrary(symbol) AS symbol,
           coalesce(sum(usd_change), 0) AS usd_value,
           count(DISTINCT wallet_address) AS wallet_count
    FROM signed_transfers
    WHERE token_address <> '0x0000000000000000000000000000000000000000'
    GROUP BY 1
    HAVING ${filter}
    ORDER BY ${sort}
    LIMIT 20
  `;
}

function buildLargeTransfersSql() {
  return `
    SELECT tx_hash,
           concat('0x', lower(to_hex("from"))) AS wallet_address,
           symbol AS token_symbol,
           amount_usd AS usd_value,
           block_time
    FROM tokens.transfers
    WHERE blockchain = '${ETHEREUM_CHAIN}'
      AND amount_usd IS NOT NULL
      AND amount_usd >= 100000
      AND block_time >= now() - interval '1' day
    ORDER BY amount_usd DESC
    LIMIT 30
  `;
}

function buildWalletSummarySql(address) {
  return `
    WITH wallet_transfers AS (
      SELECT amount_usd AS usd_change,
             block_time
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND "to" = ${evmAddressLiteral(address)}
        AND block_time >= now() - interval '7' day
      UNION ALL
      SELECT -amount_usd AS usd_change,
             block_time
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND amount_usd IS NOT NULL
        AND "from" = ${evmAddressLiteral(address)}
        AND block_time >= now() - interval '7' day
    ),
    wallet_label AS (
      SELECT arbitrary(name) AS label
      FROM labels.addresses
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND concat('0x', lower(to_hex(address))) = '${address}'
    )
    SELECT
      (SELECT label FROM wallet_label) AS label,
      coalesce(sum(CASE WHEN block_time >= now() - interval '1' day THEN usd_change ELSE 0 END), 0) AS netflow_24h_usd,
      coalesce(sum(usd_change), 0) AS netflow_7d_usd
    FROM wallet_transfers
  `;
}

function buildWalletTransfersSql(address) {
  return `
    SELECT tx_hash,
           CASE
             WHEN "to" = ${evmAddressLiteral(address)} THEN concat('0x', lower(to_hex("from")))
             ELSE concat('0x', lower(to_hex("to")))
           END AS wallet_address,
           symbol AS token_symbol,
           amount_usd AS usd_value,
           block_time
    FROM tokens.transfers
    WHERE blockchain = '${ETHEREUM_CHAIN}'
      AND amount_usd IS NOT NULL
      AND block_time >= now() - interval '30' day
      AND (
        "to" = ${evmAddressLiteral(address)}
        OR "from" = ${evmAddressLiteral(address)}
      )
    ORDER BY block_time DESC
    LIMIT 50
  `;
}

function buildTokenSummarySql(address) {
  return `
    WITH token_flows AS (
      SELECT concat('0x', lower(to_hex("to"))) AS wallet_address,
             symbol,
             amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND contract_address = ${evmAddressLiteral(address)}
        AND amount_usd IS NOT NULL
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex("from"))) AS wallet_address,
             symbol,
             -amount_usd AS usd_change
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND contract_address = ${evmAddressLiteral(address)}
        AND amount_usd IS NOT NULL
        AND block_time >= now() - interval '1' day
    ),
    wallet_net AS (
      SELECT wallet_address,
             arbitrary(symbol) AS symbol,
             coalesce(sum(usd_change), 0) AS net_usd
      FROM token_flows
      GROUP BY 1
    )
    SELECT
      coalesce(arbitrary(symbol), '???') AS symbol,
      CAST(NULL AS varchar) AS name,
      coalesce(sum(CASE WHEN net_usd >= 250000 THEN net_usd ELSE 0 END), 0) AS whale_buy_usd_24h,
      abs(coalesce(sum(CASE WHEN net_usd <= -250000 THEN net_usd ELSE 0 END), 0)) AS whale_sell_usd_24h
    FROM wallet_net
  `;
}

function buildTokenWhaleActivitySql(address) {
  return `
    WITH token_flows AS (
      SELECT concat('0x', lower(to_hex("to"))) AS wallet_address,
             amount_usd AS usd_change,
             symbol,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND contract_address = ${evmAddressLiteral(address)}
        AND amount_usd IS NOT NULL
        AND block_time >= now() - interval '1' day
      UNION ALL
      SELECT concat('0x', lower(to_hex("from"))) AS wallet_address,
             -amount_usd AS usd_change,
             symbol,
             tx_hash
      FROM tokens.transfers
      WHERE blockchain = '${ETHEREUM_CHAIN}'
        AND contract_address = ${evmAddressLiteral(address)}
        AND amount_usd IS NOT NULL
        AND block_time >= now() - interval '1' day
    ),
    active_wallets AS (
      SELECT DISTINCT wallet_address
      FROM token_flows
    ),
    wallet_labels AS (
      SELECT concat('0x', lower(to_hex(labels.address))) AS wallet_address,
             arbitrary(labels.name) AS label
      FROM labels.addresses AS labels
      INNER JOIN active_wallets
        ON active_wallets.wallet_address = concat('0x', lower(to_hex(labels.address)))
      WHERE labels.blockchain = '${ETHEREUM_CHAIN}'
      GROUP BY 1
    ),
    whale_activity AS (
      SELECT token_flows.wallet_address,
             arbitrary(wallet_labels.label) AS label,
             arbitrary(token_flows.symbol) AS token_symbol,
             coalesce(sum(token_flows.usd_change), 0) AS net_usd,
             count(DISTINCT token_flows.tx_hash) AS tx_count
      FROM token_flows
      LEFT JOIN wallet_labels ON wallet_labels.wallet_address = token_flows.wallet_address
      GROUP BY 1
    )
    SELECT wallet_address,
           label,
           token_symbol,
           net_usd AS usd_value,
           tx_count
    FROM whale_activity
    WHERE abs(net_usd) >= 100000
    ORDER BY abs(net_usd) DESC
    LIMIT 30
  `;
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    duneKeySet: DUNE_API_KEY.length > 0,
    queriesConfigured: getConfiguredQueries().length,
    rawSqlFallbackAvailable: DUNE_API_KEY.length > 0,
    queries: Object.fromEntries(
      Object.entries(Q).map(([key, value]) => [key, value > 0 ? value : "NOT SET"])
    ),
    cacheSize: cache.size,
  });
});

app.get("/api/onchain/overview", async (_req, res) => {
  try {
    const cached = getCached("overview");
    if (cached) {
      return res.json(cached);
    }

    if (!DUNE_API_KEY) {
      const payload = emptyOverviewPayload();
      setCached("overview", payload);
      return res.json(payload);
    }

    let payload;

    if (hasAllOverviewQueriesConfigured()) {
      const fetchers = {
        stablecoinNetflow: duneGetLatest(Q.stablecoinNetflow),
        topInflows: duneGetLatest(Q.topInflows),
        topOutflows: duneGetLatest(Q.topOutflows),
        accumulatedTokens: duneGetLatest(Q.accumulatedTokens),
        distributedTokens: duneGetLatest(Q.distributedTokens),
        largeTransfers: duneGetLatest(Q.largeTransfers),
      };

      const keys = Object.keys(fetchers);
      const results = await Promise.allSettled(Object.values(fetchers));
      const data = {};

      keys.forEach((key, index) => {
        if (results[index].status === "fulfilled") {
          data[key] = extractRows(results[index].value);
          return;
        }

        console.error(`Failed to fetch ${key}:`, results[index].reason?.message);
        data[key] = [];
      });

      const netflowRow = data.stablecoinNetflow?.[0];
      payload = {
        ts: new Date().toISOString(),
        metrics: {
          stablecoinNetflow: safeNum(
            netflowRow?.netflow_usd ?? netflowRow?.net_usd ?? netflowRow?.usd_value ?? 0
          ),
          totalInflows: mapWalletRows(data.topInflows).reduce(
            (sum, row) => sum + row.usd,
            0
          ),
          totalOutflows: mapWalletRows(data.topOutflows).reduce(
            (sum, row) => sum + row.usd,
            0
          ),
        },
        topInflows: mapWalletRows(data.topInflows).slice(0, 20),
        topOutflows: mapWalletRows(data.topOutflows).slice(0, 20),
        accumulatedTokens: mapTokenRows(data.accumulatedTokens).slice(0, 20),
        distributedTokens: mapTokenRows(data.distributedTokens).slice(0, 20),
        largeTransfers: mapTransferRows(data.largeTransfers).slice(0, 30),
      };
    } else {
      const stablecoinRows = await duneSqlRows(buildStablecoinNetflowSql(), 30, 2500);
      const walletRows = await duneSqlRows(buildCombinedWalletFlowSql(), 40, 2500);
      const tokenRows = await duneSqlRows(buildCombinedTokenFlowSql(), 40, 2500);
      const transferRows = await duneSqlRows(buildLargeTransfersSql(), 20, 2500);

      const topInflows = mapWalletRows(
        walletRows.filter((row) => row.section === "wallet_inflow")
      );
      const topOutflows = mapWalletRows(
        walletRows.filter((row) => row.section === "wallet_outflow")
      );
      const accumulatedTokens = mapTokenRows(
        tokenRows.filter((row) => row.section === "token_accumulated")
      );
      const distributedTokens = mapTokenRows(
        tokenRows.filter((row) => row.section === "token_distributed")
      );

      payload = {
        ts: new Date().toISOString(),
        metrics: {
          stablecoinNetflow: safeNum(
            stablecoinRows[0]?.netflow_usd ??
              stablecoinRows[0]?.net_usd ??
              stablecoinRows[0]?.usd_value
          ),
          totalInflows: topInflows.reduce((sum, row) => sum + row.usd, 0),
          totalOutflows: topOutflows.reduce((sum, row) => sum + row.usd, 0),
        },
        topInflows,
        topOutflows,
        accumulatedTokens,
        distributedTokens,
        largeTransfers: mapTransferRows(transferRows).slice(0, 30),
      };
    }

    setCached("overview", payload);
    return res.json(payload);
  } catch (error) {
    console.error("overview error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/onchain/wallet/:address", async (req, res) => {
  try {
    if (!DUNE_API_KEY) {
      return res.status(501).json({ error: "DUNE_API_KEY is not set." });
    }

    const { address } = req.params;
    if (!isValidEvmAddress(address)) {
      return res.status(400).json({ error: "Invalid wallet address." });
    }

    const normalizedAddress = normalizeEvmAddress(address);
    const cacheKey = `wallet:${address}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let summaryRows;
    let transferRows;

    if (Q.walletSummary && Q.walletTransfers) {
      const [summaryExecution, transfersExecution] = await Promise.all([
        duneExecute(Q.walletSummary, { wallet_address: normalizedAddress }),
        duneExecute(Q.walletTransfers, { wallet_address: normalizedAddress }),
      ]);

      const [summaryResult, transfersResult] = await Promise.all([
        dunePoll(summaryExecution.execution_id),
        dunePoll(transfersExecution.execution_id),
      ]);

      summaryRows = extractRows(summaryResult);
      transferRows = extractRows(transfersResult);
    } else {
      [summaryRows, transferRows] = await Promise.all([
        duneSqlRows(buildWalletSummarySql(normalizedAddress)),
        duneSqlRows(buildWalletTransfersSql(normalizedAddress)),
      ]);
    }

    const summary = summaryRows[0] ?? {};
    const payload = {
      address: normalizedAddress,
      label: summary.label ?? summary.entity ?? null,
      netflow24h: safeNum(summary.netflow_24h_usd ?? summary.net_usd_24h),
      netflow7d: safeNum(summary.netflow_7d_usd ?? summary.net_usd_7d),
      transfers: mapTransferRows(transferRows).slice(0, 50),
    };

    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error("wallet error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/onchain/token/:address", async (req, res) => {
  try {
    if (!DUNE_API_KEY) {
      return res.status(501).json({ error: "DUNE_API_KEY is not set." });
    }

    const { address } = req.params;
    if (!isValidEvmAddress(address)) {
      return res.status(400).json({ error: "Invalid token address." });
    }

    const normalizedAddress = normalizeEvmAddress(address);
    const cacheKey = `token:${address}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let summaryRows;
    let whaleRows;

    if (Q.tokenSummary && Q.tokenWhaleActivity) {
      const [summaryExecution, whalesExecution] = await Promise.all([
        duneExecute(Q.tokenSummary, { token_address: normalizedAddress }),
        duneExecute(Q.tokenWhaleActivity, { token_address: normalizedAddress }),
      ]);

      const [summaryResult, whalesResult] = await Promise.all([
        dunePoll(summaryExecution.execution_id),
        dunePoll(whalesExecution.execution_id),
      ]);

      summaryRows = extractRows(summaryResult);
      whaleRows = extractRows(whalesResult);
    } else {
      [summaryRows, whaleRows] = await Promise.all([
        duneSqlRows(buildTokenSummarySql(normalizedAddress)),
        duneSqlRows(buildTokenWhaleActivitySql(normalizedAddress)),
      ]);
    }

    const summary = summaryRows[0] ?? {};
    const payload = {
      address: normalizedAddress,
      symbol: summary.symbol ?? summary.token_symbol ?? "???",
      name: summary.name ?? null,
      whaleBuys24h: safeNum(summary.whale_buy_usd_24h),
      whaleSells24h: safeNum(summary.whale_sell_usd_24h),
      whaleActivity: mapWalletRows(whaleRows).slice(0, 30),
    };

    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error("token error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get(["/on-chain", "/on-chain.html", "/onchain"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "onchain.html"));
});

app.listen(PORT, () => {
  console.log(`Market Intel running on port ${PORT}`);
  console.log(
    `On-chain queries configured: ${getConfiguredQueries().length}/${Object.keys(Q).length}`
  );
  if (!DUNE_API_KEY) {
    console.warn("DUNE_API_KEY is not set. Overview will stay in local placeholder mode.");
  } else {
    console.log("Raw Dune SQL fallback is available for any unset DUNE_Q_* values.");
  }
});
