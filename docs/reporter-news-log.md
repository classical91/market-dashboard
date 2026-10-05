# Reporter News Log

The canonical, deduplicated record of every news candidate the reporter
workflow has seen, and what became of it. It is **not** the broadcast ledger:
the ledger records what went out, while this log records what was found. Logging
an item here never means it was approved, queued or published.

Ownership: ShareBot/FarmClaw captures and verifies items. Market Dashboard
stores and displays them. Penny owns approval, scheduling and reconciliation.

Storage: `DATA_DIR/reporter-news-log.json`. It uses the same locked, atomic
JSON-file pattern as the broadcast ledger and is safe on a single replica.

## Auth

Writes need `x-broadcast-key: $BROADCAST_LEDGER_API_KEY` (or the admin key). This
is the same key ShareBot already uses for the ledger, so no new secret is
needed. Reads are open to a logged-in dashboard session or to a request that
carries the key.

## Workflow

```
discovered → verified → approved → queued → posted
     └──────────┴───────────┴─────────┴──→ failed  (failed → approved | queued | rejected)
     └──────────┴───────────┴──→ rejected
```

- Intake accepts only `discovered` or `verified` (the default). Anything later
  in the workflow must come through `PATCH`.
- Re-sending the current status is accepted, so retries are idempotent. Any
  other move that isn't listed above returns `409` with `currentStatus`.
- `queued` requires `farmbot.queueId`.
- `posted` requires `farmbot.publication` with a `receiptId`, `postId` or
  `url`. Success is never inferred from a helper response alone.
- `failed` requires the exact `error` text, for example the TLS or network
  error. A failure stays `failed`. It is never turned into `queued`.

## Endpoints

### `POST /api/reporter-news/intake`

```json
{
  "url": "https://www.reuters.com/markets/fed-holds?utm_source=x",
  "headline": "Fed holds rates steady",
  "source": "Reuters",
  "sourceId": "optional, used when there is no URL",
  "publishedAt": "2026-10-05T15:00:00Z",
  "capturedAt": "2026-10-05T16:00:00Z",
  "market": "Economics",
  "symbols": ["SPY", "DXY"],
  "summary": "…",
  "imageUrl": "https://…",
  "capturedBy": "sharebot67",
  "status": "verified"
}
```

`market` accepts Stock/Stocks/Markets, Crypto, Economics, Geopolitics, or
anything else, which is stored as `general`.

Deduplication uses the canonical URL. That means https, lowercase host, no
`www.`, no tracking params, no fragment and no trailing slash. When an item
has no URL, `source` + `sourceId` is used instead.

The response is a durable receipt. `201` means a new record was created and
`200` means it was deduplicated:

```json
{ "ok": true, "id": "rnl_…", "created": true, "deduplicated": false,
  "status": "verified", "reporterDate": "2026-10-05", "record": { … } }
```

On a repeat intake, blank fields are filled in, `summary`, `imageUrl` and
`symbols` are refreshed, and `intakeCount` goes up. The status can only move
from `discovered` to `verified`; it never moves backwards.

`reporterDate` is the America/Vancouver calendar day of `capturedAt`.

### `PATCH /api/reporter-news/:id`

```json
{ "status": "queued", "actor": "penny",
  "farmbot": { "queueId": "fb_123", "scheduledAt": "…", "status": "scheduled" } }
```

```json
{ "status": "posted",
  "farmbot": { "status": "published",
               "publication": { "receiptId": "…", "postId": "…", "url": "…", "postedAt": "…" } } }
```

```json
{ "status": "failed", "error": "TLS handshake timeout to farmbot backend" }
```

`farmbot` fields are merged. A reconciler that only sends `status` or
`lastCheckedAt` keeps the queue ID that was already stored. Other fields you
can patch are `verification` (`unverified|verified|disputed`), `symbols`,
`market`, `summary` and `note`.

### Reads

- `GET /api/reporter-news/daily?date=YYYY-MM-DD&market=&source=&symbol=&status=`
  returns the day's records with counts for each status. The counts ignore the
  `status` filter, so they always describe the whole day. The response also
  includes source and symbol facets.
- `GET /api/reporter-news/days?limit=30` returns recent days with their totals.
- `GET /api/reporter-news/lookup?url=…` or `?source=…&sourceId=…` checks
  whether an item is already logged. It never creates a record.
- `GET /api/reporter-news/:id` returns one record with its status history.

The Reporter Room's **Daily News Log** panel renders `/daily`.

## Phase 2 (not built yet)

- A reconciler that runs every 10–15 minutes and checks queued records against
  the FarmBot backend, using `PATCH` with `farmbot.status`/`lastCheckedAt`.
- A nightly close at about 23:55 America/Vancouver that totals the day, flags
  missing receipts and stores an immutable daily snapshot.
- Alerts only for missing receipts, reconciliation mismatches or repeated
  intake failures.
- Before scheduling is turned on: backfill one test day, verify
  deduplication, and compare records against FarmBot queue and post receipts.
