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
- `/api/newsroom` - newsroom cycle records and health for the scheduled reporting run: one durable cycle per run, linking generated sections to broadcast receipts and Telegram message ids. See [docs/newsroom-cycles.md](docs/newsroom-cycles.md).
- `/api/broadcast-ledger/preflight` - answers the environment, persistence and routing half of [docs/production-verification.md](docs/production-verification.md) from inside the running service. Sends nothing, echoes no secret. `node scripts/verify-broadcast-ledger.js --url <host> --key <key>` runs it plus the read-only endpoint checks and prints a verdict.
- `/api/broadcast-ledger/broadcast` - sends a broadcast to Telegram **and** records the receipt in one call, from the real send result. Telegram never reports a bot's own messages back through `getUpdates`, so anything sent through this bot cannot be picked up by the channel watch and must go through here.
- `/api/broadcast-ledger/manual` - operational Broadcast Ledger with date/category/status filters, search, daily summaries, destination labels, attempt history, edit/delete, copy, and failed retry. **Ledger Settings** controls exact categories, per-category limits and duplicate windows, blocked-attempt recording, retention, sources, and destination names. See [docs/broadcast-ledger.md](docs/broadcast-ledger.md).

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
- `POST/PATCH/DELETE /api/decision/journal` (trading-journal writes)

Guarded requests must carry an `x-admin-key` header matching `ADMIN_API_KEY`. The Reporter, AI Analysis, and Settings pages prompt for the key on first use and store it in the browser's `localStorage`. `ADMIN_API_KEY` is separate from the website login: owner login controls browsing, while the admin key controls write/broadcast actions. The public `/api/health` probe returns only `{ "status": "ok" }`; provider-key and cache detail are returned only to admin requests.

### Endpoints reachable without the website login

When `MARKET_DASHBOARD_LOGIN_PASSWORD` is set, site auth runs ahead of every route, so anything not listed here answers `401` (or a `/login` redirect for pages) before its own router is reached. The full list of exceptions:

- `/login`, `POST /auth/login`, `POST /auth/logout` — the login flow itself.
- `POST /api/alpha-team/access` — the Alpha Team code exchange.
- `GET /api/health` — the minimal deploy probe.
- `GET /api/decision` — read-only market decision data, polled by the TraderClaw agent, which authenticates no session cookie. This is the exact path only: `/api/decision/journal` and every mutating journal route still require the owner session (and, for writes, `ADMIN_API_KEY`).
- `/api/broadcast-ledger*` — machine callers that present `BROADCAST_LEDGER_API_KEY` or `ADMIN_API_KEY`; the ledger routes still enforce that key themselves. See [docs/broadcast-ledger.md](docs/broadcast-ledger.md).

Everything else — including all Trading Lab paper-trade and mutation endpoints, settings, and the rest of `/api/decision/*` — needs a session. The Alpha Team role additionally reaches only the shared `?view=alpha` pages and their read-only data APIs.

