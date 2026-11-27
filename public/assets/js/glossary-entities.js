/**
 * Organization profiles for the Market Glossary.
 * Each profile uses the same search, detail page and read-aloud as other entries.
 */
(function () {
  "use strict";

  var links = {
    calendar: { href: "/reporter.html#economic-calendar", label: "Economic Calendar" },
    macro: { href: "/market-intel.html#macro-indicators", label: "Macro Indicators" },
    crossAsset: { href: "/market-intel.html#cross-asset-overview", label: "Cross-Asset Overview" },
    matrix: { href: "/tradehunter/market-matrix", label: "Market Matrix" },
    indices: { href: "/qa.html#q=what-does-each-major-market-index-measure", label: "Market Q&A · Major market indices" },
    rates: { href: "/qa.html#q=how-do-federal-reserve-interest-rate-decisions-affect-bitcoin", label: "Market Q&A · Fed rate decisions" },
    etfs: { href: "/crypto.html#etf-flows", label: "Crypto Hub · ETF Flows" },
    oi: { href: "/open-interest.html", label: "Crypto Open Interest" },
    funding: { href: "/crypto.html#btc-liquidations-funding", label: "Crypto Hub · Liquidations & Funding" },
    onchain: { href: "/onchain.html", label: "On-Chain Dashboard" },
    research: { href: "/crypto.html#crypto-research", label: "Crypto Hub · Bitcoin Research" },
    stablecoins: { href: "/concept.html?id=stablecoin-netflow", label: "Stablecoin Netflow / Supply" },
    kucoin: { href: "/kucoin-live-trades.html", label: "KuCoin Live Trades" },
    heatmaps: { href: "/heatmaps.html", label: "Heatmaps" },
    chart: { href: "/tradehunter/tradingchart", label: "TradingChart" },
  };

  var profiles = [
    // Central banks, government data and regulators.
    {
      id: "federal-reserve", term: "Federal Reserve (Fed)", aliases: "US central bank Federal Reserve System",
      def: "The U.S. central bank. It implements monetary policy, provides banking and payment services, and supervises certain financial institutions.",
      read: "Follow policy decisions, guidance, and balance-sheet updates for changes in rate expectations and funding conditions. Compare the announcement with what markets had priced in.",
      pages: [links.rates, links.macro],
      source: { href: "https://www.federalreserve.gov/aboutthefed/fedexplained/monetary-policy.htm", label: "Federal Reserve · Monetary policy" },
    },
    {
      id: "federal-open-market-committee", term: "Federal Open Market Committee (FOMC)", aliases: "Fed meeting federal funds rate dot plot",
      def: "The Federal Reserve committee responsible for setting U.S. monetary policy, including the target range for the federal funds rate.",
      read: "Read the statement, press conference, and projections where scheduled. A decision in line with expectations can still move markets if guidance changes.",
      pages: [links.calendar, { href: "/concept.html?id=fomc", label: "FOMC / Fed Funds Rate" }, links.rates],
      source: { href: "https://www.federalreserve.gov/monetarypolicy/fomc.htm", label: "Federal Reserve · FOMC meetings" },
    },
    {
      id: "us-treasury", term: "U.S. Department of the Treasury", aliases: "US Treasury TGA Treasury General Account bills notes bonds debt issuance",
      def: "The federal department that manages government finances. Its Bureau of the Fiscal Service issues marketable Treasury bills, notes, bonds, and other government securities.",
      read: "Watch auction schedules, issuance plans, and the Treasury cash balance to understand changes in the supply of government debt and cash flows through the banking system.",
      pages: [links.macro, { href: "/concept.html?id=us10y", label: "U.S. 10-year Treasury yield" }],
      source: { href: "https://www.treasurydirect.gov/marketable-securities/", label: "TreasuryDirect · Marketable securities" },
    },
    {
      id: "bls", term: "U.S. Bureau of Labor Statistics (BLS)", aliases: "CPI consumer price index PPI producer price index NFP nonfarm payrolls",
      def: "The U.S. statistical agency that publishes the Consumer Price Index, Producer Price Index, and Employment Situation report.",
      read: "Check the published release, its reference period, revisions, and whether the figure is adjusted for seasonality. Traders often compare the result with the consensus forecast.",
      pages: [links.calendar, { href: "/qa.html#q=what-does-the-producer-price-index-ppi-measure", label: "Market Q&A · PPI" }],
      source: { href: "https://www.bls.gov/information-guide/", label: "BLS · Information guide" },
    },
    {
      id: "bea", term: "U.S. Bureau of Economic Analysis (BEA)", aliases: "GDP gross domestic product PCE personal consumption expenditures inflation",
      def: "The U.S. statistical agency that publishes national accounts, including gross domestic product and the Personal Consumption Expenditures price index.",
      read: "Use GDP for growth and PCE prices for inflation context. Check the release vintage and whether the reported change is annualized before comparing figures.",
      pages: [links.calendar, { href: "/concept.html?id=pce", label: "PCE Price Index" }],
      source: { href: "https://www.bea.gov/data/consumer-spending/main", label: "BEA · Consumer spending and prices" },
    },
    {
      id: "st-louis-fed-fred", term: "Federal Reserve Bank of St. Louis (FRED)", aliases: "Federal Reserve Economic Data ALFRED source vintage",
      def: "The regional Federal Reserve Bank that operates FRED, a database that republishes economic time series from many statistical agencies and other providers.",
      read: "Read a series’s original source, units, frequency, and dates. Use historical vintages from ALFRED when you need to backtest what was actually known at the time.",
      pages: [links.macro, links.crossAsset],
      source: { href: "https://fred.stlouisfed.org/help/about/about-fred/what-is-fred/", label: "FRED · About the database" },
    },
    {
      id: "sec", term: "U.S. Securities and Exchange Commission (SEC)", aliases: "EDGAR securities filings prospectus regulator",
      def: "The U.S. securities regulator. Its EDGAR database provides public access to filings from companies and investment products.",
      read: "Use the issuer’s prospectus or filing to confirm fund mechanics, material company events, and disclosures. An exchange filing or regulatory approval has a specific scope and date.",
      pages: [links.etfs, { href: "/qa.html#q=how-can-i-monitor-institutional-announcements", label: "Market Q&A · Institutional announcements" }],
      source: { href: "https://www.sec.gov/search-filings", label: "SEC · Search EDGAR filings" },
    },
    {
      id: "cftc", term: "U.S. Commodity Futures Trading Commission (CFTC)", aliases: "COT commitments of traders derivatives regulator",
      def: "The U.S. agency that regulates derivatives markets including futures, options on futures, and swaps. It publishes Commitments of Traders reports.",
      read: "Use the reports to compare positioning by participant category. The published figures represent an earlier observation date and cover listed contracts in the report.",
      pages: [{ href: "/qa.html#q=how-can-i-determine-where-institutional-money-is-flowing", label: "Market Q&A · Institutional flows" }],
      source: { href: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm", label: "CFTC · Commitments of Traders" },
    },
    {
      id: "ecb", term: "European Central Bank (ECB)", aliases: "euro area eurozone EUR EURUSD governing council",
      def: "The central bank for the euro area. Its Governing Council sets monetary policy for countries using the euro.",
      read: "Compare ECB policy expectations with those of the Fed when interpreting EUR/USD. Guidance and changes in expected rates can matter even when the current rate stays steady.",
      pages: [links.matrix, links.calendar],
      source: { href: "https://www.ecb.europa.eu/press/press_conference/monetary-policy-statement/html/index.en.html", label: "ECB · Monetary policy statements" },
    },
    {
      id: "bank-of-japan", term: "Bank of Japan (BOJ)", aliases: "Japanese central bank JPY USDJPY yen carry trade",
      def: "Japan’s central bank. It makes monetary policy decisions that influence domestic funding conditions and Japanese government bond yields.",
      read: "Watch policy announcements and USD/JPY alongside U.S. and Japanese yields. Rapid yen moves can affect leveraged carry trades, with the impact depending on positioning.",
      pages: [links.matrix, { href: "/concept.html?id=yen-carry-trade", label: "Yen carry trade" }],
      source: { href: "https://www.boj.or.jp/en/mopo/index.htm", label: "Bank of Japan · Monetary policy" },
    },

    // Benchmark administrators and traditional trading venues.
    {
      id: "sp-dow-jones-indices", term: "S&P Dow Jones Indices (S&P DJI)", aliases: "SPDJI SPX S&P 500 Dow Jones Industrial Average DJIA DJI",
      def: "The index provider that maintains benchmarks including the S&P 500 and the Dow Jones Industrial Average. It publishes their eligibility, weighting, and maintenance rules.",
      read: "The S&P 500 uses float-adjusted market-cap weights, while the Dow uses share-price weights. When using a benchmark, distinguish its index level from the price of a fund or futures contract tracking it.",
      pages: [links.indices, links.matrix],
      source: { href: "https://www.spglobal.com/spdji/en/", label: "S&P DJI · Index directory" },
    },
    {
      id: "nasdaq", term: "Nasdaq", aliases: "Nasdaq Stock Market Nasdaq Composite Nasdaq-100 NDX QQQ",
      def: "An exchange operator and index provider. The Nasdaq-100 tracks 100 large nonfinancial companies listed on Nasdaq, while the Nasdaq Composite covers a broader group of listed securities.",
      read: "Identify the benchmark in a headline or chart. The Nasdaq-100, Composite, QQQ fund, and Nasdaq-100 futures are distinct instruments or measures.",
      pages: [links.matrix, links.indices],
      source: { href: "https://indexes.nasdaq.com/Index/Overview/NDX", label: "Nasdaq · Nasdaq-100 index" },
    },
    {
      id: "ftse-russell", term: "FTSE Russell", aliases: "LSEG RUT Russell 2000 Russell 1000 FTSE 100 reconstitution",
      def: "An index business within LSEG that maintains benchmarks including the Russell 2000, a measure of U.S. small-cap equities.",
      read: "Compare Russell 2000 performance with the S&P 500 to put small-cap participation in context. Check the provider’s reconstitution schedule when constituent changes may affect volume.",
      pages: [links.indices, links.matrix],
      source: { href: "https://www.lseg.com/en/ftse-russell/indices/russell-2000-index", label: "FTSE Russell · Russell 2000" },
    },
    {
      id: "cme-group", term: "CME Group", aliases: "Chicago Mercantile Exchange ES NQ BTC futures BRR CME gap",
      def: "A derivatives exchange group whose listed products include E-mini equity index futures and cash-settled Bitcoin futures.",
      read: "Check the product’s trading hours, contract size, and expiration. Compare a CME Bitcoin contract with spot or perpetuals using aligned timestamps and account for rolling expiring contracts.",
      pages: [links.matrix, { href: "/concept.html?id=cme-gap", label: "CME gap" }],
      source: { href: "https://www.cmegroup.com/markets/cryptocurrencies/bitcoin/bitcoin", label: "CME Group · Bitcoin futures" },
    },
    {
      id: "cboe", term: "Cboe Global Markets", aliases: "Chicago Board Options Exchange VIX SPX options",
      def: "An exchange operator and benchmark provider. Its VIX Index estimates expected 30-day S&P 500 volatility from S&P 500 index options.",
      read: "Read VIX as an equity-options volatility gauge. VIX futures and funds can behave differently from the index because they reflect separate pricing and expirations.",
      pages: [links.crossAsset, { href: "/concept.html?id=vix", label: "VIX" }],
      source: { href: "https://www.cboe.com/tradable_products/vix/faqs", label: "Cboe · VIX FAQ" },
    },
    {
      id: "intercontinental-exchange", term: "Intercontinental Exchange (ICE)", aliases: "ICE Futures US ICE Data Indices DXY USDX DX dollar index",
      def: "A market infrastructure and data group. Its businesses include the NYSE, an index provider, and ICE Futures U.S., which lists U.S. Dollar Index futures.",
      read: "Use the U.S. Dollar Index as a basket measure of dollar strength. Keep the index, its futures contracts, and individual currency pairs distinct when comparing market moves.",
      pages: [links.matrix, { href: "/concept.html?id=dxy", label: "U.S. Dollar Index (DXY)" }],
      source: { href: "https://www.ice.com/forex/usdx", label: "ICE · U.S. Dollar Index futures" },
    },
    {
      id: "nyse", term: "New York Stock Exchange (NYSE)", aliases: "New York Stock Exchange ICE stock listings opening closing auction",
      def: "A U.S. exchange within ICE that lists securities and runs trading sessions, including opening and closing auctions.",
      read: "Check the listing venue and session when comparing a stock’s volume or price. An auction print at the close can behave differently from continuous-session trades.",
      pages: [links.heatmaps, links.matrix],
      source: { href: "https://www.nyse.com/trade/equities", label: "NYSE · Equities trading" },
    },

    // Crypto trading and custody venues.
    {
      id: "coinbase", term: "Coinbase", aliases: "Coinbase Exchange Coinbase Prime Coinbase Custody COIN BTCUSD",
      def: "A crypto company with exchange, institutional trading, and custody businesses. Its venue data describes activity on Coinbase products.",
      read: "Separate Coinbase’s BTC/USD activity, a custodian’s holdings, and COIN stock performance. Each reflects different exposure and different data.",
      pages: [links.etfs, links.matrix],
      source: { href: "https://docs.cdp.coinbase.com/exchange/introduction/welcome", label: "Coinbase · Exchange documentation" },
    },
    {
      id: "binance", term: "Binance", aliases: "BNB BTCUSDT Binance Spot USD-M Coin-M futures",
      def: "A centralized crypto exchange whose product documentation covers spot and derivatives markets. Binance symbols are used for several dashboard crypto feeds.",
      read: "Check the product and quote currency before comparing volume, funding, or open interest. Binance spot BTC/USDT and its perpetual contract each have their own trading data.",
      pages: [links.oi, links.funding],
      source: { href: "https://developers.binance.com/en/docs/catalog", label: "Binance · Market API documentation" },
    },
    {
      id: "bybit", term: "Bybit", aliases: "Bybit V5 linear inverse perpetual open interest",
      def: "A crypto trading venue with spot and derivatives products. Its market data includes open interest for supported derivatives.",
      read: "When comparing Bybit with other venues, match the contract type, timestamp, and open-interest units. A snapshot from one exchange represents that exchange’s activity.",
      pages: [links.oi, links.funding],
      source: { href: "https://bybit-exchange.github.io/docs/v5/market/open-interest", label: "Bybit · Open-interest documentation" },
    },
    {
      id: "okx", term: "OKX", aliases: "OKEx spot swap futures options open interest",
      def: "A crypto trading venue that publishes market data for products such as spot, perpetual swaps, dated futures, and options.",
      read: "Identify the instrument type and the reported units before comparing its prices or position data with another exchange. Contract counts and USD notional can change differently.",
      pages: [links.oi, links.funding],
      source: { href: "https://www.okx.com/docs-v5/en/", label: "OKX · Market data documentation" },
    },
    {
      id: "kucoin", term: "KuCoin", aliases: "KuCoin trade history public trade feed order book",
      def: "A crypto exchange with public market-data feeds. The dashboard’s KuCoin Live Trades page displays trade prints and related metrics from the venue.",
      read: "Use a trade print to see executed activity on the selected KuCoin pair. Compare venue, quote currency, and units before interpreting it as a wider change in crypto demand.",
      pages: [links.kucoin],
      source: { href: "https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-trade-history", label: "KuCoin · Trade history documentation" },
    },
    {
      id: "bitget", term: "Bitget", aliases: "Bitget USDT futures USDT-FUTURES paper scanner market data",
      def: "A crypto trading venue that publishes spot and derivatives data. The dashboard uses Bitget candles for its paper-trading scanner.",
      read: "Use the venue’s product specification to interpret the candle, contract, and funding fields. A paper strategy’s results also depend on how it models execution and cost.",
      pages: [{ href: "/trading-lab.html", label: "Trading Lab" }, links.oi],
      source: { href: "https://www.bitget.com/docs/catalog/market/market-data", label: "Bitget · Market data documentation" },
    },
    {
      id: "deribit", term: "Deribit", aliases: "DVOL Deribit Implied Volatility Index crypto options bitcoin ethereum",
      def: "A crypto derivatives exchange whose products include Bitcoin and Ether options. Its DVOL index measures option-implied volatility for a specified underlying asset.",
      read: "Use the underlying and expiry to interpret an option quote, and treat implied volatility as a measure of expected magnitude. It can move independently of spot price direction.",
      pages: [{ href: "/concept.html?id=implied-volatility", label: "Implied volatility" }],
      source: { href: "https://insights.deribit.com/exchange-updates/dvol-deribit-implied-volatility-index/", label: "Deribit · DVOL methodology" },
    },

    // Asset managers and stablecoin issuers.
    {
      id: "blackrock", term: "BlackRock (iShares)", aliases: "IBIT iShares Bitcoin Trust ETF BlackRock asset manager",
      def: "A global asset manager. Its iShares product family includes IBIT, a U.S. exchange-traded product that holds Bitcoin.",
      read: "When reading IBIT data, distinguish its share turnover, net creations or redemptions, and Bitcoin holdings. Those measures answer different questions about trading and ownership.",
      pages: [links.etfs],
      source: { href: "https://www.ishares.com/us/products/333011/ibit-ishares-bitcoin-trust-etf", label: "iShares · IBIT fund details" },
    },
    {
      id: "fidelity-investments", term: "Fidelity Investments", aliases: "FBTC Fidelity Wise Origin Bitcoin Fund",
      def: "A financial services and asset management firm with crypto-related investment products, including the Fidelity Wise Origin Bitcoin Fund (FBTC).",
      read: "Compare FBTC net flows and fund holdings alongside those of peer products. The fund’s share trading volume does not alone identify creations or redemptions.",
      pages: [links.etfs],
      source: { href: "https://institutional.fidelity.com/advisors/investment-solutions/asset-classes/alternatives/digital-assets/fidelity-wise-origin-bitcoin-fund", label: "Fidelity · FBTC fund details" },
    },
    {
      id: "grayscale", term: "Grayscale", aliases: "GBTC Grayscale Bitcoin Trust ETF ETHE asset manager",
      def: "A digital-asset manager that sponsors exchange-traded products including the Grayscale Bitcoin Trust ETF (GBTC).",
      read: "Check the ticker and share structure when studying historical flows. A GBTC outflow may coincide with investment in another product, so compare the category-wide net total.",
      pages: [links.etfs],
      source: { href: "https://etfs.grayscale.com/gbtc", label: "Grayscale · GBTC fund details" },
    },
    {
      id: "tether", term: "Tether", aliases: "USDT USD₮ USDT.D Tether dominance stablecoin reserves",
      def: "The issuer behind USDT, a dollar-linked stablecoin used as collateral and a quote currency on many crypto venues.",
      read: "Track supply, peg, reserve disclosures, and market depth together. USDT dominance can rise because other crypto prices fall, even if USDT supply is flat.",
      pages: [links.stablecoins, { href: "/qa.html#q=what-does-usdt-dominance-tell-us-about-market-sentiment", label: "Market Q&A · USDT dominance" }],
      source: { href: "https://tether.to/en/transparency/", label: "Tether · Supply and reserve disclosures" },
    },
    {
      id: "circle", term: "Circle", aliases: "USDC USDC.D EURC stablecoin Circle Internet Group CRCL",
      def: "The company behind USDC, a dollar-linked stablecoin that circulates on multiple blockchains and is used for settlement, trading, and collateral.",
      read: "Check the peg, chain, and issuance or redemption data. A move in USDC supply can reflect settlement or transfers between products as well as changes in demand.",
      pages: [links.stablecoins, links.onchain],
      source: { href: "https://www.circle.com/transparency", label: "Circle · USDC reserve disclosures" },
    },

    // Data and charting providers.
    {
      id: "tradingview", term: "TradingView", aliases: "Pine Script market heatmaps charting exchange prefix",
      def: "A charting and market-data platform that displays symbols from exchanges and other data providers. The dashboard includes several TradingView charts and heatmaps.",
      read: "Read the symbol prefix, session, and delay status before comparing charts. Different feeds can show different prices for similarly named instruments.",
      pages: [links.heatmaps, links.chart],
      source: { href: "https://www.tradingview.com/data-coverage/", label: "TradingView · Market-data coverage" },
    },
    {
      id: "coinglass", term: "CoinGlass", aliases: "CoinGlass liquidations heatmap funding open interest crypto ETF flows",
      def: "A crypto analytics provider that collects derivatives data and publishes dashboards for funding, open interest, liquidations, and ETF flows.",
      read: "Check exchange and product coverage, units, and timestamps when comparing series. Liquidation heatmaps estimate where events could occur, while reported liquidations describe events observed by the feed.",
      pages: [links.funding, links.etfs],
      source: { href: "https://www.coinglass.com/liquidations", label: "CoinGlass · Liquidation data" },
    },
    {
      id: "coingecko", term: "CoinGecko", aliases: "Coingecko market capitalization market cap crypto spot data aggregator coin IDs",
      def: "A crypto market-data aggregator that combines prices and other information from multiple sources.",
      read: "Use the provider’s asset identifiers and aggregation rules when comparing prices or market capitalization. A blended quote can differ from an executable order-book price.",
      pages: [links.heatmaps, { href: "/concept.html?id=market-caps", label: "Market capitalizations" }],
      source: { href: "https://www.coingecko.com/en/methodology", label: "CoinGecko · Data methodology" },
    },
    {
      id: "glassnode", term: "Glassnode", aliases: "Glassnode Studio MVRV SOPR on-chain address clustering",
      def: "An analytics provider that publishes blockchain-derived measures such as holder cohorts, realized value, and exchange balances.",
      read: "Check whether a series is address-based or entity-adjusted. Inferences about ownership and exchange balances depend on the provider’s labeling and clustering methods.",
      pages: [links.research, { href: "/concept.html?id=mvrv", label: "MVRV" }],
      source: { href: "https://docs.glassnode.com/basic-api/endpoints/indicators", label: "Glassnode · Indicator definitions" },
    },
    {
      id: "cryptoquant", term: "CryptoQuant", aliases: "CryptoQuant BTC exchange flows exchange reserves netflow onchain",
      def: "An analytics provider that publishes crypto market and on-chain metrics, including flows and balances for addresses it attributes to exchanges.",
      read: "Treat transfers into labeled wallets as an observation. Confirm unusual flow readings with other sources and market data before drawing conclusions about sales or demand.",
      pages: [links.research, { href: "/concept.html?id=exchange-netflow", label: "Exchange inflow and outflow" }],
      source: { href: "https://userguide.cryptoquant.com/cryptoquant-metrics/exchange", label: "CryptoQuant · Exchange flow definitions" },
    },

    // Public companies relevant to cross-asset analysis.
    {
      id: "nvidia", term: "NVIDIA (NVDA)", aliases: "NVIDIA Corporation graphics processors GPU AI data centers semiconductor",
      def: "A publicly traded semiconductor designer whose businesses include computing and networking products for data centers, gaming, and other markets.",
      read: "Check the company’s earnings and guidance, then compare NVDA with the semiconductor sector and its benchmark. Index weight determines how much a stock move contributes to an index.",
      pages: [links.matrix, links.heatmaps],
      source: { href: "https://investor.nvidia.com/financial-info/financial-reports/", label: "NVIDIA · Financial reports" },
    },
    {
      id: "strategy", term: "Strategy (MSTR)", aliases: "MicroStrategy Bitcoin treasury equity convertible notes preferred stock",
      def: "The public company formerly named MicroStrategy. It operates an enterprise software business and holds Bitcoin as part of its treasury strategy.",
      read: "Compare the value of its Bitcoin holdings with the company’s equity valuation, liabilities, and capital structure. MSTR can move differently from Bitcoin because of financing and changes in its valuation premium.",
      pages: [links.matrix, links.etfs],
      source: { href: "https://www.strategy.com/company", label: "Strategy · Company overview" },
    },
  ].map(function (profile) {
    return Object.assign({ category: "Companies & Institutions", readLabel: "Why it matters" }, profile);
  });

  if (typeof window !== "undefined") window.MarketGlossaryEntities = profiles;
  if (typeof module !== "undefined" && module.exports) module.exports = profiles;
})();
