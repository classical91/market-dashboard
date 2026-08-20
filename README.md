# Market Dashboard

Market Dashboard is a Node.js/Express market intelligence workspace. It serves static dashboard pages from `public/` and exposes API routes under `/api/*` for overview data, on-chain analytics, YouTube channel intelligence, Telegram/reporting workflows, and health checks.

The app is intentionally lightweight: no bundler, no frontend framework, and no TypeScript migration yet. Frontend behavior is vanilla JavaScript with shared UI helpers and CSS primitives.

## Tech Stack

- Runtime: Node.js 18+
- Server: Express 4
- Config: dotenv
- Frontend: HTML, CSS, vanilla JavaScript
- Deployment: Railway via `railway.toml`
- CI: GitHub Actions with `npm run lint`, `npm run build`, and `npm test`

## Main Surfaces

- `/` - Market Command overview dashboard: live ticker, KPIs, chart, heatmap, watchlist, alerts, calendar, and news, plus TradingView market overview, technical analysis, and heatmap widgets.
- `/crypto.html` - Crypto research and market links.
- `/market-intel.html` - Cross-asset and macro research links.
- `/traditional.html` - Traditional market research links.
- `/on-chain.html` - Curated on-chain tools hub.
- `/onchain.html` - API-backed on-chain analytics dashboard.
- `/ai-analysis.html` - TradingView chart snapshots with AI reads for crypto plus BTC-correlated macro tickers.
- `/decision.html` - Decision Engine: multi-asset regime score (BTC, breadth, SPY, QQQ, DXY, VIX, gold, oil, optional US10Y), asset-class rotation board, setup-quality ranking layered over the signal screener, execution levels (trigger / invalidation / target / R:R with explicit "do not trade" reasons), and a trading journal that grades whether the engine's calls were right.
- `/trading-lab.html` - Trading Lab: paper execution with real TP1/TP2 scale-outs, ATR risk sizing, kill switches, a historical edge gate that scores every Decision Engine plan against how setups like it have actually performed, and bar-replay backtesting over the same engine. See [docs/trading-lab.md](docs/trading-lab.md).
- `/youtube-v2.html` - YouTube Intelligence: live streams, scheduled streams, and latest uploads from tracked channels.
- `/indicators.html` - Trading and market glossary.
- `/reporter.html` - Daily report generation workflow.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

For production-style local start:

```bash
npm start
```

## Validation

```bash
npm run lint
npm run build
npm test
```

`npm run lint` checks JavaScript syntax across source, scripts, and public assets. `npm run build` boots the Express app and verifies static HTML asset references and required docs. `npm test` runs the `node:test` API suite covering the admin guard, public probes, and the Trading Lab engines.

```bash
npm run parity -- --traderclaw ../traderclaw
```

`npm run parity` runs identical inputs through the ported JavaScript engines and the original TraderClaw Python ones and fails on any disagreeing field — covering summary and grouped metrics, edge-gate verdicts, checklist verdicts, sizing/levels, and full paper-trade lifecycles down to each individual exit. It needs a TraderClaw checkout and a `python3` (with `python-dotenv` and `requests` for the modules that import `config.py`); without them it reports that it skipped and exits 0. This is the check that gates archiving TraderClaw — see [docs/trading-lab.md](docs/trading-lab.md).

## Access Control

Website access is optional but recommended for deploys. Set `MARKET_DASHBOARD_LOGIN_PASSWORD` to put the dashboard behind `/login`. That owner password unlocks the full website. Set `ALPHA_TEAM_ACCESS_CODE` to give the Alpha Team a separate read-only password for shared `?view=alpha` pages; that role can open the shared Signal Screener and Pattern Scanner review pages plus their read-only data APIs, but it cannot reach the rest of the dashboard or any mutation/broadcast endpoint. When both website passwords are blank, local/dev behavior stays open.

Action/mutation endpoints are guarded by a shared secret so a public deploy cannot let anonymous visitors spend API credits or send Telegram messages. Set `ADMIN_API_KEY` on the server to enable them; while it is blank these endpoints return `503`:

