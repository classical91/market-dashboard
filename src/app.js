const express = require("express");
const path = require("path");

const { config } = require("./config/env");
const { createHealthRouter } = require("./routes/health");
const { createOnchainRouter } = require("./routes/onchain");
const { createOverviewRouter } = require("./routes/overview");
const { createReporterRouter } = require("./routes/reporter");
const { createTelegramRouter } = require("./routes/telegram");
const { createYoutubeRouter } = require("./routes/youtube");
const { YOUTUBE_CHANNELS } = require("./config/youtube-channels");
const { MemoryCache } = require("./services/cache");
const { PersistentReporterCache } = require("./services/persistent-cache");
const { CovalentService } = require("./services/covalent");
const { DefiLlamaService } = require("./services/defillama");
const { EtherscanService } = require("./services/etherscan");
const { MarketDataService } = require("./services/market-data");
const { OnchainService } = require("./services/onchain");
const { OverviewService } = require("./services/overview");
const { ReporterService } = require("./services/reporter");
const { TelegramService } = require("./services/telegram");
const { YouTubeFeedService } = require("./services/youtube");

function createApp() {
  const app = express();
  const cache = new MemoryCache();
  const reporterCache = new PersistentReporterCache();
  const defillamaService = new DefiLlamaService(config.defillama);
  const etherscanService = new EtherscanService(config.etherscan);
  const covalentService = new CovalentService(config.covalent);
  const onchainService = new OnchainService({
    cache,
    config: config.onchain,
    defillamaService,
    etherscanService,
    covalentService,
  });
  const telegramService = new TelegramService(config.telegram);
  const reporterService = new ReporterService({
    cache: reporterCache,
    apiKey: config.reporter.apiKey,
    telegramService,
  });
  const marketDataService = new MarketDataService();
  const overviewService = new OverviewService({
    marketDataService,
    onchainService,
    cache,
    cacheTtlMs: Number(process.env.OVERVIEW_CACHE_MS) || 60_000,
  });
  const youtubeService = new YouTubeFeedService({ cache });

  app.disable("x-powered-by");
  app.use(express.json());
  app.get(["/earthwatch", "/earthwatch.html"], (req, res) => {
    res.redirect(302, "https://earth-watch-production-e3c6.up.railway.app/");
  });
  app.use(express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("reporter.html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));

  app.use(
    "/api/health",
    createHealthRouter({
      onchainService,
      etherscanService,
      covalentService,
      dataSource: config.onchain.dataSourceLabel,
    }),
  );
  app.use("/api/onchain", createOnchainRouter({ onchainService }));
  app.use("/api/overview", createOverviewRouter({ overviewService }));
  app.use("/api/daily-report", createReporterRouter({ reporterService }));
  app.use("/api/telegram", createTelegramRouter({ telegramService }));
  app.use("/api/youtube", createYoutubeRouter({ youtubeService, channels: YOUTUBE_CHANNELS }));

  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    const message = err.expose || status < 500 ? err.message : "Internal server error";

    if (status >= 500) {
      console.error(err);
    }

    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
