const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AIAnalysisService } = require("../src/services/ai-analysis");

test("preset analysis captures TradingView with Playwright and sends PNG bytes inline", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-analysis-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const screenshot = Buffer.from("png fixture");
  let capturedUrl;
  let request;
  let cached;
  const service = new AIAnalysisService({
    cache: {
      get() { return cached || null; },
      set(_key, value) { cached = value; },
    },
    dataDir,
    openaiApiKey: "test-key",
    presets: [{ symbol: "BINANCE:BTCUSDT", label: "BTCUSDT", interval: "4h" }],
    captureService: { async capture(url) { capturedUrl = url; return screenshot; } },
    screenshotDir: path.join(dataDir, "screenshots"),
  });
  service._client = {
    responses: {
      async create(input) {
        request = input;
        return { output_text: "Trend is neutral. HOLD" };
      },
    },
  };

  const result = await service.generate("BINANCE:BTCUSDT", "4h", 1000, "https://dashboard.example");

  assert.equal(capturedUrl, "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=240");
  const image = request.input[0].content.find((item) => item.type === "input_image");
  assert.equal(image.image_url, `data:image/png;base64,${screenshot.toString("base64")}`);
  assert.match(result.chartUrl, /^https:\/\/dashboard\.example\/ai-analysis-screenshots\//);
  assert.equal(result.verdict, "HOLD");
  assert.equal(Object.hasOwn(result, "screenshotPath"), false);
  assert.equal(Object.hasOwn(service.peekAll()[0], "screenshotPath"), false);
});
