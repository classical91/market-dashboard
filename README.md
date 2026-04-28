# Market Dashboard

Market Dashboard is a small full-stack Node.js/Express application that serves a collection of static market-research hub pages plus a lightweight on-chain analytics API and UI. The frontend is plain HTML/CSS/vanilla JS served from `public/`, while backend routes under `/api/*` aggregate data from DefiLlama, Etherscan, and Covalent for the on-chain dashboard.

## Project Type

**Full-stack app (server-rendered static assets + backend API).**

- **Frontend:** static HTML pages and vanilla JavaScript in `public/`
- **Backend:** Express API in `src/`
- **No bundler/build pipeline** currently configured

## Current Features (from code)

### Navigation and hub pages
- Landing page at `/` (`public/index.html`) that links to:
  - `/market-intel.html`
  - `/on-chain.html`
  - external “Decision Engine” URL
- Market intel, crypto, traditional markets, and earth-watch hub pages with curated external-resource cards.
- Collapsible sections with `localStorage` persistence via shared frontend script (`public/assets/js/sections.js`) on pages that include it.

### On-chain dashboard (UI)
- Dedicated page at `/onchain.html` with:
  - Overview cards
  - Top wallet inflows/outflows
  - Token accumulation/distribution tables
  - Large transfer feed
  - Wallet/token search detail panel
- Auto-refresh behavior (3-minute interval) implemented in `public/assets/js/onchain-dashboard.js`.

### On-chain backend API
- `GET /api/health`
  - reports service/key configuration status and cache size.
- `GET /api/onchain/overview`
  - returns stablecoin netflow + aggregated transfer analytics.
  - supports a fallback payload when Covalent is not configured.
- `GET /api/onchain/wallet/:address`
  - validates Ethereum address and returns wallet netflow + recent transfers.
- `GET /api/onchain/token/:address`
  - validates token address and returns whale buy/sell summary + whale activity.

### Backend behavior
- In-memory TTL cache with in-flight request de-duplication.
- External API retry/timeout handling for Etherscan and Covalent.
- Address normalization/validation utilities.
- Environment-driven runtime tuning for cache windows, paging, thresholds, and tracked tokens.

## Tech Stack

- **Runtime:** Node.js (>= 18)
- **Server:** Express 4
- **Config:** dotenv
- **Frontend:** HTML, CSS, vanilla JavaScript
- **Deployment file:** Railway (`railway.toml`)

## Prerequisites

- Node.js 18+
- npm

## Install

```bash
npm install
```

## Run Locally

### Development mode

```bash
npm run dev
```

Uses Node’s watch mode (`node --watch server.js`).

### Standard start

```bash
npm start
```

Starts server at `http://localhost:3000` by default (or `PORT` if set).

## Build

There is currently **no build script** (`npm run build` is not defined). The app runs directly from source.

## Production Start

Production uses the same start command:

```bash
npm start
```

Equivalent process command: `node server.js`.

## Environment Variables

Use placeholder values only (do not commit real secrets).

```bash
# Server
PORT=3000

# DefiLlama
DEFILLAMA_API_BASE_URL=https://stablecoins.llama.fi/
DEFILLAMA_COINS_API_BASE_URL=https://coins.llama.fi/
DEFILLAMA_CHAIN=Ethereum
DEFILLAMA_COIN_CHAIN=ethereum

# Etherscan
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
ETHERSCAN_KEY=YOUR_ETHERSCAN_API_KEY_ALTERNATE
ETHERSCAN_API_BASE_URL=https://api.etherscan.io
ETHERSCAN_CHAIN_ID=1
ETHERSCAN_API_REQUEST_TIMEOUT_MS=15000
ETHERSCAN_API_RETRIES=2

# Covalent
COVALENT_API_KEY=YOUR_COVALENT_API_KEY
COVALENT_KEY=YOUR_COVALENT_API_KEY_ALTERNATE
COVALENT_API_BASE_URL=https://api.covalenthq.com
COVALENT_CHAIN_NAME=eth-mainnet
COVALENT_API_REQUEST_TIMEOUT_MS=15000
COVALENT_API_RETRIES=2

# On-chain analytics tuning
ONCHAIN_TRACKED_TOKENS=[{"symbol":"USDC","name":"USD Coin","contractAddress":"0x...","decimals":6}]
ONCHAIN_IGNORED_ADDRESSES=0x...,0x...
ONCHAIN_OVERVIEW_CACHE_MS=180000
ONCHAIN_DETAIL_CACHE_MS=60000
ONCHAIN_OVERVIEW_LOOKBACK_HOURS=24
ONCHAIN_DETAIL_LOOKBACK_DAYS=7
ONCHAIN_OVERVIEW_PAGE_SIZE=100
ONCHAIN_DETAIL_PAGE_SIZE=100
ONCHAIN_OVERVIEW_PAGE_LIMIT=2
ONCHAIN_TOKEN_PAGE_LIMIT=2
ONCHAIN_MAX_LARGE_TRANSFERS=25
ONCHAIN_MAX_WALLET_ROWS=10
ONCHAIN_MAX_TOKEN_ROWS=10
ONCHAIN_MAX_DETAIL_TRANSFERS=25
ONCHAIN_LARGE_TRANSFER_THRESHOLD_USD=100000
ONCHAIN_WHALE_THRESHOLD_USD=100000
```

