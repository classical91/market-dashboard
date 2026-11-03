/**
 * Topic explainers for the Indicators Glossary — one guide per glossary
 * category, rendered at /topic.html?id=<topic id>.
 *
 * Each topic turns a category's list of terms into an explanation:
 *   summary    one line, shown under the category on the glossary page
 *   intro      what the topic is about
 *   why        why a trader should care / what question it answers
 *   sections   an ordered walk-through: a lead-in note, then the concepts
 *              (by glossary id) it explains, in reading order
 *   takeaways  how to put the topic to work
 *
 * Concepts a topic's sections don't name still appear on its page under
 * "Also in this topic", so new glossary entries are never hidden.
 * Loaded before indicators.js, which exposes these through MarketGlossary.
 */
(function () {
  "use strict";

  var TOPICS = {
    "Market Fundamentals": {
      summary: "What markets are, what moves them, and the difference between trading and investing.",
      intro: "Every chart, indicator and headline on this dashboard sits on top of a few basic ideas: price is set where buyers and sellers agree, people's emotions push it past fair value, and news changes the balance suddenly. This topic covers those forces and the main markets you'll see them play out in.",
      why: "If you know why price moves, indicators stop being magic lines and become measurements of supply, demand and crowd behaviour.",
      sections: [
        {
          title: "What moves price",
          note: "Price is the running result of buying versus selling pressure. Psychology explains why that pressure overshoots, and news explains why it can flip in seconds.",
          ids: ["supply-demand", "market-sentiment-psychology", "news-macro-events"],
        },
        {
          title: "The main markets",
          note: "The same forces apply everywhere, but each market has its own hours, participants and instruments.",
          ids: ["stock-market", "forex-market", "crypto-market", "futures-market"],
        },
        {
          title: "Choosing your approach",
          note: "Before picking tools, decide your time horizon — it changes which signals matter.",
          ids: ["trading-vs-investing"],
        },
      ],
      takeaways: [
        "Read every move as a shift in supply and demand first, then ask what caused it.",
        "Expect crowds to overshoot in both directions — that's where opportunity and risk both come from.",
        "Match your tools to your horizon: traders watch structure and flows, investors watch value and macro.",
      ],
    },

    "Decision Engine & Trading Framework": {
      summary: "How this dashboard turns market data into a regime read, a ranked setup and a written plan.",
      intro: "The Decision Engine is the dashboard's step-by-step process for going from \"what is the market doing?\" to \"what exactly would I do, and where am I wrong?\". It separates mapping the market from picking a setup, sizing the risk and reviewing the result.",
      why: "Most losses come from skipping steps — trading against the regime, entering without an invalidation level, or never reviewing. A framework makes each step explicit.",
      sections: [
        {
          title: "1. Map the environment",
          note: "Start broad: what regime are we in, where is money rotating, and is there an event that could blow up any setup?",
          ids: ["market-map-framework", "market-regime-score", "rotation-board", "news-risk-window"],
        },
        {
          title: "2. Pick and grade the setup",
          note: "Only then look for a trade, and score it on how many independent reasons line up.",
          ids: ["confluence-model", "setup-quality-score"],
        },
        {
          title: "3. Plan, execute, review",
          note: "Write the trigger, invalidation and target before entering, then log the outcome so the process improves.",
          ids: ["execution-plan", "trading-journal-feedback-loop"],
        },
      ],
      takeaways: [
        "Regime first, setup second — a great setup in the wrong regime is still a low-odds trade.",
        "No invalidation level, no trade.",
        "The journal is what turns individual trades into a system that gets better.",
      ],
    },

    "Core Trading Vocabulary": {
      summary: "The everyday words traders use for direction, positions and market state.",
      intro: "These are the words you'll hear in every trading chat: who's in control (bulls or bears), which way you're betting (long or short), and whether the market is trending or going sideways.",
      why: "Most other concepts assume you already know these terms — they're the grammar the rest of the glossary is written in.",
      sections: [
        {
          title: "Direction and positions",
          note: "Bulls want higher prices and go long; bears want lower prices and go short.",
          ids: ["bulls-bears", "long-short"],
        },
        {
          title: "Trend or range?",
          note: "The first question on any chart: is price trending, or chopping sideways? Clean charts make that easier to see.",
          ids: ["dominant-trend-direction", "consolidated-ranging-market", "naked-charts"],
        },
      ],
      takeaways: [
        "Identify the dominant trend before anything else.",
        "Trend tools work in trends and fail in ranges — and vice versa.",
        "When in doubt, strip the chart back to price alone.",
      ],
    },

    "Candlestick Patterns": {
      summary: "One- to three-candle shapes that show who won a session and where momentum may turn.",
      intro: "Each candlestick records a fight between buyers and sellers: where price opened, how far each side pushed it, and where it closed. Certain shapes show one side clearly winning, losing steam, or being rejected.",
      why: "Candles are the smallest unit of price action. Read at key levels, they're often the earliest sign a move is starting or failing.",
      sections: [
        {
          title: "Indecision",
          note: "Small bodies mean neither side won the session. On their own they say little; after a strong move they warn momentum is fading.",
          ids: ["doji", "spinning-top"],
        },
        {
          title: "Rejection wicks",
          note: "Long wicks show price was pushed somewhere and rejected. Where the wick points tells you which side was turned away.",
          ids: ["pin-bar", "hammer", "inverted-hammer", "shooting-star", "hanging-man"],
        },
        {
          title: "Two-candle reversals",
          note: "One candle overwhelms or contains the previous one, showing control changing hands.",
          ids: ["bullish-engulfing", "bearish-engulfing", "harami", "tweezer-tops-bottoms"],
        },
        {
          title: "Three-candle and conviction patterns",
          note: "Longer sequences confirm a turn or a continuation more clearly, and full-bodied candles show one side in total control.",
          ids: ["morning-star", "evening-star", "three-soldiers-crows", "rising-three-methods", "marubozu"],
        },
      ],
      takeaways: [
        "Location matters more than shape: a hammer at support means far more than one mid-range.",
        "Wait for the candle to close — a pattern isn't real until then.",
        "Use candles as triggers inside a plan, not as the whole plan.",
      ],
    },

    "Chart Patterns": {
      summary: "Multi-swing shapes — triangles, flags, wedges, tops and bottoms — that frame breakouts and reversals.",
      intro: "Chart patterns are the shapes price draws over many candles as buyers and sellers compress, pause or exhaust. Each one implies a likely break direction and a rough measured target.",
      why: "Patterns give you a ready-made plan: a breakout level to trigger on, an invalidation on the other side, and a measured-move target.",
      sections: [
        {
          title: "Continuation patterns",
          note: "A pause in a trend before it resumes. The prior move (the pole) usually sets the target.",
          ids: ["bull-bear-flag", "bull-pennant", "ascending-triangle", "descending-triangle", "symmetrical-triangle", "cup-and-handle"],
        },
        {
          title: "Reversal patterns",
          note: "Shapes that show a trend running out of steam and control flipping to the other side.",
          ids: ["double-top-bottom", "inverse-head-and-shoulders", "rising-wedge", "falling-wedge"],
        },
        {
          title: "Ratio-based patterns",
          note: "Harmonics use Fibonacci ratios between swings to project precise reversal zones.",
          ids: ["harmonic-patterns"],
        },
      ],
      takeaways: [
        "A pattern is only confirmed on a close beyond its boundary — anticipate, but don't front-run.",
        "Rising volume on the breakout separates real moves from fakeouts.",
        "The opposite side of the pattern is your natural invalidation.",
      ],
    },

    "Technical Indicators": {
      summary: "Formulas applied to price and volume to measure trend, momentum, volatility and participation.",
      intro: "Indicators are calculations on price and volume that make one property of the market easier to see. Moving averages show trend, oscillators show momentum, bands show volatility and volume tools show participation. Each answers a different question.",
      why: "Stacking several indicators that measure the same thing adds noise, not confirmation. Knowing which family each belongs to lets you combine them properly.",
      sections: [
        {
          title: "Start here: indicator families",
          note: "Trend tools tell you direction; momentum tools tell you how strongly price is moving. Use one of each rather than three of the same.",
          ids: ["momentum-vs-trend-indicators", "popular-crypto-indicators", "indicator-setups"],
        },
        {
          title: "Trend: moving averages and trend-followers",
          note: "Moving averages smooth price into a trend line. Crosses, the cloud and trailing tools turn that into signals.",
          ids: ["sma", "ema", "wvma", "vwap", "moving-average-price-signal", "golden-death-cross", "ichimoku-cloud", "supertrend", "parabolic-sar", "adx", "vortex-indicator"],
        },
        {
          title: "Momentum oscillators",
          note: "Oscillators measure the speed of price changes, flagging stretched (overbought/oversold) conditions and fading momentum.",
          ids: ["rsi", "macd", "impulse-macd", "stochastic-oscillator", "williams-r", "rate-of-change", "trix", "bull-bear-power"],
        },
        {
          title: "Volatility",
          note: "Volatility tools show how far price normally moves — useful for stop placement and spotting quiet periods before big moves.",
          ids: ["atr", "bollinger", "keltner-channels"],
        },
        {
          title: "Volume and money flow",
          note: "Volume-weighted indicators check whether price moves are backed by real participation.",
          ids: ["on-balance-volume", "money-flow-indicator", "elder-force-index"],
        },
        {
          title: "Divergences and reversal signals",
          note: "When price and an oscillator disagree, momentum is changing before price does — one of the most useful signals indicators give.",
          ids: ["divergence", "hidden-divergence", "sse-divergences", "reversal-indicators"],
        },
      ],
      takeaways: [
        "Pair one trend tool with one momentum tool instead of stacking similar oscillators.",
        "Overbought isn't a sell signal in a strong trend — divergence is more reliable than extremes.",
        "Use ATR or bands to size stops so normal noise doesn't knock you out.",
      ],
    },

    "Price Action & Liquidity": {
      summary: "Reading raw price — structure, levels and where resting orders (liquidity) sit — without relying on indicators.",
      intro: "Price action trading reads the chart itself: the sequence of highs and lows, the levels price respects, and the pools of stop and limit orders resting above and below obvious levels. Large players need that liquidity to fill, so price is often drawn toward it before the real move.",
      why: "Indicators are derived from price; structure and liquidity are price. Knowing where stops cluster explains fakeouts, sweeps and sudden reversals.",
      sections: [
        {
          title: "Start here: structure",
          note: "A trend is a series of higher highs and higher lows (or the reverse). Breaks of that sequence are the earliest trend-change signals.",
          ids: ["price-action-pa", "market-structure", "leg-pullback", "impulsive-wave", "break-of-structure", "change-of-character", "reversal", "relief-rally", "price-cyclicity"],
        },
        {
          title: "Levels that matter",
          note: "Support, resistance and prior period highs/lows are where decisions get made. Fibonacci levels mark likely pullback zones.",
          ids: ["support-resistance", "ceiling-floor", "upper-lower-lines", "price-channels", "pivots", "pdh-pwh-pmh", "previous-day-high", "previous-day-low", "previous-week-high", "previous-month-high", "fibonacci-retracement", "golden-pocket"],
        },
        {
          title: "Liquidity: where the orders are",
          note: "Stops and resting orders cluster just beyond obvious highs and lows. Price is often pushed into those pools before reversing.",
          ids: ["liquidity", "liquid-illiquid-market", "buy-side-liquidity", "sell-side-liquidity", "equal-highs-lows", "untapped-liquidity", "open-liquidity", "liquidity-hunt", "liquidity-sweep", "stop-hunting"],
        },
        {
          title: "Imbalances and institutional footprints",
          note: "Fast moves leave gaps and zones where big orders were placed — price often returns to them.",
          ids: ["fair-value-gap", "order-blocks"],
        },
        {
          title: "Breakouts, retests and classic structures",
          note: "Telling a real breakout from a fakeout, and recognising larger accumulation and distribution structures.",
          ids: ["breakout-fakeout", "retest", "bullish-pin-bar", "head-and-shoulders", "wyckoff-method"],
        },
      ],
      takeaways: [
        "Mark structure and key levels first; everything else is context.",
        "Obvious highs and lows are targets for stops — expect sweeps before the real move.",
        "A break that holds on the retest is stronger than the first break itself.",
      ],
    },

    "ICT / Smart Money Concepts": {
      summary: "A framework built on how large players accumulate, manipulate and distribute around liquidity and time.",
      intro: "ICT (Inner Circle Trader) and Smart Money Concepts model price as being driven by institutions that need liquidity to fill big orders. The ideas cover when they're active (kill zones), how a session tends to unfold (accumulation, manipulation, distribution) and where entries are cheapest (discount) or most expensive (premium).",
      why: "It gives a precise vocabulary for timing and locating entries around liquidity sweeps — and builds on the Price Action & Liquidity topic.",
      sections: [
        {
          title: "Vocabulary first",
          note: "SMC uses a lot of shorthand; start with the acronym list.",
          ids: ["ict-acronyms"],
        },
        {
          title: "Time and the daily cycle",
          note: "Moves cluster in specific sessions, and a day often accumulates, fakes one way, then delivers the real move.",
          ids: ["kill-zones", "amd-power-of-three"],
        },
        {
          title: "Location and entries",
          note: "Buy in discount, sell in premium, and use failed breakouts and broken blocks as entry zones.",
          ids: ["premium-discount", "optimal-trade-entry", "breaker-block", "turtle-soup"],
        },
      ],
      takeaways: [
        "Wait for the liquidity sweep, then look for the structure shift.",
        "Trade during kill zones — outside them, setups have less follow-through.",
        "Longs from discount, shorts from premium; the middle of the range is noise.",
      ],
    },

    "Market Profile & Volume": {
      summary: "Where volume actually traded, who was aggressive, and what the order book shows about intent.",
      intro: "Price shows where the market went; volume shows where it did business. Volume profile maps how much traded at each price, delta and CVD show whether buyers or sellers were the aggressors, and the order book shows resting intent.",
      why: "High-volume prices act as magnets and low-volume prices as fast lanes. Delta reveals whether a move is real buying or just thin liquidity.",
      sections: [
        {
          title: "Start here: how auctions work",
          note: "Markets auction up and down to find prices where business gets done. Profile theory explains balance versus discovery.",
          ids: ["market-profile-theory", "price-discovery", "volume-indicators"],
        },
        {
          title: "Volume profile: where business happened",
          note: "The POC and value area mark accepted prices; naked and developing versions show unfinished business and today's evolving fair value.",
          ids: ["vpvr", "point-of-control", "value-area", "developing-point-of-control", "developing-value-area", "naked-point-of-control"],
        },
        {
          title: "Delta and CVD: who was aggressive",
          note: "Delta compares market buys with market sells. Cumulative delta that disagrees with price warns of absorption or exhaustion.",
          ids: ["volume-delta", "cumulative-volume-delta", "aggregated-cvd", "cvd-spot-perp-kline", "cvd-absorption", "cvd-exhaustion", "aggregated-volume"],
        },
        {
          title: "Order book and footprint",
          note: "The book shows resting limit orders; footprint charts show traded volume inside each candle.",
          ids: ["order-book", "footprint-terminologies"],
        },
      ],
      takeaways: [
        "Expect price to slow at high-volume nodes and move fast through low-volume gaps.",
        "Price up with flat or falling CVD means limit sellers are absorbing — be cautious.",
        "Spot-led moves are usually healthier than perp-led ones.",
      ],
    },

    "Futures & Derivatives": {
      summary: "Leverage, perps, open interest, funding, liquidations and options — the positioning layer behind price.",
      intro: "Derivatives let traders bet on price with leverage, and in crypto they often trade far more volume than spot. Open interest, funding and liquidation data show how crowded and leveraged the market is — which often explains violent moves better than news does.",
      why: "Crowded, over-leveraged positioning is fuel for squeezes. Reading derivatives data tells you which side is vulnerable.",
      sections: [
        {
          title: "Start here: how leveraged contracts work",
          note: "Futures and perps let you control a large position with little capital, which is why liquidation prices matter.",
          ids: ["types-of-contracts", "perpetual-futures", "leverage-margin", "isolated-vs-cross-margin", "mark-price", "liquidation-price"],
        },
        {
          title: "Positioning: OI, funding and crowding",
          note: "Open interest shows how much leverage is in the market; funding and long/short ratios show which side is paying to stay in.",
          ids: ["open-interest", "aggregated-open-interest", "oi-cheat-sheet", "futures-volume", "funding-rate", "long-short-ratio"],
        },
        {
          title: "When leverage unwinds",
          note: "Liquidations force positions closed, which pushes price further and can cascade into squeezes.",
          ids: ["liquidations", "aggregated-liquidations", "short-squeeze"],
        },
        {
          title: "CME, basis and arbitrage",
          note: "Regulated futures and the premium of futures over spot show institutional demand and create low-risk carry trades.",
          ids: ["cme", "btc1", "cme-gap", "contango-backwardation", "basis-trade", "btc-annualized-daily-basis", "arbitrage"],
        },
        {
          title: "Options",
          note: "Options price in expected volatility. Put/call ratios, max pain and expiries show where hedging flows may pin or push price.",
          ids: ["option-trading", "call-option", "put-option", "options-greeks", "implied-volatility", "put-call-ratio", "max-pain", "options-expiration"],
        },
      ],
      takeaways: [
        "Rising OI with flat price plus extreme funding = a squeeze is building; check which side.",
        "Liquidation clusters act as magnets — price often runs into them.",
        "Know your liquidation price before you open any leveraged position.",
      ],
    },

    "Order Types & Execution": {
      summary: "How orders actually get filled — order types, spreads, fees and the hidden costs of execution.",
      intro: "A good idea can still be a bad trade if it's executed poorly. This topic covers the orders you can place, how the bid/ask spread and maker/taker fees work, and how slippage and front-running eat into results.",
      why: "Execution costs come out of every trade. Picking the right order type is the cheapest edge available.",
      sections: [
        {
          title: "Start here: the quote",
          note: "Every market has a best bid and best ask; the gap between them is your first cost.",
          ids: ["bid-ask-price", "bid-ask-spread", "public-quote-price"],
        },
        {
          title: "Order types",
          note: "Market orders guarantee a fill but not the price; limit orders guarantee the price but not the fill. Stops and take-profits automate your exits.",
          ids: ["market-order", "limit-order", "stop-loss-order", "take-profit-order", "post-only", "reduce-only"],
        },
        {
          title: "Costs and hidden risks",
          note: "Taking liquidity costs more than providing it, thin books cause slippage, and large orders can be front-run or moved off-exchange.",
          ids: ["makers-vs-takers", "slippage", "front-running", "otc"],
        },
      ],
      takeaways: [
        "Use limit (post-only) orders when you're not in a hurry to cut fees and slippage.",
        "Always place the stop-loss as an actual order, not a mental note.",
        "Use reduce-only on exits so a stop can never flip you into a new position.",
      ],
    },

    "Trading Risk & Strategy": {
      summary: "Position sizing, risk/reward, expectancy and the habits that keep a trader in the game.",
      intro: "Strategy decides which trades to take; risk management decides how much to lose when they fail. This topic covers sizing, risk/reward, measuring performance, picking a trading style and the practical habits that separate a system from gambling.",
      why: "You can be wrong most of the time and still profit with good risk/reward — or be right most of the time and still blow up with bad sizing.",
      sections: [
        {
          title: "Start here: protect the account",
          note: "Size every position so a loss is small and planned. Risk/reward and drawdown limits keep losing streaks survivable.",
          ids: ["risk-management", "position-sizing", "risk-reward-ratio", "trailing-stop", "max-drawdown", "diversification"],
        },
        {
          title: "Measuring an edge",
          note: "Win rate alone means nothing — expectancy combines it with average win and loss. Backtest before you trust a strategy.",
          ids: ["win-rate-expectancy", "sharpe-ratio", "backtesting", "using-calculus"],
        },
        {
          title: "Choosing a style and timeframe",
          note: "Your style sets your timeframes. Always check the higher timeframe before acting on a lower one.",
          ids: ["trading-styles", "multi-timeframe-analysis", "intraday-charts", "dollar-cost-averaging"],
        },
        {
          title: "Matching strategy to conditions",
          note: "Trend-following and mean reversion suit different regimes. Grade setups and only trade when the trigger fires.",
          ids: ["market-regime", "ranging-market-indicators", "mean-reversion", "aggressive-trading-strategies", "correlation", "setup-quality", "marking-important-levels", "execution-trigger", "types-of-dump"],
        },
        {
          title: "Practical checklists and notes",
          note: "Collected rules of thumb, shorthand and pre-trade checks.",
          ids: ["five-aces", "important-aspects-before-trading-btc", "trading-tips", "abbreviations", "astrology-for-stocks"],
        },
      ],
      takeaways: [
        "Decide the loss before the entry: size = account risk ÷ distance to stop.",
        "Only take trades where the target is meaningfully further than the stop.",
        "Judge a strategy by its expectancy over many trades, not by the last one.",
      ],
    },

    "Fundamental & Research": {
      summary: "Judging what an asset is worth — project quality, research process and regulatory risk.",
      intro: "Fundamental analysis asks whether an asset deserves its price, regardless of what the chart is doing. For crypto that means the team, product, token design and regulation; for stocks it means earnings and the business itself.",
      why: "Charts tell you when; fundamentals tell you what. Strong fundamentals plus a good chart is the best combination for longer holds.",
      sections: [
        {
          title: "The research process",
          note: "Start with the general method, then apply it to individual projects and altcoins.",
          ids: ["fundamental-analysis", "project-fundamentals", "alt-research"],
        },
        {
          title: "Regulation",
          note: "Rules and enforcement can change an asset's prospects overnight.",
          ids: ["regulatory-news"],
        },
      ],
      takeaways: [
        "Use fundamentals to choose what to trade and technicals to choose when.",
        "Check token unlocks and supply before buying any altcoin (see Crypto Infrastructure).",
        "Regulatory headlines are event risk — size down around them.",
      ],
    },

    "Market Participants": {
      summary: "Who's on the other side of your trade — from retail to market makers, funds and HFTs.",
      intro: "Markets are made of participants with very different goals, sizes and time horizons. Retail traders, market makers, hedge funds, asset managers and venture investors all leave different footprints on price.",
      why: "Knowing who is likely buying or selling — and why — explains flows, liquidity and why some moves look engineered.",
      sections: [
        {
          title: "Size tiers",
          note: "Participants range from small retail accounts to institutions that move markets.",
          ids: ["big-mid-small-players", "retail-traders", "institutional-investors"],
        },
        {
          title: "Liquidity and speed",
          note: "Some participants exist to provide liquidity or trade at very high speed; they profit from spreads and order flow.",
          ids: ["market-maker", "liquidity-providers", "high-frequency-traders"],
        },
        {
          title: "Professional money",
          note: "Funds and managers allocate capital with mandates, benchmarks and hedging needs.",
          ids: ["hedge-funds", "asset-manager", "portfolio-manager", "venture-capitalist", "gold-hedger"],
        },
      ],
      takeaways: [
        "Big players need liquidity — expect them to buy into selling and sell into buying.",
        "VC-backed tokens face selling pressure when early investors unlock.",
        "Market makers profit from spreads, not direction; thin books are where they step back.",
      ],
    },

    "Professional & Compliance": {
      summary: "What counts as financial advice, what \"NFA\" means, and the path to becoming an advisor.",
      intro: "Sharing market views is not the same as giving regulated financial advice. This topic explains the line between the two, the common \"not financial advice\" disclaimer, and what it takes to advise clients professionally.",
      why: "Anyone publishing market commentary — including this dashboard's reporter workflow — needs to know where commentary ends and advice begins.",
      sections: [
        {
          title: "Advice versus commentary",
          note: "Personalised recommendations are regulated; general analysis usually isn't, but a disclaimer doesn't change what you actually said.",
          ids: ["financial-advice", "nfa", "becoming-financial-advisor"],
        },
      ],
      takeaways: [
        "Keep public posts to analysis and education, not personal instructions.",
        "A disclaimer helps, but it doesn't turn a recommendation into commentary.",
        "Advising clients professionally requires licensing in most countries.",
      ],
    },

    "On-Chain & Network": {
      summary: "Blockchain data — addresses, fees, exchange flows and whale moves — that shows real usage and holder behaviour.",
      intro: "Public blockchains let anyone see coins moving. On-chain metrics turn that into signals: how many people use the network, whether coins are flowing onto exchanges to be sold or off them to be held, and whether holders are selling at a profit or a loss.",
      why: "On-chain data shows what holders are doing, not what they're saying — a useful check on price and sentiment.",
      sections: [
        {
          title: "Start here",
          note: "An overview of what on-chain data is and how it differs from price data.",
          ids: ["on-chain-metrics"],
        },
        {
          title: "Network health and usage",
          note: "Activity, security and demand for block space show whether the network is growing.",
          ids: ["active-addresses", "hash-rate", "mempool", "total-value-locked"],
        },
        {
          title: "Exchange flows and big holders",
          note: "Coins moving to exchanges are usually about to be sold; coins leaving are usually being held. Stablecoin inflows are dry powder.",
          ids: ["exchange-netflow", "exchange-reserves", "stablecoin-netflow", "whale-transactions"],
        },
        {
          title: "Holder profitability",
          note: "Whether coins are being sold at a profit or loss shows capitulation and euphoria.",
          ids: ["sopr"],
        },
      ],
      takeaways: [
        "Falling exchange reserves plus rising stablecoin supply is a constructive backdrop.",
        "A big exchange inflow from a whale is a warning, not a guarantee of selling.",
        "SOPR dipping below 1 in an uptrend often marks a reset rather than a top.",
      ],
    },

    "Crypto Infrastructure": {
      summary: "How crypto projects are built and valued — DeFi, layer 2s, staking, tokenomics and unlocks.",
      intro: "Crypto assets are tied to networks and applications. This topic covers the building blocks (DeFi, layer 2s, staking), what makes the systems valuable (censorship resistance), and how token supply design affects price.",
      why: "Supply matters as much as demand: a great project with heavy upcoming unlocks can still trend down.",
      sections: [
        {
          title: "The building blocks",
          note: "What the systems do and why decentralisation matters.",
          ids: ["censorship-resistance", "defi", "layer-2", "staking"],
        },
        {
          title: "Token supply and valuation",
          note: "Market cap shows today's value; FDV shows what it would be with every token issued. Unlocks bridge the two.",
          ids: ["tokenomics", "fdv", "token-unlocks"],
        },
      ],
      takeaways: [
        "Compare market cap to FDV — a big gap means future supply is coming.",
        "Check the unlock schedule before buying; large unlocks often see selling into them.",
        "Staking yield paid in new tokens is dilution unless demand grows too.",
      ],
    },

    "Cycle & Valuation": {
      summary: "Long-term Bitcoin valuation models and the halving cycle used to spot tops and bottoms.",
      intro: "Bitcoin has moved in roughly four-year cycles tied to its halvings. Valuation metrics compare today's price with what holders paid (realized price), long-term averages and miner revenue to judge whether the market is cheap or overheated.",
      why: "These metrics are for big-picture positioning — they've historically flagged cycle extremes far better than short-term indicators.",
      sections: [
        {
          title: "The halving cycle",
          note: "Every ~4 years new supply is cut in half, which has historically framed the cycle's rhythm.",
          ids: ["bitcoin-halving", "halvenings", "stock-to-flow"],
        },
        {
          title: "Cost-basis models",
          note: "Comparing market price with the average price holders paid shows how much unrealised profit or loss is in the market.",
          ids: ["realized-price", "mvrv", "nupl"],
        },
        {
          title: "Moving-average and miner models",
          note: "Long averages and miner revenue extremes flag overheated tops and deep-value bottoms.",
          ids: ["200-week-ma", "mayer-multiple", "pi-cycle-top", "puell-multiple"],
        },
      ],
      takeaways: [
        "Use cycle metrics for scaling in and out over months, not for day trades.",
        "Several metrics at extremes together is far stronger than any one alone.",
        "Models fit past cycles — each cycle has been less extreme, so don't expect exact repeats.",
      ],
    },

    "Market Cap & Dominance": {
      summary: "How big assets are, how money rotates between Bitcoin and altcoins, and index benchmarks.",
      intro: "Market cap measures an asset's size; dominance measures its share of the whole crypto market. Watching how dominance shifts shows money rotating from Bitcoin to large caps to smaller altcoins and back.",
      why: "Rotation decides whether altcoins outperform or bleed against Bitcoin — the most important call for anyone trading alts.",
      sections: [
        {
          title: "Start here: size and value",
          note: "The basics of what an asset is and how market cap is measured.",
          ids: ["asset", "market-value", "market-caps"],
        },
        {
          title: "Dominance and rotation",
          note: "Money tends to flow into Bitcoin first, then large caps, then smaller alts. Dominance and the alt season index track that rotation.",
          ids: ["btc-dominance", "btc-dominance-cycle", "altcoin-season-index", "money-flow-between-assets"],
        },
        {
          title: "Benchmarks and indices",
          note: "Indices give a single number for broad market performance.",
          ids: ["cmc-indices", "bitcoin-liquid-index"],
        },
      ],
      takeaways: [
        "Rising BTC dominance in a rally means Bitcoin is leading — alts usually lag.",
        "Falling dominance while BTC holds firm is the classic alt season setup.",
        "Benchmark your alt trades against BTC, not just the dollar.",
      ],
    },

    "Volatility & Sentiment": {
      summary: "How much the market is moving and how the crowd feels about it — fear, greed and social mood.",
      intro: "Volatility measures how big price swings are; sentiment measures the crowd's mood. Both tend to go to extremes at turning points: panic and spiking volatility near bottoms, euphoria and complacency near tops.",
      why: "Sentiment works best as a contrarian check — when everyone is on one side, the risk is on that side.",
      sections: [
        {
          title: "Volatility",
          note: "Standard deviation is the maths behind most volatility measures; the VIX and realised crypto volatility apply it to markets.",
          ids: ["standard-deviation", "vix", "crvol"],
        },
        {
          title: "Sentiment",
          note: "Indexes and social data summarise the crowd's mood — most useful at extremes.",
          ids: ["fear-greed", "sentiment-analysis", "social-media-sentiment", "twitter-crypto-sentiment"],
        },
      ],
      takeaways: [
        "Extreme fear is often a better time to buy than extreme greed.",
        "Low volatility doesn't last — compression usually precedes expansion.",
        "Treat sentiment as context, not a trigger: extremes can last longer than expected.",
      ],
    },

    "ETF Flows": {
      summary: "Daily money moving into and out of spot crypto ETFs — a direct read on institutional demand.",
      intro: "Spot Bitcoin and Ether ETFs hold the actual coins, so every dollar of net inflow means the fund has to buy. Daily flow data is one of the clearest windows into traditional-finance demand for crypto.",
      why: "Persistent inflows soak up supply; persistent outflows add to it. Flows often lead or confirm larger trend moves.",
      sections: [
        {
          title: "Reading the flows",
          note: "Look at the streak and the size of flows, not just one day.",
          ids: ["etf-flows"],
        },
      ],
      takeaways: [
        "Multi-day inflow streaks are more meaningful than any single day.",
        "Compare flows with price: inflows on a down day show dip-buying demand.",
        "Flows are reported after the close, so they confirm rather than predict intraday moves.",
      ],
    },

    "Real World Assets": {
      summary: "Tokenised versions of traditional assets — treasuries, credit, commodities — and where they live on-chain.",
      intro: "Real world assets (RWAs) are traditional assets like government bonds, private credit or gold issued as tokens on a blockchain. Value-locked data shows which protocols and chains are capturing that business.",
      why: "RWAs connect crypto to traditional yield and are one of the clearest areas of institutional adoption.",
      sections: [
        {
          title: "What RWAs are and where they're growing",
          note: "Start with the concept, then compare protocols and chains by value locked.",
          ids: ["real-world-asset", "rwa-protocol-tvl", "rwa-chain-tvl"],
        },
      ],
      takeaways: [
        "Growing RWA value on a chain is a sign of institutional use there.",
        "Tokenised treasuries track interest rates — RWA yields move with the Fed.",
        "Check who holds the underlying asset; RWAs carry issuer risk on top of smart-contract risk.",
      ],
    },

    "Macro & Global Liquidity": {
      summary: "Money supply, liquidity cycles, carry trades and data releases that set the tide for risk assets.",
      intro: "When central banks and governments add money to the system, it tends to flow into risk assets; when they drain it, risk assets struggle. This topic covers measuring that liquidity, how it rotates, and the releases and trades that can shift it quickly.",
      why: "Crypto and growth stocks are highly sensitive to liquidity — it's the tide that lifts or sinks most boats.",
      sections: [
        {
          title: "Measuring liquidity",
          note: "Money supply and global liquidity show how much cash is available to chase assets.",
          ids: ["global-liquidity", "m2-money-supply", "liquidity-rotation"],
        },
        {
          title: "Shocks and regimes",
          note: "Data releases, funding trades and policy can change the liquidity picture suddenly.",
          ids: ["non-farm-payrolls", "stagflation", "yen-carry-trade", "strategic-reserve"],
        },
        {
          title: "Timing: global sessions",
          note: "Liquidity also changes through the day as Asian, London and New York sessions open and close.",
          ids: ["major-forex-sessions"],
        },
      ],
      takeaways: [
        "Rising global liquidity is a tailwind for crypto; falling liquidity is a headwind.",
        "A carry-trade unwind can hit every risk asset at once — watch the yen.",
        "Big data releases are event risk; the reaction matters more than the number.",
      ],
    },

    "Indices & Assets": {
      summary: "Stock indices, ETFs and sector baskets used to track broad markets and regions.",
      intro: "An index tracks a basket of assets with one number — the S&P 500 for large US companies, the TSX for Canada, and so on. ETFs let you trade those baskets directly.",
      why: "Indices tell you what the broad market is doing, which is the backdrop for every individual stock or crypto trade.",
      sections: [
        {
          title: "What indices are",
          note: "Start with what an index is, then the major ones.",
          ids: ["indices", "financial-indices", "different-indices", "equities"],
        },
        {
          title: "Regions and sectors",
          note: "Regional indices and sector baskets show where money is going around the world.",
          ids: ["tsx-composite", "japan-etf", "gas-stocks"],
        },
      ],
      takeaways: [
        "Check the main index before trading any single stock — most stocks follow it.",
        "Crypto often moves with the Nasdaq during risk-on and risk-off swings.",
        "Sector ETFs show rotation that a headline index can hide.",
      ],
    },

    "Traditional Markets": {
      summary: "The dollar, Treasury yields, equity valuation and breadth — the TradFi signals crypto reacts to.",
      intro: "Crypto doesn't trade in a vacuum. A strong dollar and rising yields tighten financial conditions; healthy stock breadth and reasonable valuations support risk appetite. This topic covers the traditional-market gauges worth watching.",
      why: "Many big crypto moves start with a move in the dollar or yields.",
      sections: [
        {
          title: "Dollar and rates",
          note: "The dollar index and 10-year yield set the cost of money worldwide.",
          ids: ["dxy", "us10y"],
        },
        {
          title: "Equity health and valuation",
          note: "Breadth shows how many stocks join a move; P/E and short interest show valuation and positioning.",
          ids: ["market-breadth", "pe-ratio", "short-interest", "ipo", "oil-stocks"],
        },
      ],
      takeaways: [
        "A rising DXY and rising yields together are usually bad for crypto.",
        "Narrow breadth (few stocks leading) makes a rally fragile.",
        "High short interest plus good news is squeeze fuel — in stocks as in crypto.",
      ],
    },

    "Macro Economics": {
      summary: "Inflation, growth, jobs and the Fed — the economic data that drives interest-rate expectations.",
      intro: "Central banks set interest rates based on inflation and the job market. Economic releases change expectations for those rates, and rate expectations drive the dollar, yields and risk assets.",
      why: "Knowing the calendar and what each release means stops you being blindsided by a CPI or FOMC day.",
      sections: [
        {
          title: "Inflation",
          note: "CPI and PCE measure rising prices — the Fed's main concern when inflation is high.",
          ids: ["cpi", "pce"],
        },
        {
          title: "Growth and jobs",
          note: "GDP, PMI and unemployment show whether the economy is expanding or slowing.",
          ids: ["gdp", "pmi", "unemployment"],
        },
        {
          title: "Policy and recession signals",
          note: "The Fed's rate and balance-sheet decisions, and the warning signs of recession.",
          ids: ["fomc", "qe-qt", "yield-curve-inversion", "nber-recession"],
        },
      ],
      takeaways: [
        "Hotter-than-expected inflation usually means higher rates for longer — a risk-asset headwind.",
        "The surprise versus expectations moves markets, not the number itself.",
        "Reduce size into FOMC and CPI releases unless you're trading the event on purpose.",
      ],
    },

    "Commodities": {
      summary: "Raw-material markets and the COT report that shows how big players are positioned in them.",
      intro: "Commodities like oil, gold and grains trade mostly through futures. The weekly Commitments of Traders report shows how commercial hedgers and speculators are positioned.",
      why: "Commodity prices feed into inflation, and extreme speculator positioning often marks turning points.",
      sections: [
        {
          title: "Markets and positioning",
          note: "Start with how commodity markets work, then read positioning through the COT report.",
          ids: ["commodity-markets", "cot-report"],
        },
      ],
      takeaways: [
        "Oil spikes feed inflation and can change rate expectations.",
        "Extreme speculator positioning in the COT report is a contrarian warning.",
        "Gold often rises on falling real yields and geopolitical stress.",
      ],
    },

    "Trading Tools & Workflows": {
      summary: "Charting tools, alerts, bots, data APIs and shortcuts that make up a practical trading setup.",
      intro: "A trading process runs on tools: charts to analyse, alerts so you don't have to watch all day, data sources and bots to automate, and shortcuts to capture news and ideas quickly.",
      why: "Good tooling saves screen time and enforces discipline — alerts and automation stop you chasing the chart.",
      sections: [
        {
          title: "Charts and visual tools",
          note: "The main charting environment and heatmaps for scanning many assets at once.",
          ids: ["supercharts", "xy-heat-map"],
        },
        {
          title: "System design and alerts",
          note: "Split your setup into layers and let alerts watch levels for you.",
          ids: ["trading-system-layers", "add-to-alerts"],
        },
        {
          title: "Automation and data",
          note: "APIs, bots and AI tools to pull data and act on it.",
          ids: ["realtime-data-sources-apis", "bot-father-api", "free-crypto-bots", "ai-with-crypto"],
        },
        {
          title: "News capture and references",
          note: "Shortcuts and saved links for collecting news and ideas.",
          ids: ["current-news", "new-shortcut-news", "shortcut-idea", "links", "website-ideas"],
        },
      ],
      takeaways: [
        "Set alerts at your levels instead of watching the chart.",
        "Automate data collection, not decisions — keep a human on approvals.",
        "Keep tools organised by layer: data, analysis, execution, review.",
      ],
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = TOPICS;
  if (typeof window !== "undefined") window.MarketGlossaryTopics = TOPICS;
})();