- `POST /api/daily-report/generate`, `POST /api/daily-report/logs/import`
- `POST /api/ai-analysis/generate`, `POST /api/ai-analysis/broadcast`
- `POST /api/telegram/test`, `GET /api/telegram/diagnose`
- `POST/PATCH/DELETE /api/decision/journal` (trading-journal writes; reads stay public)

Guarded requests must carry an `x-admin-key` header matching `ADMIN_API_KEY`. The Reporter, AI Analysis, and Settings pages prompt for the key on first use and store it in the browser's `localStorage`. `ADMIN_API_KEY` is separate from the website login: owner login controls browsing, while the admin key controls write/broadcast actions. The public `/api/health` probe returns only `{ "status": "ok" }`; provider-key and cache detail are returned only to admin requests.

## Environment Variables

Most keys are optional. The app is designed to degrade to fallback data where possible.

### Core

- `PORT` - local/server port, defaults to `3000`.
- `DATA_DIR` - persistent file directory for reporter logs/caches and X feed cache. On Railway, set this to the mounted volume path, usually `/app/data`.
- `MARKET_DASHBOARD_LOGIN_PASSWORD` - optional owner website password. When set, unauthenticated visitors are redirected to `/login`.
- `ADMIN_API_KEY` - shared secret enabling action/mutation endpoints (see [Access Control](#access-control)). Blank means those endpoints are disabled (`503`).
- `OPENAI_API_KEY` - enables report generation.
- `REPORTER_MODEL` - OpenAI model for reporter generation, defaults to `gpt-5.4-mini`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` - enable Telegram delivery.
- `MARKET_DASHBOARD_URL` - public base URL used for Alpha Team `Visit:` links.
- `ALPHA_TEAM_ACCESS_CODE` - optional read-only password for Alpha Team shared pages opened with `?view=alpha`.

### Market Overview

- `OVERVIEW_CACHE_MS` - overview cache TTL.
- `MARKET_DATA_PROVIDER` - defaults to `coingecko`.
- `MARKET_DATA_BASE_URL`, `MARKET_DATA_TIMEOUT_MS`, `MARKET_DATA_RETRIES`.
- `COINGECKO_DEMO_API_KEY`, `COINGECKO_API_KEY`, `COINGECKO_KEY_HEADER` - optional CoinGecko auth.
- `FINNHUB_API_KEY`, `FINNHUB_BASE_URL` - live equity quotes (also powers the macro/FX board by default).
- `MARKET_NEWS_URL` - optional JSON news feed.
- `MACRO_DATA_URL` - optional JSON macro feed (`{symbol, name, price, changePercent}` rows); takes priority over Finnhub for the macro board.
- `MACRO_SYMBOLS` - `DISPLAY=PROVIDER_SYMBOL` pairs for the Finnhub macro adapter; defaults to free-tier ETF proxies (`XAU=GLD,DXY=UUP,WTI=USO,VIX=VIXY`).
- `MACRO_DATA_PROVIDER` - set to `none` to force static macro fallback.
- `MACRO_CALENDAR_URL` - optional JSON macro-calendar feed (`{time, title, impact, country}` rows).
- `DECISION_CACHE_MS` - Decision Engine payload cache TTL, defaults to `120000`. The engine reuses the feeds above; adding a `US10Y` row via `MACRO_SYMBOLS` or `MACRO_DATA_URL` enriches its regime score and rotation board with live yields.

### Signal Bot Telegram Alerts

Signal Bot Telegram messages are formatted for Jason's Alpha Team group. They are intentionally high-signal ops updates: each signal includes tier, symbol/timeframe, pattern label, bias, trend regime, indicator evidence, Trading Lab verdict, concise risk framing, and a `Visit:` link when `MARKET_DASHBOARD_URL` is configured. Pattern Scanner alerts use the same style for breakouts and fresh divergences, linking only to available dashboard pages. Shared links open in Alpha review mode (`?view=alpha`), where the requested page renders without the dashboard sidebar/tabs. When `ALPHA_TEAM_ACCESS_CODE` is configured, the shared page can be opened with the Alpha Team read-only password. Messages must stay free of secrets, private account details, account-mode wording, internal dry-run wording, and financial-advice framing. Unfinished setup sources should appear as blurred `BETA` modules inside the dashboard, not as direct group links.

### Live Scanner

Generates its own BTC signals from Bitget USDT-perpetual candles instead of waiting on TradingView alert webhooks. Closed candles only, paper trades only, one open position per symbol, and one entry per symbol + direction + candle close time (persisted across restarts). Status is exposed at `GET /api/live-scanner/status` and rendered on `/trading-lab.html`.

- `ENABLE_LIVE_SCANNER` - off unless set to exactly `true`.
- `LIVE_SCANNER_SYMBOL` - defaults to `BTCUSDT.P`; the `.P` suffix maps to Bitget's `BTCUSDT` contract on `USDT-FUTURES` and is kept as the ledger symbol.
- `LIVE_SCANNER_TIMEFRAME` - `1m`, `3m`, `5m`, `15m` (default), `30m`, `1h`, `4h`, `6h`, `12h`, `1d`.
- `LIVE_SCANNER_STRATEGY` - defaults to `mindset_v1` (EMA20/50 trend with an RSI band filter). Validated against the strategy registry at startup: an unknown, backtest-only or otherwise scanner-ineligible id makes the scanner refuse to start with a configuration error rather than silently falling back. Backtest-only strategies such as `smc_v1` are not selectable here. Scanner eligibility means *paper* execution on live candles — it is not real-money approval, and nothing in this repo is real-money eligible.

The **backtester** takes a strategy from its own registry (`GET /api/trading-lab/strategies`) and can compare strategies side by side over one candle fetch (`POST /api/trading-lab/backtest/compare`). Each registry entry carries research lifecycle metadata (`status`, `supportsLiveScanner`) plus two **computed** eligibilities that are deliberately not the same thing: `scannerEligible` (the live scanner may run it forward against a *paper* ledger — true for `mindset_v1`) and `realMoneyEligible` (validation complete enough that real-money execution could later be approved — **false for everything**). A backtest can be recorded as an **experiment** (`record: true`) that is readable at `GET /api/trading-lab/experiments`. See [docs/trading-lab.md](docs/trading-lab.md#strategies).

Mindset research keeps the forward-paper v1 benchmark frozen and exposes `mindset_v1_1` as an isolated experimental A–F ablation strategy. Run chronological, cost-stressed research over supplied candle datasets with `npm run research:mindset -- path/to/datasets.json`; see [the audit and preliminary report](docs/mindset-v1-research.md).
- `LIVE_SCANNER_INTERVAL_MS` - poll cadence, defaults to `60000`.
- `LIVE_SCANNER_CONTEXT_INTERVAL` - higher timeframe feeding the checklist's regime/daily-bias buckets, defaults to `4h`.
- `LIVE_SCANNER_BOOK` - Trading Lab book scanner trades land in, defaults to `main`.
- `LIVE_SCANNER_PAPER_TRADE_ENABLED` - defaults to `true` once the scanner is enabled; set `false` for an observe-only run that scores and logs signals but opens nothing.

### Live Strategy Research Accounts

Trading Lab continuously evaluates every candle-compatible registered strategy against newly closed candles and writes simulated results only to that strategy's isolated `$10,000` demo ledger. This runner is an evidence-collection capability, not a lifecycle promotion: a strategy can remain `backtest` while its live demo runner says `RUNNING`. It never changes `scannerEligible`, `forward-paper`, or `realMoneyEligible`, never routes through an exchange adapter, and never mutates historical backtest ledgers. BananaGun stays event-replay only until live point-in-time candidate and safety snapshots exist.

- `LIVE_RESEARCH_ENABLED` - defaults to `true`; set `false` to pause all live demo research runners.
- `LIVE_RESEARCH_SYMBOL` - defaults to `BTCUSDT`.
- `LIVE_RESEARCH_TIMEFRAME` - defaults to `1h`.
- `LIVE_RESEARCH_INTERVAL_MS` - polling cadence, defaults to `60000`. Only newly closed candles are evaluated and the last processed close is persisted across restarts.

Strategy-account GETs are observational: they read the runner's last persisted mark and cannot trigger SL/TP or change P&L. The runner force-refreshes raw klines before accepting a new finalized close. After downtime it replays missed bars only to manage an existing position, evaluates entries only on the newest finalized bar, and uses the same SL/TP exit contract as the backtester. Position records carry an execution owner, so Signal Bot and Live Scanner cannot mark live-research trades. Startup also refuses a paper-trading Live Scanner and Live Research claiming the same strategy account; disable one writer rather than combining two experiments in one wallet.

### On-Chain

- `DEFILLAMA_API_BASE_URL`, `DEFILLAMA_COINS_API_BASE_URL`, `DEFILLAMA_CHAIN`, `DEFILLAMA_COIN_CHAIN`.
- `ETHERSCAN_API_KEY`, `ETHERSCAN_KEY`, `ETHERSCAN_API_BASE_URL`, `ETHERSCAN_CHAIN_ID`.
- `COVALENT_API_KEY`, `COVALENT_KEY`, `COVALENT_API_BASE_URL`, `COVALENT_CHAIN_NAME`.
- `ONCHAIN_TRACKED_TOKENS`, `ONCHAIN_IGNORED_ADDRESSES`.
- `ONCHAIN_MODE` - `cheap` (default), `normal`, or `deep`; presets Covalent page counts/sizes, lookback, and cache TTL so overview refreshes don't burn credits. Individual `ONCHAIN_*` vars override the preset.
- `ONCHAIN_COOLDOWN_CACHE_MS` - how long to serve the cached overview while Covalent cools down after a 402/429. During that window tracked-token flows fall back to Etherscan when `ETHERSCAN_API_KEY` is set.
- `ONCHAIN_*` tuning values for lookbacks, page sizes, row counts, thresholds, and cache TTLs.

### YouTube Intelligence

`/youtube-v2.html` runs on a hybrid of the YouTube Data API v3 and YouTube's public RSS feeds. Per channel the service tries the API first (uploads plus live/upcoming state), falls back to RSS (uploads only, no key, but it needs a known `UC...` channel ID), and finally serves the last known good feed rather than blanking the page. It never scrapes `youtube.com/@handle` HTML — doing that is what used to break the page on Railway, where YouTube answers datacenter IPs with a consent interstitial instead of the channel document.

- `YOUTUBE_API_KEY` - YouTube Data API v3 key, from Google Cloud Console (enable **YouTube Data API v3**, then Credentials → API key; restrict it to that one API). **Server-side only** — it is never sent to the browser and is redacted from logs. Blank means uploads-only, with no live/upcoming detection.
- `YOUTUBE_CHANNEL_IDS` - optional handle → channel ID overrides, as JSON (`{"stockmoe":"UC..."}`) or `handle=UC...,handle=UC...`. Setting these saves an API call per handle and is what lets the RSS fallback work on a deploy with no key at all. Channel IDs can also be committed into `src/config/youtube-channels.js`.
- `YOUTUBE_MAX_VIDEOS_PER_CHANNEL`, `YOUTUBE_REQUEST_TIMEOUT_MS`.
- `YOUTUBE_CHANNEL_ID_CACHE_MS`, `YOUTUBE_CHANNEL_META_CACHE_MS`, `YOUTUBE_UPLOADS_CACHE_MS`, `YOUTUBE_LIVE_CACHE_MS` - server-side cache TTLs. These are what keep a refreshing dashboard off the API.
- `YOUTUBE_QUOTA_COOLDOWN_MS` - how long to stop calling the API after it reports the daily quota is gone, so an exhausted key isn't re-hit on every refresh.
- `YOUTUBE_LIVE_SEARCH_ENABLED`, `YOUTUBE_LIVE_SEARCH_CACHE_MS` - opt-in live discovery through `search.list`. Off by default and best left off (see quota below).

**Quota.** The default YouTube Data API quota is 10,000 units/day. The request path uses only cheap endpoints: `channels.list` (1 unit, cached 24h), `playlistItems.list` (1 unit per channel, cached 10min), and a single batched `videos.list` (1 unit per 50 videos, cached 2min). Four channels therefore cost roughly 5 units per refresh cycle — a few thousand units a day even under constant refreshing. `search.list` costs **100 units per call** and is never used on the request path; enabling `YOUTUBE_LIVE_SEARCH_ENABLED` for four channels on a 30-minute TTL would cost ~19,000 units/day, so only turn it on with a raised quota.

To resolve the configured handles to permanent channel IDs once:

```bash
YOUTUBE_API_KEY=... node scripts/resolve-youtube-channels.js
```

It prints both a `src/config/youtube-channels.js` snippet and a ready-to-paste `YOUTUBE_CHANNEL_IDS` value.

See `.env.example` for the full list.

### Railway Deployment

Railway reads `railway.toml` (start command, `/api/health` healthcheck) and takes every value above from the service's **Variables** tab — there is no `.env` file in the deployed image. For YouTube Intelligence, set `YOUTUBE_API_KEY` there; optionally add `YOUTUBE_CHANNEL_IDS` so the RSS fallback keeps working if the key is ever removed or exhausted. Railway restarts the service on a variable change, which also clears the in-memory caches. `DATA_DIR` should point at the mounted volume (usually `/app/data`) so resolved channel IDs survive restarts.

## Project Structure

```text
market-dashboard/
  public/
    *.html
    assets/
      js/
        sidebar.js        shared navigation
        sections.js       collapsible section behavior
        ui.js             reusable UI HTML helpers
        overview.js       main dashboard renderer
      styles/
        components.css    reusable UI primitives
        overview.css      main dashboard layout
        command.css       command-page shell
  src/
    app.js                Express app composition
    config/env.js         environment parsing
    routes/               API routers
    services/             provider clients and aggregation
      trading/            Trading Lab engines (ported from TraderClaw)
        config.js         risk policy, kill-switch thresholds, live-mode gates
        round.js          Python-compatible half-to-even rounding
        metrics.js        expectancy, profit factor, drawdown, R-multiples
        edge-gate.js      historical edge gate over closed-trade history
        checklist.js      kill switches and 0-100 setup scoring
        risk.js           ATR position sizing and stop/target levels
        paper-trader.js   paper execution with TP1/TP2 scale-outs
        backtest.js       bar replay over the paper-trading engine
        trading-lab.js    composition + Decision Engine bridge
        signal-bridge.js  Signal Bot transitions -> paper trades
        live-scanner.js   native Bitget candle feed + strategy loop
        trade-intent.js   raw strategy intent, with risk fields refused
        intent-handler.js one boundary: gated entries, ungated exits
    utils/                validators, errors, mappers
  docs/
    trading-lab.md        migration map and remaining work
  scripts/
    lint.js
    build-check.js
    traderclaw-parity.js  JS vs Python engine comparison
  .github/workflows/ci.yml
  AGENTS.md
```

## UI System Notes

- Shared navigation is generated by `public/assets/js/sidebar.js`.
- Shared loading, empty, error, badge, and skeleton helpers live in `public/assets/js/ui.js`.
- Shared visual primitives live in `public/assets/styles/components.css`.
- Keep pages dashboard-focused: dense, readable, dark-mode friendly, and responsive.

## API Fallback Behavior

- `/api/overview` still returns fallback data when market providers are missing or rate-limited.
- On-chain overview degrades when Covalent is unavailable.
- Wallet/token detail endpoints require valid provider keys and should return clear service errors when unavailable.
- YouTube Intelligence prefers the YouTube Data API, falls back to RSS when the key is missing, rejected or out of quota, and serves the last known good feed when both are down. Live/upcoming detection needs the API key; without one the page shows uploads and says so.

## Roadmap

- Expand the automated test suite (the admin guard and public probes are covered; service-level coverage is still pending).
- Add a formatter once the repo is ready for broader mechanical changes.
- Extract more repeated card/link HTML into data-driven renderers.
- Add visual regression checks for core pages.
- Consider a TypeScript migration only after agreeing on a build pipeline and module boundary.