Verify this model against a running deploy with `npm run smoke:decision` (see [Production smoke check](#production-smoke-check)).

### Production smoke check

The test suite runs against a local app, so it cannot see a deploy's own environment — a site password that is set, an admin key that is not, a provider key that expired. `npm run smoke:decision` covers that gap from outside:

```bash
DASHBOARD_URL=https://your-dashboard.up.railway.app npm run smoke:decision
# or
npm run smoke:decision -- https://your-dashboard.up.railway.app
```

It sends no cookies, so it sees exactly what the TraderClaw agent sees, and checks in order: the health probe answers; `GET /api/decision` returns `200` without a login; the payload echoes the interval and carries a regime label/score and scored setups with a direction and action; `/api/decision/journal` and the Trading Lab still answer `401`/`403`; and a write to `/api/decision` is rejected rather than inheriting the read bypass.

It has two modes, because "is the deploy up?" and "is the deploy usable?" are different questions:

| Mode | Answers | Degraded market data |
| --- | --- | --- |
| normal (default) | reachability and the access model | `WARN` — a provider outage is not a broken deploy |
| `--strict` | trading health: a real scored setup with a direction and action, a regime, and market data that is not wholly fallback | `FAIL` — reachable but unusable is not green |

```bash
npm run smoke:decision -- https://your-dashboard.up.railway.app --strict
```

Output is `PASS`/`WARN`/`FAIL` per check with the URL and HTTP status, and the exit code is non-zero if any check fails. Every request is a `GET` apart from one `POST /api/decision` that is asserted to be *rejected*; nothing it does can mutate production state or place a trade. Optional: `DECISION_INTERVAL` (default `4h`), `SMOKE_TIMEOUT_MS` (default `20000`), `SMOKE_STRICT=1` as an alternative to `--strict`.

### Macro calendar and news risk

The Decision Engine gates news risk on "is a high-impact release inside the next 45 minutes?", and that answer feeds setup quality — so a calendar event has to be a real instant, not a clock label.

Every event resolves to `at`, a UTC ISO timestamp, or to `null`:

| Feed value | `at` | `precision` |
| --- | --- | --- |
| `2026-08-23T08:30:00-04:00`, `…Z`, epoch seconds/ms | the instant it states | `exact` |
| `2026-08-23 09:45` (no offset) | read in `MACRO_CALENDAR_TIMEZONE` | `assumed` |
| `08:30 ET`, `14:00 UTC` | read in the labelled zone, which beats the configured default | `assumed` |
| `08:30` (bare) | today, in `MACRO_CALENDAR_TIMEZONE` | `assumed` |
| `TBA`, unparseable, absent | `null` | `unknown` |

Two rules follow from that:

- **Events dated to another day are dropped.** Yesterday's CPI is never counted down to; `droppedNotToday` reports how many were excluded.
- **An event with no `at` never produces a countdown.** It still raises news risk to medium — a high-impact release at an unknown time is a reason for caution — but nothing claims it is "in 12 min". Fallback events are all `at: null` for exactly this reason: seed data must never trigger a blackout.

`GET /api/decision` reports the outcome under `dataQuality.calendar`:

```json
{
  "source": "macro_calendar_url", "live": true, "reason": null,
  "timezone": "America/New_York", "events": 2, "droppedNotToday": 1,
  "timing": { "total": 2, "exact": 0, "assumed": 1, "untimed": 1 }
}
```

When it falls back, `reason` says which of these happened — `not-configured`, `request-failed`, `invalid-shape`, `empty-feed`, `no-events-today` — with `detail` carrying the underlying error. A fallback calendar means news risk is being scored off static seed data, so `npm run smoke:decision -- --strict` fails on it.

If `timing.exact` is 0 while `assumed` is non-zero, no event states its own offset and every time is only as correct as `MACRO_CALENDAR_TIMEZONE`. Prefer a feed that emits ISO timestamps with offsets.

### Paper pipeline reconciliation

`GET /api/trading-lab/pipeline` answers the question no single store could: of everything the signal bridge evaluated, where did each one end up, and did anything silently disappear?

Three stores hold three different kinds of record, and they are deliberately not the same thing:

| Store | File | What it is |
| --- | --- | --- |
| `SignalActionStore` | `signal-bridge-log.json` | the **evaluation** ledger — one row per scored transition, whatever the outcome. The denominator. |
| `PaperTradingService` | `trading-lab/<book>/{positions,history}.json` | the **execution** ledger — paper fills and their closes. |
| `TradeJournalService` | `trade-journal.json` | the **human** journal — hand-logged and hand-graded through the admin-keyed route. |

The reconciliation view reads all three and writes none of them. In particular it never feeds the human journal: its win-rate and expectancy statistics are only meaningful because a person vouched for every row, so an automated dump would quietly destroy them. The journal is reported alongside, labelled `maintainedBy: "human"`.

`reconciled` is `true` only when every evaluated row reached a terminal status carrying a reason, and every bridge-owned paper fill has an evaluation row behind it. Anything else appears in `discrepancies` (`unknown-status`, `missing-reason`, `missing-attribution`, `unlogged-fill`) with enough detail to go looking. A `summary` line reads like `73 evaluated, 70 blocked, 2 dry-run, 1 failed, 0 unaccounted`.

Note that zero bridge-owned fills is the **designed** outcome today, not a broken pipeline: the Signal Bot has no registered strategy identity, so persistent execution is refused by attribution even when `SIGNAL_BOT_PAPER_TRADE_ENABLED=true`. The view says so explicitly in `execution.note` rather than leaving a bare zero to be misread.

### Newsroom cycles

`/api/newsroom` records one durable **cycle** per scheduled reporting run, so "did the 13:00 run happen, and how far did it get?" has an answer even when the run failed before writing a report or a receipt. See [docs/newsroom-cycles.md](docs/newsroom-cycles.md).

A cycle links the two records that already existed — the reporter generation log (what was written) and the broadcast ledger (what was sent) — under one id:

```text
cycle -> generated sections -> broadcast receipts -> destinations -> Telegram message ids
```

`queued -> generating -> generated -> delivering -> completed`, with `preflight_failed`, `generation_failed`, `delivery_partial` and `delivery_failed` as the failure states. Generation and delivery failures are deliberately distinct: **a cycle that generated its report and failed to deliver is redelivered, never regenerated.**

- A scheduled cycle's identity is its slot floored to the minute, and find-or-create runs under the store's exclusive lock, so a doubled cron invocation joins the existing cycle instead of forking a parallel run. Category-level broadcast idempotency is unchanged and still enforced by the ledger.
- Every failure is classified `retryable` (429, 5xx, timeouts, network) or `non_retryable` (401/403, 404, 400, missing credentials) before it is stored, so an authentication or configuration fault is not retried on a loop. `HTTP 401: User not found` gets its own code, `provider_user_not_found` — see [docs/newsroom-401-verification.md](docs/newsroom-401-verification.md).
- A lightweight preflight checks credentials, sections and routing before anything is generated or sent, in the same `pass` / `warn` / `fail` vocabulary as the broadcast preflight. Point `NEWSROOM_AGENT_PREFLIGHT_URL` at the gateway's identity endpoint and the ShareBot/OpenClaw agent route becomes a real gate — a credential it no longer recognizes fails the cycle before anything is spent. Leave it unset and the route reports `warn: not verified`, never a pass.
- **Delivery is cycle-exact.** Each generated section records `generationRef` — `{ cycleId, generatedAt, section }` — naming the one stored generation it stands for, and delivery rebuilds the report from those references rather than from the reporter's latest cache. Without that, a cycle whose delivery failed and is retried after a *later* cycle regenerated the same section would publish the later text under the earlier cycle's receipts. A same-day reused section points at the original generation and records `reusedFromCycleId`, so the reuse stays traceable. `peekReport()` still serves the Daily Reporter page, where "latest" is the intended answer.
- **Unprovable content is never sent.** If a section the cycle claims to have generated cannot be resolved to exactly one stored generation, delivery does not substitute the latest report and does not regenerate: it records `generation_reference_missing` (or `generation_reference_ambiguous`) against the cycle and sends nothing for it. Cycles recorded before references existed are read as they were written and resolved by cycle id, section and exact timestamp — and fail closed when that cannot identify one generation.
- `GET /api/newsroom/health` is a read-only operational summary (last successful cycle, last attempted cycle, current cycle, next expected run, most recent classified error, generated/delivered/failed counts, reporter model) carrying no credential, prompt body or message text. It is the one newsroom endpoint a machine may read with an `x-admin-key` instead of a browser session, so Agent Office's ShareBot67 panel can read it server-to-server: GET/HEAD only, that exact path only, header only. Everything else in `/api/newsroom` stays behind the owner session, and the writes behind the admin guard as well.

Storage is the same locked/atomic JSON the reporter log and ledger use — `<DATA_DIR>/newsroom-cycles.json`. No database was introduced: the reporter has no database layer to extend and the existing primitives were built for this exact fan-out-then-write pattern. Nothing here starts a timer; the schedule lives in the external cron, which calls `POST /api/newsroom/cycles/run` with the slot's `scheduledAt`.

## Environment Variables

Most keys are optional. The app is designed to degrade to fallback data where possible.

### Core

- `PORT` - local/server port, defaults to `3000`.
- `DATA_DIR` - persistent file directory for reporter logs/caches and X feed cache. On Railway, set this to the mounted volume path, usually `/app/data`.
- `MARKET_DASHBOARD_LOGIN_PASSWORD` - optional owner website password. When set, unauthenticated visitors are redirected to `/login`.
- `ADMIN_API_KEY` - shared secret enabling action/mutation endpoints (see [Access Control](#access-control)). Blank means those endpoints are disabled (`503`).
- `BROADCAST_LEDGER_API_KEY` - shared secret for the broadcast receipt ledger (`/api/broadcast-ledger`). Falls back to `ADMIN_API_KEY`; blank for both disables those endpoints (`503`). See [docs/broadcast-ledger.md](docs/broadcast-ledger.md).
- `BROADCAST_LEDGER_RATE_LIMIT_PER_MIN` - per-IP rate limit for the ledger endpoints, defaults to `60` (`0` disables).
- `BROADCAST_LEDGER_INGEST_ENABLED` - set to `true` to watch the configured Telegram channels and auto-record every post as a broadcast receipt, whichever path sent it. Off by default; requires Telegram to be configured.
- `BROADCAST_LEDGER_INGEST_INTERVAL_MS` - channel poll interval, defaults to `60000` (floor `15000`).
- `BROADCAST_LEDGER_NOTIFICATION_CHAT_IDS` - private Telegram `chatId` or `chatId:threadId` targets for enabled ledger alerts. No alerts are delivered when blank.
- `OPENAI_API_KEY` - enables report generation.
- `REPORTER_MODEL` - OpenAI model for reporter generation, defaults to `gpt-5.4-mini`.
- `NEWSROOM_SECTIONS` - sections one scheduled newsroom cycle is expected to produce. Blank means the reporter's default set (`crypto`, `economics`, `markets`). See [docs/newsroom-cycles.md](docs/newsroom-cycles.md).
- `NEWSROOM_EXPECTED_RUN_TIMES_UTC` - optional `HH:MM,HH:MM` in UTC, used only to report the next expected run in `/api/newsroom/health`. The schedule itself lives in the external cron; this app starts no timer for it.
- `NEWSROOM_CYCLE_HISTORY` - how many newsroom cycles to retain, defaults to `200`. Cycles hold no report text, so history is cheap.
- `NEWSROOM_ALLOW_PARTIAL_DELIVERY` - set to `true` to deliver the sections that exist when another expected section could not be generated. Off by default; a cycle delivering an incomplete report ends `delivery_partial`, never `completed`, and never sends a section it did not generate itself.
- `NEWSROOM_AGENT_PREFLIGHT_URL`, `NEWSROOM_AGENT_PREFLIGHT_HEADER`, `NEWSROOM_AGENT_PREFLIGHT_TOKEN`, `NEWSROOM_AGENT_PREFLIGHT_EXPECT`, `NEWSROOM_AGENT_PREFLIGHT_TIMEOUT_MS` - read-only identity check against the ShareBot/OpenClaw gateway, run before a cycle spends anything. Must be a GET that reports who the credential is, never a run endpoint. Without a URL the agent route is reported as `warn: not verified` — never as passing. See [docs/newsroom-401-verification.md](docs/newsroom-401-verification.md).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` - enable Telegram delivery. By default each news category is locked to its approved topics: `Stock`, `Crypto` and `Economics` to `-1001841650798:6297` and `-1001941064823:984`, and `Geopolitics` to the War Room, `-1001841650798:75972`. The two sets do not overlap. These targets **replace** the configured chat list rather than adding to it, so a broader `TELEGRAM_CHAT_IDS` cannot widen news routing. The policy applies to ledger broadcasts (first delivery and retry) and to the Daily Reporter's per-category sends alike — one table in `src/services/news-routing.js` serves both. The persisted **Restrict news categories to their approved topics** Ledger Setting controls it.
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
- `MACRO_CALENDAR_URL` - optional JSON macro-calendar feed. Accepts a bare array or `{events|items|data: [...]}`; each row needs a title (`title`/`event`/`name`), an impact (`impact`/`importance`), and a time (`time`/`datetime`/`date`/`timestamp`, or a `date` plus a `time`). See [Macro calendar and news risk](#macro-calendar-and-news-risk).
- `MACRO_CALENDAR_TIMEZONE` - the zone a feed's bare clock labels are published in, e.g. `America/New_York`. Defaults to `UTC`. Only consulted when the event itself carries no offset.
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
    services/broadcast-ledger.js  broadcast receipts: dedupe, idempotency, reconciliation
    services/broadcast-ingest.js  watches Telegram channels and auto-records what it sees
    middleware/ledger-auth.js     ledger API key guard (separate secret from ADMIN_API_KEY)
    middleware/rate-limit.js      in-process per-IP fixed-window limiter
    utils/                validators, errors, mappers
  docs/
    trading-lab.md        migration map and remaining work
    broadcast-ledger.md   receipt ledger: data model, endpoints, integrations
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
