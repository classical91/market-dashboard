# Market Dashboard

Market Dashboard is a Node.js/Express market intelligence workspace. It serves static dashboard pages from `public/` and exposes API routes under `/api/*` for overview data, on-chain analytics, YouTube RSS feeds, Telegram/reporting workflows, and health checks.

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
- `/youtube-v2.html` - YouTube Intelligence RSS upload dashboard.
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

`npm run lint` checks JavaScript syntax across source, scripts, and public assets. `npm run build` boots the Express app and verifies static HTML asset references and required docs. `npm test` runs the `node:test` API suite covering the admin guard and public probes.

## Access Control

Action/mutation endpoints are guarded by a shared secret so a public deploy cannot let anonymous visitors spend API credits or send Telegram messages. Set `ADMIN_API_KEY` on the server to enable them; while it is blank these endpoints return `503`:

- `POST /api/daily-report/generate`, `POST /api/daily-report/logs/import`
- `POST /api/ai-analysis/generate`, `POST /api/ai-analysis/broadcast`
- `POST /api/telegram/test`, `GET /api/telegram/diagnose`

Guarded requests must carry an `x-admin-key` header matching `ADMIN_API_KEY`. The Reporter, AI Analysis, and Settings pages prompt for the key on first use and store it in the browser's `localStorage`. Read-only views (overview, on-chain, YouTube, `/api/telegram/status`) stay public. The public `/api/health` probe returns only `{ "status": "ok" }`; provider-key and cache detail are returned only to admin requests.

## Environment Variables

Most keys are optional. The app is designed to degrade to fallback data where possible.

### Core

- `PORT` - local/server port, defaults to `3000`.
- `DATA_DIR` - persistent file directory for reporter logs/caches and X feed cache. On Railway, set this to the mounted volume path, usually `/app/data`.
- `ADMIN_API_KEY` - shared secret enabling action/mutation endpoints (see [Access Control](#access-control)). Blank means those endpoints are disabled (`503`).
- `OPENAI_API_KEY` - enables report generation.
- `REPORTER_MODEL` - OpenAI model for reporter generation, defaults to `gpt-5.4-mini`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` - enable Telegram delivery.

### Market Overview

- `OVERVIEW_CACHE_MS` - overview cache TTL.
- `MARKET_DATA_PROVIDER` - defaults to `coingecko`.
- `MARKET_DATA_BASE_URL`, `MARKET_DATA_TIMEOUT_MS`, `MARKET_DATA_RETRIES`.
- `COINGECKO_DEMO_API_KEY`, `COINGECKO_API_KEY`, `COINGECKO_KEY_HEADER` - optional CoinGecko auth.
- `FINNHUB_API_KEY`, `FINNHUB_BASE_URL` - live equity quotes.
- `MARKET_NEWS_URL` - optional JSON news feed.

### On-Chain

- `DEFILLAMA_API_BASE_URL`, `DEFILLAMA_COINS_API_BASE_URL`, `DEFILLAMA_CHAIN`, `DEFILLAMA_COIN_CHAIN`.
- `ETHERSCAN_API_KEY`, `ETHERSCAN_KEY`, `ETHERSCAN_API_BASE_URL`, `ETHERSCAN_CHAIN_ID`.
- `COVALENT_API_KEY`, `COVALENT_KEY`, `COVALENT_API_BASE_URL`, `COVALENT_CHAIN_NAME`.
- `ONCHAIN_TRACKED_TOKENS`, `ONCHAIN_IGNORED_ADDRESSES`.
- `ONCHAIN_*` tuning values for lookbacks, page sizes, row counts, thresholds, and cache TTLs.

See `.env.example` for the full list.

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
    utils/                validators, errors, mappers
  scripts/
    lint.js
    build-check.js
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
- YouTube RSS feeds resolve channel IDs and return upload lists without requiring the YouTube Data API.

## Roadmap

- Expand the automated test suite (the admin guard and public probes are covered; service-level coverage is still pending).
- Add a formatter once the repo is ready for broader mechanical changes.
- Extract more repeated card/link HTML into data-driven renderers.
- Add visual regression checks for core pages.
- Consider a TypeScript migration only after agreeing on a build pipeline and module boundary.