Notes:
- `ETHERSCAN_API_KEY` and `COVALENT_API_KEY` gate wallet/token detail endpoints.
- If Covalent is missing, `/api/onchain/overview` returns a reduced fallback payload.
- If Etherscan is missing, `/api/onchain/wallet/:address` returns a 503 service error.

## Deployment Notes

- `railway.toml` is configured with:
  - `startCommand = "node server.js"`
  - `healthcheckPath = "/api/health"`
  - restart policy on failure
- Ensure required API keys are set in deployment environment variables.

## Folder Structure

```text
market-dashboard/
├─ public/
│  ├─ index.html
│  ├─ market-intel.html
│  ├─ crypto.html
│  ├─ traditional.html
│  ├─ earthwatch.html
│  ├─ on-chain.html
│  ├─ onchain.html
│  └─ assets/
│     ├─ js/
│     │  ├─ home.js
│     │  ├─ crypto.js
│     │  ├─ on-chain.js
│     │  ├─ onchain-dashboard.js
│     │  ├─ sections.js
│     │  └─ cards.js
│     └─ styles/
│        ├─ base.css
│        ├─ home.css
│        ├─ crypto.css
│        ├─ on-chain.css
│        └─ onchain-dashboard.css
├─ src/
│  ├─ app.js
│  ├─ config/
│  │  └─ env.js
│  ├─ routes/
│  │  ├─ health.js
│  │  └─ onchain.js
│  ├─ services/
│  │  ├─ cache.js
│  │  ├─ defillama.js
│  │  ├─ etherscan.js
│  │  ├─ covalent.js
│  │  └─ onchain.js
│  └─ utils/
│     ├─ errors.js
│     ├─ mappers.js
│     └─ validators.js
├─ server.js
├─ railway.toml
├─ package.json
└─ README.md
```

## Important Files

- `server.js` — runtime entrypoint; loads dotenv and starts Express.
- `src/app.js` — app wiring (middleware, static hosting, routes, error handlers).
- `src/config/env.js` — all environment parsing/defaults.
- `src/services/onchain.js` — aggregation and payload assembly for overview/wallet/token endpoints.
- `src/services/defillama.js` / `etherscan.js` / `covalent.js` — upstream API clients with error handling.
- `src/routes/onchain.js` — on-chain API endpoints + address validation.
- `public/onchain.html` + `public/assets/js/onchain-dashboard.js` — analytics dashboard UI.
- `public/on-chain.html` — curated on-chain tools page (separate from analytics dashboard).

## Developer Notes (for Codex/Claude/OpenClaw agents)

- **Do not claim frameworks/tools not present** (no React, no TypeScript, no build step).
- Prefer small, modular changes under `src/services` and `src/routes` for backend features.
- Keep UI updates in `public/assets/styles` and `public/assets/js` when possible; avoid large inline scripts/styles for new pages.
- Preserve the distinction between:
  - `/on-chain.html` (curated links hub)
  - `/onchain.html` (API-backed analytics dashboard)
- For API work, maintain existing error style (`createServiceError`) and address validation helpers.
- If adding scripts, update `package.json` explicitly.

## Known Limitations / TODOs Visible in Code

- No automated test suite is configured.
- No lint/format scripts are configured.
- No build pipeline/minification for frontend assets.
- Several pages (`traditional.html`, `earthwatch.html`, and `index.html`) still include large inline style/script blocks.
- `public/assets/js/cards.js` exists but is not currently referenced by the HTML pages.
