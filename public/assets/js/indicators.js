/**
 * Indicators Glossary — data + renderer for indicators.html.
 * Each entry: term, category, def (what it is), read (how to interpret it),
 * and pages (where it shows up elsewhere in this dashboard).
 */
(function () {
  "use strict";

  var GLOSSARY = [
    // ── Technical Indicators ──────────────────────────────────────────
    {
      id: "macd", term: "MACD (Moving Average Convergence Divergence)", category: "Technical Indicators",
      def: "A momentum indicator that plots the gap between a 12-period and 26-period EMA (the “MACD line”), plus a 9-period EMA of that line (the “signal line”). The difference between them is often shown as a histogram.",
      read: "MACD line crossing above the signal line is typically read as bullish momentum building; crossing below is bearish. A widening histogram means momentum is accelerating in that direction.",
      pages: [{ label: "Crypto Hub → Heatmaps & Momentum", href: "/crypto.html#heatmaps" }],
    },
    {
      id: "rsi", term: "RSI (Relative Strength Index)", category: "Technical Indicators",
      def: "A 0–100 momentum oscillator measuring the speed and size of recent price moves, usually over a 14-period lookback.",
      read: "Above 70 is conventionally overbought, below 30 oversold — but in strong trends RSI can stay extreme for a long time, so it's more reliable for spotting divergences than as a standalone buy/sell trigger.",
      pages: [{ label: "Crypto Hub → Heatmaps & Momentum", href: "/crypto.html#heatmaps" }],
    },
    {
      id: "ema", term: "EMA (Exponential Moving Average)", category: "Technical Indicators",
      def: "A moving average that weights recent prices more heavily than older ones, so it reacts faster to new price action than a simple average.",
      read: "Price holding above a rising EMA (commonly 20/50/200-period) is read as trend support; a cross below is often an early trend-change signal. A shorter EMA crossing a longer one (e.g. the 50/200 “golden cross”) is a classic trend-following trigger.",
      pages: [{ label: "Crypto Hub → Bitcoin Research", href: "/crypto.html#crypto-research" }],
    },
    {
      id: "sma", term: "SMA (Simple Moving Average)", category: "Technical Indicators",
      def: "The unweighted average closing price over a fixed window (e.g. 50-day, 200-day) — every period counts equally, so it's smoother and slower to react than an EMA.",
      read: "The 200-day SMA is the most widely watched long-term trend line in both crypto and equities; sustained price below it is broadly treated as a bear-market signal.",
      pages: [{ label: "Crypto Hub → Bitcoin Research", href: "/crypto.html#crypto-research" }],
    },
    {
      id: "bollinger", term: "Bollinger Bands", category: "Technical Indicators",
      def: "A volatility envelope — a moving average (typically 20-period) plus and minus two standard deviations of price, forming an upper and lower band.",
      read: "Bands squeezing tight signal low volatility and often precede a sharp move; price tagging a band means volatility is expanding in that direction, not necessarily “time to reverse.”",
      pages: [{ label: "Crypto Hub → Bitcoin Research", href: "/crypto.html#crypto-research" }],
    },

    // ── Futures & Derivatives ─────────────────────────────────────────
    {
      id: "open-interest", term: "Open Interest (OI)", category: "Futures & Derivatives",
      def: "The total number of outstanding (not yet closed) futures or options contracts on an asset — a direct measure of how much leveraged money is in the market.",
      read: "OI rising with price = fresh money entering, conviction building. OI rising while price is flat/falling = leverage stacking up, raising squeeze risk. OI falling = positions closing or being liquidated.",
      pages: [
        { label: "Crypto Hub → Open-Interest Overview", href: "/crypto.html#open-interest" },
        { label: "On-Chain → Derivatives", href: "/on-chain.html#derivatives" },
      ],
    },
    {
      id: "futures-volume", term: "Futures Volume", category: "Futures & Derivatives",
      def: "The dollar or contract volume of futures trades over a period — how much derivatives activity is happening, independent of how many positions are still open.",
      read: "Rising volume alongside rising OI confirms genuine new positioning rather than existing positions just churning. Volume spikes without an OI change usually mean traders are flipping sides, not adding net exposure.",
      pages: [{ label: "Crypto Hub → Market Volumes", href: "/crypto.html#market-overview-dashboard" }],
    },
    {
      id: "funding-rate", term: "Funding Rate", category: "Futures & Derivatives",
      def: "A periodic payment (usually every 8 hours) between long and short holders of a perpetual futures contract, designed to keep the perp price anchored to spot.",
      read: "Positive funding = longs pay shorts (market leaning bullish, can get crowded). Negative funding = shorts pay longs. Persistently high positive funding alongside flat price is a classic “longs overcrowded” squeeze setup.",
      pages: [
        { label: "Crypto Hub → Interactive Dashboards", href: "/crypto.html#interactive-dashboards" },
        { label: "On-Chain → Derivatives", href: "/on-chain.html#derivatives" },
      ],
    },
    {
      id: "long-short-ratio", term: "Long/Short Ratio", category: "Futures & Derivatives",
      def: "The ratio of accounts (or position size) holding long vs. short positions on a given exchange or contract.",
      read: "A heavily skewed ratio signals crowded positioning on one side, which raises the odds of a liquidation cascade if price moves against the crowd.",
      pages: [
        { label: "Crypto Hub → Interactive Dashboards", href: "/crypto.html#interactive-dashboards" },
        { label: "On-Chain → Derivatives", href: "/on-chain.html#derivatives" },
      ],
    },
    {
      id: "liquidations", term: "Liquidations", category: "Futures & Derivatives",
      def: "The forced closing of a leveraged position when losses erode a trader's margin below the maintenance threshold — the exchange closes it automatically.",
      read: "A spike in long liquidations means leveraged longs got flushed on a drop (often capitulation, sometimes a local bottom). A spike in short liquidations on a rally signals a short squeeze. Liquidation heatmaps show price levels with the most leveraged positions stacked — these often act as price magnets.",
      pages: [
        { label: "Crypto Hub → Liquidations", href: "/crypto.html#liquidations" },
        { label: "On-Chain → Derivatives", href: "/on-chain.html#derivatives" },
      ],
    },
    {
      id: "options-expiration", term: "Options Expiration", category: "Futures & Derivatives",
      def: "The date a batch of options contracts expires and stops trading — large simultaneous expiries can temporarily distort spot price as market makers hedge.",
      read: "Watch for price gravitating toward the “max pain” strike (the level causing the most option holders to lose money) in the days leading into a large expiry.",
      pages: [
        { label: "Traditional → Market Data", href: "/traditional.html#market-data" },
        { label: "Overview → Calendars & Tools", href: "/#calendars-tools" },
      ],
    },

    // ── On-Chain & Network ────────────────────────────────────────────
    {
      id: "active-addresses", term: "Active Addresses", category: "On-Chain & Network",
      def: "The count of unique wallet addresses that sent or received a transaction on-chain over a given window — a rough proxy for network usage.",
      read: "Rising active addresses alongside rising price supports a “real demand” narrative. Price rising while active addresses stagnate or fall is a divergence worth noting — the rally may be thinner than it looks.",
      pages: [
        { label: "Crypto Hub → Bitcoin Research", href: "/crypto.html#crypto-research" },
        { label: "On-Chain → Network Activity", href: "/on-chain.html#network-activity" },
      ],
    },
    {
      id: "hash-rate", term: "Hash Rate", category: "On-Chain & Network",
      def: "The total computational power miners dedicate to securing a proof-of-work network like Bitcoin, usually measured in EH/s (exahashes per second).",
      read: "A steadily rising hash rate signals miner confidence and network security strengthening. Sharp drops (e.g. after regulatory bans or energy crises) can briefly slow block production until difficulty readjusts.",
      pages: [{ label: "On-Chain → Network Activity", href: "/on-chain.html#network-activity" }],
    },
    {
      id: "mempool", term: "Mempool & Transaction Fees", category: "On-Chain & Network",
      def: "The mempool is the queue of unconfirmed transactions waiting to be included in a block; fee pressure rises when more transactions compete for limited block space.",
      read: "A growing, high-fee mempool signals network congestion and real on-chain demand. A near-empty mempool with low fees means block space is easy to get — low urgency.",
      pages: [
        { label: "Crypto Hub → Interactive Dashboards", href: "/crypto.html#interactive-dashboards" },
        { label: "On-Chain → Network Activity", href: "/on-chain.html#network-activity" },
      ],
    },
    {
      id: "exchange-netflow", term: "Exchange Inflow & Outflow (Netflow)", category: "On-Chain & Network",
      def: "The net amount of an asset moving onto exchanges (inflow) vs. off exchanges into self-custody (outflow).",
      read: "Large inflows often precede selling pressure (coins moved to exchanges to be sold). Sustained outflows suggest accumulation/holding conviction, since coins are leaving liquid markets.",
      pages: [
        { label: "Crypto Hub → Alt Research", href: "/crypto.html#alt-research" },
        { label: "On-Chain → Exchange Flows", href: "/on-chain.html#exchange-flows" },
      ],
    },
    {
      id: "stablecoin-netflow", term: "Stablecoin Netflow / Supply", category: "On-Chain & Network",
      def: "The net change in stablecoin supply minted or burned, and the flow of stablecoins onto/off exchanges — a proxy for the “dry powder” available to buy crypto.",
      read: "Rising stablecoin supply plus inflows to exchanges suggests fresh buying power entering the market. Shrinking supply or outflows to fiat suggests capital leaving the crypto ecosystem.",
      pages: [{ label: "On-Chain → Stablecoin Flows", href: "/on-chain.html#stablecoin-flows" }],
    },
    {
      id: "whale-transactions", term: "Whale Transactions", category: "On-Chain & Network",
      def: "Tracking of unusually large transfers (commonly $100k+, or top-holder wallets) that can move markets or signal informed positioning.",
      read: "Large transfers TO exchanges often precede selling; large transfers FROM exchanges into cold storage often signal accumulation. A single whale move isn't conclusive — look for clusters of same-direction activity.",
      pages: [{ label: "On-Chain → Whale Tracking", href: "/on-chain.html#whale-tracking" }],
    },

    // ── Cycle & Valuation (Bitcoin-specific) ──────────────────────────
    {
      id: "mvrv", term: "MVRV (Z-Score)", category: "Cycle & Valuation",
      def: "Market Value to Realized Value — compares Bitcoin's current market cap to the aggregate cost basis of every coin (realized cap). The Z-Score normalizes this by historical volatility.",
      read: "Very high MVRV Z-Score readings have historically lined up with cycle tops (the market is deeply in aggregate profit, sell pressure builds). Very low or negative readings have historically lined up with cycle bottoms.",
      pages: [{ label: "On-Chain → Cycle Indicators", href: "/on-chain.html#cycle-indicators" }],
    },
    {
      id: "nupl", term: "NUPL (Net Unrealized Profit/Loss)", category: "Cycle & Valuation",
      def: "The aggregate unrealized profit or loss held by all coin holders, expressed as a share of market cap.",
      read: "Divided into named zones (Capitulation, Hope/Fear, Optimism, Belief, Euphoria/Greed). Euphoria-zone readings have historically marked late-cycle tops; Capitulation-zone readings have marked deep bottoms.",
      pages: [{ label: "On-Chain → Cycle Indicators", href: "/on-chain.html#cycle-indicators" }],
    },
    {
      id: "puell-multiple", term: "Puell Multiple", category: "Cycle & Valuation",
      def: "Daily miner revenue (in USD) divided by its 365-day moving average — measures whether mining is currently extremely profitable or unprofitable relative to its own history.",
      read: "Very high readings mean miners are earning far above average and have historically coincided with cycle tops (miners sell more). Very low readings mean mining is unusually unprofitable, historically associated with cycle bottoms.",
      pages: [{ label: "On-Chain → Cycle Indicators", href: "/on-chain.html#cycle-indicators" }],
    },
    {
      id: "stock-to-flow", term: "Stock-to-Flow (S2F)", category: "Cycle & Valuation",
      def: "A scarcity model dividing the existing stock of an asset by its annual new production (flow) — a commodities model applied to Bitcoin because of its programmed, halving supply schedule.",
      read: "Treat it as a long-term scarcity narrative, not a timing tool — its predictive track record has been heavily debated since 2021, so use it as one input rather than a price target.",
      pages: [{ label: "On-Chain → Cycle Indicators", href: "/on-chain.html#cycle-indicators" }],
    },
    {
      id: "pi-cycle-top", term: "Pi Cycle Top Indicator", category: "Cycle & Valuation",
      def: "Compares the 111-day moving average to 2x the 350-day moving average; historically, when the shorter line crosses up through the longer one, it has closely marked previous Bitcoin cycle tops.",
      read: "Treat a Pi Cycle cross as a late-cycle warning sign rather than an exact top signal — it has fired close to, not exactly at, past tops.",
      pages: [{ label: "On-Chain → Cycle Indicators", href: "/on-chain.html#cycle-indicators" }],
    },

    // ── Market Cap & Dominance ────────────────────────────────────────
    {
      id: "btc-dominance", term: "Bitcoin Dominance", category: "Market Cap & Dominance",
      def: "Bitcoin's market cap as a percentage of the total crypto market cap.",
      read: "Rising dominance with a flat/falling total market cap usually means capital rotating out of altcoins into BTC (risk-off within crypto). Falling dominance with a rising total market cap usually signals “alt season,” where altcoins outperform BTC.",
      pages: [{ label: "Crypto Hub → Indicators", href: "/crypto.html#cmc-indicators" }],
    },
    {
      id: "altcoin-season-index", term: "Altcoin Season Index", category: "Market Cap & Dominance",
      def: "A composite score (0–100) measuring what share of the top altcoins have outperformed Bitcoin over the trailing 90 days.",
      read: "Above ~75 is conventionally labeled “Altcoin Season” (most alts beating BTC); below ~25 is “Bitcoin Season.” It's a backward-looking confirmation tool, not a leading signal.",
      pages: [{ label: "Crypto Hub → Alt Research", href: "/crypto.html#alt-research" }],
    },
    {
      id: "cmc-indices", term: "CMC20 / CMC100 Index", category: "Market Cap & Dominance",
      def: "Market-cap-weighted indices tracking CoinMarketCap's top 20 / top 100 cryptocurrencies — similar in concept to the S&P 500, but for crypto.",
      read: "Useful as a single number for “how is the broad crypto market doing” without checking each asset individually — compare against BTC alone to see if a move is BTC-led or broad-based.",
      pages: [{ label: "Crypto Hub → Indicators", href: "/crypto.html#cmc-indicators" }],
    },

    // ── Volatility & Sentiment ────────────────────────────────────────
    {
      id: "fear-greed", term: "Fear & Greed Index", category: "Volatility & Sentiment",
      def: "A composite sentiment score (0–100) blending volatility, momentum, social activity, and survey data into a single “how emotional is the market right now” reading. Crypto (alternative.me) and traditional markets (CNN) each publish their own version.",
      read: "Extreme Fear readings have historically been decent contrarian buy zones; Extreme Greed readings have historically preceded pullbacks. It's a sentiment gauge, not a standalone timing signal.",
      pages: [
        { label: "Crypto Hub → Bitcoin Research", href: "/crypto.html#crypto-research" },
        { label: "Overview → Calendars & Tools", href: "/#calendars-tools" },
      ],
    },
    {
      id: "vix", term: "VIX (CBOE Volatility Index)", category: "Volatility & Sentiment",
      def: "Derived from S&P 500 options pricing, VIX estimates the market's expected 30-day volatility — often called the equity market's “fear gauge.”",
      read: "VIX below ~15 signals complacency/low expected volatility; above ~25–30 signals elevated fear, often correlated with broad risk-off moves that can spill into crypto.",
      pages: [{ label: "Traditional → Key Charts", href: "/traditional.html#key-charts" }],
    },

    // ── ETF Flows ─────────────────────────────────────────────────────
    {
      id: "etf-flows", term: "Spot ETF Flows", category: "ETF Flows",
      def: "The daily net dollar amount moving into or out of spot Bitcoin/Ethereum ETFs — a direct read on regulated, institutional demand, since these funds must buy/sell the underlying asset to match flows.",
      read: "Sustained net inflows are a steady source of real spot demand (a supply sink). A run of net outflows signals institutional money pulling back and can pressure spot price.",
      pages: [
        { label: "Crypto Hub → ETF Flows", href: "/crypto.html#etf-flows" },
        { label: "Crypto Hub → Interactive Dashboards", href: "/crypto.html#interactive-dashboards" },
      ],
    },

    // ── Traditional Markets ───────────────────────────────────────────
    {
      id: "dxy", term: "DXY (US Dollar Index)", category: "Traditional Markets",
      def: "Measures the US dollar's value against a basket of major foreign currencies (euro-weighted heaviest).",
      read: "A strong/rising DXY is typically a headwind for risk assets including crypto (tightening global dollar liquidity); a falling DXY is typically supportive of risk-on moves.",
      pages: [{ label: "Traditional → Key Charts", href: "/traditional.html#key-charts" }],
    },
    {
      id: "us10y", term: "US10Y (10-Year Treasury Yield)", category: "Traditional Markets",
      def: "The yield on the US 10-year government bond — a benchmark for the broader cost of money and a key input to how richly other assets get valued.",
      read: "Rapidly rising yields tend to pressure risk assets (higher “risk-free” returns compete with stocks/crypto); falling yields tend to support risk-on positioning.",
      pages: [{ label: "Traditional → Key Charts", href: "/traditional.html#key-charts" }],
    },

    // ── Macro Economics ───────────────────────────────────────────────
    {
      id: "cpi", term: "CPI / Inflation Rate", category: "Macro Economics",
      def: "The Consumer Price Index measures the change in prices of a basket of goods and services over time — the headline gauge of inflation.",
      read: "Hotter-than-expected CPI prints typically push rate-hike expectations up (bearish for risk assets); cooler prints do the opposite. Markets react to the surprise vs. forecast, not just the raw number.",
      pages: [{ label: "Market Intel → Macro Indicators", href: "/market-intel.html#macro-indicators" }],
    },
    {
      id: "gdp", term: "GDP Growth Rate", category: "Macro Economics",
      def: "The percentage change in a country's total economic output over a period — the broadest single measure of economic health.",
      read: "Slowing or negative GDP growth (especially two consecutive negative quarters) raises recession concerns, typically pressuring risk assets and pulling rate-cut expectations forward.",
      pages: [{ label: "Market Intel → Macro Indicators", href: "/market-intel.html#macro-indicators" }],
    },
    {
      id: "unemployment", term: "Unemployment Rate", category: "Macro Economics",
      def: "The share of the labor force that is jobless and actively seeking work.",
      read: "A rising unemployment rate alongside other weakening data raises recession risk; an unexpectedly strong (low) reading can fuel “no rate cuts needed” repricing, which can pressure risk assets short-term.",
      pages: [{ label: "Market Intel → Macro Indicators", href: "/market-intel.html#macro-indicators" }],
    },
    {
      id: "fomc", term: "FOMC / Fed Funds Rate", category: "Macro Economics",
      def: "The Federal Open Market Committee sets the Fed Funds Rate, the benchmark US interest rate that ripples through borrowing costs, bond yields, and risk-asset valuations globally.",
      read: "Rate hikes (or hawkish guidance) are typically a headwind for crypto/equities by tightening liquidity; rate cuts (or dovish guidance) are typically supportive.",
      pages: [
        { label: "Traditional → Macro", href: "/traditional.html#macro" },
        { label: "Overview → Calendars & Tools", href: "/#calendars-tools" },
      ],
    },
    {
      id: "nber-recession", term: "NBER Recession Indicators", category: "Macro Economics",
      def: "The National Bureau of Economic Research is the official US arbiter of recession start/end dates, using a broad set of indicators (employment, income, spending, production) rather than one simple rule.",
      read: "NBER calls are announced well after the fact (often 6–12+ months into a recession) — useful for historical context, not as a real-time trading signal.",
      pages: [{ label: "Traditional → Macro", href: "/traditional.html#macro" }],
    },

    // ── Commodities ───────────────────────────────────────────────────
    {
      id: "cot-report", term: "COT Report (Commitments of Traders)", category: "Commodities",
      def: "A weekly CFTC report showing how different trader categories (commercials/hedgers, large speculators, small speculators) are positioned in futures markets like gold, oil, and currencies.",
      read: "Commercial hedgers are often viewed as the “smart money” — extreme positioning by commercials against the speculative crowd has historically preceded trend reversals.",
      pages: [{ label: "Traditional → Commodities", href: "/traditional.html#commodities" }],
    },
  ];

  var USER_GLOSSARY = [
    {
      id: "untapped-liquidity", term: "Untapped Liquidity", category: "Price Action & Liquidity",
      def: "Resting liquidity that price has not yet traded into, often visible near prior highs/lows, equal highs/lows, unfilled gaps, or obvious stop clusters.",
      read: "Untapped liquidity often acts like a magnet. A move into it can fuel continuation, but a sharp rejection after the sweep can mark a reversal attempt.",
    },
    {
      id: "open-liquidity", term: "Open Liquidity", category: "Price Action & Liquidity",
      def: "Visible or inferred liquidity that remains available above or below current price, including stops, limit orders, liquidation levels, and unfilled auction areas.",
      read: "Map open liquidity on both sides of price. The side with the cleaner, more obvious liquidity pool is often the next target before a real directional move forms.",
    },
    {
      id: "liquidity", term: "Liquidity", category: "Price Action & Liquidity",
      def: "The available buying and selling interest that lets price move through a market without excessive slippage.",
      read: "High liquidity produces cleaner fills and tighter spreads. Thin liquidity exaggerates wicks, slippage, and stop runs.",
    },
    {
      id: "buy-side-liquidity", term: "Buy-Side Liquidity", category: "Price Action & Liquidity",
      def: "Liquidity resting above price, commonly from buy stops placed above highs by short sellers or breakout traders.",
      read: "A run above old highs may be a true breakout or a liquidity sweep. Confirmation comes from whether price accepts above the level or quickly falls back below it.",
    },
    {
      id: "liquidity-hunt", term: "Liquidity Hunt", category: "Price Action & Liquidity",
      def: "A move designed to trade into known stop or order clusters before reversing or continuing with stronger participation.",
      read: "Watch the reaction after the sweep. Fast rejection suggests a trap; acceptance beyond the swept level suggests continuation.",
    },
    {
      id: "stop-hunting", term: "Stop Hunting", category: "Price Action & Liquidity",
      def: "A sharp push into obvious stop-loss zones, usually around prior highs/lows, to trigger orders and create temporary volatility.",
      read: "Do not treat every stop run as manipulation. The useful read is whether the market finds real demand/supply after the stops are triggered.",
    },
    {
      id: "equal-highs-lows", term: "Equal Highs and Lows", category: "Price Action & Liquidity",
      def: "Two or more similar swing highs or lows that form a visible horizontal liquidity pool.",
      read: "Equal highs attract buy-side liquidity; equal lows attract sell-side liquidity. A clean sweep and rejection often matters more than the level itself.",
    },
    {
      id: "fair-value-gap", term: "Fair Value Gap (FVG)", category: "Price Action & Liquidity",
      def: "An imbalance left by a fast move where price traded inefficiently, commonly identified as a three-candle gap between the first and third candle wicks.",
      read: "Price often revisits FVGs to rebalance. A respected FVG can act as continuation support/resistance; a clean failure through it weakens the setup.",
    },
    {
      id: "order-blocks", term: "Order Blocks", category: "Price Action & Liquidity",
      def: "Price zones associated with large institutional buying or selling before a strong displacement move.",
      read: "The strongest order blocks cause clear displacement and break structure. Weak blocks that have already been retested several times lose reliability.",
    },
    {
      id: "break-of-structure", term: "Break of Structure (BOS)", category: "Price Action & Liquidity",
      def: "A decisive break of a prior swing high or swing low that confirms trend continuation in the current direction.",
      read: "A bullish BOS breaks a prior high; a bearish BOS breaks a prior low. Look for displacement and follow-through rather than a tiny wick break.",
    },
    {
      id: "change-of-character", term: "Change of Character (ChoCh)", category: "Price Action & Liquidity",
      def: "An early structure shift where price breaks the most recent counter-trend swing, suggesting the prior trend may be weakening.",
      read: "ChoCh is an early warning, not full confirmation. Pair it with a retest, volume, or liquidity sweep to avoid false reversals.",
    },
    {
      id: "reversal", term: "Reversal", category: "Price Action & Liquidity",
      def: "A change from an existing uptrend to a downtrend, or from a downtrend to an uptrend.",
      read: "A real reversal usually needs structure change, failed continuation, and acceptance in the new direction. One strong candle is not enough by itself.",
    },
    {
      id: "relief-rally", term: "Relief Rally", category: "Price Action & Liquidity",
      def: "A temporary rebound after heavy selling, often driven by short covering and oversold conditions rather than a confirmed trend change.",
      read: "Treat relief rallies carefully until price reclaims key structure and holds higher lows. Weak volume and rejection at resistance often expose the move.",
    },
    {
      id: "impulsive-wave", term: "Impulsive Wave", category: "Price Action & Liquidity",
      def: "A strong directional price leg with speed, range expansion, and usually elevated volume.",
      read: "Impulsive waves show control by one side of the market. Continuation is stronger when pullbacks are shallow and volume remains supportive.",
    },
    {
      id: "bullish-pin-bar", term: "Bullish Pin Bar", category: "Price Action & Liquidity",
      def: "A candle with a long lower wick and small real body, showing sellers pushed price down but buyers absorbed the move.",
      read: "It is strongest at support, after a liquidity sweep, or inside a demand zone. In the middle of a range it is much less meaningful.",
    },
    {
      id: "pivots", term: "Pivots", category: "Price Action & Liquidity",
      def: "Reference levels calculated from prior high, low, and close, used to estimate support, resistance, and intraday bias.",
      read: "Price holding above the main pivot favors bullish intraday bias; below it favors bearish bias. Use reactions at R1/S1 and beyond for context.",
    },
    {
      id: "pdh-pwh-pmh", term: "PDH, PWH, and PMH", category: "Price Action & Liquidity",
      def: "Previous Day High, Previous Week High, and Previous Month High; common reference levels where liquidity and reactions cluster.",
      read: "These highs often act as breakout levels or sweep targets. Watch whether price accepts above them or rejects back into the prior range.",
    },
    {
      id: "golden-pocket", term: "Golden Pocket", category: "Price Action & Liquidity",
      def: "The Fibonacci retracement zone between 61.8% and 65%, widely watched as a potential pullback or reaction area.",
      read: "A golden pocket is more useful when it overlaps structure, liquidity, or volume levels. Alone, it is just a popular retracement zone.",
    },
    {
      id: "order-book", term: "Order Book", category: "Market Profile & Volume",
      def: "A live list of resting buy and sell limit orders at different prices on an exchange.",
      read: "Large visible walls can slow price or attract liquidity, but they can also be pulled. Use the order book with traded volume, not in isolation.",
    },
    {
      id: "aggregated-volume", term: "Aggregated Volume", category: "Market Profile & Volume",
      def: "Combined trading volume across multiple exchanges, venues, or pairs to show broader market participation.",
      read: "Aggregated volume reduces single-exchange noise. Strong moves with broad volume confirmation are more trustworthy than moves isolated to one venue.",
    },
    {
      id: "volume-delta", term: "Volume Delta", category: "Market Profile & Volume",
      def: "The difference between aggressive buy volume and aggressive sell volume over a period.",
      read: "Positive delta means buyers are lifting offers; negative delta means sellers are hitting bids. Price rising on negative delta can signal absorption.",
    },
    {
      id: "cumulative-volume-delta", term: "Cumulative Volume Delta (CVD)", category: "Market Profile & Volume",
      def: "A running total of volume delta, used to track whether aggressive buying or selling is dominating over time.",
      read: "Price and CVD moving together confirms the move. Price making new highs while CVD lags can warn of fading buyer aggression.",
    },
    {
      id: "cvd-spot-perp-kline", term: "CVD Spot/Perp Kline", category: "Market Profile & Volume",
      def: "A candle-style view comparing cumulative volume delta from spot markets versus perpetual futures markets.",
      read: "Spot-led CVD is usually healthier than perp-only aggression. Perp CVD surging while spot lags can mean leverage is driving the move.",
    },
    {
      id: "value-area", term: "Value Area", category: "Market Profile & Volume",
      def: "The price range where a specified percentage of volume, often 70%, traded during a session or profile period.",
      read: "Holding inside value implies balance. Acceptance above value favors continuation higher; rejection back into value often returns price toward POC.",
    },
    {
      id: "developing-value-area", term: "Developing Value Area (DVA)", category: "Market Profile & Volume",
      def: "The value area as it forms during the current session, updating as new volume trades.",
      read: "A rising DVA shows value migrating higher; a falling DVA shows value migrating lower. Flat DVA suggests balance.",
    },
    {
      id: "point-of-control", term: "Point of Control (POC)", category: "Market Profile & Volume",
      def: "The price level with the highest traded volume inside a volume profile.",
      read: "POC acts as a fair-value magnet. Price above POC suggests buyers control value; below it suggests sellers control value.",
    },
    {
      id: "naked-point-of-control", term: "Naked Point of Control (NPOC)", category: "Market Profile & Volume",
      def: "A prior session's POC that has not yet been revisited by price.",
      read: "NPOCs often act as magnets because they mark unresolved high-volume acceptance. A tag and rejection can complete the auction.",
    },
    {
      id: "developing-point-of-control", term: "Developing Point of Control (DPOC)", category: "Market Profile & Volume",
      def: "The current session's POC as it updates in real time with incoming volume.",
      read: "A shifting DPOC shows where current value is migrating. If DPOC follows price, trend acceptance is stronger.",
    },
    {
      id: "vpvr", term: "VPVR (Visible Range Volume Profile)", category: "Market Profile & Volume",
      def: "A volume profile calculated only from the price action visible on the chart.",
      read: "Use VPVR to find high-volume nodes, low-volume gaps, and likely reaction levels. The result changes when you zoom or pan.",
    },
    {
      id: "moving-average-price-signal", term: "Moving Average Price Signal", category: "Technical Indicators",
      def: "A signal created when price interacts with a moving average or when faster and slower moving averages cross.",
      read: "Signals are stronger when slope, timeframe, and market structure agree. Flat moving averages produce more false crosses.",
    },
    {
      id: "wvma", term: "WVMA / VWMA (Volume-Weighted Moving Average)", category: "Technical Indicators",
      def: "A moving average that incorporates volume weighting so higher-volume periods influence the average more heavily than low-volume periods.",
      read: "A WVMA/VWMA can show where high-volume consensus sits. Price reclaiming it may signal improving demand; rejection can mark supply.",
    },
    {
      id: "atr", term: "ATR (Average True Range)", category: "Technical Indicators",
      def: "A volatility indicator measuring the average true range of price movement over a selected period.",
      read: "Use ATR to size stops and targets relative to current volatility. Low ATR means compression; rising ATR means expansion.",
    },
    {
      id: "ichimoku-cloud", term: "Ichimoku Cloud", category: "Technical Indicators",
      def: "A multi-line trend system showing momentum, support/resistance, and projected equilibrium zones.",
      read: "Price above the cloud favors bullish trend, below favors bearish trend, and inside the cloud signals chop or transition.",
    },
    {
      id: "vortex-indicator", term: "Vortex Indicator", category: "Technical Indicators",
      def: "A trend indicator with positive and negative lines designed to identify trend direction and potential reversals.",
      read: "VI+ crossing above VI- supports bullish trend; VI- crossing above VI+ supports bearish trend. Confirm with structure.",
    },
    {
      id: "money-flow-indicator", term: "Money Flow Indicator (MFI)", category: "Technical Indicators",
      def: "A volume-weighted momentum oscillator, similar to RSI but using both price and volume.",
      read: "Extreme readings can flag overbought/oversold conditions. MFI divergences can reveal weakening participation before price turns.",
    },
    {
      id: "stochastic-oscillator", term: "Stochastic Oscillator", category: "Technical Indicators",
      def: "A momentum oscillator comparing the close to the recent high-low range.",
      read: "Crosses from oversold or overbought areas can help time entries, but it works best in ranges and can stay pinned during strong trends.",
    },
    {
      id: "rate-of-change", term: "Rate of Change (ROC)", category: "Technical Indicators",
      def: "A momentum indicator measuring the percentage change in price over a lookback period.",
      read: "ROC above zero shows upward momentum; below zero shows downward momentum. Divergences can warn momentum is fading.",
    },
    {
      id: "on-balance-volume", term: "On-Balance Volume (OBV)", category: "Technical Indicators",
      def: "A cumulative volume indicator that adds volume on up days and subtracts volume on down days.",
      read: "OBV rising before price can suggest accumulation. OBV failing to confirm new highs can warn of weak participation.",
    },
    {
      id: "elder-force-index", term: "Elder Force Index", category: "Technical Indicators",
      def: "An indicator combining price change and volume to estimate buying or selling pressure.",
      read: "Positive force supports buyer control; negative force supports seller control. Spikes often mark emotional exhaustion points.",
    },
    {
      id: "trix", term: "TRIX", category: "Technical Indicators",
      def: "A triple-smoothed rate-of-change oscillator used to filter noise and identify momentum shifts.",
      read: "TRIX crossing above zero or its signal line supports bullish momentum; below supports bearish momentum.",
    },
    {
      id: "adx", term: "ADX Indicator", category: "Technical Indicators",
      def: "Average Directional Index measures trend strength, usually without regard to trend direction.",
      read: "ADX above 20-25 suggests a stronger trend environment. Low ADX favors range strategies over trend-following.",
    },
    {
      id: "bull-bear-power", term: "Bull Bear Power", category: "Technical Indicators",
      def: "A measure of buyer and seller strength relative to a moving average, often associated with Elder-Ray analysis.",
      read: "Bull power above zero supports upside pressure; bear power below zero supports downside pressure. Divergences can flag exhaustion.",
    },
    {
      id: "sse-divergences", term: "SSE Divergences", category: "Technical Indicators",
      def: "A divergence setup where price makes a new extreme while the selected strength, sentiment, or momentum measure fails to confirm.",
      read: "Treat divergence as a warning, not a trigger. It becomes actionable when structure breaks or price rejects a key liquidity zone.",
    },
    {
      id: "divergence", term: "Divergence", category: "Technical Indicators",
      def: "A technical-analysis condition where price moves in one direction while an indicator, volume measure, or momentum reading moves in another.",
      read: "Bullish divergence appears when price makes lower lows but the indicator makes higher lows. Bearish divergence appears when price makes higher highs but the indicator makes lower highs.",
    },
    {
      id: "trailing-stop", term: "Trailing Stop", category: "Trading Risk & Strategy",
      def: "A stop-loss that moves with price as a trade becomes profitable, designed to protect gains while leaving room for continuation.",
      read: "Use a trailing stop based on structure or volatility. Too tight gets shaken out; too loose gives back too much profit.",
    },
    {
      id: "max-drawdown", term: "Max Drawdown", category: "Trading Risk & Strategy",
      def: "The largest peak-to-trough decline in an account, strategy, or asset over a measured period.",
      read: "Max drawdown shows worst-case stress historically. A strategy with high return but extreme drawdown may be untradeable in practice.",
    },
    {
      id: "aggressive-trading-strategies", term: "Aggressive Trading Strategies", category: "Trading Risk & Strategy",
      def: "High-risk tactics that usually involve leverage, tight timing, breakout chasing, scalping, or trading around liquidation/liquidity zones.",
      read: "Aggressive strategies require predefined invalidation, smaller size, and strict execution. They fail quickly when discipline slips.",
    },
    {
      id: "ranging-market-indicators", term: "Ranging Market Indicators", category: "Trading Risk & Strategy",
      def: "Tools used when price is moving sideways, including RSI, stochastic, Bollinger Bands, VWAP, pivots, and volume profile levels.",
      read: "In ranges, fade extremes and take profits faster. Trend tools are less reliable until price accepts outside the range.",
    },
    {
      id: "intraday-charts", term: "Intraday Charts", category: "Trading Risk & Strategy",
      def: "Charts using timeframes shorter than one trading day, such as 1-minute, 5-minute, 15-minute, or hourly candles.",
      read: "Intraday charts are useful for execution and timing, but higher-timeframe levels usually define the broader bias.",
    },
    {
      id: "reduce-only", term: "Reduce Only", category: "Order Types & Execution",
      def: "An order setting that can only reduce or close an existing position, not increase it or open a new one.",
      read: "Use reduce-only for take-profits and protective exits so an accidental fill cannot flip you into the opposite position.",
    },
    {
      id: "post-only", term: "Post Only", category: "Order Types & Execution",
      def: "A limit order setting that only posts to the order book as maker liquidity and cancels if it would immediately execute.",
      read: "Post-only helps avoid taker fees and prevents accidental marketable fills, but it can miss fast-moving entries.",
    },
    {
      id: "bid-ask-takers", term: "Puts, Ask Price, Bid Price, and Takers", category: "Order Types & Execution",
      def: "Puts are options that gain value when the underlying falls; bid is the highest buyer price; ask is the lowest seller price; takers execute immediately against resting liquidity.",
      read: "A wide bid-ask spread means expensive execution. Heavy taker buying or selling shows urgency, but can also mark exhaustion if price stops moving.",
    },
    {
      id: "option-trading", term: "Option Trading", category: "Futures & Derivatives",
      def: "Trading contracts that give the right, but not the obligation, to buy or sell an asset at a specified strike before expiration.",
      read: "Options express direction, volatility, and timing. Watch implied volatility, expiration, and strike liquidity before reading option flow.",
    },
    {
      id: "short-squeeze", term: "Short Squeeze", category: "Futures & Derivatives",
      def: "A rapid rally caused when short sellers are forced to buy back positions as price moves against them.",
      read: "A squeeze is more likely when open interest, negative sentiment, and short liquidation levels are stacked above price.",
    },
    {
      id: "cme", term: "Chicago Mercantile Exchange (CME)", category: "Futures & Derivatives",
      def: "A major regulated derivatives exchange listing futures and options across commodities, equities, rates, FX, and crypto products.",
      read: "CME activity is watched as a regulated institutional signal, especially for Bitcoin and Ethereum futures.",
    },
    {
      id: "cme-gap", term: "CME Gap", category: "Futures & Derivatives",
      def: "A price gap on CME futures charts that forms because CME closes over weekends while spot crypto continues trading.",
      read: "CME gaps often get revisited, but not always immediately. Treat them as magnet levels, not guaranteed trades.",
    },
    {
      id: "aggregated-open-interest", term: "Aggregated Open Interest (AOI)", category: "Futures & Derivatives",
      def: "Open interest combined across multiple exchanges or contracts to show total leveraged positioning.",
      read: "AOI helps separate broad leverage buildup from one-exchange noise. Rising AOI into resistance/support increases squeeze risk.",
    },
    {
      id: "standard-deviation", term: "Standard Deviation", category: "Volatility & Sentiment",
      def: "A statistical measure of how far values typically move away from their average.",
      read: "Higher standard deviation means wider dispersion and more volatility. Bands and z-scores use it to identify stretched conditions.",
    },
    {
      id: "abbreviations", term: "Common Trading Abbreviations", category: "Trading Risk & Strategy",
      def: "Short forms used in trading notes, such as OI, AOI, FVG, POC, NPOC, BOS, ChoCh, CVD, OBV, RSI, ATR, and DVA.",
      read: "Abbreviations speed up chart work, but define them in watchlists so signals stay clear across timeframes and tools.",
    },
    {
      id: "market-caps", term: "Market Caps", category: "Market Cap & Dominance",
      def: "Market capitalization equals asset price multiplied by circulating supply; it estimates the total market value of an asset or sector.",
      read: "Large caps are usually more liquid and stable; small caps can move faster but carry higher liquidity and drawdown risk.",
    },
    {
      id: "total-value-locked", term: "Total Value Locked (TVL)", category: "On-Chain & Network",
      def: "The dollar value of assets deposited into a protocol, chain, or DeFi category.",
      read: "Rising TVL can signal adoption and liquidity growth. TVL falling while token price rises can warn the move lacks protocol support.",
    },
    {
      id: "rwa-protocol-tvl", term: "Value Locked in RWA by Protocol", category: "Real World Assets",
      def: "The amount of real-world asset value tokenized or deposited in each individual RWA protocol.",
      read: "Compare protocol TVL growth with revenue, asset type, and counterparty risk. Large TVL alone does not prove quality.",
    },
    {
      id: "rwa-chain-tvl", term: "Value Locked in RWA by Chain", category: "Real World Assets",
      def: "The amount of tokenized real-world asset value hosted on each blockchain.",
      read: "RWA chain TVL shows where institutional or yield-bearing assets are settling. Watch concentration risk if one chain dominates.",
    },
    {
      id: "oil-stocks", term: "Oil Stocks", category: "Traditional Markets",
      def: "Public companies tied to oil exploration, production, refining, services, transport, or integrated energy operations.",
      read: "Common oil names to track include XOM, CVX, COP, EOG, SLB, HAL, OXY, VLO, MPC, PSX, BP, SHEL, TTE, and CNQ. Compare them with crude oil prices, refining margins, and energy-sector breadth.",
    },
    {
      id: "five-aces", term: "The 5 Aces", category: "Trading Risk & Strategy",
      def: "A checklist-style trading framework for scoring a setup across multiple confirmations before entering a trade.",
      read: "Use it to slow down entries. A setup with trend, level, liquidity, momentum, and risk alignment is stronger than one built on a single signal.",
    },
    {
      id: "fundamental-analysis", term: "Fundamental Analysis", category: "Fundamental & Research",
      def: "Evaluating an asset using business quality, cash flows, tokenomics, adoption, macro conditions, valuation, and competitive positioning.",
      read: "Fundamentals matter most on longer horizons. Pair them with technical levels for timing instead of using them as instant entry signals.",
    },
    {
      id: "marking-important-levels", term: "Marking Important Levels", category: "Trading Risk & Strategy",
      def: "The process of identifying key support, resistance, liquidity pools, session levels, gaps, POC/value areas, and higher-timeframe structure.",
      read: "Mark fewer, higher-quality levels. The best levels combine history, volume, liquidity, and clean reaction behavior.",
    },
    {
      id: "risk-management", term: "Risk Management", category: "Trading Risk & Strategy",
      def: "Rules for position sizing, invalidation, stop placement, drawdown limits, and trade selection.",
      read: "Good risk management keeps one bad idea from damaging the account. Define risk before entry, not after price moves against you.",
    },
    {
      id: "using-calculus", term: "Using Calculus", category: "Trading Risk & Strategy",
      def: "Applying rate-of-change, slope, acceleration, and curvature concepts to understand how price, volatility, or momentum is changing.",
      read: "In practice, calculus ideas show up as momentum, acceleration, and derivative-style signals. Use them to study change, not to overfit trades.",
    },
    {
      id: "slippage", term: "Slippage", category: "Order Types & Execution",
      def: "The difference between the expected trade price and the actual fill price.",
      read: "Slippage rises in thin liquidity, high volatility, and large order size. Use limits, smaller clips, or more liquid venues to reduce it.",
    },
    {
      id: "bid-ask-spread", term: "Bid-Ask Spread", category: "Order Types & Execution",
      def: "The gap between the highest price buyers are bidding and the lowest price sellers are asking.",
      read: "A tight spread means cheaper execution. A wide spread is a hidden cost and often signals thin liquidity or stress.",
    },
    {
      id: "public-quote-price", term: "Public Quote Price", category: "Order Types & Execution",
      def: "The visible quoted market price available from public exchanges, brokers, or data vendors.",
      read: "Public quotes can differ from executable prices, especially in fast or illiquid markets. Check spread, depth, and venue before trusting the quote.",
    },
    {
      id: "price-discovery", term: "Price Discovery", category: "Market Profile & Volume",
      def: "The process by which buyers and sellers establish a fair market price through trading.",
      read: "Strong price discovery happens when price accepts in new territory with volume. Failed discovery snaps back into the prior value area.",
    },
    {
      id: "market-profile-theory", term: "Market Profile Theory", category: "Market Profile & Volume",
      def: "A framework that studies auctions, time, volume, and value to understand where markets accept or reject price.",
      read: "Focus on balance versus imbalance. Breaks from balance that build new value are stronger than quick excursions that reject.",
    },
    {
      id: "footprint-terminologies", term: "Footprint Terminologies", category: "Market Profile & Volume",
      def: "Order-flow terms used on footprint charts, including bid volume, ask volume, delta, imbalance, absorption, unfinished auctions, and stacked imbalances.",
      read: "Footprint data is useful for execution timing. The key is whether aggressive volume creates progress or gets absorbed.",
    },
    {
      id: "volume-indicators", term: "Volume Indicators", category: "Market Profile & Volume",
      def: "Indicators that use traded volume to evaluate participation, pressure, accumulation, or distribution.",
      read: "Volume confirms or questions price. Breakouts with volume are more credible; moves on weak volume are more vulnerable.",
    },
    {
      id: "sentiment-analysis", term: "Sentiment Analysis", category: "Volatility & Sentiment",
      def: "Measuring the market's emotional or narrative bias using news, social media, positioning, surveys, funding, and options data.",
      read: "Extreme sentiment can become contrarian, but only after price confirms. Use sentiment to identify crowding, not as a standalone trigger.",
    },
    {
      id: "twitter-crypto-sentiment", term: "Twitter + Crypto Sentiment", category: "Volatility & Sentiment",
      def: "Tracking crypto narratives, influencer activity, keyword velocity, and crowd mood across X/Twitter and related social channels.",
      read: "Rising social attention can drive momentum, but crowded narratives reverse quickly. Compare sentiment with volume, funding, and price structure.",
    },
    {
      id: "hidden-divergence", term: "Hidden Divergence", category: "Technical Indicators",
      def: "A continuation divergence where price makes a higher low in an uptrend while an oscillator makes a lower low, or price makes a lower high in a downtrend while the oscillator makes a higher high.",
      read: "Hidden bullish divergence supports trend continuation after a pullback; hidden bearish divergence supports continuation lower after a bounce.",
    },
    {
      id: "reversal-indicators", term: "Reversal Indicators", category: "Technical Indicators",
      def: "Tools used to detect possible trend exhaustion, including divergences, RSI/MFI extremes, MACD shifts, volume climax, pin bars, and structure breaks.",
      read: "Reversal indicators work best when multiple signals cluster at a major level. Avoid calling reversals before structure confirms.",
    },
    {
      id: "popular-crypto-indicators", term: "Popular Crypto Indicators", category: "Technical Indicators",
      def: "Common crypto tools such as RSI, MACD, moving averages, funding rates, open interest, liquidations, CVD, volume profile, and dominance.",
      read: "No indicator is universal. Choose indicators that match the market regime: trend, range, volatility expansion, or leverage squeeze.",
    },
    {
      id: "indicator-setups", term: "Indicator Setups", category: "Technical Indicators",
      def: "Repeatable combinations of indicators and levels used to define a trading idea.",
      read: "A good setup defines trigger, invalidation, target, and regime. If it cannot be written down simply, it is probably discretionary noise.",
    },
    {
      id: "halvenings", term: "Halvings", category: "Cycle & Valuation",
      def: "Scheduled Bitcoin events that cut the block subsidy paid to miners by 50%, reducing new BTC issuance.",
      read: "Halvings are long-cycle supply events, not exact timing signals. Watch miner behavior, liquidity, and macro conditions around each cycle.",
    },
    {
      id: "bitcoin-liquid-index", term: "Bitcoin Liquid Index", category: "Market Cap & Dominance",
      def: "A reference Bitcoin price index built from liquid exchange venues to represent a reliable BTC market price.",
      read: "Use liquid indices for cleaner benchmark pricing. They help reduce noise from thin or manipulated single-venue prints.",
    },
    {
      id: "market-value", term: "Market Value", category: "Market Cap & Dominance",
      def: "The current value assigned to an asset by the market, usually price multiplied by supply or shares outstanding.",
      read: "Market value tells you what the market is paying now, not whether the asset is cheap or expensive. Compare it with fundamentals and peers.",
    },
    {
      id: "asset", term: "Asset", category: "Market Cap & Dominance",
      def: "Anything with economic value that can be owned or traded, including stocks, bonds, commodities, currencies, crypto, and real estate.",
      read: "Classify assets by risk, liquidity, volatility, and correlation before comparing them inside one portfolio.",
    },
    {
      id: "money-flow-between-assets", term: "Money Flow Between Assets", category: "Market Cap & Dominance",
      def: "Rotation of capital between asset classes, sectors, or tokens as investors seek risk, safety, yield, or momentum.",
      read: "Track flow from cash to bonds, equities, commodities, BTC, ETH, and alts. Rotation often explains relative strength before headlines do.",
    },
    {
      id: "venture-capitalist", term: "Venture Capitalist (VC)", category: "Market Participants",
      def: "An investor or firm that funds early-stage companies or protocols in exchange for equity, tokens, or other ownership rights.",
      read: "VC backing can signal resources and network access, but also creates unlock and sell-pressure risk. Check vesting schedules.",
    },
    {
      id: "market-maker", term: "Market Maker", category: "Market Participants",
      def: "A firm or participant that continuously quotes bids and asks to provide liquidity and earn spread or incentives.",
      read: "Market makers improve liquidity, but their hedging can shape short-term price action. Watch spread, depth, and inventory stress.",
    },
    {
      id: "hedge-funds", term: "Hedge Funds", category: "Market Participants",
      def: "Investment funds using flexible strategies such as long/short, macro, arbitrage, derivatives, leverage, and event-driven trades.",
      read: "Hedge fund positioning can matter when trades become crowded. Watch prime broker, futures, options, and flow data where available.",
    },
    {
      id: "asset-manager", term: "Asset Manager", category: "Market Participants",
      def: "A firm or professional managing capital for clients through funds, ETFs, portfolios, or mandates.",
      read: "Asset-manager flows are often slower and larger than retail flows. ETF and fund flow data can reveal this demand.",
    },
    {
      id: "portfolio-manager", term: "Portfolio Manager", category: "Market Participants",
      def: "A professional responsible for allocation, risk, and performance of a portfolio.",
      read: "Think like a portfolio manager by measuring exposure, correlation, drawdown, liquidity, and concentration instead of only entry signals.",
    },
    {
      id: "gold-hedger", term: "Gold Hedger", category: "Market Participants",
      def: "A producer, consumer, or financial participant using gold futures or options to reduce exposure to gold price changes.",
      read: "Commercial hedger positioning can reveal stress or protection needs, but it is not a simple buy/sell signal by itself.",
    },
    {
      id: "financial-advice", term: "Financial Advice", category: "Professional & Compliance",
      def: "Personalized guidance about investments, allocation, or financial decisions based on an individual's circumstances.",
      read: "Distinguish education from advice. Personalized recommendations can require licensing and suitability obligations.",
    },
    {
      id: "nfa", term: "NFA (Not Financial Advice)", category: "Professional & Compliance",
      def: "A disclaimer meaning content is educational or opinion-based and not a personalized investment recommendation.",
      read: "NFA does not make poor analysis useful or remove all responsibility. Still evaluate risk, assumptions, and conflicts.",
    },
    {
      id: "becoming-financial-advisor", term: "Becoming a Financial Advisor", category: "Professional & Compliance",
      def: "The process of meeting licensing, registration, education, and compliance requirements to give regulated financial advice.",
      read: "Requirements vary by jurisdiction. In the US, relevant paths may include FINRA exams, state registration, RIA rules, or CFP-style education.",
    },
    {
      id: "btc-annualized-daily-basis", term: "BTC Annualized Daily Basis", category: "Futures & Derivatives",
      def: "The annualized premium or discount of Bitcoin futures versus spot price, calculated from the daily basis.",
      read: "High positive basis suggests bullish leverage or carry demand. Negative basis suggests stress, bearish positioning, or spot scarcity dynamics.",
    },
    {
      id: "btc1", term: "Bitcoin CME Futures (BTC1!)", category: "Futures & Derivatives",
      def: "The front-month continuous Bitcoin futures contract symbol commonly used on charting platforms for CME BTC futures.",
      read: "BTC1! helps track regulated futures structure. Compare it with spot BTC to identify CME gaps, basis, and institutional futures behavior.",
    },
    {
      id: "types-of-contracts", term: "Types of Contracts", category: "Futures & Derivatives",
      def: "Trading contracts include spot, futures, perpetual swaps, options, forwards, CFDs, and structured products.",
      read: "Each contract has different funding, expiry, margin, and liquidation rules. Know the contract mechanics before reading its signals.",
    },
    {
      id: "arbitrage", term: "Arbitrage", category: "Futures & Derivatives",
      def: "A strategy that exploits price differences between markets, venues, or related instruments.",
      read: "Arbitrage compresses mispricing, but fees, latency, borrow costs, and execution risk can erase the apparent edge.",
    },
    {
      id: "front-running", term: "Front Running", category: "Order Types & Execution",
      def: "Trading ahead of a known or expected order to profit from its market impact.",
      read: "In regulated markets it can be illegal when based on nonpublic client order information. On-chain, similar behavior appears as MEV and priority-gas competition.",
    },
    {
      id: "otc", term: "Over-the-Counter (OTC)", category: "Order Types & Execution",
      def: "Trading directly between parties or through a dealer rather than on a public exchange order book.",
      read: "OTC can reduce visible market impact for large orders, but pricing, counterparty risk, and settlement terms matter.",
    },
    {
      id: "types-of-dump", term: "Types of Dump", category: "Trading Risk & Strategy",
      def: "Selloffs can be driven by liquidation cascades, profit-taking, news shocks, unlocks, rug pulls, macro repricing, or low-liquidity stop runs.",
      read: "Identify the cause before reacting. Liquidation dumps can rebound quickly; fundamental or unlock-driven dumps can persist.",
    },
    {
      id: "important-aspects-before-trading-btc", term: "Important Aspects Before Trading BTC", category: "Trading Risk & Strategy",
      def: "Key checks before a Bitcoin trade: trend, liquidity, open interest, funding, news, session timing, volatility, invalidation, and position size.",
      read: "BTC trades cleaner when higher-timeframe bias and leverage conditions agree. Avoid forcing trades around major macro releases.",
    },
    {
      id: "trading-tips", term: "Trading Tips", category: "Trading Risk & Strategy",
      def: "Practical rules that improve execution, such as waiting for confirmation, sizing small, journaling trades, and avoiding revenge trading.",
      read: "The best tips are process rules. If a rule cannot be measured or repeated, it will be hard to improve.",
    },
    {
      id: "add-to-alerts", term: "Add to Alerts", category: "Trading Tools & Workflows",
      def: "A workflow step for turning important levels, conditions, or news triggers into platform alerts.",
      read: "Alerts reduce screen fatigue. Use them for levels, funding extremes, open-interest spikes, macro events, and structure breaks.",
    },
    {
      id: "shortcut-idea", term: "Shortcut Idea", category: "Trading Tools & Workflows",
      def: "A repeatable automation or quick action that reduces manual steps in research, alerts, screenshots, or reporting.",
      read: "Good shortcuts remove friction without hiding risk. Keep automations transparent enough that you can audit their output.",
    },
    {
      id: "website-ideas", term: "Website to Visit Ideas", category: "Trading Tools & Workflows",
      def: "A curated research list of data sources, dashboards, news feeds, screeners, and charting tools.",
      read: "Group websites by decision type: macro, crypto, on-chain, derivatives, news, execution, and watchlists.",
    },
    {
      id: "links", term: "Links", category: "Trading Tools & Workflows",
      def: "Reference URLs saved for fast access to dashboards, sources, tools, and market monitors.",
      read: "Organize links by workflow. A useful link list should answer what to check before, during, and after a trade.",
    },
    {
      id: "current-news", term: "Current News", category: "Trading Tools & Workflows",
      def: "Timely headlines and verified developments that can affect market pricing or sentiment.",
      read: "React to verified news, not screenshots or rumors. The market often prices the surprise, not the headline itself.",
    },
    {
      id: "new-shortcut-news", term: "New Shortcut News", category: "Trading Tools & Workflows",
      def: "A workflow idea for quickly capturing and routing new market news into alerts, summaries, or watchlists.",
      read: "Useful news shortcuts should include source, timestamp, asset impact, and whether the event is confirmed.",
    },
    {
      id: "realtime-data-sources-apis", term: "Real-Time Data Sources / APIs", category: "Trading Tools & Workflows",
      def: "APIs and feeds that provide current prices, order books, news, on-chain metrics, economic calendars, and derivatives data.",
      read: "Prioritize source reliability, latency, limits, and licensing. Real-time data is only useful if timestamps and failure modes are clear.",
    },
    {
      id: "bot-father-api", term: "BotFather API", category: "Trading Tools & Workflows",
      def: "Telegram's BotFather is used to create and manage Telegram bots that can deliver alerts, commands, and notifications.",
      read: "Use bots for alerts and workflow routing. Protect tokens, validate chat IDs, and avoid sending sensitive trade data to public channels.",
    },
    {
      id: "free-crypto-bots", term: "Crypto Bots", category: "Trading Tools & Workflows",
      def: "Automated tools that can monitor, alert, rebalance, copy trade, arbitrage, or execute rule-based strategies.",
      read: "Free bots can still be expensive if they trade poorly. Paper test, cap permissions, and never grant withdrawal access.",
    },
    {
      id: "ai-with-crypto", term: "Using AI with Cryptocurrency", category: "Trading Tools & Workflows",
      def: "Using AI for summarization, screening, sentiment, code, alerts, strategy research, and anomaly detection in crypto markets.",
      read: "AI is useful for organization and pattern discovery, but it can hallucinate. Verify data, formulas, and trade logic before acting.",
    },
    {
      id: "supercharts", term: "Supercharts / Trading Supercharts", category: "Trading Tools & Workflows",
      def: "Advanced charting workspaces that combine multiple indicators, layouts, watchlists, alerts, and multi-asset views.",
      read: "Supercharts are best when layouts match workflows. Keep a clean execution layout separate from research-heavy layouts.",
    },
    {
      id: "xy-heat-map", term: "XY Heat Map", category: "Trading Tools & Workflows",
      def: "A two-axis heat map used to compare assets or signals across dimensions such as performance, volatility, volume, or correlation.",
      read: "Heat maps are scanning tools. Use them to find outliers, then inspect the chart and underlying data before trading.",
    },
    {
      id: "alt-research", term: "Alt Research", category: "Fundamental & Research",
      def: "Research focused on altcoins, including tokenomics, unlocks, liquidity, catalysts, sector strength, and relative performance versus BTC/ETH.",
      read: "Strong alt research separates narrative from flows. Check liquidity, vesting, team, revenue, chain usage, and exchange depth.",
    },
    {
      id: "defi", term: "DeFi", category: "Crypto Infrastructure",
      def: "Decentralized finance protocols for trading, lending, borrowing, derivatives, staking, and yield without traditional intermediaries.",
      read: "Evaluate DeFi by TVL quality, revenue, smart-contract risk, incentives, liquidity depth, and governance control.",
    },
    {
      id: "censorship-resistance", term: "Censorship Resistance", category: "Crypto Infrastructure",
      def: "The ability of a network or asset to remain usable without transactions being blocked by a central authority.",
      read: "Censorship resistance depends on validator/miner decentralization, client diversity, governance, and infrastructure chokepoints.",
    },
    {
      id: "real-world-asset", term: "Real World Asset (RWA)", category: "Real World Assets",
      def: "A tokenized or blockchain-represented claim on an off-chain asset such as Treasuries, credit, real estate, invoices, or commodities.",
      read: "RWA quality depends on legal claims, custody, issuer risk, transparency, yield source, and redemption mechanics.",
    },
    {
      id: "strategic-reserve", term: "Strategic Reserve", category: "Macro & Global Liquidity",
      def: "A reserve of assets held by a government, institution, or treasury for stability, policy, or strategic optionality.",
      read: "Strategic reserves can affect supply expectations and narratives. Watch whether reserves are actually funded, audited, and restricted.",
    },
    {
      id: "global-liquidity", term: "Global Liquidity", category: "Macro & Global Liquidity",
      def: "The availability of money and credit across the global financial system, influenced by central banks, fiscal policy, banking conditions, and dollar funding.",
      read: "Rising global liquidity tends to support risk assets; tightening liquidity pressures them. Track dollar strength, yields, central-bank balance sheets, and credit spreads.",
    },
    {
      id: "non-farm-payrolls", term: "Non-Farm Payrolls (NFP)", category: "Macro & Global Liquidity",
      def: "A monthly US jobs report measuring payroll employment outside farming and a few excluded categories.",
      read: "NFP matters because it shifts Fed expectations. Markets react to payrolls, unemployment, wage growth, and revisions versus forecast.",
    },
    {
      id: "stagflation", term: "Stagflation", category: "Macro & Global Liquidity",
      def: "An environment with weak growth, elevated unemployment or stagnation, and persistent inflation.",
      read: "Stagflation is difficult for risk assets because growth weakens while central banks may still be constrained by inflation.",
    },
    {
      id: "yen-carry-trade", term: "Yen Carry Trade", category: "Macro & Global Liquidity",
      def: "Borrowing low-yielding Japanese yen to buy higher-yielding or riskier assets elsewhere.",
      read: "Carry trades support risk while stable, but unwind violently when yen strengthens or volatility rises.",
    },
    {
      id: "major-forex-sessions", term: "Major Forex Sessions", category: "Macro & Global Liquidity",
      def: "The main global trading sessions: Asia, London/Europe, and New York.",
      read: "Liquidity and volatility change by session. London and New York overlap often produces the highest FX and macro-market activity.",
    },
    {
      id: "financial-indices", term: "Financial Indices", category: "Indices & Assets",
      def: "Benchmarks that track baskets of assets, such as the S&P 500, Nasdaq 100, Dow, TSX Composite, DXY, or sector indices.",
      read: "Use indices to understand broad market direction and sector rotation before reading individual names in isolation.",
    },
    {
      id: "indices", term: "Indices", category: "Indices & Assets",
      def: "Grouped benchmarks designed to represent a market, sector, country, factor, or asset class.",
      read: "Different indices have different weighting rules. Know whether a move is broad-based or driven by a few heavy components.",
    },
    {
      id: "different-indices", term: "Different Indices", category: "Indices & Assets",
      def: "Examples include equity indices, bond indices, commodity indices, volatility indices, dollar indices, and crypto indices.",
      read: "Compare related indices to detect rotation, divergence, and risk appetite across markets.",
    },
    {
      id: "tsx-composite", term: "TSX Composite", category: "Indices & Assets",
      def: "A major Canadian equity index tracking large companies listed on the Toronto Stock Exchange.",
      read: "TSX has meaningful exposure to financials, energy, materials, and commodities, so it can behave differently from US tech-heavy indices.",
    },
    {
      id: "japan-etf", term: "Japan ETF", category: "Indices & Assets",
      def: "An exchange-traded fund providing exposure to Japanese equities, sectors, currency-hedged shares, or broad Japan benchmarks.",
      read: "Watch yen direction, Bank of Japan policy, export sensitivity, and whether the ETF hedges currency exposure.",
    },
    {
      id: "gas-stocks", term: "Gas Stocks", category: "Indices & Assets",
      def: "Companies tied to natural gas production, pipelines, LNG, utilities, services, or midstream infrastructure.",
      read: "Track natural gas prices, storage reports, weather, LNG demand, and pipeline constraints alongside individual company fundamentals.",
    },
    {
      id: "equities", term: "Equities", category: "Indices & Assets",
      def: "Ownership shares in companies, commonly called stocks.",
      read: "Equities are driven by earnings, rates, liquidity, sector flows, sentiment, and valuation. Index context matters before single-stock reads.",
    },
    {
      id: "commodity-markets", term: "Commodity Markets", category: "Commodities",
      def: "Markets for raw materials such as oil, natural gas, gold, copper, grains, and livestock.",
      read: "Commodities respond to supply/demand, inventories, weather, geopolitics, currency moves, and futures curve structure.",
    },
    {
      id: "ipo", term: "IPO (Initial Public Offering)", category: "Traditional Markets",
      def: "The first sale of a private company's shares to public market investors.",
      read: "IPO trading depends on valuation, float, lockups, growth quality, market conditions, and insider/VC supply.",
    },
    {
      id: "astrology-for-stocks", term: "Astrology for Stocks", category: "Trading Risk & Strategy",
      def: "A speculative practice that attempts to connect market timing with astrological cycles rather than financial or statistical evidence.",
      read: "Treat it as non-evidence-based and high risk. Do not replace risk management, data, or verified analysis with astrology.",
    },
  ];

  var ALL_GLOSSARY = GLOSSARY.concat(USER_GLOSSARY);

  var CATEGORY_ORDER = [
    "Technical Indicators",
    "Price Action & Liquidity",
    "Market Profile & Volume",
    "Futures & Derivatives",
    "Order Types & Execution",
    "Trading Risk & Strategy",
    "Fundamental & Research",
    "Market Participants",
    "Professional & Compliance",
    "On-Chain & Network",
    "Crypto Infrastructure",
    "Cycle & Valuation",
    "Market Cap & Dominance",
    "Volatility & Sentiment",
    "ETF Flows",
    "Real World Assets",
    "Macro & Global Liquidity",
    "Indices & Assets",
    "Traditional Markets",
    "Macro Economics",
    "Commodities",
    "Trading Tools & Workflows",
  ];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function slug(category) {
    return "cat-" + category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function cardHtml(entry) {
    var usedIn = (entry.pages || [])
      .map(function (p) {
        return '<a class="glossary-used-chip" href="' + escapeHtml(p.href) + '">' + escapeHtml(p.label) + "</a>";
      })
      .join("");
    return (
      '<article class="glossary-card" data-search="' + escapeHtml((entry.term + " " + entry.category + " " + entry.def + " " + entry.read).toLowerCase()) + '" data-category="' + escapeHtml(entry.category) + '">' +
      '<div class="glossary-term">' + escapeHtml(entry.term) + "</div>" +
      '<div class="glossary-def">' + escapeHtml(entry.def) + "</div>" +
      '<div class="glossary-read"><strong>How to read it:</strong> ' + escapeHtml(entry.read) + "</div>" +
      (usedIn ? '<div class="glossary-used-in">' + usedIn + "</div>" : "") +
      "</article>"
    );
  }

  function render() {
    var content = document.getElementById("glossaryContent");
    var pills = document.getElementById("glossaryPills");
    if (!content) return;

    var byCategory = {};
    ALL_GLOSSARY.forEach(function (entry) {
      (byCategory[entry.category] = byCategory[entry.category] || []).push(entry);
    });

    Object.keys(byCategory).forEach(function (category) {
      byCategory[category].sort(function (a, b) { return a.term.localeCompare(b.term); });
    });

    pills.innerHTML = CATEGORY_ORDER.filter(function (c) { return byCategory[c]; })
      .map(function (c) {
        return '<a href="#' + slug(c) + '" class="nav-pill nav-pill--accent">' + escapeHtml(c) + "</a>";
      })
      .join("");

    content.innerHTML = CATEGORY_ORDER.filter(function (c) { return byCategory[c]; })
      .map(function (c) {
        return (
          '<div class="glossary-category" id="' + slug(c) + '">' +
          '<div class="glossary-category-label">' + escapeHtml(c) + "</div></div>" +
          '<div class="glossary-grid">' + byCategory[c].map(cardHtml).join("") + "</div>"
        );
      })
      .join("");
  }

  function applyFilter(query) {
    var q = query.trim().toLowerCase();
    var cards = document.querySelectorAll(".glossary-card");
    var anyVisible = {};
    cards.forEach(function (card) {
      var match = !q || card.dataset.search.indexOf(q) !== -1 || card.dataset.category.toLowerCase().indexOf(q) !== -1;
      card.style.display = match ? "" : "none";
      if (match) anyVisible[card.dataset.category] = true;
    });
    document.querySelectorAll(".glossary-category").forEach(function (section) {
      var label = section.querySelector(".glossary-category-label");
      var category = label ? label.textContent : "";
      var hasVisible = anyVisible[category];
      section.style.display = hasVisible ? "" : "none";
      var grid = section.nextElementSibling;
      if (grid && grid.classList.contains("glossary-grid")) {
        grid.style.display = hasVisible ? "" : "none";
      }
    });
    var emptyEl = document.getElementById("glossaryEmpty");
    if (emptyEl) emptyEl.hidden = Object.keys(anyVisible).length > 0;
  }

  function init() {
    render();
    var search = document.getElementById("glossarySearch");
    if (search) {
      search.addEventListener("input", function () {
        applyFilter(search.value);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
