const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MarketDataService } = require("../src/services/market-data");
const { ProviderRequestCache } = require("../src/services/provider-request-cache");
const { PersistentReporterCache } = require("../src/services/persistent-cache");

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const options = { requestIntervalMs: 0, retryCount: 0 };
const coin = { id: "bitcoin", current_price: 97000, price_change_percentage_24h: 2, total_volume: 1e9 };

test("concurrent readers and Overview ranges share crypto/global requests, charts stay distinct", async t => {
  const urls = [];
  t.mock.method(global, "fetch", async url => {
    urls.push(url);
    if (url.includes("/coins/markets")) return json([coin]);
    if (url.endsWith("/global")) return json({ data: { market_cap_percentage: { btc: 60 } } });
    return json({ prices: [[1000, 100], [2000, 110]] });
  });
  const service = new MarketDataService(options);
  const read = range => Promise.all([service.getCryptoPrices(), service.getGlobalDominance(), service.getMarketChart(range)]);
  await Promise.all([read("1D"), read("1W"), read("1D")]);
  await read("1D");
  assert.equal(urls.length, 4);
  assert.equal(urls.filter(url => url.includes("/coins/markets")).length, 1);
  assert.equal(urls.filter(url => url.endsWith("/global")).length, 1);
});

test("429 stops retries and queued endpoints until the full Retry-After, then recovers", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  let healthy = true;
  t.mock.method(global, "fetch", async url => {
    calls++;
    if (!healthy) return json({ error: "rate limit" }, 429, { "Retry-After": "3600" });
    return url.includes("/coins/markets") ? json([coin]) : json({ prices: [[1000, 100], [2000, 110]] });
  });
  const service = new MarketDataService({ ...options, retryCount: 3, cacheMs: 100 });
  await service.getCryptoPrices();
  now += 101;
  healthy = false;
  const [crypto, chart, globalData] = await Promise.all([
    service.getCryptoPrices(), service.getMarketChart(), service.getGlobalDominance(),
  ]);
  assert.equal(calls, 2, "only the first of the queued requests reaches CoinGecko, with no immediate retries");
  assert.equal(crypto.stale, true);
  assert.equal(crypto.live, false);
  assert.equal(crypto.items[0].price, 97000);
  assert.equal(chart.source, "fallback");
  assert.match(globalData.error, /rate limited; retrying after/);
  now += 3_599_999;
  await service.getMarketChart();
  assert.equal(calls, 2);
  now++;
  healthy = true;
  assert.equal((await service.getCryptoPrices()).live, true);
  assert.equal(calls, 3);
});

test("cooldown leaves fresh cache available and consecutive 429s increase backoff", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const gate = new ProviderRequestCache({ intervalMs: 0, cooldownMs: 1000 });
  await gate.get("cached", 10000, async () => "good");
  const limited = () => { throw Object.assign(new Error("limit"), { statusCode: 429 }); };
  await assert.rejects(gate.get("a", 0, limited));
  assert.equal(await gate.get("cached", 10000, () => assert.fail("should use cache")), "good");
  assert.equal(gate.cooldownUntil, now + 1000);
  now += 1000;
  await assert.rejects(gate.get("b", 0, limited));
  assert.equal(gate.cooldownUntil, now + 2000);
  now += 2000;
  assert.equal(await gate.get("recovered", 0, async () => "ok"), "ok");
  assert.equal(gate.rateLimitCount, 0);
});

test("requests to different provider endpoints are spaced", async () => {
  const gate = new ProviderRequestCache({ intervalMs: 25 });
  const times = [];
  const load = async () => { times.push(Date.now()); return {}; };
  await Promise.all([gate.get("a", 0, load), gate.get("b", 0, load)]);
  assert.ok(times[1] - times[0] >= 20, "initial calls must not burst together");
});

test("HTTP-date Retry-After is honored and 5xx remains retryable", async t => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    if (calls === 1) return json({}, 503, { "Retry-After": "0" });
    return json({}, 429, { "Retry-After": "Sun, 22 Nov 2026 12:10:00 GMT" });
  });
  const service = new MarketDataService({ ...options, retryCount: 1 });
  await service.getCryptoPrices();
  assert.equal(calls, 2);
  assert.equal(service.providerRequests.cooldownUntil, now + 600_000);
});

test("live snapshots survive a restart but cannot be served beyond the stale limit", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-snapshots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshots.json");
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(global, "fetch", async () => json([coin]));
  const first = new MarketDataService({ ...options, staleMaxAgeMs: 1000, snapshotCache: new PersistentReporterCache(file) });
  await first.getCryptoPrices();
  now += 500;
  const restarted = new MarketDataService({ ...options, staleMaxAgeMs: 1000, snapshotCache: new PersistentReporterCache(file) });
  global.fetch = async () => json({}, 429);
  const stale = await restarted.getCryptoPrices();
  assert.equal(stale.stale, true);
  assert.equal(stale.items[0].price, 97000);
  assert.equal(stale.fetchedAt, new Date(now - 500).toISOString());
  now += 501;
  assert.equal((await restarted.getCryptoPrices()).stale, undefined);
});

test("news uses Finnhub without an explicit feed, coalesces calls, and retains stale headlines", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(global, "fetch", async url => {
    calls++;
    assert.match(url, /\/news\?category=general&token=test-key/);
    return calls === 1
      ? json([{ headline: "Market headline", source: "Publisher", url: "https://news.example/a", datetime: 1795348800 }])
      : json({ error: "offline" }, 503);
  });
  const service = new MarketDataService({ ...options, finnhubApiKey: "test-key", newsCacheMs: 100 });
  const [first, second] = await Promise.all([service.getNews(), service.getNews()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.source, "finnhub");
  assert.equal(first.live, true);
  assert.equal(first.items[0].publishedAt, "2026-11-22T12:00:00.000Z");
  now += 101;
  const stale = await service.getNews();
  assert.equal(stale.stale, true);
  assert.equal(stale.live, false);
  assert.equal(stale.items[0].title, "Market headline");
});

test("configured news URL takes priority; an empty response cannot replace last good headlines", async t => {
  let empty = false;
  t.mock.method(global, "fetch", async url => {
    assert.equal(url, "https://feed.example/news");
    return json(empty ? [] : [{ title: "Real headline" }]);
  });
  const service = new MarketDataService({ ...options, newsUrl: "https://feed.example/news", finnhubApiKey: "key", newsCacheMs: 0 });
  assert.equal((await service.getNews()).source, "market_news_url");
  empty = true;
  const result = await service.getNews();
  assert.equal(result.stale, true);
  assert.equal(result.items[0].title, "Real headline");
});
