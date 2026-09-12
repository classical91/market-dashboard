const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LayoutAnalysisService } = require("../src/services/layout-analysis");

test("layout analysis sends captured PNG bytes inline to OpenAI", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-analysis-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const screenshot = Buffer.from("png fixture");
  let request;
  const cache = {
    get() { return null; },
    set() {},
  };
  const service = new LayoutAnalysisService({
    cache,
    dataDir,
    openaiApiKey: "test-key",
    layouts: [{ id: "btc-4h", label: "BTC 4h", url: "https://example.com/chart" }],
    captureService: { async capture() { return screenshot; } },
    screenshotDir: path.join(dataDir, "layout-screenshots"),
    screenshotUrlPrefix: "/layout-screenshots",
  });
  service._client = {
    responses: {
      async create(input) {
        request = input;
        return { output_text: "Trend is neutral. HOLD" };
      },
    },
  };

  const result = await service.generate("btc-4h", 30 * 60 * 1000, "https://dashboard.example");

  const image = request.input[0].content.find((item) => item.type === "input_image");
  assert.equal(image.image_url, `data:image/png;base64,${screenshot.toString("base64")}`);
  assert.match(result.chartUrl, /^https:\/\/dashboard\.example\/layout-screenshots\/btc-4h-\d+\.png$/);
  assert.equal(result.analysis, "Trend is neutral. HOLD");
  assert.equal(result.verdict, "HOLD");
});
