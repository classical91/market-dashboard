const { createServiceError } = require("../utils/errors");
const {
  formatUsdAmount,
  getCounterpartyAddress,
  isAddress,
  normalizeAddress,
  toDateIsoString,
} = require("../utils/mappers");

const DEFAULT_END_BLOCK = "latest";
const MAX_BLOCK_NUMBER = 9999999999;

class OnchainService {
  constructor({ cache, config, defillamaService, etherscanService, covalentService }) {
    this.cache = cache;
    this.config = config;
    this.defillamaService = defillamaService;
    this.etherscanService = etherscanService;
    this.covalentService = covalentService;
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  async getOverview() {
    return this.cache.getOrLoad("onchain:overview", this.config.overviewCacheMs, async () => {
      const stablecoinNetflow = await this.defillamaService.getStablecoinNetflow(
        this.config.trackedTokens,
        this.config.defillamaChain,
      );

      if (!this.covalentService.isConfigured()) {
        return this.createOverviewPayload({
          stablecoinNetflow,
          topInflows: [],
          topOutflows: [],
          accumulatedTokens: [],
          distributedTokens: [],
          largeTransfers: [],
          metaSource: "defillama-fallback",
        });
      }

      const cutoffTimestamp = Math.floor(Date.now() / 1000) - this.config.overviewLookbackHours * 3600;
      const [priceMap, startBlock] = await Promise.all([
        this.defillamaService.getTokenPrices(
          this.config.trackedTokens.map((token) => token.contractAddress),
          this.config.defillamaCoinChain,
        ),
        this.getOptionalStartBlock(cutoffTimestamp),
      ]);

      const transfers = await this.getTrackedTokenTransfers({
        cutoffTimestamp,
        pageLimit: this.config.overviewPageLimit,
        pageSize: this.config.pageSize,
        priceMap,
        startBlock,
      });

      const walletFlows = this.aggregateWalletFlows(transfers);
      const tokenTotals = this.aggregateTokenTotals(transfers);
      const topInflows = walletFlows
        .filter((row) => row.usd > 0)
        .sort((left, right) => right.usd - left.usd)
        .slice(0, this.config.maxWalletRows);
      const topOutflows = walletFlows
        .filter((row) => row.usd < 0)
        .sort((left, right) => left.usd - right.usd)
        .slice(0, this.config.maxWalletRows);
      const accumulatedTokens = tokenTotals
        .filter((row) => row.usd > 0)
        .sort((left, right) => right.usd - left.usd)
        .slice(0, this.config.maxTokenRows);
      const distributedTokens = tokenTotals
        .filter((row) => row.usd < 0)
        .sort((left, right) => left.usd - right.usd)
        .slice(0, this.config.maxTokenRows);
      const largeTransfers = transfers
        .filter((transfer) => transfer.usd >= this.config.largeTransferThresholdUsd)
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, this.config.maxLargeTransfers)
        .map((transfer) => ({
          txHash: transfer.txHash,
          address: transfer.from,
          token: transfer.tokenSymbol,
          usd: transfer.usd,
          time: transfer.time,
        }));

      return this.createOverviewPayload({
        stablecoinNetflow,
        topInflows,
        topOutflows,
        accumulatedTokens,
        distributedTokens,
        largeTransfers,
        metaSource: this.etherscanService.isConfigured()
          ? "defillama-covalent-etherscan"
          : "defillama-covalent",
      });
    });
  }

  async getWallet(address) {
    if (!this.etherscanService.isConfigured()) {
      throw createServiceError("Etherscan API key is not configured yet.", 503);
    }

    const normalizedAddress = normalizeAddress(address);
    return this.cache.getOrLoad(
      `onchain:wallet:${normalizedAddress}`,
      this.config.detailCacheMs,
      async () => {
        const cutoff24h = Math.floor(Date.now() / 1000) - 24 * 3600;
        const cutoff7d = Math.floor(Date.now() / 1000) - this.config.detailLookbackDays * 24 * 3600;

        const [priceMap, startBlock] = await Promise.all([
          this.defillamaService.getTokenPrices(
            this.config.trackedTokens.map((token) => token.contractAddress),
            this.config.defillamaCoinChain,
          ),
          this.requireStartBlock(cutoff7d),
        ]);

        const transfers = await this.getAddressTransfers(normalizedAddress, cutoff7d, priceMap, startBlock);
        const netflow24h = this.computeNetflowForAddress(normalizedAddress, transfers, cutoff24h);
        const netflow7d = this.computeNetflowForAddress(normalizedAddress, transfers, cutoff7d);
        const recentTransfers = transfers
          .slice()
          .sort((left, right) => right.timestamp - left.timestamp)
          .slice(0, this.config.maxDetailTransfers)
          .map((transfer) => ({
            txHash: transfer.txHash,
            address: getCounterpartyAddress(normalizedAddress, transfer.from, transfer.to),
            token: transfer.tokenSymbol,
            usd: transfer.usd,
            time: transfer.time,
          }))
          .filter((transfer) => transfer.address);

        return {
          address: normalizedAddress,
          label: null,
          netflow24h,
          netflow7d,
          transfers: recentTransfers,
        };
      },
    );
  }

