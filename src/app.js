const express = require("express");
const path = require("path");
const crypto = require("crypto");

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

function matchesSecret(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  if (!expectedBuffer.length || providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

const { config } = require("./config/env");
const { createAIAnalysisRouter } = require("./routes/ai-analysis");
const { createDecisionRouter } = require("./routes/decision");
const { createLayoutAnalysisRouter } = require("./routes/layout-analysis");
const { createPatternScannerRouter } = require("./routes/pattern-scanner");
const { createSignalScreenerRouter } = require("./routes/signal-screener");
const { createStrategyEngineRouter } = require("./routes/strategy-engine");
const { createTradingLabRouter } = require("./routes/trading-lab");
const { createWatchlistRouter } = require("./routes/watchlist");
const { createBotCommandsRouter } = require("./routes/bot-commands");
const { createPatternTrackerRouter } = require("./routes/pattern-tracker");
const { createLiveScannerRouter } = require("./routes/live-scanner");
const { createHealthRouter } = require("./routes/health");
const { createOnchainRouter } = require("./routes/onchain");
const { createOverviewRouter } = require("./routes/overview");
const { createBroadcastLedgerRouter } = require("./routes/broadcast-ledger");
const { createReporterRouter } = require("./routes/reporter");
const { createNewsroomRouter } = require("./routes/newsroom");
const { createTelegramRouter } = require("./routes/telegram");
const { createYoutubeRouter } = require("./routes/youtube");
const { createXFeedRouter } = require("./routes/x-feed");
const { resolveYoutubeChannels } = require("./config/youtube-channels");
const { X_ACCOUNTS } = require("./config/x-accounts");
const { TOP_TOKENS } = require("./config/market-symbols");
const { AIAnalysisService } = require("./services/ai-analysis");
const { DecisionEngineService } = require("./services/decision-engine");
const { TradeJournalService } = require("./services/trade-journal");
const { TradingLabService } = require("./services/trading/trading-lab");
const { BacktestService } = require("./services/trading/backtest");
const { LayoutAnalysisService } = require("./services/layout-analysis");
const { LayoutCaptureService } = require("./services/layout-capture");
const { PatternScannerService } = require("./services/pattern-scanner");
const { SignalScreenerService } = require("./services/signal-screener");
const { StrategyEngineService } = require("./services/strategy-engine");
const { SignalBotService } = require("./services/signal-bot");
const { SignalTradeBridge } = require("./services/trading/signal-bridge");
const { SignalActionStore } = require("./services/trading/signal-action-store");
const { ExperimentStore } = require("./services/trading/experiment-store");
const { ResearchQueue } = require("./services/trading/research-queue");
const { LiveScannerService } = require("./services/trading/live-scanner");
const { LiveResearchService } = require("./services/trading/live-research-runner");
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
const { BroadcastIngestService } = require("./services/broadcast-ingest");
const { BroadcastLedgerStore } = require("./services/broadcast-ledger");
const { BroadcastLedgerNotificationService } = require("./services/broadcast-ledger-notifications");
const { ReporterService } = require("./services/reporter");
const { NewsroomCycleStore } = require("./services/newsroom-cycles");
const { NewsroomService } = require("./services/newsroom");
const { TelegramService } = require("./services/telegram");
const { YouTubeIntelligenceService } = require("./services/youtube");
const { XFeedService } = require("./services/x-feed");
const { resolveDataDir } = require("./utils/data-dir");
const { createRequireAdmin } = require("./middleware/admin-auth");
const { createRequireLedgerKey } = require("./middleware/ledger-auth");
const { createSiteAuth } = require("./middleware/site-auth");

function createApp() {
  const app = express();
  const cache = new MemoryCache();
  const dataDir = resolveDataDir();
  const reporterCache = new PersistentReporterCache(path.join(dataDir, "reporter-cache.json"));
  const xFeedCache = new PersistentReporterCache(path.join(dataDir, "x-feed-cache.json"));
  const aiAnalysisCache = new PersistentReporterCache(path.join(dataDir, "ai-analysis-cache.json"));
  const layoutAnalysisCache = new PersistentReporterCache(path.join(dataDir, "layout-analysis-cache.json"));
  // Resolved YouTube channel IDs are persisted so the keyless RSS fallback
  // still has an ID to work with after a restart.
  const youtubeIdCache = new PersistentReporterCache(path.join(dataDir, "youtube-channel-ids.json"));
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
  // The ledger/Shortcut news route is deliberately isolated from the shared
  // dashboard sender. Only ShareClaw97's dedicated credentials can send news.
  const newsTelegramService = new TelegramService(config.newsTelegram);
  const broadcastLedgerNotificationService = new BroadcastLedgerNotificationService({
    telegramService: new TelegramService({
      ...config.newsTelegram,
      chatIds: config.broadcastLedger.notificationTargets,
    }),
  });
  // Shared source of truth for every completed broadcast, across the
  // dashboard, the iOS/GPT shortcut, ShareBot67 and manual posting. Lives
  // here rather than behind the OpenClaw gateway precisely so it stays
  // readable when that gateway is down.
  const broadcastLedgerStore = new BroadcastLedgerStore({ dataDir });
  // Watches the same channels the bot posts to and records what it sees, so a
  // story reaches the ledger even when the path that sent it never reported.
  // Constructed always, started only by server.js, and a no-op that logs when
  // BROADCAST_LEDGER_INGEST_ENABLED is not "true".
  const broadcastIngestService = new BroadcastIngestService({
    telegramService,
    broadcastLedgerStore,
    stateCache: new PersistentReporterCache(path.join(dataDir, "broadcast-ingest-state.json")),
    enabled: config.broadcastLedger.ingestEnabled,
    intervalMs: config.broadcastLedger.ingestIntervalMs,
    watchTargets: config.broadcastLedger.watchTargets,
  });
  const reporterService = new ReporterService({
    cache: reporterCache,
    apiKey: config.reporter.apiKey,
    model: config.reporter.model,
    dataDir,
  });
  // One durable record per scheduled newsroom run, linking the reporter's
  // generation log to the broadcast ledger's receipts. Storage is the same
  // locked/atomic JSON the other stores use — the reporter has no database
  // layer, and introducing one here would buy nothing this pattern doesn't
  // already give.
  const newsroomCycleStore = new NewsroomCycleStore({ dataDir, cap: config.newsroom.historyCap });
  const newsroomService = new NewsroomService({
    cycleStore: newsroomCycleStore,
    reporterService,
    // News digests go through the same sender the Daily Reporter broadcast
    // route uses, so both paths land in the same locked topics.
    telegramService,
    broadcastLedgerStore,
    sections: config.newsroom.sections,
    expectedRunTimesUtc: config.newsroom.expectedRunTimesUtc,
  });
  const marketDataService = new MarketDataService();
  const overviewService = new OverviewService({
    marketDataService,
    onchainService,
    cache,
    cacheTtlMs: Number(process.env.OVERVIEW_CACHE_MS) || 60_000,
  });
  const youtubeChannels = resolveYoutubeChannels(config.youtube.channelIds);
  const youtubeService = new YouTubeIntelligenceService({
    cache,
    idCache: youtubeIdCache,
    apiKey: config.youtube.apiKey,
    channels: youtubeChannels,
    ttls: config.youtube.ttls,
    maxVideosPerChannel: config.youtube.maxVideosPerChannel,
    requestTimeoutMs: config.youtube.requestTimeoutMs,
    quotaCooldownMs: config.youtube.quotaCooldownMs,
    liveSearchEnabled: config.youtube.liveSearchEnabled,
  });
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
  const signalActionStore = new SignalActionStore({ dataDir });
  // Research history. Deliberately its own store under <dataDir>/research, so
  // resetting a paper book can never disturb the record of what was tested.
  const experimentStore = new ExperimentStore({ dataDir });
  // Stage one of the research workflow: candidates worth backtesting, kept
  // beside the experiment log they eventually link to.
  const researchQueue = new ResearchQueue({ dataDir });
  const decisionEngineService = new DecisionEngineService({
    marketDataService,
    signalScreenerService,
    cache,
    cacheTtlMs: Number(process.env.DECISION_CACHE_MS) || 120_000,
  });
  const tradeJournalService = new TradeJournalService({ dataDir });
  // Trading Lab: the paper-execution, risk-sizing and historical-edge layer
  // ported from TraderClaw. It reuses the same Binance ticker the pattern
  // tracker resolves entries with, so marks and paper fills agree on price.
  const tradingLabService = new TradingLabService({
    dataDir,
    priceFeed: fetchBinancePrice,
    decisionEngineService,
    // The regime engine reads the screener's cached klines rather than fetching
    // its own, same as the backtester.
    signalScreenerService,
  });
  // Backtests replay the same paper-trading engine over historical candles, so
  // a backtest and a forward paper run agree by construction. It reuses the
  // screener's cached klines rather than fetching its own.
  const backtestService = new BacktestService({ signalScreenerService, experimentStore, dataDir });
  // Signal transitions are the replacement for the TradingView alert webhooks:
  // the bot already detects FLAT -> LONG/SHORT on closed candles, on a timer,
  // without a subscription. The bridge scores those through the Trading Lab —
  // log-only until SIGNAL_BOT_PAPER_TRADE_ENABLED=true.
  const signalTradeBridge = new SignalTradeBridge({
    tradingLabService,
    signalScreenerService,
    signalActionStore,
    paperTradeEnabled: config.signalBot.paperTradeEnabled,
    autoMarkEnabled: config.signalBot.autoMarkEnabled,
    book: config.signalBot.book,
  });
  const signalBotService = new SignalBotService({
    signalScreenerService,
    patternScannerService,
    patternTrackerService,
    telegramService,
    tradeBridge: signalTradeBridge,
    stateCache: new PersistentReporterCache(path.join(dataDir, "signal-bot-state.json")),
    intervalMs: config.signalBot.intervalMs,
    timeframes: config.signalBot.timeframes,
    minChecks: config.signalBot.minChecks,
  });

  // Native live scanner: its own Bitget candle feed and strategy on a 60s
  // loop, feeding the same Trading Lab paper pipeline as the signal bridge.
  // Constructed even when disabled so /api/live-scanner/status can report the
  // configuration — but a broken config only fails the boot when someone has
  // explicitly asked for the scanner, rather than taking the dashboard down
  // over an unused variable.
  let liveScannerService = null;
  try {
    liveScannerService = new LiveScannerService({
      tradingLabService,
      signalActionStore,
      stateCache: new PersistentReporterCache(path.join(dataDir, "live-scanner-state.json")),
      enabled: config.liveScanner.enabled,
      paperTradeEnabled: config.liveScanner.paperTradeEnabled,
      symbol: config.liveScanner.symbol,
      timeframe: config.liveScanner.timeframe,
      strategy: config.liveScanner.strategy,
      intervalMs: config.liveScanner.intervalMs,
      contextInterval: config.liveScanner.contextInterval,
      book: config.liveScanner.book,
    });
  } catch (err) {
    if (config.liveScanner.enabled) throw err;
    console.warn(`[LiveScanner] Not configured: ${err.message}`);
  }

  const liveResearchService = new LiveResearchService({
    tradingLabService,
    candleSource: signalScreenerService,
    stateCache: new PersistentReporterCache(path.join(dataDir, "live-research-state.json")),
    enabled: config.liveResearch.enabled,
    symbols: config.liveResearch.symbols,
    timeframes: config.liveResearch.timeframes,
    symbol: config.liveResearch.symbol,
    timeframe: config.liveResearch.timeframe,
    intervalMs: config.liveResearch.intervalMs,
    reservedStrategyIds:
      liveScannerService?.enabled && liveScannerService.paperTradeEnabled
        ? [liveScannerService.strategy]
        : [],
  });
  tradingLabService.attachLiveResearchService(liveResearchService);

  const requireAdmin = createRequireAdmin({ adminKey: config.admin.apiKey });
  const requireLedgerKey = createRequireLedgerKey({
    ledgerKey: config.broadcastLedger.apiKey,
    adminKey: config.admin.apiKey,
  });
  const siteAuth = createSiteAuth({
    adminKey: config.admin.apiKey,
    ledgerKey: config.broadcastLedger.apiKey,
    sitePassword: config.access.sitePassword,
    alphaAccessCode: config.access.alphaAccessCode,
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.get("/login", siteAuth.loginPage);
  app.post("/auth/login", siteAuth.login);
  app.post("/auth/logout", siteAuth.logout);
  app.post("/api/alpha-team/access", (req, res) => {
    const accessCode = config.access.alphaAccessCode;
    const session = siteAuth.sessionFromRequest(req);
    if (session && (session.role === "owner" || session.role === "alpha")) {
      res.json({ ok: true, configured: Boolean(accessCode), session: session.role });
      return;
    }
    if (!accessCode) {
      res.json({ ok: true, configured: false });
      return;
    }

    if (!matchesSecret(req.body && req.body.code, accessCode)) {
      res.status(401).json({ error: "Invalid access code" });
      return;
    }

    siteAuth.setSessionCookie(res, req, "alpha");
    res.json({ ok: true, configured: true });
  });
  app.use(siteAuth.requireAccess);
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
  app.use(
    "/api/decision",
    createDecisionRouter({
      decisionEngineService,
      tradeJournalService,
      requireAdmin,
    }),
  );
  app.use("/api/trading-lab", createTradingLabRouter({ tradingLabService, backtestService, signalActionStore, experimentStore, researchQueue, signalScreenerService, tradeJournalService, requireAdmin }));
  app.use("/api/live-scanner", createLiveScannerRouter({ liveScannerService, requireAdmin }));
  app.use("/api/watchlist", createWatchlistRouter({ watchlistService, requireAdmin }));
  app.use("/api/bot-commands", createBotCommandsRouter({ botCommandsService }));
  app.use("/api/pattern-tracker", createPatternTrackerRouter({ patternTrackerService }));
  app.use("/api/onchain", createOnchainRouter({ onchainService }));
  app.use("/api/overview", createOverviewRouter({ overviewService }));
  app.use(
    "/api/broadcast-ledger",
    createBroadcastLedgerRouter({
      broadcastLedgerStore,
      broadcastIngestService,
      telegramService: newsTelegramService,
      notificationService: broadcastLedgerNotificationService,
      requireAdmin,
      requireLedgerKey,
      ledgerKey: config.broadcastLedger.apiKey,
      adminKey: config.admin.apiKey,
      rateLimitPerMinute: config.broadcastLedger.rateLimitPerMinute,
    }),
  );
  app.use(
    "/api/daily-report",
    createReporterRouter({ reporterService, telegramService, broadcastLedgerStore, requireAdmin }),
  );
  app.use(
    "/api/newsroom",
    createNewsroomRouter({
      newsroomService,
      cycleStore: newsroomCycleStore,
      reporterService,
      broadcastLedgerStore,
      requireAdmin,
    }),
  );
  app.use("/api/telegram", createTelegramRouter({ telegramService, requireAdmin }));
  app.use("/api/youtube", createYoutubeRouter({ youtubeService, channels: youtubeChannels }));
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
  app.locals.broadcastIngest = broadcastIngestService;
  app.locals.liveScanner = liveScannerService;
  app.locals.liveResearch = liveResearchService;

  return app;
}

module.exports = { createApp, matchesSecret };
