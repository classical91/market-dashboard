const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AIAnalysisService } = require("../src/services/ai-analysis");
const { PRESET_CATEGORIES, inferPresetCategory } = require("../src/config/market-symbols");

function createService(presets) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-analysis-categories-"));
  const service = new AIAnalysisService({
    cache: { get() { return null; }, set() {} },
    dataDir,
    presets,
  });
  return { service, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("default presets split into crypto, dominance, and stock categories", (t) => {
  const { service, cleanup } = createService();
  t.after(cleanup);

  assert.deepEqual(service.categories.map((category) => category.key), ["crypto", "dominance", "stocks"]);

  const byCategory = {};
  service.presets.forEach((preset) => {
    byCategory[preset.category] = byCategory[preset.category] || [];
    byCategory[preset.category].push(preset.label);
  });

  // Every preset lands in exactly one of the three declared categories.
  assert.deepEqual(Object.keys(byCategory).sort(), ["crypto", "dominance", "stocks"]);
  assert.deepEqual(byCategory.crypto, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(byCategory.dominance, ["BTC.D", "ETH.D", "USDT.D", "OTHERS.D", "TOTAL", "TOTAL2", "TOTAL3"]);
  assert.deepEqual(byCategory.stocks, ["DXY", "S&P 500", "Gold", "US 2Y", "VIX", "EUR/USD"]);
});

test("overrides keep an explicit category and infer a missing one", (t) => {
  const { service, cleanup } = createService([
    { symbol: "BINANCE:XRPUSDT", label: "XRPUSDT", interval: "1h" },
    { symbol: "CRYPTOCAP:BTC.D", label: "BTC.D", interval: "1D" },
    { symbol: "NASDAQ:IXIC", label: "Nasdaq", interval: "4h" },
    { symbol: "TVC:GOLD", label: "Gold", interval: "4h", category: "crypto" },
  ]);
  t.after(cleanup);

  assert.deepEqual(service.presets.map((preset) => preset.category), [
    "crypto",
    "dominance",
    "stocks",
    // An explicit category wins over what the symbol would imply.
    "crypto",
  ]);
});

test("inference falls back to stocks for unrecognized symbols", () => {
  assert.equal(inferPresetCategory("BYBIT:SOLUSDT.P"), "crypto");
  assert.equal(inferPresetCategory("BTCUSDT"), "crypto");
  assert.equal(inferPresetCategory("CRYPTOCAP:TOTAL3"), "dominance");
  assert.equal(inferPresetCategory("OANDA:XAUUSD"), "stocks");
  assert.equal(inferPresetCategory("SPX"), "stocks");
  assert.equal(inferPresetCategory(""), "stocks");
});

test("every category has a label the page can render", () => {
  PRESET_CATEGORIES.forEach((category) => {
    assert.ok(category.key, "category needs a key");
    assert.ok(category.label, `category ${category.key} needs a label`);
  });
});