  async getToken(address) {
    if (!this.covalentService.isConfigured()) {
      throw createServiceError("Covalent API key is not configured yet.", 503);
    }

    const normalizedAddress = normalizeAddress(address);
    return this.cache.getOrLoad(
      `onchain:token:${normalizedAddress}`,
      this.config.detailCacheMs,
      async () => {
        const cutoff24h = Math.floor(Date.now() / 1000) - 24 * 3600;
        const [priceMap, startBlock] = await Promise.all([
          this.defillamaService.getTokenPrices([normalizedAddress], this.config.defillamaCoinChain),
          this.getOptionalStartBlock(cutoff24h),
        ]);

        const trackedToken = this.getTrackedToken(normalizedAddress);
        const priceUsd = priceMap.get(normalizedAddress) || (trackedToken ? 1 : 0);
        const token = trackedToken || {
          symbol: "TOKEN",
          name: null,
          contractAddress: normalizedAddress,
          decimals: 18,
        };

        const transfers = await this.getContractTransfers({
          token,
          cutoffTimestamp: cutoff24h,
          pageLimit: this.config.tokenPageLimit,
          pageSize: this.config.pageSize,
          priceUsd,
          startBlock,
        });

        const resolvedToken = transfers[0]
          ? {
              ...token,
              symbol: transfers[0].tokenSymbol || token.symbol,
              name: transfers[0].tokenName || token.name,
            }
          : token;

        const whaleFlows = this.aggregateWalletFlows(transfers)
          .filter((row) => Math.abs(row.usd) >= this.config.whaleThresholdUsd)
          .sort((left, right) => Math.abs(right.usd) - Math.abs(left.usd))
          .slice(0, this.config.maxWalletRows);

        return {
          address: normalizedAddress,
          symbol: resolvedToken.symbol,
          name: resolvedToken.name,
          whaleBuys24h: whaleFlows
            .filter((row) => row.usd > 0)
            .reduce((total, row) => total + row.usd, 0),
          whaleSells24h: Math.abs(
            whaleFlows
              .filter((row) => row.usd < 0)
              .reduce((total, row) => total + row.usd, 0),
          ),
          whaleActivity: whaleFlows,
        };
      },
    );
  }

  createOverviewPayload({
    stablecoinNetflow,
    topInflows,
    topOutflows,
    accumulatedTokens,
    distributedTokens,
    largeTransfers,
    metaSource,
  }) {
    return {
      ts: new Date().toISOString(),
      metrics: {
        stablecoinNetflow,
        totalInflows: topInflows
          .filter((row) => row.usd > 0)
          .reduce((total, row) => total + row.usd, 0),
        totalOutflows: topOutflows
          .filter((row) => row.usd < 0)
          .reduce((total, row) => total + row.usd, 0),
      },
      topInflows,
      topOutflows,
      accumulatedTokens,
      distributedTokens,
      largeTransfers,
      meta: {
        source: metaSource,
      },
    };
  }

  async getTrackedTokenTransfers({ cutoffTimestamp, pageLimit, pageSize, priceMap, startBlock }) {
    const tokenTransfers = await Promise.all(
      this.config.trackedTokens.map((token) =>
        this.getContractTransfers({
          token,
          cutoffTimestamp,
          pageLimit,
          pageSize,
          priceUsd: priceMap.get(token.contractAddress) || 1,
          startBlock,
        }),
      ),
    );

    return tokenTransfers.flat();
  }

  async getContractTransfers({ token, cutoffTimestamp, pageLimit, pageSize, priceUsd, startBlock }) {
    const items = [];

    for (let pageNumber = 0; pageNumber < pageLimit; pageNumber += 1) {
      const { items: rows, pagination } = await this.covalentService.getLogEventsByContract({
        contractAddress: token.contractAddress,
        startBlock,
        endBlock: DEFAULT_END_BLOCK,
        pageSize,
        pageNumber,
      });

      const mapped = rows
        .map((row) => this.mapCovalentTransferRow(row, token, priceUsd))
        .filter((row) => row && row.timestamp >= cutoffTimestamp);

      items.push(...mapped);

      if (!pagination?.has_more || rows.length < pageSize) {
        break;
      }
    }

    return items;
  }

  async getAddressTransfers(address, cutoffTimestamp, priceMap, startBlock) {
    const tokenTransfers = await Promise.all(
      this.config.trackedTokens.map(async (token) => {
        const rows = await this.etherscanService.getTokenTransfers({
          contractAddress: token.contractAddress,
          address,
          startBlock,
          endBlock: MAX_BLOCK_NUMBER,
          page: 1,
          offset: this.config.detailPageSize,
          sort: "desc",
        });

        return rows
          .map((row) => this.mapEtherscanTransferRow(row, token, priceMap.get(token.contractAddress) || 1))
          .filter((row) => row && row.timestamp >= cutoffTimestamp);
      }),
    );

    return tokenTransfers.flat();
  }

