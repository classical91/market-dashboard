const { createServiceError } = require("../utils/errors");
const { normalizeAddress } = require("../utils/validators");

class DefiLlamaService {
  constructor(config) {
    this.config = config;
  }

  async getStablecoinNetflow(tokens, chainName) {
    const payload = await this.requestJson(this.config.baseUrl, "/stablecoins?includePrices=true");
    const assets = Array.isArray(payload.peggedAssets) ? payload.peggedAssets : [];

    return tokens.reduce((total, token) => {
      const asset = assets.find((item) => item.symbol === token.symbol);
      if (!asset) {
        return total;
      }

      const chain = asset.chainCirculating?.[chainName];
      const current = Number(chain?.current?.peggedUSD ?? asset.circulating?.peggedUSD ?? 0);
      const previous = Number(
        chain?.circulatingPrevDay?.peggedUSD ?? asset.circulatingPrevDay?.peggedUSD ?? current,
      );

      return total + (current - previous);
    }, 0);
  }

  async getTokenPrices(addresses, chainSlug = this.config.coinChain) {
    const normalizedAddresses = Array.from(
      new Set(addresses.map((address) => normalizeAddress(address)).filter(Boolean)),
    );

    if (normalizedAddresses.length === 0) {
      return new Map();
    }

    const coins = normalizedAddresses.map((address) => `${chainSlug}:${address}`);
    const payload = await this.requestJson(
      this.config.coinsBaseUrl,
      `/prices/current/${coins.join(",")}`,
    );

    const items = payload.coins || {};
    return new Map(
      normalizedAddresses.map((address) => {
        const key = `${chainSlug}:${address}`;
        return [address, Number(items[key]?.price ?? 0)];
      }),
    );
  }

  async requestJson(baseUrl, pathname) {
    const url = new URL(pathname, baseUrl);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw createServiceError(
        `DefiLlama API ${response.status}: ${payload?.message || response.statusText}`,
        response.status,
      );
    }

    return payload;
  }
}

module.exports = { DefiLlamaService };
