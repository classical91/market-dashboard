const express = require("express");
const path = require("path");

// Binance's public-data mirror (see pattern-scanner.js for why this domain,
// not api.binance.com) has a lightweight ticker endpoint just for the
// current price — cheaper than pulling klines when all the tracker needs is
// "what's it worth now" to resolve a pending pattern/divergence entry.
async function fetchBinancePrice(symbol) {
  const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status} for ${symbol}`);
  const data = await res.json();
  return Number(data.price);
}

const { config } = require("./config/env");
const { createAIAnalysisRouter } = require("./routes/ai-analysis");
const { createDecisionRouter } = require("./routes/decision");
const { createLayoutAnalysisRouter } = require("./routes/layout-analysis");
const { createPatternScannerRouter } = require("./routes/pattern-scanner");
const { createSignalScreenerRouter } = require("./routes/signal-screener");
const { createStrategyEngineRouter } = require("./routes/strategy-engine");
const { createWatchlistRouter } = require("./routes/watchlist");
const { createBotCommandsRouter } = require("./routes/bot-commands");
const { createPatternTrackerRouter } = require("./routes/pattern-tracker");
const { createHealthRouter } = require("./routes/health");
const { createOnchainRouter } = require("./routes/onchain");
const { createOverviewRouter } = require("./routes/overview");
const { createReporterRouter } = require("./routes/reporter");
const { createTelegramRouter } = require("./routes/telegram");
const { createYoutubeRouter } = require("./routes/youtube");
const { createXFeedRouter } = require("./routes/x-feed");
const { YOUTUBE_CHANNELS } = require("./config/youtube-channels");
const { X_ACCOUNTS } = require("./config/x-accounts");
const { TOP_TOKENS } = require("./config/market-symbols");
const { AIAnalysisService } = require("./services/ai-analysis");
const { DecisionEngineService } = require("./services/decision-engine");
const { TradeJournalService } = require("./services/trade-journal");
const { LayoutAnalysisService } = require("./services/layout-analysis");
const { LayoutCaptureService } = require("./services/layout-capture");
const { PatternScannerService } = require("./services/pattern-scanner");
const { SignalScreenerService } = require("./services/signal-screener");
const { StrategyEngineService } = require("./services/strategy-engine");
const { SignalBotService } = require("./services/signal-bot");
const { WatchlistService } = require("./services/watchlist");
const { BotCommandsService } = require("./services/bot-commands");
const { PatternTrackerService } = require("./services/pattern-tracker");
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
const { XFeedService } = require("./services/x-feed");
const { resolveDataDir } = require("./utils/data-dir");
const { createRequireAdmin } = require("./middleware/admin-auth");

function createApp() {
  const app = express();
  const cache = new MemoryCache();
  const dataDir = resolveDataDir();
  const reporterCache = new PersistentReporterCache(path.join(dataDir, "reporter-cache.json"));
  const xFeedCache = new PersistentReporterCache(path.join(dataDir, "x-feed-cache.json"));
  const aiAnalysisCache = new PersistentReporterCache(path.join(dataDir, "ai-analysis-cache.json"));
  const layoutAnalysisCache = new PersistentReporterCache(path.join(dataDir, "layout-analysis-cache.json"));
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
    model: config.reporter.model,
    dataDir,
  });
  const marketDataService = new MarketDataService();
  const overviewService = new OverviewService({
    marketDataService,
    onchainService,
    cache,
    cacheTtlMs: Number(process.env.OVERVIEW_CACHE_MS) || 60_000,
  });
  const youtubeService = new YouTubeFeedService({ cache });
  const xFeedService = new XFeedService({ cache: xFeedCache });
  const aiAnalysisService = new AIAnalysisService({
    cache: aiAnalysisCache,
    dataDir,
    openaiApiKey: config.aiAnalysis.openaiApiKey,
    chartImgApiKey: config.aiAnalysis.chartImgApiKey,
    chartImgBaseUrl: config.aiAnalysis.chartImgBaseUrl,
    model: config.aiAnalysis.model,
    presets: config.aiAnalysis.presets,
  });
  const layoutScreenshotsDir = path.join(dataDir, "layout-screenshots");
  const layoutCaptureService = new LayoutCaptureService({ timeoutMs: config.layoutAnalysis.timeoutMs });
  const layoutAnalysisService = new LayoutAnalysisService({
    cache: layoutAnalysisCache,
    dataDir,
    openaiApiKey: config.aiAnalysis.openaiApiKey,
    model: config.aiAnalysis.model,
    layouts: config.layoutAnalysis.layouts,
    captureService: layoutCaptureService,
    screenshotDir: layoutScreenshotsDir,
    screenshotUrlPrefix: "/layout-screenshots",
  });
  const patternScannerService = new PatternScannerService({ cache, tokens: TOP_TOKENS });
  const signalScreenerService = new SignalScreenerService({ cache });
  const strategyEngineService = new StrategyEngineService({ signalScreenerService });
  const watchlistService = new WatchlistService({ dataDir });
  const botCommandsService = new BotCommandsService({ dataDir });
  const patternTrackerService = new PatternTrackerService({ dataDir, fetchPrice: fetchBinancePrice });
  const decisionEngineService = new DecisionEngineService({
    marketDataService,
    signalScreenerService,
    cache,
    cacheTtlMs: Number(process.env.DECISION_CACHE_MS) || 120_000,
  });
  const tradeJournalService = new TradeJournalService({ dataDir });
  const signalBotService = new SignalBotService({
    signalScreenerService,
    patternScannerService,
    patternTrackerService,
    telegramService,
    stateCache: new PersistentReporterCache(path.join(dataDir, "signal-bot-state.json")),
    intervalMs: config.signalBot.intervalMs,
    timeframes: config.signalBot.timeframes,
    minChecks: config.signalBot.minChecks,
  });

  const requireAdmin = createRequireAdmin({ adminKey: config.admin.apiKey });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.get(["/earthwatch", "/earthwatch.html"], (req, res) => {
    res.redirect(302, "https://earth-watch-production-e3c6.up.railway.app/");
  });
  app.get(["/overview-v2.html", "/overview-hybrid.html"], (req, res) => {
    res.redirect(301, "/");
  });
  app.use(express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("reporter.html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));
  app.use("/layout-screenshots", express.static(layoutScreenshotsDir));

  app.get(["/emerging-markets.html", "/economics-top-10.html", "/markets-top-10.html"], (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "public", "reporter.html"));
  });

  app.use(
    "/api/health",
    createHealthRouter({
      onchainService,
      etherscanService,
      covalentService,
      dataSource: config.onchain.dataSourceLabel,
      adminKey: config.admin.apiKey,
    }),
  );
  app.use("/api/ai-analysis", createAIAnalysisRouter({ aiAnalysisService, telegramService, requireAdmin }));
  app.use(
    "/api/layout-analysis",
    createLayoutAnalysisRouter({ layoutAnalysisService, telegramService, requireAdmin }),
  );
  app.use("/api/pattern-scanner", createPatternScannerRouter({ patternScannerService }));
  app.use("/api/signal-screener", createSignalScreenerRouter({ signalScreenerService }));
  app.use("/api/strategy-engine", createStrategyEngineRouter({ strategyEngineService }));
  app.use("/api/decision", createDecisionRouter({ decisionEngineService, tradeJournalService, requireAdmin }));
  app.use("/api/watchlist", createWatchlistRouter({ watchlistService, requireAdmin }));
  app.use("/api/bot-commands", createBotCommandsRouter({ botCommandsService }));
  app.use("/api/pattern-tracker", createPatternTrackerRouter({ patternTrackerService }));
  app.use("/api/onchain", createOnchainRouter({ onchainService }));
  app.use("/api/overview", createOverviewRouter({ overviewService }));
  app.use("/api/daily-report", createReporterRouter({ reporterService, telegramService, requireAdmin }));
  app.use("/api/telegram", createTelegramRouter({ telegramService, requireAdmin }));
  app.use("/api/youtube", createYoutubeRouter({ youtubeService, channels: YOUTUBE_CHANNELS }));
  app.use("/api/x", createXFeedRouter({ xFeedService, accounts: X_ACCOUNTS }));

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

  // The interval loop is started by server.js, not here — createApp() is also
  // used by tests and the build check, which must not leave timers running.
  app.locals.signalBot = signalBotService;

  return app;
}

module.exports = { createApp };