  mapCovalentTransferRow(row, token, priceUsd) {
    const params = Array.isArray(row.decoded?.params) ? row.decoded.params : [];
    const from = normalizeAddress(this.getDecodedParamValue(params, "from"));
    const to = normalizeAddress(this.getDecodedParamValue(params, "to"));
    const rawValue = this.getDecodedParamValue(params, "value");
    const timestamp = Math.floor(new Date(row.block_signed_at).getTime() / 1000);

    if (!from || !to || !rawValue || !Number.isFinite(timestamp) || timestamp <= 0) {
      return null;
    }

    const decimals = Number.parseInt(row.sender_contract_decimals ?? token.decimals, 10);

    return {
      txHash: row.tx_hash,
      from,
      to,
      tokenAddress: normalizeAddress(row.sender_address) || token.contractAddress,
      tokenSymbol: row.sender_contract_ticker_symbol || token.symbol,
      tokenName: row.sender_name || token.name,
      usd: formatUsdAmount(rawValue, decimals, priceUsd),
      timestamp,
      time: toDateIsoString(timestamp),
    };
  }

  mapEtherscanTransferRow(row, token, priceUsd) {
    const from = normalizeAddress(row.from);
    const to = normalizeAddress(row.to);
    if (!from && !to) {
      return null;
    }

    const decimals = Number.parseInt(row.tokenDecimal || token.decimals, 10);
    const timestamp = Number.parseInt(row.timeStamp, 10);

    return {
      txHash: row.hash,
      from,
      to,
      tokenAddress: normalizeAddress(row.contractAddress) || token.contractAddress,
      tokenSymbol: row.tokenSymbol || token.symbol,
      tokenName: row.tokenName || token.name,
      usd: formatUsdAmount(row.value, decimals, priceUsd),
      timestamp,
      time: toDateIsoString(timestamp),
    };
  }

  aggregateWalletFlows(transfers) {
    const rowsByAddress = new Map();

    const apply = (address, delta, tokenSymbol) => {
      if (!isAddress(address) || this.isIgnoredAddress(address)) {
        return;
      }

      const existing = rowsByAddress.get(address) || {
        address,
        label: null,
        token: tokenSymbol || null,
        usd: 0,
        txCount: 0,
      };

      existing.usd += delta;
      existing.txCount += 1;
      if (!existing.token && tokenSymbol) {
        existing.token = tokenSymbol;
      }

      rowsByAddress.set(address, existing);
    };

    for (const transfer of transfers) {
      apply(transfer.from, -transfer.usd, transfer.tokenSymbol);
      apply(transfer.to, transfer.usd, transfer.tokenSymbol);
    }

    return Array.from(rowsByAddress.values()).filter((row) => row.usd !== 0);
  }

  aggregateTokenTotals(transfers) {
    const rowsByToken = new Map();

    const add = (tokenAddress, tokenSymbol, usd, directionAddress) => {
      if (!tokenAddress) {
        return;
      }

      const existing = rowsByToken.get(tokenAddress) || {
        address: tokenAddress,
        symbol: tokenSymbol || "TOKEN",
        usd: 0,
        walletSet: new Set(),
      };

      existing.usd += usd;
      if (directionAddress && isAddress(directionAddress) && !this.isIgnoredAddress(directionAddress)) {
        existing.walletSet.add(directionAddress);
      }

      rowsByToken.set(tokenAddress, existing);
    };

    for (const transfer of transfers) {
      add(transfer.tokenAddress, transfer.tokenSymbol, transfer.usd, transfer.to);
      add(transfer.tokenAddress, transfer.tokenSymbol, -transfer.usd, transfer.from);
    }

    return Array.from(rowsByToken.values())
      .map((row) => ({
        address: row.address,
        symbol: row.symbol,
        usd: row.usd,
        walletCount: row.walletSet.size,
      }))
      .filter((row) => row.usd !== 0);
  }

  computeNetflowForAddress(address, transfers, cutoffTimestamp) {
    return transfers.reduce((total, transfer) => {
      if (transfer.timestamp < cutoffTimestamp) {
        return total;
      }
      if (transfer.to === address) {
        return total + transfer.usd;
      }
      if (transfer.from === address) {
        return total - transfer.usd;
      }
      return total;
    }, 0);
  }

  async getOptionalStartBlock(cutoffTimestamp) {
    if (!this.etherscanService.isConfigured()) {
      return null;
    }

    return this.etherscanService.getBlockNumberByTimestamp(cutoffTimestamp);
  }

  async requireStartBlock(cutoffTimestamp) {
    const blockNumber = await this.getOptionalStartBlock(cutoffTimestamp);
    if (!Number.isFinite(blockNumber)) {
      throw createServiceError("Unable to resolve a block height for the requested time window.", 502);
    }

    return blockNumber;
  }

  getTrackedToken(address) {
    return this.config.trackedTokens.find((token) => token.contractAddress === address) || null;
  }

  getDecodedParamValue(params, name) {
    return params.find((param) => String(param.name).toLowerCase() === name)?.value || null;
  }

  isIgnoredAddress(address) {
    return this.config.ignoredAddresses.includes(address);
  }
}

module.exports = { OnchainService };
