# Macroeconomic calendar: sources, accuracy and operation

## Deployment audit

The read-only production audit on 2026-11-16 UTC found a **configured, live**
feed: `/api/macro/calendar` returned `fallback:false` and dated events, while
`/api/decision` reported `source:macro_calendar_url`, `live:true`, ten exact
events and 97 events dropped because they were not today. This disproves a
missing URL as the current production diagnosis. Railway's environment values
were not accessible in this workspace; the provider's identity, entitlement
and any earlier outage cannot be established from the public projection.

The code did expose genuine defects irrespective of deployment configuration:

- Not-configured, failed, malformed **and successfully empty** feeds all became
  the same four sample events (CPI, sentiment, Fed speaker, oil inventories).
- Bare clocks were assigned today's date; only today's events survived and
  the service and public endpoint capped them at ten and eight respectively.
- Overview, Decision Engine and the public route could fetch separately.
- Assumed instants could trigger timed news windows; a missing live calendar
  could look like a low-risk day.

These operational sample rows have been removed. Other market-data fallbacks
are unaffected.

## Provider decision

Preserve the deployment's working `MACRO_CALENDAR_URL` JSON integration rather
than purchase or silently substitute a provider. A generic source must publish
real dated releases covering the requested horizon; the app never fills gaps
with a recurring calendar or AI-generated estimates. A fixed current-week feed
can be combined with a configured next-week feed through
`MACRO_CALENDAR_NEXT_URL`. Date-range URLs can use `{from}` and `{to}` placeholders.
The calendar supports a rolling seven-day view and a fourteen-day view; results
are limited by the provider's published coverage, which the empty-state text
explicitly notes. No subscription or new key is required for an already working
generic URL.

