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
      pages: [{ label: "Crypto Hub → CMC Indicators", href: "/crypto.html#cmc-indicators" }],
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
      pages: [{ label: "Crypto Hub → CMC Indicators", href: "/crypto.html#cmc-indicators" }],
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

  var CATEGORY_ORDER = [
    "Technical Indicators",
    "Futures & Derivatives",
    "On-Chain & Network",
    "Cycle & Valuation",
    "Market Cap & Dominance",
    "Volatility & Sentiment",
    "ETF Flows",
    "Traditional Markets",
    "Macro Economics",
    "Commodities",
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
      '<article class="glossary-card" data-term="' + escapeHtml(entry.term.toLowerCase()) + '" data-category="' + escapeHtml(entry.category) + '">' +
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
    GLOSSARY.forEach(function (entry) {
      (byCategory[entry.category] = byCategory[entry.category] || []).push(entry);
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
      var match = !q || card.dataset.term.indexOf(q) !== -1 || card.dataset.category.toLowerCase().indexOf(q) !== -1;
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
