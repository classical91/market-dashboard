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
const { createDirectionalBiasRouter } = require("./routes/directional-bias");
const { createLocalExtremesRouter } = require("./routes/local-extremes");
const { createOpenInterestRouter } = require("./routes/open-interest");
const { createCrossMarketOiRouter } = require("./routes/cross-market-oi");
const { createScreenerSettingsRouter } = require("./routes/screener-settings");
const { createStrategyEngineRouter } = require("./routes/strategy-engine");
const { createTradingLabRouter } = require("./routes/trading-lab");
const { createWatchlistRouter } = require("./routes/watchlist");
const { createTradeContextRouter } = require("./routes/trade-context");
const { createBotCommandsRouter } = require("./routes/bot-commands");
const { createPatternTrackerRouter } = require("./routes/pattern-tracker");
const { createLiveScannerRouter } = require("./routes/live-scanner");
const { createHealthRouter } = require("./routes/health");
const { createOnchainRouter } = require("./routes/onchain");
const { createOverviewRouter } = require("./routes/overview");
const { createMarketSessionRouter } = require("./routes/market-session");
const { createBroadcastLedgerRouter } = require("./routes/broadcast-ledger");
const { createReporterRouter } = require("./routes/reporter");
const { createNewsroomRouter } = require("./routes/newsroom");
const { createTelegramRouter } = require("./routes/telegram");
const { createYoutubeRouter } = require("./routes/youtube");
const { createXFeedRouter } = require("./routes/x-feed");
const { resolveYoutubeChannels } = require("./config/youtube-channels");
const { XAccountRegistry } = require("./services/x-account-registry");
const { XTemplateRegistry } = require("./services/x-template-registry");
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
const { OpenInterestService } = require("./services/open-interest/service");
const { createProviders: createOpenInterestProviders } = require("./services/open-interest/providers");
const { CrossMarketOiService } = require("./services/cross-market-oi/service");
const { CftcCotProvider } = require("./services/cross-market-oi/cftc-provider");
const { ScreenerSettingsService } = require("./services/screener-settings");
const { UsdtDominanceService } = require("./services/usdt-dominance");
const { StrategyEngineService } = require("./services/strategy-engine");
const { SignalBotService } = require("./services/signal-bot");
const { SignalTradeBridge } = require("./services/trading/signal-bridge");
const { SignalActionStore } = require("./services/trading/signal-action-store");
const { ExperimentStore } = require("./services/trading/experiment-store");
const { ResearchQueue } = require("./services/trading/research-queue");
const { LiveScannerService } = require("./services/trading/live-scanner");
const { LiveResearchService } = require("./services/trading/live-research-runner");
const { WatchlistService } = require("./services/watchlist");
const { TradeContextService } = require("./services/trade-context");
const { BotCommandsService } = require("./services/bot-commands");
const { PatternTrackerService } = require("./services/pattern-tracker");
const { MemoryCache } = require("./services/cache");
const { PersistentReporterCache } = require("./services/persistent-cache");
const { CovalentService } = require("./services/covalent");
const { DefiLlamaService } = require("./services/defillama");
const { EtherscanService } = require("./services/etherscan");
const { MarketDataService } = require("./services/market-data");
const { OnchainService } = require("./services/onchain");
const { OnchainIntelligenceService } = require("./services/onchain-intelligence/service");
const { DefiLlamaOnchainProvider } = require("./services/onchain-intelligence/defillama-provider");
const { OverviewService } = require("./services/overview");
const { BroadcastIngestService } = require("./services/broadcast-ingest");
const { BroadcastLedgerStore } = require("./services/broadcast-ledger");
const { BroadcastLedgerNotificationService } = require("./services/broadcast-ledger-notifications");
const { ReporterService } = require("./services/reporter");
const { NewsroomCycleStore } = require("./services/newsroom-cycles");
const { NewsroomService } = require("./services/newsroom");
const { createAgentRoutePreflight } = require("./services/newsroom-agent-preflight");
const { TelegramService } = require("./services/telegram");
const { YouTubeIntelligenceService } = require("./services/youtube");
const { YoutubeChannelRegistry } = require("./services/youtube-channel-registry");
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
  const onchainIntelligenceService = new OnchainIntelligenceService({
    provider: new DefiLlamaOnchainProvider(config.onchainIntelligence),
    cache,
    store: new PersistentReporterCache(path.join(dataDir, "onchain-intelligence.json")),
    cacheTtlMs: config.onchainIntelligence.cacheTtlMs,
    staleAfterMs: config.onchainIntelligence.staleAfterMs,
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
    allowPartialDelivery: config.newsroom.allowPartialDelivery,
    // Null unless NEWSROOM_AGENT_PREFLIGHT_URL is set, in which case the
    // preflight stops reporting the ShareBot/OpenClaw route as unverified and
    // starts actually checking it — read-only, before anything is spent.
    externalPreflight: createAgentRoutePreflight(config.newsroom.agentPreflight),
  });
  const marketDataService = new MarketDataService();
  const overviewService = new OverviewService({
    marketDataService,
    onchainService,
    cache,
    cacheTtlMs: Number(process.env.OVERVIEW_CACHE_MS) || 60_000,
  });
  // The tracked channel list is editable at runtime and persisted next to the
  // feed cache, so add/delete survives a redeploy. The static config in
  // src/config/youtube-channels.js is now only the first-boot seed.
  //
  // No `categorySeed` is passed: a first boot gets exactly the categories its
  // seeded channels are filed under, and nothing else. Seeding from the theme
  // catalogue used to turn every section a theme names — Archaeology, AI Labs,
  // Apple & iOS — into a YouTube category holding no channels, which made the
  // filter read as a list of things to fix rather than a list of what is
  // tracked. Themes and YouTube categories are independent now.
  const youtubeChannelRegistry = new YoutubeChannelRegistry({
    dataDir,
    seed: resolveYoutubeChannels(config.youtube.channelIds),
  });
  youtubeChannelRegistry.ensureSeeded();
  const youtubeChannels = youtubeChannelRegistry.list();
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
  // The tracked-account list is editable at runtime and persisted next to the
  // feed cache, so add/delete survives a redeploy. The static config in
  // src/config/x-accounts.js is now only the first-boot seed.
  const xAccountRegistry = new XAccountRegistry({ dataDir, cache: xFeedCache });
  xAccountRegistry.ensureSeeded();
  const xTemplateRegistry = new XTemplateRegistry({
    dataDir,
    seedAccounts: () => xAccountRegistry.list(),
  });
  xTemplateRegistry.ensureSeeded();
  xAccountRegistry.setMembershipHooks({
    // An account added while a theme is selected joins that theme. Adding it
    // to the default one regardless was the reason a handle added from, say,
    // the Conspiracy filter never appeared in it.
    onAdd: (account, options) =>
      (options && options.templateId
        ? xTemplateRegistry.addHandleToTemplate(options.templateId, account.handle)
        : xTemplateRegistry.addHandleToDefault(account.handle)),
    onRemove: (account) => xTemplateRegistry.removeHandle(account.handle),
  });
  const aiAnalysisScreenshotsDir = path.join(dataDir, "ai-analysis-screenshots");
  const layoutScreenshotsDir = path.join(dataDir, "layout-screenshots");
  const layoutCaptureService = new LayoutCaptureService({ timeoutMs: config.layoutAnalysis.timeoutMs });
  const aiAnalysisService = new AIAnalysisService({
    cache: aiAnalysisCache,
    dataDir,
    openaiApiKey: config.aiAnalysis.openaiApiKey,
    model: config.aiAnalysis.model,
    presets: config.aiAnalysis.presets,
    captureService: layoutCaptureService,
    screenshotDir: aiAnalysisScreenshotsDir,
    screenshotUrlPrefix: "/ai-analysis-screenshots",
  });
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
  // Which tokens each screener scans, editable from the Settings page and
  // persisted under DATA_DIR. TOP_TOKENS stays the default catalog the store
  // seeds itself from on first boot (and restores on a reset), so behaviour
  // out of the box is exactly what it was when the routes read that list
  // directly — but it is no longer the active configuration.
  const screenerSettingsService = new ScreenerSettingsService({ dataDir });
  screenerSettingsService.ensureSeeded();
  const patternScannerService = new PatternScannerService({ cache, tokens: TOP_TOKENS });
  const signalScreenerService = new SignalScreenerService({ cache });
  // Open Interest Intelligence. Its universe is the "openInterest" screener
  // in the settings store; price and confluence come from the screener engine
  // above rather than a second candle fetcher.
  const openInterestService = new OpenInterestService({
    providers: createOpenInterestProviders(config.openInterest.providers, {
      timeoutMs: config.openInterest.requestTimeoutMs,
    }),
    signalScreenerService,
    screenerSettingsService,
    cache,
    cacheTtlMs: config.openInterest.cacheTtlMs,
    staleAfterMs: config.openInterest.staleAfterMs,
    venueCooldownMs: config.openInterest.venueCooldownMs,
  });
  // Cross-Market Open Interest: weekly CFTC futures data. The last good
  // report is kept on disk, so a CFTC outage or a restart still shows the
  // most recent week, marked as cached.
  const crossMarketOiService = new CrossMarketOiService({
    provider: new CftcCotProvider({
      baseUrl: config.crossMarketOi.baseUrl,
      appToken: config.crossMarketOi.appToken,
      timeoutMs: config.crossMarketOi.requestTimeoutMs,
    }),
    cache,
    store: new PersistentReporterCache(path.join(dataDir, "cross-market-oi.json")),
    cacheTtlMs: config.crossMarketOi.cacheTtlMs,
    staleAfterDays: config.crossMarketOi.staleAfterDays,
  });
  const usdtDominanceService = new UsdtDominanceService({ marketDataService, dataDir });
  const strategyEngineService = new StrategyEngineService({ signalScreenerService });
  const watchlistService = new WatchlistService({ dataDir });
  // Pure aggregation over the engines above — it owns no indicator maths and
  // asks both scanners per tracked symbol rather than for the full universe.
  const tradeContextService = new TradeContextService({
    watchlistService,
    signalScreenerService,
    patternScannerService,
  });
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
    // The bot is the Directional Bias and Pattern Scanner screeners on a
    // timer, so it watches the same universes those pages show. Without this
    // an operator who unchecked a token would keep receiving Telegram alerts
    // for a row the dashboard no longer displays.
    screenerSettingsService,
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
  const requireXAdmin = createRequireAdmin({
    adminKey: config.admin.apiKey,
    allowOwnerSession: true,
  });
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
  app.get("/api/auth/session", (req, res) => {
    const session = siteAuth.sessionFromRequest(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      enabled: siteAuth.enabled,
      authenticated: Boolean(session),
      role: session ? session.role : null,
      identifier: null,
    });
  });
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
  // The Signal Screener's two tabs are now two pages. Every old link — the
  // Telegram alerts already sent, a bookmarked ?view=alpha review link, the
  // footers on other pages — lands on the directional half it named, with its
  // query string intact so an alpha review link stays an alpha review link.
  app.get(["/signal-screener", "/signal-screener.html"], (req, res) => {
    const query = req.originalUrl.slice(req.path.length);
    res.redirect(301, `/directional-bias.html${query}`);
  });
  app.use(express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith("reporter.html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));
  app.use("/layout-screenshots", express.static(layoutScreenshotsDir));
  app.use("/ai-analysis-screenshots", express.static(aiAnalysisScreenshotsDir));

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
  app.use("/api/pattern-scanner", createPatternScannerRouter({ patternScannerService, screenerSettingsService }));
  app.use("/api/signal-screener", createSignalScreenerRouter({ signalScreenerService, usdtDominanceService }));
  // Two views of the screener above, one engine behind both: direction and
  // location are separate questions and now separate pages, but they share a
  // single cached scan per symbol + interval.
  app.use(
    "/api/directional-bias",
    createDirectionalBiasRouter({ signalScreenerService, usdtDominanceService, screenerSettingsService }),
  );
  app.use("/api/local-extremes", createLocalExtremesRouter({ signalScreenerService, screenerSettingsService }));
  app.use("/api/open-interest", createOpenInterestRouter({ openInterestService }));
  app.use("/api/cross-market-oi", createCrossMarketOiRouter({ crossMarketOiService }));
  // Settings owns the universes above. Reads are open like the screeners
  // themselves; writes take the browser-management guard (owner session or
  // admin key), the same one the X Intelligence registry uses.
  app.use(
    "/api/screener-settings",
    createScreenerSettingsRouter({ screenerSettingsService, requireAdmin: requireXAdmin }),
  );
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
  app.use("/api/trade-context", createTradeContextRouter({ tradeContextService }));
  app.use("/api/bot-commands", createBotCommandsRouter({ botCommandsService }));
  app.use("/api/pattern-tracker", createPatternTrackerRouter({ patternTrackerService }));
  app.use("/api/onchain", createOnchainRouter({ onchainService, onchainIntelligenceService }));
  app.use("/api/overview", createOverviewRouter({ overviewService }));
  app.use("/api/market-session", createMarketSessionRouter());
  app.use(
    "/api/broadcast-ledger",
    createBroadcastLedgerRouter({
      broadcastLedgerStore,
      broadcastIngestService,
      telegramService: newsTelegramService,
      // The watch polls the dashboard bot while news goes out through the news
      // bot. Preflight needs both to report on that asymmetry honestly.
      watchTelegramService: telegramService,
      config,
      bootedAt: new Date().toISOString(),
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
      broadcastLedgerStore,
      requireAdmin,
    }),
  );
  app.use("/api/telegram", createTelegramRouter({ telegramService, requireAdmin }));
  app.use(
    "/api/youtube",
    createYoutubeRouter({
      youtubeService,
      channelRegistry: youtubeChannelRegistry,
      channelIdOverrides: config.youtube.channelIds,
      requireAdmin,
    }),
  );
  app.use(
    "/api/x",
    createXFeedRouter({
      xFeedService,
      accountRegistry: xAccountRegistry,
      templateRegistry: xTemplateRegistry,
      requireAdmin: requireXAdmin,
      // The general sender, not the news one: an X post broadcast goes where
      // the operator ticked, and carries no category for news routing to act
      // on.
      telegramService,
      broadcastChannels: config.xBroadcast.channels,
    }),
  );

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