Trading Economics is the supported optional upgrade for richer, licensed data:
its [calendar documentation](https://docs.tradingeconomics.com/economic_calendar/snapshot/)
describes official-source actuals and consensus forecasts, and its
[schema](https://docs.tradingeconomics.com/economic_calendar/schema/) documents
UTC dates, numerical importance and DateSpan estimates. Its
[country/date API](https://docs.tradingeconomics.com/economic_calendar/country/)
supports bounded horizon requests. The adapter preserves DateSpan estimates as
`assumed`, even though the timestamp uses UTC. It does not confuse TEForecast
with consensus Forecast. API access and redistribution rights depend on the
subscription; pricing is plan-specific, not presumed free. See
[pricing](https://tradingeconomics.com/analytics/pricing.aspx?source=developer)
and [published limits](https://docs.tradingeconomics.com/get_started/rate-limits/).
Five-minute shared reads and Retry-After handling reduce API usage; they do not
establish a provider SLA or guarantee instantaneous release actuals.

Forex Factory's official calendar provides weekly exports, but its
[notices](https://www.forexfactory.com/notices) restrict redistribution of the
compiled calendar. Export availability is not a blanket API redistribution
license. This change does not set a Forex Factory default, scrape a website,
purchase a plan, or assert that the existing deployment has particular rights.

Before enabling a new source, check coverage for US CPI/PPI, employment and
unemployment, FOMC, GDP, retail sales, PMI, sentiment and EIA inventories, plus
the major international economies. Missing events and missing values remain
missing; release actuals and licensing are provider capabilities.

## Railway configuration

For the existing feed, retain `MACRO_CALENDAR_URL`. Optional additions:

| Variable | Purpose/default |
| --- | --- |
| `MACRO_CALENDAR_PROVIDER` | `url` (default); or `tradingeconomics` for its documented schema |
| `MACRO_CALENDAR_NEXT_URL` | Optional complementary next-week dated JSON feed |
| `MACRO_CALENDAR_SOURCE` | Human-readable source label, never a credential-bearing URL |
| `MACRO_CALENDAR_TIMEZONE` | IANA zone for dated clock labels; default UTC |
| `MACRO_CALENDAR_CACHE_MS` | Default 300000, bounded to 60000–900000 |
| `MACRO_CALENDAR_STALE_MS` | Default 1800000, at least cache TTL and at most 3600000 |
| `MACRO_CALENDAR_API_KEY` | Optional Trading Economics key, held only server-side |

For Trading Economics, set its provider and key and leave URL empty to build
the official date-range request. An explicitly configured URL takes precedence.
No key is added to browser JavaScript, responses, diagnostic messages or logs.
Do not use guest/demo credentials as a production source. No environment values
were changed and no deployment was made as part of this task.

## Data and public API contract

Generic rows accept `title|event|name`, `at|datetime|timestamp|date`, or a split
date and time. Dates must be real calendar dates. ISO offsets/epochs produce
exact UTC instants; dated local clocks remain assumed. Date-only events retain
their real date, `at:null` and `precision:unknown`; undated clocks are rejected.
Invalid dates and nonexistent DST-gap times cannot acquire invented timestamps.
Country/currency, High/Medium/Low impact, forecast, previous and actual are
retained, including zero actuals. Duplicate country/title/date/instant entries
are removed. A passed scheduled time without an actual is labelled Delayed,
not confirmed Released. Provider-reported release statuses are retained.

`GET /api/macro/calendar` remains public and read-only, as does HEAD on the
same exact path. Mutations and neighbouring endpoints retain authentication.
The default returns today's full schedule in the feed's zone for Main Hub.
Optional bounded query parameters: `days=1..14`, an IANA `timezone`, and
`range=today|tomorrow|week|nextweek|all`. `all` spans the current local week and
the next fourteen days for Reporter-side filtering; weeks start Monday.

Existing fields (`status`, `fallback`, `timezone`, `events`, event time/title/
impact/precision) remain present. Added fields include date, country, verified,
forecast/previous/actual, status, source, quality, fetchedAt, expiresAt,
staleUntil and range. Private provider URLs, keys, raw errors and diagnostics
are excluded. Healthy empty reads have `status:ok` with an empty events array;
outages have `status:unavailable`, no samples and “Live calendar unavailable”.
Stale responses explicitly use `status:stale`; the existing Main Hub adapter
therefore shows unavailable instead of drawing stale events as live. Its
existing `status:ok` contract continues to work for healthy feeds.

## Cache and trading safety

One process-local snapshot serves Reporter, Overview, Decision Engine and Main
Hub, with in-flight coalescing. Provider reads occur on demand, normally at
most once per five minutes (per configured feed/process); projections and
midnight date pruning happen on every request. A provider failure holds retries
for at least one minute, honors Retry-After up to an hour, and never renews
fetchedAt. Last-known-good events are display-only, labelled stale and discarded
at their original maximum age. Successful empty reads replace older events.
After a restart there is no persisted stale snapshot; the UI stays unavailable
until a successful provider read.

Only fresh, explicitly verified `exact` events can produce a 45-minute
pre-release/15-minute post-release news window. Both Overview and the Decision
Engine request two days so a window crossing midnight is not lost. Assumed,
unknown or unverified times raise caution without countdowns. An unavailable
or stale feed yields unknown risk, a “verify calendar” setup action and a
separate `CALENDAR_UNAVAILABLE` Trading Lab safety check, rather than fabricating
a news-window blackout or claiming low risk. Existing high-impact blackout
checks still operate on valid instants.

Before deploying, run `npm run lint`, `npm run build`, `npm test`, the calendar
route/normalization/browser checks, and boot `createApp()`. Verify the public
feed and `/api/decision` after deployment, without exposing the provider URL.

## Validation and changed files for this fix

- `npm test -- --test-concurrency=4`: **2,111 passed**, no failures or skips.
- `npm run lint`, `npm run build`, explicit `createApp()` boot and
  `git diff --check`: passed.
- Chromium component checks at 390, 768 and 1280px: filters, Local/UTC
  conversion, approximate-time labels, zero actual values, hostile text,
  countdowns, visible mobile quality labels, stale/unavailable/empty states
  and horizontal fit passed using clearly identified offline fixtures.
- The existing Main Hub adapter was run unchanged against the new public
  router and read the healthy schedule successfully.
- The existing `smoke:decision` script passed all eight normal-mode access
  checks against the updated app locally. Its four warnings were expected:
  upstream requests were deliberately disabled, with no provider keys or
  production data used. This verifies access boundaries, not production
  market-data quality. No post-deployment validation is claimed.

Changed runtime files:

```text
src/services/calendar-normalize.js
src/services/macro-calendar.js
src/services/market-data.js
src/services/decision-engine.js
src/services/market-state.js
src/services/overview.js
src/services/trading/checklist.js
src/services/trading/trading-lab.js
src/routes/macro-calendar.js
public/reporter.html
public/assets/js/reporter-calendar.js
public/assets/js/reporter-market.js
public/assets/js/terminal-suite.js
public/assets/styles/reporter.css
```

Updated tests: calendar-normalize, macro-calendar-route, market-data-macro,
decision-engine, market-state and reporter-intelligence-ui. Added focused
Reporter calendar unit and browser tests. Configuration and documentation:
`.env.example`, `README.md` and this file.
