const test = require("node:test");
const assert = require("node:assert/strict");
const { OnchainService } = require("../src/services/onchain");
const { CovalentService } = require("../src/services/covalent");
const { MemoryCache } = require("../src/services/cache");

test("first exhausted-token response stops the scan, blocks details, and keeps Etherscan/DefiLlama available", async t => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let covalentCalls = 0;
  let etherscanCalls = 0;
  const token = { contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 };
  const service = new OnchainService({
    cache: new MemoryCache(),
    config: {
      overviewCacheMs: 0, cooldownCacheMs: 600_000, overviewLookbackHours: 6,
      overviewPageLimit: 1, pageSize: 50, trackedTokens: [token, { ...token, symbol: "USDT" }],
      covalentCreditCooldownMs: 1800_000, covalentRateCooldownMs: 120_000,
      maxWalletRows: 10, maxTokenRows: 10, maxLargeTransfers: 10,
      ignoredAddresses: [],
    },
    defillamaService: {
      getStablecoinNetflow: async () => ({ netflow24h: 123 }),
      getTokenPrices: async () => new Map(),
    },
    etherscanService: {
      isConfigured: () => true,
      getBlockNumberByTimestamp: async () => 100,
      getTokenTransfers: async () => { etherscanCalls++; return []; },
    },
    covalentService: {
      isConfigured: () => true,
      getLogEventsByContract: async () => {
        covalentCalls++;
        throw Object.assign(new Error("Covalent credits exhausted"), { statusCode: 402, retryAfterMs: 7200_000 });
      },
    },
  });
  const first = await service.getOverview();
  assert.equal(covalentCalls, 1, "the second tracked token must not hit an exhausted account");
  assert.equal(etherscanCalls, 2);
  assert.equal(first.meta.source, "defillama-etherscan");
  assert.match(first.meta.note, /Covalent wallet\/token feed paused/);
  assert.match(first.meta.note, /Tracked-token flows served via Etherscan/);
  assert.equal(service.covalentCooldownUntil, now + 7200_000);
  await assert.rejects(service.getContractTransfers({ token, pageLimit: 1 }), /paused/);
  assert.equal(covalentCalls, 1, "token details must honor the shared pause");
  const second = await service.getOverview();
  assert.equal(second.meta.source, "defillama-etherscan");
  assert.equal(covalentCalls, 1);
});

test("Covalent forwards Retry-After and preserves 402/429 returned inside a successful HTTP response", async t => {
  const service = new CovalentService({ apiKey: "test", baseUrl: "https://covalent.example", requestTimeoutMs: 1000, retryCount: 2 });
  let calls = 0;
  let status = 402;
  let httpStatus = 200;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: true, error_code: status, error_message: "Budget unavailable" }), {
      status: httpStatus, headers: { "Retry-After": "3600" },
    });
  });
  for (const code of [402, 429]) {
    status = code;
    await assert.rejects(service.request({ pathname: "/v1/test" }), error => {
      assert.equal(error.statusCode, code);
      assert.equal(error.retryAfterMs, 3600_000);
      return true;
    });
  }
  httpStatus = 429;
  await assert.rejects(service.request({ pathname: "/v1/test" }), error => error.retryAfterMs === 3600_000);
  assert.equal(calls, 3, "budget errors must never be immediately retried");
});
