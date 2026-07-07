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
      def: "A decisive break of the trend's most recent swing in the trend's own direction — a higher high broken in an uptrend, or a lower low broken in a downtrend — confirming the existing trend is continuing.",
      read: "Example: in an uptrend, price makes a higher low, then breaks above the prior high — that's a bullish BOS confirming the uptrend. Look for displacement and follow-through past the level, not just a wick poking through it. Contrast with Change of Character, which breaks against the trend instead of with it.",
    },
    {
      id: "change-of-character", term: "Change of Character (ChoCh)", category: "Price Action & Liquidity",
      def: "A break in the opposite direction of the current trend's structure — the first sign the trend may be reversing, before a full reversal is confirmed.",
      read: "Example: in an uptrend, if price breaks below the most recent higher low, that's a ChoCH warning the uptrend may be ending. It's an early flag, not confirmation — pair it with a retest, volume, or liquidity sweep before treating it as a full reversal. Contrast with Break of Structure, which continues the trend instead of challenging it.",
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
      id: "bid-ask-price", term: "Bid & Ask (Offer) Price", category: "Order Types & Execution",
      def: "The bid is the highest price a buyer is currently willing to pay for a security; the ask (or offer) is the lowest price a seller is currently willing to accept. Sellers typically receive the bid; buyers typically pay the ask.",
      read: "The bid sits at or below the ask in a functioning market — the gap between them is the bid-ask spread. Watch how each side moves as you approach a trade: a bid pulling away as you try to buy signals thinning liquidity on that side.",
    },
    {
      id: "makers-vs-takers", term: "Makers vs. Takers", category: "Order Types & Execution",
      def: "Takers execute immediately at the current bid or ask — a market order to buy takes the lowest ask, a market order to sell takes the highest bid — removing that resting order from the book. Makers place orders that aren't immediately matched (limit orders away from the current price), adding depth to the book instead.",
      read: "Most venues charge takers more than makers, since takers remove liquidity while makers supply it. Heavy taker buying/selling shows urgency and can mark exhaustion once it stops moving price further; heavy maker activity building on one side shows resting interest at that level.",
    },
    {
      id: "put-option", term: "Put Option", category: "Futures & Derivatives",
      def: "An options contract that gains value as the underlying asset's price falls, giving the holder the right — not the obligation — to sell at a set strike price before expiration.",
      read: "Puts are used both to speculate on a decline and to hedge an existing long position. Weigh implied volatility and time decay against the expected move before buying one outright.",
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

  var DECISION_ENGINE_GLOSSARY = [
    {
      id: "market-map-framework", term: "Dashboard vs. Strategy vs. Risk System vs. Journal", category: "Decision Engine & Trading Framework",
      def: "A multi-asset trader's toolkit splits into four separate layers: the dashboard maps the market (regime, rotation, cleanest setups), the strategy defines entry rules, the risk system enforces survival (sizing, invalidation, exposure limits), and the journal drives improvement by grading past calls.",
      read: "Keep the layers separate. The dashboard's job is to answer “where is the cleanest opportunity with the best risk?” — not to place trades for you. If a page tries to do all four jobs at once, it gets cluttered and none of them work well.",
      pages: [{ label: "Decision Engine", href: "/decision.html" }],
    },
    {
      id: "market-regime", term: "Market Regime (Risk-On / Risk-Off / Defensive / Volatile / Trend Mode / Choppy)", category: "Decision Engine & Trading Framework",
      def: "A single read on “what environment are we in,” built by voting BTC, crypto breadth, SPY, QQQ, DXY, VIX, gold, oil and US10Y (when available) each –10..+1 on risk appetite, weighting them, and turning the result into a 0–100 score and a label.",
      read: "Score ≥62 is Risk-On, ≤38 is Risk-Off; in between it falls back to Defensive (gold bid + soft equities), Volatile (VIX/crypto swings large), Trend Mode (inputs agree and lean hard one way), or Choppy (inputs disagree or are flat). Use it to set directional bias, not as an entry trigger.",
      pages: [{ label: "Decision Engine → Market Regime", href: "/decision.html#de-regime-card" }],
    },
    {
      id: "rotation-board", term: "Rotation Board", category: "Decision Engine & Trading Framework",
      def: "A table showing where money is flowing right now across Crypto, Stocks, USD, Gold, Oil, and Bonds/Yields — each class's move is scaled against its own normal daily range (a 0.5% DXY move counts as “strong” the same way a 3% crypto move does) so the classes are comparable head-to-head.",
      read: "Check the “leader” call before picking which market to trade: it names the asset class with the largest scaled move. A trader watching 20 markets uses this to narrow down to the 1–3 that actually have flow behind them.",
      pages: [{ label: "Decision Engine → Rotation Board", href: "/decision.html#de-rotation-body" }],
    },
    {
      id: "setup-quality-score", term: "Setup Quality Score", category: "Decision Engine & Trading Framework",
      def: "A 0–100 ranking layered on top of the signal screener's confluence score for each LONG/SHORT candidate, blending confluence (45%), regime alignment (25%), trend strength/ADX (15%), and news safety (15%) into one number and an action.",
      read: "≥75 = “Ready — watch for entry,” ≥60 = “Watch,” ≥45 = “Low edge,” below that = “Skip.” A high-impact news window overrides the score entirely to “Stand down.” It ranks candidates — it doesn't replace chart confirmation.",
      pages: [{ label: "Decision Engine → Setup Ranking", href: "/decision.html#de-setups-table" }],
    },
    {
      id: "execution-plan", term: "Execution Plan (Trigger / Invalidation / Target)", category: "Decision Engine & Trading Framework",
      def: "Trigger, invalidation, and target levels computed from recent swing high/low structure and ATR for the top-ranked setups: trigger at the breakout level, invalidation at the structure stop (capped at 2.5× ATR from trigger), target from the swing range or 1.5× risk, whichever is larger — plus the resulting risk/reward ratio.",
      read: "Each plan also lists explicit “do not trade” reasons — a high-impact news window, the signal conflicting with the regime, a volatile regime, or risk/reward under 1.5 — any of which should make you skip it even with a high setup score. Verify levels on the actual chart before acting; this is a starting plan, not an order ticket.",
      pages: [{ label: "Decision Engine → Execution Panel", href: "/decision.html#de-exec-grid" }],
    },
    {
      id: "trading-journal-feedback-loop", term: "Trading Journal / Feedback Loop", category: "Decision Engine & Trading Framework",
      def: "Every logged signal snapshots what the engine said at the time (setup score, regime, plan levels). You grade it later — was it taken, was the result a win/loss/breakeven, was the regime read correct, was the pattern correct, was news risk missed — and the journal aggregates win rate and review accuracy across all graded entries.",
      read: "This is what turns a dashboard from a market map into a trading assistant: the win rate and regime/pattern accuracy stats tell you whether the engine's scoring is actually predictive for you, rather than just looking reasonable in the moment.",
      pages: [{ label: "Decision Engine → Trading Journal", href: "/decision.html#de-journal-stats" }],
    },
    {
      id: "news-risk-window", term: "News Risk Window", category: "Decision Engine & Trading Framework",
      def: "A calendar-aware risk read that scans today's high-impact economic events: “high” when one falls inside a –15/+45 minute window of now (the pre-release chop and post-release whipsaw), “medium” when high-impact events exist later today, “low” otherwise.",
      read: "Treat a “high” reading as a hard stand-down for new entries — it overrides setup score and regime alignment alike, since whipsaw around CPI/FOMC-type prints can invalidate a clean technical setup in seconds.",
      pages: [{ label: "Decision Engine → News Risk", href: "/decision.html#de-news-strip" }],
    },
  ];

  var MARKET_FUNDAMENTALS_GLOSSARY = [
    {
      id: "supply-demand", term: "Supply & Demand", category: "Market Fundamentals",
      def: "The balance between buying pressure (demand) and selling pressure (supply) at each price level — the basic force that sets price in any market.",
      read: "Price is a magnet to imbalance: buyers overpowering sellers push price up, sellers dominating pull it down. Watch order flow, volume, and how price reacts at a level to spot which side is winning before the move is obvious.",
    },
    {
      id: "market-sentiment-psychology", term: "Market Sentiment & Psychology", category: "Market Fundamentals",
      def: "The collective emotional state of participants — fear, greed, complacency, panic — that drives price beyond what fundamentals alone would justify.",
      read: "Markets are driven more by emotion than logic more often than traders like to admit. Staying calm when others panic, and skeptical when others are euphoric, is a structural edge rather than just a saying.",
      pages: [{ label: "Indicators Glossary → Fear & Greed Index", href: "/indicators.html#term-fear-greed" }],
    },
    {
      id: "news-macro-events", term: "News & Macro Events", category: "Market Fundamentals",
      def: "Economic reports, central bank decisions, and geopolitical developments that can trigger sudden, outsized price moves as the market reprices its expectations.",
      read: "Headlines become candles. Markets react to the surprise versus the forecast, not the raw number — know the calendar (CPI, FOMC, NFP, geopolitical shocks) so a release doesn't catch you mid-trade.",
      pages: [{ label: "Overview → Calendars & Tools", href: "/#calendars-tools" }],
    },
    {
      id: "stock-market", term: "Stock Market", category: "Market Fundamentals",
      def: "The market for buying and selling ownership shares (equities) in public companies, e.g. Apple or Tesla.",
      read: "Generally suits longer-term growth, dividend, and blue-chip strategies; moves on earnings, rates, and sector rotation more than on 24-hour news cycles.",
    },
    {
      id: "forex-market", term: "Forex (FX) Market", category: "Market Fundamentals",
      def: "The market for trading currency pairs (e.g. EUR/USD) against each other.",
      read: "Extremely liquid and open roughly 24/5, which suits technical and session-based trading. Highly sensitive to central bank policy and interest-rate differentials between the two currencies in a pair.",
    },
    {
      id: "crypto-market", term: "Crypto Market", category: "Market Fundamentals",
      def: "The market for digital assets like Bitcoin and Ethereum, trading on centralized and decentralized exchanges.",
      read: "Trades 24/7 with no close and tends to be more volatile than traditional markets, which suits momentum and swing approaches — but thinner liquidity outside the majors means bigger slippage and sharper reversals.",
    },
    {
      id: "futures-market", term: "Futures Market", category: "Market Fundamentals",
      def: "Contracts to buy or sell an underlying commodity, index, or currency at a set price on a future date, traded on regulated exchanges like the CME.",
      read: "Heavily leveraged by design — a small margin deposit controls a much larger notional position — so define risk per contract before sizing, not after a move goes against you.",
      pages: [{ label: "Indicators Glossary → Types of Contracts", href: "/indicators.html#term-types-of-contracts" }],
    },
    {
      id: "trading-vs-investing", term: "Trading vs. Investing", category: "Market Fundamentals",
      def: "Trading targets short-term price movement (minutes to weeks) using price action, charts, and news, and requires active monitoring. Investing targets long-term wealth growth (years) based on company or protocol fundamentals, and tolerates short-term drawdowns.",
      read: "The two aren't mutually exclusive — many participants hold a long-term core position alongside shorter-term tactical trades. The common, avoidable mistake is conflating the two: panic-selling a long-term thesis because of daily noise, or treating a trade's stop level like a long-term investment's drawdown tolerance.",
    },
    {
      id: "retail-traders", term: "Retail Traders", category: "Market Participants",
      def: "Individual, non-professional traders investing their own capital, typically through retail brokers or exchanges.",
      read: "Retail flow often follows trends, headlines, and social sentiment rather than leading them — useful as a contrarian crowd-positioning signal at extremes rather than a source of edge to copy directly.",
    },
    {
      id: "institutional-investors", term: "Institutional Investors", category: "Market Participants",
      def: "Large organizations — hedge funds, banks, pension funds, insurers — trading substantial size on behalf of others.",
      read: "Their large orders can move markets and often execute over time (accumulation or distribution) rather than in one print, which is why volume and open-interest trends can reveal institutional activity before price confirms it.",
    },
    {
      id: "high-frequency-traders", term: "High-Frequency Traders (HFTs)", category: "Market Participants",
      def: "Firms using algorithms and low-latency infrastructure to profit from small, extremely short-term price movements.",
      read: "HFT activity is largely invisible on a normal chart but shows up as tighter spreads and rapid order-book churn — a reason very short-term price noise shouldn't be over-interpreted as a directional signal.",
    },
    {
      id: "liquidity-providers", term: "Liquidity Providers", category: "Market Participants",
      def: "Participants — often market makers or dedicated LP firms — who commit to continuously quoting both sides of the market so trades execute smoothly.",
      read: "Think of liquidity providers as the market's “oil”: more of them, quoting tighter and deeper, means less slippage. When they pull back around news events or stress, spreads widen and slippage jumps sharply.",
    },
  ];

  var CANDLESTICK_GLOSSARY = [
    {
      id: "bullish-engulfing", term: "Bullish Engulfing", category: "Candlestick Patterns",
      def: "A two-candle bullish reversal pattern where a large bullish candle fully engulfs the prior bearish candle's real body, showing buyers overwhelming the recent selling.",
      read: "Most reliable at support, after a liquidity sweep of lows, or at the bottom of a pullback in an uptrend. A bullish engulfing candle in the middle of a range carries much less weight.",
    },
    {
      id: "bearish-engulfing", term: "Bearish Engulfing", category: "Candlestick Patterns",
      def: "A two-candle bearish reversal pattern where a large bearish candle fully engulfs the prior bullish candle's real body, showing sellers overwhelming recent buying.",
      read: "Most meaningful at resistance or after a liquidity run above old highs — treat it as a reason to tighten risk rather than an automatic short trigger on its own.",
    },
    {
      id: "shooting-star", term: "Shooting Star", category: "Candlestick Patterns",
      def: "A single bearish reversal candle with a small body near the low and a long upper wick, forming after an uptrend when buyers push price up but sellers overwhelm them into the close.",
      read: "Strongest at resistance, after a liquidity sweep of old highs, or into a supply zone. Confirmation comes from the next candle closing lower, not the shooting star alone.",
    },
    {
      id: "hammer", term: "Hammer", category: "Candlestick Patterns",
      def: "A bullish reversal candle with a small body near the top and a long lower wick, forming after a downtrend when sellers push price down but buyers step in before the close.",
      read: "Strongest at support, after a liquidity sweep of old lows, or inside a demand zone. Confirm with the next candle closing higher rather than trading the hammer in isolation.",
    },
    {
      id: "inverted-hammer", term: "Inverted Hammer", category: "Candlestick Patterns",
      def: "A potential bullish reversal candle after a downtrend, with a small body near the low and a long upper wick, showing buyers tested higher prices before the close.",
      read: "Needs a bullish follow-through candle to confirm — on its own it only shows buyers are starting to test the sellers' control, not that they've won it.",
    },
    {
      id: "hanging-man", term: "Hanging Man", category: "Candlestick Patterns",
      def: "The same shape as a hammer — small body, long lower wick — but forming after an uptrend, warning that sellers are starting to test control.",
      read: "Confirmation requires the next candle to close lower; without it, the hanging man alone is just a shape, not a signal.",
    },
    {
      id: "doji", term: "Doji", category: "Candlestick Patterns",
      def: "A candle where the open and close are virtually equal, leaving little or no real body — a visual sign of indecision between buyers and sellers.",
      read: "A doji after a strong trend, especially at a key level, can flag exhaustion. In the middle of a range it usually just means low conviction, not an imminent reversal.",
    },
    {
      id: "morning-star", term: "Morning Star", category: "Candlestick Patterns",
      def: "A three-candle bullish reversal pattern: a long bearish candle, a small-bodied indecision candle, then a strong bullish candle closing well into the first candle's body.",
      read: "More reliable at support or demand zones after a clear downtrend. The third candle's strength and close location matter more than matching the textbook shape exactly.",
    },
    {
      id: "evening-star", term: "Evening Star", category: "Candlestick Patterns",
      def: "A three-candle bearish reversal pattern: a long bullish candle, a small indecision candle, then a strong bearish candle closing well into the first candle's body.",
      read: "Most significant at resistance or supply zones after a clear uptrend. Treat it as a warning to manage risk, not a guaranteed top.",
    },
  ];

  var ILLUSTRATED_GLOSSARY = [
    {
      id: "support-resistance", term: "Support & Resistance", category: "Price Action & Liquidity",
      def: "Support is a price zone where historical buying has been strong enough to halt or reverse a decline; resistance is a zone where historical selling has been strong enough to halt or reverse an advance.",
      read: "The more times a level is tested and holds, the more traders watch it — but each retest also slightly weakens it. A support level that finally breaks often flips into resistance on the retest, and vice versa, since the traders trapped on the wrong side now have a level to defend.",
      illustration:
        '<div class="gi-diagram" style="flex-direction:column;align-items:stretch;gap:6px;">' +
        '<span class="gi-cell gi-down">Resistance — sellers likely to defend</span>' +
        '<span class="gi-cell gi-flat">Price trades in between</span>' +
        '<span class="gi-cell gi-up">Support — buyers likely to defend</span>' +
        "</div>",
    },
    {
      id: "btc-dominance-cycle", term: "Bitcoin Dominance Cycle (BTC.D vs. BTC vs. Alts)", category: "Market Cap & Dominance",
      def: "A cheat-sheet mapping how BTC dominance (BTC.D), Bitcoin's own price, and total altcoin market cap tend to move relative to each other. Because BTC.D is itself a ratio (BTC market cap / total crypto market cap), its direction depends on how BTC and alts move together, not on BTC.D in isolation.",
      read: "Two rows matter most: BTC.D and BTC both rising while alts fall means capital is consolidating into Bitcoin (alt weakness); BTC.D falling while BTC and alts both rise fast is classic alt season. The remaining rows describe quieter accumulation or distribution phases rather than a decisive rotation.",
      illustration:
        '<table class="gi-table"><thead><tr><th>BTC.D</th><th>BTC</th><th>Alts</th></tr></thead><tbody>' +
        '<tr><td><span class="gi-cell gi-up">Increases</span></td><td><span class="gi-cell gi-up">Increases</span></td><td><span class="gi-cell gi-down">Decreases</span></td></tr>' +
        '<tr><td><span class="gi-cell gi-up">Increases</span></td><td><span class="gi-cell gi-down">Decreases</span></td><td><span class="gi-cell gi-down">Decreases Fast (Dump)</span></td></tr>' +
        '<tr><td><span class="gi-cell gi-up">Increases</span></td><td><span class="gi-cell gi-flat">Stable</span></td><td><span class="gi-cell gi-flat">Stable (Accumulation)</span></td></tr>' +
        '<tr><td><span class="gi-cell gi-down">Decreases</span></td><td><span class="gi-cell gi-up">Increases</span></td><td><span class="gi-cell gi-up">Increases Fast (Alt Season)</span></td></tr>' +
        '<tr><td><span class="gi-cell gi-down">Decreases</span></td><td><span class="gi-cell gi-down">Decreases</span></td><td><span class="gi-cell gi-flat">Stable</span></td></tr>' +
        '<tr><td><span class="gi-cell gi-down">Decreases</span></td><td><span class="gi-cell gi-flat">Stable</span></td><td><span class="gi-cell gi-up">Increases</span></td></tr>' +
        "</tbody></table>",
    },
  ];

  var CORE_VOCAB_GLOSSARY = [
    {
      id: "bulls-bears", term: "Bulls & Bears", category: "Core Trading Vocabulary",
      def: "Bulls are traders/investors buying because they expect price to rise; bears are those selling or shorting because they expect price to fall — the market's basic two-sided vocabulary for buyer vs. seller conviction.",
      read: "A “bullish” market, asset, or setup means net buying pressure is expected to win; “bearish” means net selling pressure is expected to win. Don't confuse the label with certainty — both sides are trading at every price.",
    },
    {
      id: "long-short", term: "Long & Short", category: "Core Trading Vocabulary",
      def: "Going long means opening a position expecting price to rise (buy first, profit if it goes up); going short means opening a position expecting price to fall (sell or borrow first, profit if it goes down).",
      read: "Shorting typically carries different mechanics and risk than going long — borrowing costs, funding rates, and in a naked short, theoretically unlimited loss. Know your instrument's specific short mechanics before using it.",
    },
    {
      id: "dominant-trend-direction", term: "Dominant Trend Direction (DTD)", category: "Core Trading Vocabulary",
      def: "The main direction the market is moving on the timeframe you're trading — the higher-order bias that pullbacks and legs happen inside of.",
      read: "Establish DTD before looking at entries. Trades aligned with DTD have a structural tailwind; counter-DTD trades need a stronger, confirmed reason to work.",
    },
    {
      id: "consolidated-ranging-market", term: "Consolidated / Ranging Market", category: "Core Trading Vocabulary",
      def: "A period where price lacks a clear directional leader, typically driven by low volume, indecision, or uncertainty, and stays contained between a floor and a ceiling rather than trending.",
      read: "Range tools (RSI, stochastics, Bollinger Bands, VWAP) tend to work better here than trend tools. Wait for a confirmed break with acceptance before treating a range edge as the start of a new trend.",
      pages: [{ label: "Indicators Glossary → Ranging Market Indicators", href: "/indicators.html#term-ranging-market-indicators" }],
    },
    {
      id: "naked-charts", term: "Naked Charts", category: "Core Trading Vocabulary",
      def: "Clean price charts showing only price bars or candles, with no indicators or signals overlaid.",
      read: "Naked-chart reading forces you to judge structure, momentum, and liquidity directly from price and volume — useful for building chart-reading skill without leaning on lagging indicators.",
    },
  ];

  var PRICE_ACTION_EXTRA_GLOSSARY = [
    {
      id: "big-mid-small-players", term: "Big Players, Mid Players & Small Players", category: "Market Participants",
      def: "A size-based way to bucket market participants: Big Players (central banks, major financial institutions), Mid Players (mid- or small-sized banks, large hedge funds, market makers, large corporate or commercial companies), and Small Players (retail or private individual traders).",
      read: "Size roughly maps to how a participant moves the market: big players can move price with a single order, mid players move it by accumulating over time, and small players mostly react to the moves the other two create.",
    },
    {
      id: "ceiling-floor", term: "Ceiling & Floor (Horizontal Resistance / Support)", category: "Price Action & Liquidity",
      def: "A ceiling is a horizontal upper resistance line confirmed by at least two touches of price highs at roughly the same level; a floor is the equivalent horizontal lower support line confirmed by at least two touches of price lows.",
      read: "Require the two-touch confirmation before trusting a ceiling or floor as a real level — a single high or low is just a swing point, not yet a defended line.",
    },
    {
      id: "upper-lower-lines", term: "Upper Resistance Line & Lower Support Line", category: "Price Action & Liquidity",
      def: "The upper resistance line is drawn using at least two price highs; the lower support line is drawn using at least two price lows — together they form the boundaries of a channel or range.",
      read: "Like a ceiling/floor, these lines need at least two touches to be considered valid, rather than an arbitrary line connecting one high to a guess.",
    },
    {
      id: "price-channels", term: "Price Channels", category: "Price Action & Liquidity",
      def: "A continuation pattern where price is bounded between a sloping upper resistance line and a sloping lower support line, moving up or down together like a slanted rectangle.",
      read: "Trade the channel by fading the edges back toward the middle, or by watching for a clean break of either line as an early signal the channel — and the trend inside it — may be ending.",
    },
    {
      id: "fibonacci-retracement", term: "Fibonacci Retracement (Fib / Fib Ret)", category: "Price Action & Liquidity",
      def: "A tool that marks likely pullback levels — commonly 23.6%, 38.2%, 50%, 61.8%, and 78.6% — between a swing high and swing low, based on Fibonacci ratios.",
      read: "Treat fib levels as areas of interest, not exact turning points. They're far more useful when they overlap with structure, liquidity, or a volume level than when used in isolation.",
      pages: [{ label: "Indicators Glossary → Golden Pocket", href: "/indicators.html#term-golden-pocket" }],
    },
    {
      id: "head-and-shoulders", term: "Head & Shoulders (H&S)", category: "Price Action & Liquidity",
      def: "A reversal chart pattern made of three peaks (or troughs, for the inverse) — a higher center peak (head) flanked by two lower peaks (shoulders) at roughly similar height, with a “neckline” connecting the two troughs between them.",
      read: "Confirmation comes from a decisive close through the neckline, not just the visual shape. Measure the target as the head-to-neckline distance, projected from the break.",
    },
    {
      id: "leg-pullback", term: "Leg & Pullback", category: "Price Action & Liquidity",
      def: "A leg is a single directional price movement; a pullback is a move — of one or more bars or legs — against the prevailing trend direction before it resumes, commonly modeled as a 3-leg structure.",
      read: "Distinguish a normal pullback (shallow, low volume, holds structure) from a reversal (breaks structure, high volume) — leg count and retracement depth are your first clues.",
    },
    {
      id: "liquid-illiquid-market", term: "Liquid vs. Illiquid (Thin) Market", category: "Price Action & Liquidity",
      def: "A liquid market has plenty of active buyers and sellers, which tightens the bid-ask spread and lets trades execute quickly near the last price. An illiquid (thin) market has few active participants, wide spreads, and larger price impact per trade.",
      read: "Size down in thin markets — slippage and gaps get worse exactly when you need a clean exit. Liquidity itself changes by session and by proximity to news, not just by asset.",
      pages: [{ label: "Indicators Glossary → Liquidity", href: "/indicators.html#term-liquidity" }],
    },
    {
      id: "price-action-pa", term: "Price Action (PA)", category: "Price Action & Liquidity",
      def: "The study of an asset's price movement itself — candles, chart patterns, structure, and for some traders volume — used to make trading decisions without relying primarily on lagging indicators.",
      read: "Price action reads faster than most indicators because it's the rawest data available; the tradeoff is it requires more subjective interpretation and experience to apply consistently.",
    },
    {
      id: "price-cyclicity", term: "Price Cyclicity", category: "Price Action & Liquidity",
      def: "The tendency of price to move up and down in waves — pullbacks and countertrend legs — even while a clear larger trend is in place.",
      read: "Expect cyclicity inside any trend. The presence of a pullback doesn't by itself mean the trend has changed — only a structure break against the trend (a BOS the wrong way, or a ChoCH) does.",
      pages: [{ label: "Indicators Glossary → Change of Character", href: "/indicators.html#term-change-of-character" }],
    },
    {
      id: "pin-bar", term: "Pin Bar", category: "Candlestick Patterns",
      def: "A single candle with a long wick (high test or low test) and a small real body, showing price rejected a level within the bar — the general form behind patterns like the hammer, shooting star, and bullish/bearish pin bar.",
      read: "A high-test pin bar (long upper wick) signals rejection of higher prices; a low-test pin bar (long lower wick) signals rejection of lower prices. Context — support/resistance, trend, volume — matters more than the shape alone.",
    },
    {
      id: "momentum-vs-trend-indicators", term: "Momentum vs. Trend Indicators", category: "Technical Indicators",
      def: "Momentum indicators (RSI, MACD, stochastics) measure the speed and strength of a price move and flag overbought/oversold conditions. Trend indicators (moving averages, Bollinger Bands, Ichimoku Cloud) identify the direction and strength of the prevailing trend — up, down, or sideways.",
      read: "Some tools (moving averages) do double duty. Use trend indicators to decide whether to look for longs or shorts at all, and momentum indicators to time entries/exits within that bias — momentum readings against a strong trend are weaker signals than the same reading in a range.",
    },
  ];

  var ICT_GLOSSARY = [
    {
      id: "kill-zones", term: "Kill Zones (London / New York)", category: "ICT / Smart Money Concepts",
      def: "Specific windows during the London and New York sessions — roughly the first 1–2 hours of each — when ICT-style traders expect the highest-probability liquidity raids and directional moves, driven by session-open volume.",
      read: "Kill zones matter because volume and volatility cluster there. A setup that looks clean outside a kill zone often lacks the participation to follow through.",
    },
    {
      id: "amd-power-of-three", term: "AMD / Power of Three (PO3)", category: "ICT / Smart Money Concepts",
      def: "A three-phase model for how a trading range unfolds: Accumulation (quiet, range-bound build-up), Manipulation (a stop hunt or liquidity sweep beyond the range, often at a session open), and Distribution (the real directional move away from the range).",
      read: "Use it to avoid entering during the manipulation phase — a sharp move against the expected direction right at a session open or kill zone is often the manipulation leg, not the real trend.",
    },
    {
      id: "optimal-trade-entry", term: "Optimal Trade Entry (OTE)", category: "ICT / Smart Money Concepts",
      def: "An entry zone, typically the 62–79% Fibonacci retracement of the most recent impulsive leg, where price is expected to react before continuing in the leg's direction.",
      read: "OTE marks a location to look for confluence, not a standalone trigger — combine it with an order block, fair value gap, or liquidity sweep rather than trading the fib zone alone.",
      pages: [{ label: "Indicators Glossary → Order Blocks", href: "/indicators.html#term-order-blocks" }],
    },
    {
      id: "turtle-soup", term: "Turtle Soup (TS)", category: "ICT / Smart Money Concepts",
      def: "A reversal setup where price makes a new high or low beyond a recent swing point (often to trigger stops) and then quickly reverses back inside the prior range — a liquidity-sweep-based fade.",
      read: "The name references the classic Turtle trend-following breakout system: Turtle Soup fades the breakout the Turtles would have bought or sold, betting it's a stop-hunt rather than genuine continuation.",
    },
    {
      id: "ict-acronyms", term: "ICT / Smart Money Concepts (SMC) Acronyms", category: "ICT / Smart Money Concepts",
      def: "A reference list of shorthand used across ICT (Inner Circle Trader) and Smart Money Concepts material — session times, structure labels, block types, and liquidity terms — for reading SMC-style charts, videos, and notes without decoding each term from scratch. PDH/PDL/PWH/PWL (previous day/week high/low), DH/DL/MH/ML (daily/monthly high/low), BMS/SMS/MS (break/shift in/market structure), OB/+OB/-OB (order block, bullish/bearish), BRK/+BRK/-BRK (breaker, bullish/bearish), PB (propulsion block), VB (vacuum block), MB (mitigation block), RTB (return to breaker), RTO (return to order block/origin), FVG (fair value gap), CE (consequent encroachment, 50% of FVG), LV/LVG (liquidity void / liquidity void gap), BISI/SIBI (buy-side/sell-side imbalance, sell-side/buy-side inefficiency), BSL/SSL (buyside/sellside liquidity), EQH/EQL (equal high/low), LP (liquidity pool), SH/SP/SL/TP (stop hunt, stops purged, stop loss, take profit), OTE (optimal trade entry), IPDA (interbank price delivery algorithm), IOF (institutional order flow), SMT (smart money tool/divergence), AMD/PO3 (accumulation, manipulation, distribution / power of three), TSBM/TSSM (turtle soup buy/sell model), CBDR (central bank dealer range), RN (round numbers), OSOK (one shot one kill), WDYS (what do you see), LO/NYO (London/New York open), LOKZ/NYKZ (London/New York kill zone), CME (Chicago Mercantile Exchange, bond market open), HTF/LTF (higher/lower timeframe), 1D/1W/1M (daily/weekly/monthly timeframe), RR (risk to reward), MJH (Michael J. Huddleston, founder of the ICT methodology), COT (Commitment of Traders), NFP (Non-Farm Payroll).",
      read: "Most of these describe the same handful of ideas — market structure shifts, order blocks/breakers, liquidity pools and sweeps, session timing — under different shorthand. Learn the concept once (structure break, imbalance, liquidity raid, session timing) and the acronym becomes a label, not a new thing to memorize.",
      illustration:
        '<table class="gi-table"><tbody>' +
        '<tr><td><span class="gi-cell gi-flat">PDH / PDL</span></td><td>Previous Day High / Low</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">PWH / PWL</span></td><td>Previous Week High / Low</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">DH / DL / MH / ML</span></td><td>Daily / Monthly High / Low</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">BMS / SMS / MS</span></td><td>Break / Shift in / Market Structure</td></tr>' +
        '<tr><td><span class="gi-cell gi-up">+OB</span> / <span class="gi-cell gi-down">-OB</span></td><td>Bullish / Bearish Order Block</td></tr>' +
        '<tr><td><span class="gi-cell gi-up">+BRK</span> / <span class="gi-cell gi-down">-BRK</span></td><td>Bullish / Bearish Breaker</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">PB / VB / MB</span></td><td>Propulsion / Vacuum / Mitigation Block</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">RTB / RTO</span></td><td>Return to Breaker / Return to Order Block (Origin)</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">FVG / CE</span></td><td>Fair Value Gap / Consequent Encroachment (50% of FVG)</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">LV / LVG</span></td><td>Liquidity Void / Liquidity Void Gap</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">BISI / SIBI</span></td><td>Buy-Side Imbalance / Sell-Side Imbalance (Inefficiency)</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">BSL / SSL</span></td><td>Buyside / Sellside Liquidity</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">EQH / EQL</span></td><td>Equal High / Equal Low</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">LP</span></td><td>Liquidity Pool</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">SH / SP / SL / TP</span></td><td>Stop Hunt / Stops Purged / Stop Loss / Take Profit</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">OTE</span></td><td>Optimal Trade Entry</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">IPDA / IOF</span></td><td>Interbank Price Delivery Algorithm / Institutional Order Flow</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">SMT</span></td><td>Smart Money Tool (Divergence)</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">AMD / PO3</span></td><td>Accumulation, Manipulation, Distribution / Power of Three</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">TSBM / TSSM</span></td><td>Turtle Soup Buy Model / Sell Model</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">CBDR</span></td><td>Central Bank Dealer Range</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">RN / OSOK / WDYS</span></td><td>Round Numbers / One Shot One Kill / What Do You See</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">LO / NYO</span></td><td>London Open / New York Open</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">LOKZ / NYKZ</span></td><td>London Kill Zone / New York Kill Zone</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">CME</span></td><td>Chicago Mercantile Exchange (bond market open)</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">HTF / LTF</span></td><td>Higher / Lower Timeframe</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">1D / 1W / 1M</span></td><td>Daily / Weekly / Monthly Timeframe</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">RR</span></td><td>Risk to Reward</td></tr>' +
        '<tr><td><span class="gi-cell gi-flat">MJH</span></td><td>Michael J. Huddleston (ICT founder)</td></tr>' +
        "</tbody></table>",
    },
  ];

  var ALL_GLOSSARY = GLOSSARY.concat(USER_GLOSSARY)
    .concat(DECISION_ENGINE_GLOSSARY)
    .concat(MARKET_FUNDAMENTALS_GLOSSARY)
    .concat(CANDLESTICK_GLOSSARY)
    .concat(ILLUSTRATED_GLOSSARY)
    .concat(CORE_VOCAB_GLOSSARY)
    .concat(PRICE_ACTION_EXTRA_GLOSSARY)
    .concat(ICT_GLOSSARY);

  var CATEGORY_ORDER = [
    "Market Fundamentals",
    "Decision Engine & Trading Framework",
    "Core Trading Vocabulary",
    "Candlestick Patterns",
    "Technical Indicators",
    "Price Action & Liquidity",
    "ICT / Smart Money Concepts",
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

  // entry.illustration is authored, trusted HTML (defined in this file, not
  // user input) — rendered as-is so glossary entries can carry a small
  // diagram or reference table alongside the def/read text.
  function cardHtml(entry) {
    var usedIn = (entry.pages || [])
      .map(function (p) {
        return '<a class="glossary-used-chip" href="' + escapeHtml(p.href) + '">' + escapeHtml(p.label) + "</a>";
      })
      .join("");
    return (
      '<article class="glossary-card" id="term-' + escapeHtml(entry.id) + '" data-search="' + escapeHtml((entry.term + " " + entry.category + " " + entry.def + " " + entry.read).toLowerCase()) + '" data-category="' + escapeHtml(entry.category) + '">' +
      '<div class="glossary-term">' + escapeHtml(entry.term) + "</div>" +
      '<div class="glossary-def">' + escapeHtml(entry.def) + "</div>" +
      '<div class="glossary-read"><strong>How to read it:</strong> ' + escapeHtml(entry.read) + "</div>" +
      (entry.illustration ? '<div class="glossary-illustration">' + entry.illustration + "</div>" : "") +
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

  function populateJumpMenu() {
    var jump = document.getElementById("glossaryJump");
    if (!jump) return;
    var sorted = ALL_GLOSSARY.slice().sort(function (a, b) { return a.term.localeCompare(b.term); });
    var options = sorted.map(function (entry) {
      return '<option value="' + escapeHtml(entry.id) + '">' + escapeHtml(entry.term) + "</option>";
    });
    jump.insertAdjacentHTML("beforeend", options.join(""));
    jump.addEventListener("change", function () {
      var id = jump.value;
      jump.value = "";
      if (!id) return;
      var search = document.getElementById("glossarySearch");
      if (search && search.value) {
        search.value = "";
        applyFilter("");
      }
      var card = document.getElementById("term-" + id);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("glossary-card--highlight");
      setTimeout(function () {
        card.classList.remove("glossary-card--highlight");
      }, 1600);
    });
  }

  function init() {
    render();
    populateJumpMenu();
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
